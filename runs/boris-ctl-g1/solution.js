"use strict";
// Count lines with status 500 and start <= ts < end in a gzip'd access log.
// See PLAN.md.  Fast path: the file is a sequence of independent gzip members
// (one per hour in the production data).  We locate the members that overlap
// the window by probing member headers (first timestamp), decode only those
// (the last one only as far as needed), and count with native searches.
// Anything unexpected bails out to the original straightforward algorithm.
const zlib = require("zlib");
const { Z_SYNC_FLUSH } = zlib.constants;

const MAGIC = Buffer.from([0x1f, 0x8b, 0x08]);
const TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const stats = { ok: 0, bail: 0, partial: 0, partialRetry: 0, partialFull: 0 };
const opts = { smallLimit: 1 << 18 }; // below this compressed size use the plain path

// ---------------------------------------------------------------- reference
function plain(buf, start, end) {
  const text = zlib.gunzipSync(buf).toString("utf8");
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [ts, , , status] = line.split(" ");
    if (ts >= start && ts < end && status === "500") n++;
  }
  return n;
}

// ------------------------------------------------------------- byte helpers
// true if the timestamp token starting at b[p] is < key (JS string order, ASCII)
function tokLess(b, p, key, kl) {
  const n = b.length;
  for (let i = 0; ; i++) {
    const c = p + i < n ? b[p + i] : 32;
    if (c === 32 || c === 10) return i < kl;
    if (i === kl) return false;
    const d = c - key[i];
    if (d !== 0) return d < 0;
  }
}

// First line start in [lo,hi] whose ts >= key (hi if none).  lo and hi are line
// starts (or buffer bounds); lines in between are ordered; blank lines ignored.
function lowerBound(b, lo, hi, key) {
  const kl = key.length;
  let a = lo, z = hi;
  while (z - a > 8192) {
    const mid = (a + z) >> 1;
    let ls = mid > a ? b.lastIndexOf(10, mid - 1) + 1 : a;
    if (ls < a) ls = a;
    const ls0 = ls;
    while (ls < z && b[ls] === 10) ls++;
    if (ls >= z) { z = ls0; continue; }
    if (tokLess(b, ls, key, kl)) {
      const nl = b.indexOf(10, ls);
      a = nl < 0 || nl + 1 > z ? z : nl + 1;
    } else z = ls;
  }
  while (a < z) {
    if (b[a] === 10) { a++; continue; }
    if (!tokLess(b, a, key, kl)) break;
    const nl = b.indexOf(10, a);
    a = nl < 0 || nl + 1 > z ? z : nl + 1;
  }
  return a;
}

// number of lines in [i,j) (i a line start, j a line start/end) whose 4th
// space-separated field is exactly "500"
function count500(b, i, j) {
  const s = b.latin1Slice(i, j);
  const L = s.length;
  let n = 0, p = 0;
  for (;;) {
    const h = s.indexOf(" 500", p);
    if (h < 0) return n;
    p = h + 4; // the terminator space may begin the next hit
    if (p < L) {
      const c = s.charCodeAt(p);
      if (c !== 32 && c !== 10) continue;
    }
    // the space at h must be the 3rd space of its line
    const ls = s.lastIndexOf("\n", h) + 1;
    const a = s.indexOf(" ", ls);
    if (a < 0 || a >= h) continue;
    const c2 = s.indexOf(" ", a + 1);
    if (c2 < 0 || c2 >= h) continue;
    if (s.indexOf(" ", c2 + 1) === h) n++;
  }
}

// ---------------------------------------------------------------- fast path
class Bail extends Error {}

function fast(buf, start, end) {
  const blen = buf.length;
  const startKey = Buffer.from(start, "latin1");
  const endKey = Buffer.from(end, "latin1");
  const probes = new Map();

  function probe(q) {
    let r = probes.get(q);
    if (r !== undefined) return r;
    r = null;
    try {
      const out = zlib.gunzipSync(buf.subarray(q, Math.min(q + 4096, blen)), {
        finishFlush: Z_SYNC_FLUSH,
        chunkSize: 65536,
      });
      let p = 0;
      while (p < out.length && out[p] === 10) p++;
      if (out.length - p > 25 && out[p + 24] === 32) {
        const s = out.latin1Slice(p, p + 24);
        if (TS_RE.test(s)) r = s;
      }
    } catch (e) { /* not a member */ }
    probes.set(q, r);
    return r;
  }

  function nextValid(from, limit) {
    let p = from;
    for (;;) {
      const q = buf.indexOf(MAGIC, p);
      if (q < 0 || q >= limit) return null;
      const f = probe(q);
      if (f !== null) return { S: q, f };
      p = q + 1;
    }
  }

  function lastValid() {
    let q = blen;
    for (;;) {
      if (q <= 0) return null;
      q = buf.lastIndexOf(MAGIC, q - 1);
      if (q < 0) return null;
      const f = probe(q);
      if (f !== null) return { S: q, f };
    }
  }

  if (buf[0] !== 0x1f) throw new Bail();
  const f0 = probe(0);
  if (f0 === null) throw new Bail();
  const m0 = { S: 0, f: f0 };
  const last = lastValid();
  if (last === null) throw new Bail();

  // last member start with f < key (m0 returned if m0.f >= key); lo.f < key
  function lastBefore(key, lo) {
    if (last.S === lo.S) return lo;
    if (last.f < key) return last;
    let hi = last;
    let a = lo.S + 1, b = hi.S;
    let first = true;
    const tk = Date.parse(key);
    while (a < b) {
      let p = (a + b) >> 1;
      if (first) {
        first = false;
        const t0 = Date.parse(lo.f), t1 = Date.parse(hi.f);
        if (tk === tk && t0 === t0 && t1 === t1 && t1 > t0) {
          let fr = (tk - t0) / (t1 - t0);
          if (fr < 0) fr = 0; else if (fr > 1) fr = 1;
          p = Math.floor(lo.S + fr * (hi.S - lo.S));
          if (p < a) p = a; else if (p >= b) p = b - 1;
        }
      }
      const q = nextValid(p, b);
      if (q === null) b = p;
      else if (q.f < key) { lo = q; a = q.S + 1; }
      else { hi = q; b = p; }
    }
    return lo;
  }

  if (!(f0 < end)) return 0; // every line is >= end
  const A = f0 >= start ? m0 : lastBefore(start, m0);
  const Z = lastBefore(end, A);

  // members A..Z
  const starts = [A];
  while (starts[starts.length - 1].S !== Z.S) {
    const cur = starts[starts.length - 1];
    const nx = nextValid(cur.S + 1, Infinity);
    if (nx === null || nx.S > Z.S) throw new Bail();
    starts.push(nx);
  }
  const N = Z.S === last.S ? null : nextValid(Z.S + 1, Infinity);
  const endOf = (idx) => (idx + 1 < starts.length ? starts[idx + 1].S : N ? N.S : blen);

  function hint(S, E) {
    if (E - S < 18) return 65536;
    const isz = buf.readUInt32LE(E - 4);
    return Math.min(Math.max(isz + 4096, 65536), 1 << 27);
  }
  function full(S, E) {
    let out;
    try {
      out = zlib.gunzipSync(buf.subarray(S, E), { chunkSize: hint(S, E) });
    } catch (e) { throw new Bail(); }
    if (E < blen && out.length && out[out.length - 1] !== 10) throw new Bail();
    return out;
  }

  let total = 0;
  for (let mi = 0; mi < starts.length; mi++) {
    const S = starts[mi].S, E = endOf(mi);
    const isA = mi === 0, isZ = mi === starts.length - 1;
    let out, usable;
    if (isZ && N !== null && E - S > 65536) {
      // partial decode of the last member, grown until a line >= end is seen
      const t0 = Date.parse(Z.f), t1 = Date.parse(N.f), tk = Date.parse(end);
      let L;
      if (tk === tk && t0 === t0 && t1 === t1 && t1 > t0) {
        let fr = (tk - t0) / (t1 - t0);
        if (!(fr > 0.02)) fr = 0.02;
        L = Math.ceil(fr * (E - S) * 1.1) + 16384;
      } else L = (E - S) >> 1;
      const isz = buf.readUInt32LE(E - 4);
      stats.partial++;
      for (;;) {
        if (L >= (E - S) * 0.9) { stats.partialFull++; out = full(S, E); usable = out.length; break; }
        let o;
        try {
          o = zlib.gunzipSync(buf.subarray(S, S + L), {
            finishFlush: Z_SYNC_FLUSH,
            chunkSize: Math.min(Math.max(Math.ceil(isz * (L / (E - S)) * 1.2) + 65536, 65536), 1 << 27),
          });
        } catch (e) { throw new Bail(); }
        const u = o.lastIndexOf(10) + 1;
        if (u > 0) {
          const j = lowerBound(o, 0, u, endKey);
          if (j < u) { out = o; usable = u; break; }
        }
        stats.partialRetry++;
        L = Math.ceil(L * 1.6) + 65536;
      }
    } else {
      out = full(S, E);
      usable = out.length;
    }
    const i = isA ? lowerBound(out, 0, usable, startKey) : 0;
    const j = isZ ? lowerBound(out, i, usable, endKey) : usable;
    if (j > i) total += count500(out, i, j);
  }
  return total;
}

function countErrors(buf, start, end) {
  if (typeof start === "string" && typeof end === "string") {
    if (!(start < end)) {
      // nothing can satisfy start <= t < end; still validate nothing (input is trusted)
      return 0;
    }
    if (buf.length >= opts.smallLimit && /^[\x20-\x7e]*$/.test(start) && /^[\x20-\x7e]*$/.test(end)) {
      try {
        const r = fast(buf, start, end);
        stats.ok++;
        return r;
      } catch (e) { stats.bail++; }
    }
  }
  return plain(buf, start, end);
}

module.exports = countErrors;
module.exports._opts = opts;
module.exports._stats = stats;
module.exports._plain = plain;
