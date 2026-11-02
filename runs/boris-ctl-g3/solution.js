"use strict";
const zlib = require("zlib");

const SYNC = zlib.constants.Z_SYNC_FLUSH;
const TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const cfg = { minFast: 1 << 16 };
const stat = { fast: 0, generic: 0, baseline: 0 };

// ---------------------------------------------------------------- baseline
// Exact reference semantics. Used for odd inputs (non-canonical start/end).
function baseline(buf, start, end) {
  const text = zlib.gunzipSync(buf).toString("utf8");
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [ts, , , status] = line.split(" ");
    if (ts >= start && ts < end && status === "500") n++;
  }
  return n;
}

// ------------------------------------------------- buffer line primitives
// b: Buffer of whole lines, n: line-aligned length (b[n-1] === 10 or n === 0)
// T: 24-byte timestamp Buffer. Returns first line start with ts >= T (or n).
function lineLB(b, n, T) {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const ls = mid === 0 ? 0 : b.lastIndexOf(10, mid - 1) + 1;
    let d = 0;
    for (let i = 0; i < 24; i++) {
      d = b[ls + i] - T[i];
      if (d !== 0) break;
    }
    if (d < 0) {
      const le = b.indexOf(10, ls);
      lo = le < 0 ? n : le + 1;
    } else hi = ls;
  }
  return lo;
}

// count lines with status exactly 500 whose start offset lies in [a, bnd)
// (status = second-to-last space-separated token of the line)
function count500(b, a, bnd) {
  const s = b.latin1Slice(a, bnd);
  const n = s.length;
  let cnt = 0, h = 0;
  for (;;) {
    h = s.indexOf(" 500 ", h);
    if (h < 0) break;
    h += 5; // h = start of duration token; next search may reuse the trailing space
    if (h >= n) break;
    // duration token must be non-empty and end at newline/range end, no space
    const nl = s.indexOf("\n", h);
    const sp = s.indexOf(" ", h);
    if (sp !== h && nl !== h && (sp < 0 || (nl >= 0 && sp > nl))) cnt++;
    h--;
  }
  return cnt;
}

function countBuf(b, n, S, E) {
  const a = lineLB(b, n, S);
  const e = lineLB(b, n, E);
  if (e <= a) return 0;
  return count500(b, a, e);
}

function validStart(b) {
  return b.length >= 25 && TS_RE.test(b.latin1Slice(0, 24)) && b[24] === 32;
}

// ----------------------------------------------------------- generic path
function generic(buf, S, E) {
  const b = zlib.gunzipSync(buf, { chunkSize: 1 << 22 });
  if (b.length === 0) return 0;
  if (b[b.length - 1] !== 10) return null;
  if (!validStart(b)) return null;
  return countBuf(b, b.length, S, E);
}

// -------------------------------------------------------- multi-member path
function fast(buf, start, end, S, E) {
  const len = buf.length;
  if (len < 28 || buf[0] !== 0x1f || buf[1] !== 0x8b || buf[2] !== 8 || buf[3] !== 0) return null;
  const pat = buf.subarray(0, 10);
  const cache = new Map();

  function probe(p) {
    let s = cache.get(p);
    if (s !== undefined) return s;
    let want = 512;
    for (;;) {
      const lim = Math.min(len, p + 10 + want);
      const o = zlib.inflateRawSync(buf.subarray(p + 10, lim), { finishFlush: SYNC, chunkSize: 4096 });
      if (o.length >= 25) {
        s = o.latin1Slice(0, 24);
        if (!TS_RE.test(s) || o[24] !== 32) throw new Error("probe");
        break;
      }
      if (lim >= len || want > 1 << 20) throw new Error("probe-short");
      want *= 8;
    }
    cache.set(p, s);
    return s;
  }
  const ms = (s) => Date.parse(s);

  const last = buf.lastIndexOf(pat);
  if (last < 0) return null;
  const F0 = probe(0);
  const FL = last === 0 ? F0 : probe(last);

  // returns {pred, succ}: pred = last member with F < T (-1 if none),
  // succ = first member with F >= T (len if none)
  function lowerBound(T, lowOff) {
    let pred = -1, succ = len, tp = 0, ts = 0;
    if (lowOff > 0) { pred = lowOff; tp = ms(probe(lowOff)); }
    else if (F0 >= T) return { pred: -1, succ: 0 };
    else { pred = 0; tp = ms(F0); }
    if (FL < T) return { pred: last, succ: len };
    if (pred === last) return { pred, succ: len };
    // F(last) >= T so succ <= last
    succ = last; ts = ms(FL);
    const tT = ms(T);
    for (let it = 0; ; it++) {
      let g;
      if (it < 3 && ts > tp && tT === tT) {
        g = pred + Math.floor(((succ - pred) * (tT - tp)) / (ts - tp));
      } else g = (pred + succ) >>> 1;
      if (!(g > pred)) g = pred + 1;
      if (!(g < succ)) g = succ - 1;
      // q: last member in (pred, g]; p: first member in (g, succ)
      let q = g > pred ? buf.lastIndexOf(pat, g) : -1;
      if (q <= pred) q = -1;
      let p = buf.indexOf(pat, g + 1);
      if (p < 0 || p >= succ) p = -1;
      if (q < 0 && p < 0) break;
      if (q >= 0) {
        const f = probe(q);
        if (f < T) { pred = q; tp = ms(f); } else { succ = q; ts = ms(f); p = -1; }
      }
      if (p >= 0) {
        const f = probe(p);
        if (f < T) { pred = p; tp = ms(f); } else { succ = p; ts = ms(f); }
      }
    }
    return { pred, succ };
  }

  const lbS = lowerBound(start, 0);
  const A = lbS.pred < 0 ? 0 : lbS.pred;
  const lbE = lowerBound(end, lbS.pred < 0 ? 0 : lbS.pred);
  const B = lbE.succ;
  if (B <= A) return 0;

  // enumerate candidate members in [A, B)
  const offs = [A];
  for (;;) {
    const p = buf.indexOf(pat, offs[offs.length - 1] + 1);
    if (p < 0 || p >= B) break;
    offs.push(p);
  }
  let total = 0;
  const tE = ms(end);
  for (let k = 0; k < offs.length; k++) {
    const p = offs[k];
    const nxt = k + 1 < offs.length ? offs[k + 1] : B;
    if (nxt - p < 18) return null;
    const isize = buf.readUInt32LE(nxt - 4);
    if (isize > 1 << 28) return null;
    const body = buf.subarray(p + 10, nxt - 8);
    const lastCand = k === offs.length - 1;
    let b = null, n = 0;
    if (lastCand && nxt < len && isize > (1 << 18)) {
      // partial decode: stop shortly after the end of the window
      const Fm = ms(probe(p)), Fn = ms(probe(nxt));
      const cs = Math.max(64, isize);
      if (Fn > Fm && tE === tE) {
        let f = (tE - Fm) / (Fn - Fm);
        if (f < 0) f = 0;
        let take = Math.ceil(body.length * (f + 0.03)) + 4096;
        for (let tries = 0; tries < 3 && take < body.length; tries++) {
          const o = zlib.inflateRawSync(body.subarray(0, take), { finishFlush: SYNC, chunkSize: cs });
          const nl = o.lastIndexOf(10);
          if (nl >= 25) {
            let ls = o.lastIndexOf(10, nl - 1) + 1;
            let ge = true;
            for (let i = 0; i < 24; i++) {
              const x = o[ls + i] - E[i];
              if (x !== 0) { ge = x > 0; break; }
            }
            if (ge) { b = o; n = nl + 1; break; }
          }
          take = Math.ceil(take * 1.5) + 8192;
        }
      }
    }
    if (b === null) {
      const o = zlib.inflateRawSync(body, { chunkSize: Math.max(64, isize) });
      if (o.length !== isize) return null;
      if (o.length === 0) continue;
      if (o[o.length - 1] !== 10) return null;
      b = o; n = o.length;
    }
    if (!validStart(b)) return null;
    total += countBuf(b, n, S, E);
  }
  return total;
}

module.exports = function countErrors(buf, start, end) {
  if (typeof start !== "string" || typeof end !== "string" || !TS_RE.test(start) || !TS_RE.test(end)) {
    return baseline(buf, start, end);
  }
  if (start >= end) return 0;
  const S = Buffer.from(start, "latin1"), E = Buffer.from(end, "latin1");
  let r = null;
  try {
    if (buf.length >= cfg.minFast) r = fast(buf, start, end, S, E);
  } catch (e) { r = null; }
  if (r !== null) { stat.fast++; return r; }
  try { r = generic(buf, S, E); } catch (e) { r = null; }
  if (r !== null) { stat.generic++; return r; }
  stat.baseline++;
  return baseline(buf, start, end);
};
module.exports._cfg = cfg;
module.exports._baseline = baseline;
module.exports._stat = stat;
