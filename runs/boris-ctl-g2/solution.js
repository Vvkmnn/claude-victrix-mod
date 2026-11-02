"use strict";
const zlib = require("zlib");

const Z_SYNC_FLUSH = zlib.constants.Z_SYNC_FLUSH;
const Z_FINISH = zlib.constants.Z_FINISH;
const HDR4 = Buffer.from([0x1f, 0x8b, 0x08, 0x00]);
const PAT = Buffer.from(" 500"); // status token candidate (checked below)

class Bail extends Error {}

// ---------------------------------------------------------------- helpers
// Compare the timestamp token of the line at b[ls..] with T (bytes).
function cmpTs(b, ls, T) {
  const n = T.length;
  for (let k = 0; k < n; k++) {
    const d = (b[ls + k] | 0) - T[k];
    if (d !== 0) return d;
  }
  const c = b[ls + n];
  return c === 32 || c === 10 || c === undefined ? 0 : 1;
}

// First line start in [s,e) whose ts >= T (e if none). [s,e) are whole lines.
function lowerBound(b, s, e, T) {
  let lo = s, hi = e;
  while (lo < hi) {
    let ls = (lo + hi) >> 1;
    while (ls > lo && b[ls - 1] !== 10) ls--;
    if (b[ls] === 10) { // blank line(s): move to next non-blank line
      let p = ls;
      while (p < hi && b[p] === 10) p++;
      if (p >= hi) { hi = ls; continue; }
      ls = p;
    }
    if (cmpTs(b, ls, T) >= 0) hi = ls;
    else {
      let le = b.indexOf(10, ls);
      if (le < 0 || le >= hi) le = hi - 1;
      lo = le + 1;
    }
  }
  return lo;
}

// Count lines in w (whole lines) whose 4th space-separated token is "500".
// If checkTs, also require S <= ts < E (used by the slow path).
function countHits(w, checkTs, S, E) {
  let n = 0, p = 0;
  while ((p = w.indexOf(PAT, p)) >= 0) {
    const nx = w[p + 4];
    if (nx === 32 || nx === 10 || nx === undefined) {
      // exactly two spaces before p within this line
      let q = p - 1, sp = 0;
      while (q >= 0 && w[q] !== 10) {
        if (w[q] === 32 && ++sp > 2) break;
        q--;
      }
      if (sp === 2) {
        if (!checkTs || (cmpTs(w, q + 1, S) >= 0 && cmpTs(w, q + 1, E) < 0)) n++;
      }
    }
    p += 4;
  }
  return n;
}

// ------------------------------------------------------------- slow path
function slow(buf, S, E) {
  const out = zlib.gunzipSync(buf);
  return countHits(out, true, S, E);
}

// ------------------------------------------------------------- fast path
function gzHeaderEnd(b, pos) {
  if (pos + 10 > b.length || b[pos] !== 0x1f || b[pos + 1] !== 0x8b || b[pos + 2] !== 8) return -1;
  const flg = b[pos + 3];
  if (flg & 0xe0) return -1;
  let p = pos + 10;
  if (flg & 4) {
    if (p + 2 > b.length) return -1;
    p += 2 + b.readUInt16LE(p);
  }
  if (flg & 8) { p = b.indexOf(0, p); if (p < 0) return -1; p++; }
  if (flg & 16) { p = b.indexOf(0, p); if (p < 0) return -1; p++; }
  if (flg & 2) p += 2;
  return p <= b.length ? p : -1;
}

function looksLikeTs(b, o) {
  if (o + 11 > b.length) return false;
  for (let k = 0; k < 4; k++) { const c = b[o + k]; if (c < 48 || c > 57) return false; }
  return b[o + 4] === 45 && b[o + 10] === 84;
}

function tsToken(b, o) {
  let q = o;
  const lim = Math.min(b.length, o + 48);
  while (q < lim && b[q] !== 32 && b[q] !== 10) q++;
  if (q >= lim) return null; // not terminated within what we decoded
  return Buffer.from(b.subarray(o, q));
}

function fast(buf, S, E) {
  const blen = buf.length;
  const h0 = gzHeaderEnd(buf, 0);
  if (h0 < 0 || blen < 20) throw new Bail();
  const cmp = Buffer.compare;

  // A member is identified by the offset c of its header (0 for the first).
  // Members are discovered lazily by searching for gzip headers.
  const infos = new Map();
  function mem(c) {
    let m = infos.get(c);
    if (m) return m;
    const hs = c === 0 ? h0 : c + 10;
    const nx = buf.indexOf(HDR4, hs);
    const cap = (nx < 0 ? blen : nx) - 8;
    if (cap < hs) throw new Bail();
    m = { c, hs, next: nx, cap, pr: null };
    infos.set(c, m);
    return m;
  }
  function prevOf(c) {
    if (c === 0) throw new Bail();
    let p = buf.lastIndexOf(HDR4, c - 1);
    if (p < h0) p = 0;
    if (mem(p).next !== c) throw new Bail();
    return p;
  }
  // head info of a member (T = ts at offset 0 if it starts a line, U = ts of
  // the first line starting after the first newline)
  function probe(c) {
    const m = mem(c);
    if (m.pr) return m.pr;
    const slice = m.cap - m.hs;
    let p = Math.min(slice, 4096);
    for (;;) {
      const out = zlib.inflateRawSync(buf.subarray(m.hs, m.hs + p), { finishFlush: Z_SYNC_FLUSH });
      const clean = looksLikeTs(out, 0);
      const nl = out.indexOf(10);
      let T = null, U = null;
      if (clean) T = tsToken(out, 0);
      if (nl >= 0) {
        let x = nl + 1;
        while (x < out.length && out[x] === 10) x++;
        if (x < out.length && looksLikeTs(out, x)) U = tsToken(out, x);
      }
      if (U && (T || !clean)) { m.pr = { clean, T, U, ms: NaN }; break; }
      if (p >= slice) throw new Bail();
      p = Math.min(slice, p * 8);
    }
    return m.pr;
  }
  function msOf(c) {
    const pr = probe(c);
    if (pr.ms !== pr.ms) pr.ms = Date.parse((pr.T || pr.U).toString("latin1"));
    return pr.ms;
  }
  function Lof(c) {
    const pr = probe(c);
    if (pr.clean) return pr.T;
    return probe(prevOf(c)).U;
  }
  if (!probe(0).clean) throw new Bail();

  // last member start
  let Rc = buf.lastIndexOf(HDR4, blen - 1);
  if (Rc < h0) Rc = 0;

  // Smallest member start c in (0, Rc] with right(c) true, given right(0)
  // false and right(Rc) true. Interpolates on timestamps first, then bisects.
  function firstRight(right, target) {
    let L = 0, R = Rc;
    for (let it = 0; ; it++) {
      let mid = Math.floor((L + R) / 2);
      if (it < 3) {
        const tl = msOf(L), tr = msOf(R);
        if (tr > tl && target > tl) {
          const f = (target - tl) / (tr - tl);
          mid = L + Math.floor((R - L) * Math.min(1, Math.max(0, f)));
        }
      }
      let c = buf.lastIndexOf(HDR4, mid);
      if (c <= L) {
        c = buf.indexOf(HDR4, Math.max(mid + 1, L + 1));
        if (c < 0 || c >= R) {
          // nothing in (L, R) at or after mid; check before mid too
          c = buf.lastIndexOf(HDR4, R - 1);
          if (c <= L) return R;
        }
      }
      if (c < h0) throw new Bail();
      if (right(c)) R = c; else L = c;
    }
  }

  const Sms = Date.parse(S.toString("latin1"));
  const Ems = Date.parse(E.toString("latin1"));

  // hi: last member with L(c) < E
  if (cmp(Lof(0), E) >= 0) return 0;
  let hiC;
  if (cmp(Lof(Rc), E) < 0) hiC = Rc;
  else hiC = prevOf(firstRight((c) => cmp(Lof(c), E) >= 0, Ems));
  // lo: first member with U(next) >= S (the last member always qualifies)
  const A = (c) => { const nx = mem(c).next; return nx < 0 || cmp(probe(nx).U, S) >= 0; };
  let firstC;
  if (A(0)) firstC = 0;
  else firstC = firstRight(A, Sms);
  if (firstC > hiC) return 0;
  while (firstC > 0 && !probe(firstC).clean) firstC = prevOf(firstC);

  let total = 0;
  let carry = null;
  let done = false;

  function range(b, s, e) { // whole lines in b[s,e)
    while (e - 2 >= s && b[e - 1] === 10 && b[e - 2] === 10) e--; // trailing blank lines
    const lb = lowerBound(b, s, e, S);
    const ub = lowerBound(b, lb, e, E);
    if (ub < e) done = true;
    if (ub > lb) total += countHits(b.subarray(lb, ub), false);
  }
  function feed(data) {
    let s = 0;
    if (carry) {
      const nl = data.indexOf(10);
      if (nl < 0) { carry = Buffer.concat([carry, data]); return; }
      const line = Buffer.concat([carry, data.subarray(0, nl + 1)]);
      carry = null;
      range(line, 0, line.length);
      s = nl + 1;
      if (done) return;
    }
    const last = data.lastIndexOf(10);
    if (last >= s) {
      range(data, s, last + 1);
      if (done) return;
      s = last + 1;
    }
    if (s < data.length) carry = data.subarray(s);
  }

  function checkTrailer(m, out, used) {
    // member fully decoded: verify extent and ISIZE
    if (used !== m.cap - m.hs) throw new Bail();
    if (out.length !== buf.readUInt32LE(m.cap + 4)) throw new Bail();
  }
  function hint(m) {
    const isz = buf.readUInt32LE(m.cap + 4);
    return isz > 0 && isz < (1 << 29) ? isz + 1 : 1 << 20;
  }

  for (let c = firstC; !done; ) {
    const m = mem(c);
    const slice = m.cap - m.hs;
    const cs = hint(m);
    if (c < hiC) {
      const r = zlib.inflateRawSync(buf.subarray(m.hs, m.cap), { chunkSize: cs, info: true });
      checkTrailer(m, r.buffer, r.engine.bytesWritten);
      feed(r.buffer);
      if (m.next < 0) throw new Bail();
      c = m.next;
    } else {
      // last needed member: decode only a prefix, growing if too short
      const pr = probe(c);
      let p;
      const t0 = Date.parse(pr.T.toString("latin1"));
      const t1 = m.next >= 0 ? msOf(m.next) : NaN;
      if (t1 > t0 && Ems >= t0) p = Math.ceil(slice * Math.min(1, (Ems - t0) / (t1 - t0)) * 1.04) + 16384;
      else p = Math.ceil(slice / 2);
      p = Math.max(Math.min(p, slice), Math.min(slice, 65536));
      for (;;) {
        const whole = p >= slice;
        const r = zlib.inflateRawSync(buf.subarray(m.hs, m.hs + p), {
          chunkSize: cs, info: true, finishFlush: whole ? Z_FINISH : Z_SYNC_FLUSH,
        });
        const out = r.buffer;
        if (whole) {
          checkTrailer(m, out, r.engine.bytesWritten);
          feed(out);
          break;
        }
        if (r.engine.bytesWritten !== p) throw new Bail(); // member ended early: bad boundaries
        const last = out.lastIndexOf(10);
        let tr = NaN;
        if (last >= 0) {
          let ls = last;
          while (ls > 0 && out[ls - 1] !== 10) ls--;
          if (out[ls] !== 10 && cmpTs(out, ls, E) >= 0) {
            feed(out);
            done = true; // truncated tail is beyond the window; ignore it
            break;
          }
          if (looksLikeTs(out, ls)) { const tk = tsToken(out, ls); if (tk) tr = Date.parse(tk.toString("latin1")); }
        }
        let np = Math.ceil(p * 1.25) + 16384;
        if (tr > t0 && Ems > tr) np = Math.max(np, Math.ceil(p * (Ems - t0) / (tr - t0) * 1.04) + 16384);
        p = Math.min(slice, np);
      }
      break;
    }
  }
  if (!done && carry && carry.length) range(carry, 0, carry.length);
  return total;
}

module.exports = function countErrors(buf, start, end) {
  const S = Buffer.from(start, "utf8");
  const E = Buffer.from(end, "utf8");
  try {
    return fast(buf, S, E);
  } catch (e) {
    return slow(buf, S, E);
  }
};
