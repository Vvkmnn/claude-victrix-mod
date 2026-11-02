"use strict";
const zlib = require("zlib");

const TS_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const MAGIC = Buffer.from([0x1f, 0x8b, 0x08, 0x00]); // member header, FLG=0
const SAMPLE_IN = 6144; // compressed bytes inflated to read a member's 2nd line

// ---- general line scanner (matches the obvious split(" ") version) --------
// Counts complete "\n"-terminated lines in b[from, to); returns offset of the
// first unconsumed byte. Optionally reports (via state.stop) a ts >= end.
function scan(b, from, to, st) {
  const { s, e } = st;
  let n = 0, p = from;
  while (p < to) {
    const nl = b.indexOf(10, p);
    if (nl < 0 || nl >= to) break;
    n += lineHit(b, p, nl, s, e, st);
    p = nl + 1;
    if (st.stop) break;
  }
  st.n += n;
  return p;
}
function lineHit(b, p, q, s, e, st) {
  if (q === p) return 0;
  const sp = b.indexOf(32, p);
  const tsEnd = sp < 0 || sp > q ? q : sp;
  const ts = b.latin1Slice(p, tsEnd);
  if (ts >= e) { st.ge++; if (st.ge > 0 && st.mono) st.stop = true; return 0; }
  if (ts < s) return 0;
  if (sp < 0 || sp >= q) return 0;
  // tokens: ts METHOD path status ; status is 4th token
  let a = sp + 1;
  for (let k = 0; k < 2; k++) {
    const x = b.indexOf(32, a);
    if (x < 0 || x >= q) return 0;
    a = x + 1;
  }
  let z = b.indexOf(32, a);
  if (z < 0 || z > q) z = q;
  return z - a === 3 && b[a] === 53 && b[a + 1] === 48 && b[a + 2] === 48 ? 1 : 0;
}

// Fully general reference path (used for any surprise).
function slow(buf, start, end) {
  const text = zlib.gunzipSync(buf).toString("utf8");
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [ts, , , status] = line.split(" ");
    if (ts >= start && ts < end && status === "500") n++;
  }
  return n;
}

// First line that STARTS inside a member (after its first "\n"), if complete.
function firstStartedTs(b) {
  const a = b.indexOf(10);
  if (a < 0) return null;
  const c = b.indexOf(10, a + 1);
  if (c < 0 || c - a - 1 < 24) return null;
  const t = b.latin1Slice(a + 1, a + 25);
  return TS_RE.test(t) ? t : null;
}
const sample = (buf, off) =>
  zlib.inflateRawSync(buf.subarray(off + 10, off + 10 + SAMPLE_IN), { finishFlush: zlib.constants.Z_SYNC_FLUSH });

// Byte offset of the first line (start) in d[from..] whose ts >= key.
// Lines are non-decreasing in ts, so this is a binary search over bytes.
function lowerBound(d, from, key) {
  const len = d.length;
  const nextStart = (x) => (x <= from ? from : d.indexOf(10, x - 1) + 1 || len + 1);
  let lo = from, hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const ls = nextStart(mid);
    if (ls >= len) { hi = mid; continue; }
    if (d[ls + 4] !== 45 || d[ls + 23] !== 90) throw new Error("odd line");
    if (d.latin1Slice(ls, ls + 24) >= key) hi = mid; else lo = mid + 1;
  }
  const r = nextStart(lo);
  return r > len ? len : r;
}

// Count status-500 lines in d[from,to) (complete lines). A hit " 500 " counts
// only if it is the 4th token (exactly two spaces earlier on its line).
function count500(d, from, to) {
  let n = 0, i = from;
  while ((i = d.indexOf(" 500 ", i)) >= 0 && i < to) {
    const ls = d.lastIndexOf(10, i) + 1;
    let sp = 0;
    for (let k = ls < from ? from : ls; k < i; k++) if (d[k] === 32) sp++;
    if (sp === 2) n++;
    i += 5;
  }
  return n;
}

function fast(buf, start, end) {
  if (!TS_RE.test(start) || !TS_RE.test(end)) return -1;
  if (buf.length < 18 || buf[0] !== 0x1f || buf[1] !== 0x8b || buf[2] !== 8 || buf[3] !== 0) return -1;
  const offs = [0], S = [null], heads = [null];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i + 1)) >= 0) {
    if (i < 18) continue;
    let t = null, out;
    try { out = sample(buf, i); t = firstStartedTs(out); } catch (_) {}
    if (t !== null) { offs.push(i); S.push(t); heads.push(out); }
  }
  if (offs.length < 2) return -1;
  S[0] = ""; // member 0 always starts a line; never excluded by its own bound
  const m = offs.length;
  for (let k = 2; k < m; k++) if (S[k] < S[k - 1]) return -1;
  let lo = -1, hi = -1;
  for (let k = 0; k < m; k++) {
    if ((k === 0 || S[k] < end) && (k === m - 1 || S[k + 1] >= start)) { if (lo < 0) lo = k; hi = k; }
  }
  if (lo < 0) return 0;
  const last = hi === m - 1;
  let data = zlib.gunzipSync(buf.subarray(offs[lo], last ? buf.length : offs[hi + 1]));
  if (!last) { // complete the line that straddles into the next member (or its aligned first line)
    const h = heads[hi + 1], nl = h.indexOf(10);
    data = Buffer.concat([data, h.subarray(0, nl + 1)]);
  }
  if (last && data[data.length - 1] !== 10) data = Buffer.concat([data, Buffer.from("\n")]);
  let from = 0;
  if (lo > 0) { const nl = data.indexOf(10); if (nl < 0) return 0; from = nl + 1; }
  const a = lowerBound(data, from, start);
  const e = lowerBound(data, a, end);
  return count500(data, a, e);
}

// Generic path with early stop: inflate a growing prefix (a truncated gzip
// stream with Z_SYNC_FLUSH yields its complete output so far) until a line
// with ts >= end has been seen; the size of each next prefix is extrapolated.
function streaming(buf, start, end) {
  const N = buf.length, F = zlib.constants.Z_SYNC_FLUSH;
  const t0 = Date.parse(end);
  let n = Math.min(N, 1 << 20), prev = 0, base = NaN;
  for (;;) {
    const full = n >= N;
    const data = zlib.gunzipSync(full ? buf : buf.subarray(0, n), { finishFlush: F });
    // probe: ts of the last complete line
    const lastNl = data.lastIndexOf(10);
    let reached = false, p = 0;
    if (lastNl >= 0) {
      p = lastNl + 1;
      const ls = data.lastIndexOf(10, lastNl - 1) + 1;
      const sp = data.indexOf(32, ls);
      reached = data.latin1Slice(ls, sp < 0 || sp > lastNl ? lastNl : sp) >= end;
    }
    if (reached || full) {
      const st = { s: start, e: end, n: 0, ge: 0, mono: true, stop: false };
      const q = scan(data, 0, data.length, st);
      if (!st.stop && q < data.length) st.n += lineHit(data, q, data.length, start, end, st);
      return st.n;
    }
    // extrapolate: compressed bytes per millisecond of log time
    let next = n * 2;
    if (p > 0 && data.length >= 48) {
      const a = Date.parse(data.latin1Slice(0, 24));
      const lnl = data.lastIndexOf(10, p - 2);
      const z = Date.parse(data.latin1Slice(lnl + 1, lnl + 25));
      if (z > a && t0 > z) next = Math.max(Math.ceil(n * 1.25), Math.ceil(n * ((t0 - a) / (z - a)) * 1.05));
    }
    n = Math.min(N, next);
  }
}

module.exports = function countErrors(buf, start, end) {
  try { const r = fast(buf, start, end); if (r >= 0) return r; } catch (_) {}
  try { return streaming(buf, start, end); } catch (_) {}
  return slow(buf, start, end);
};
module.exports._slow = slow;
module.exports._streaming = streaming;
module.exports._fast = fast;
