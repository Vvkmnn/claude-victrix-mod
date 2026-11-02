"use strict";
const zlib = require("zlib");

const TSLEN = 24; // "YYYY-MM-DDTHH:MM:SS.mmmZ"
const SYNC = zlib.constants.Z_SYNC_FLUSH;
const PAT = Buffer.from(" 500");
const CH = { chunkSize: 1 << 18 };
let SMALL = 1 << 16; // below this just do the plain thing (tests may lower it)
let INIT = 1 << 20;

class Bail extends Error {}

// ---- general version: exactly the obvious one ----
function reference(buf, start, end) {
  const text = zlib.gunzipSync(buf).toString("utf8");
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [ts, , , status] = line.split(" ");
    if (ts >= start && ts < end && status === "500") n++;
  }
  return n;
}

function isAscii24(s) {
  if (s.length !== TSLEN) return false;
  for (let i = 0; i < TSLEN; i++) if (s.charCodeAt(i) > 126) return false;
  return true;
}

// compare 24 bytes of b at p with key (Buffer): <0, 0, >0
function cmp(b, p, key) {
  for (let i = 0; i < TSLEN; i++) {
    const d = b[p + i] - key[i];
    if (d !== 0) return d;
  }
  return 0;
}

// first line-start offset whose timestamp >= key (lines are non-decreasing)
function lowerBound(b, key) {
  const n = b.length;
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    let p;
    if (mid === lo) p = lo;
    else {
      const nl = b.indexOf(10, mid - 1);
      p = nl < 0 ? n : nl + 1;
    }
    while (p < n && b[p] === 10) p++; // skip blank lines
    if (p >= hi) { hi = mid; continue; }
    if (p + TSLEN >= n || b[p + TSLEN] !== 32) throw new Bail();
    if (cmp(b, p, key) < 0) {
      const nl = b.indexOf(10, p);
      lo = nl < 0 ? n : nl + 1;
    } else hi = mid;
  }
  return lo;
}

// count status-500 lines in b whose ts is in [startKey, endKey)
function countIn(b, startKey, endKey) {
  const a = lowerBound(b, startKey);
  const e = lowerBound(b, endKey);
  let n = 0, i = a, c;
  const nb = b.length;
  while (i < e) {
    if (b[i] === 10) { i++; continue; } // blank line
    if (b[i + TSLEN] !== 32) throw new Bail();
    let j = i + TSLEN + 1;
    for (;;) { c = b[j]; if (c === 32 || c === 10 || c === undefined) break; j++; } // method
    if (c === 32) {
      j++;
      for (;;) { c = b[j]; if (c === 32 || c === 10 || c === undefined) break; j++; } // path
      if (c === 32) {
        j++; // status token
        if (b[j] === 53 && b[j + 1] === 48 && b[j + 2] === 48) {
          const d = b[j + 3];
          if (d === 32 || d === 10 || d === undefined) n++;
        }
      }
    }
    while (j < nb && b[j] !== 10) j++;
    i = j + 1;
  }
  return n;
}

function tsOk(b, p) {
  // "dddd-dd-ddTdd:dd:dd.dddZ "
  if (p + TSLEN >= b.length || b[p + TSLEN] !== 32) return false;
  for (let i = 0; i < TSLEN; i++) {
    const c = b[p + i];
    switch (i) {
      case 4: case 7: if (c !== 45) return false; break;
      case 10: if (c !== 84) return false; break;
      case 13: case 16: if (c !== 58) return false; break;
      case 19: if (c !== 46) return false; break;
      case 23: if (c !== 90) return false; break;
      default: if (c < 48 || c > 57) return false;
    }
  }
  return true;
}

// ---- gzip member navigation (members found by exact header bytes) ----
function fast(buf, start, end) {
  const len = buf.length;
  const H = buf.subarray(0, 10);
  if (len < 30 || H[0] !== 0x1f || H[1] !== 0x8b || H[2] !== 8 || H[3] !== 0) throw new Bail();
  const Hc = Buffer.from(H);
  const startKey = Buffer.from(start, "latin1");
  const endKey = Buffer.from(end, "latin1");

  const idx = (from, lim) => {
    const r = buf.subarray(0, lim).indexOf(Hc, from);
    return r;
  };
  // first line timestamp (24 bytes) of member at p, as Buffer; throws Bail if not valid (cached)
  const cache = new Map();
  const firstTs = (p) => {
    let r = cache.get(p);
    if (r !== undefined) return r;
    const out = zlib.inflateRawSync(buf.subarray(p + 10, Math.min(len, p + 10 + 4096)), { finishFlush: SYNC });
    if (out.length < TSLEN + 1 || !tsOk(out, 0)) throw new Bail();
    r = out.subarray(0, TSLEN);
    cache.set(p, r);
    return r;
  };
  const before = (p) => cmp(firstTs(p), 0, startKey) < 0; // member p starts before `start`
  const ms = (p) => Date.parse(firstTs(p).toString("latin1"));

  // find j = last member start whose first ts < start (or 0)
  // invariant: lo is a member start (assumed "before"), hi is a member start that is not "before", or len
  let lo = 0, hi = len, steps = 0;
  const m1 = idx(10, len);
  if (m1 > 0 && before(m1) ) lo = m1;
  else if (m1 > 0) hi = m1;
  if (hi === len && lo > 0) {
    // rate guess from members 0 and m1: bytes per millisecond
    const dt = ms(m1) - ms(0);
    const ds = Date.parse(start) - ms(m1);
    if (dt > 0 && ds > 0) {
      const g = m1 + Math.floor((m1 * ds) / dt);
      if (g > lo && g < len) {
        const p = idx(g, len);
        if (p > lo) { if (before(p)) lo = p; else hi = p; }
      }
    }
  }
  for (;;) {
    const q = idx(lo + 10, hi);
    if (q < 0) break; // no member strictly between lo and hi: lo is j
    if (steps++ > 5) { // guess was poor: plain bisection on byte offsets
      const mid = Math.max(q, (lo + hi) >>> 1);
      let p = idx(mid, hi);
      if (p < 0) p = q;
      if (before(p)) lo = p; else hi = p;
    } else if (hi < len) { // walk back from hi
      const pr = buf.subarray(0, hi).lastIndexOf(Hc, hi - 1);
      if (pr <= lo) break;
      if (before(pr)) { lo = pr; break; }
      hi = pr;
    } else { // walk forward from lo
      if (before(q)) lo = q; else { hi = q; break; }
    }
  }
  // select members j.. while first ts < end
  const segs = []; // [s, nxt] ; nxt = -1 for last member in file
  const nextFts = []; // first ts of following member (Buffer) if known
  let s = lo;
  for (;;) {
    const nxt = idx(s + 10, len);
    if (nxt < 0) { segs.push([s, -1]); nextFts.push(null); break; }
    const f = firstTs(nxt);
    if (cmp(f, 0, endKey) < 0) {
      segs.push([s, nxt]); nextFts.push(f);
      s = nxt;
    } else { segs.push([s, nxt]); nextFts.push(f); break; }
  }
  // note: if the loop stopped on f >= end, the last seg is the final one needed
  let total = 0;
  for (let k = 0; k < segs.length; k++) {
    const [sp, nxt] = segs[k];
    const cEnd = (nxt < 0 ? len : nxt) - 8; // end of deflate data
    const L = cEnd - (sp + 10);
    if (L < 1) throw new Bail();
    const isLast = k === segs.length - 1;
    let out;
    if (!isLast) {
      out = zlib.gunzipSync(buf.subarray(sp, cEnd + 8), CH); // checks CRC/ISIZE; decodes any unrecognised members too
      if (out.length === 0 || out[out.length - 1] !== 10) throw new Bail();
    } else {
      // partial inflate: grow prefix until a complete line with ts >= end is seen
      let pre;
      const f = nextFts[k];
      if (f && cmp(f, 0, endKey) >= 0 && segs.length >= 1) {
        // interpolate position of `end` inside this member by time
        const t0 = Date.parse(firstTsStr(buf, sp));
        const t1 = Date.parse(f.toString("latin1"));
        const te = Date.parse(end);
        let frac = t1 > t0 ? (te - t0) / (t1 - t0) : 0.5;
        if (!(frac >= 0)) frac = 0.5;
        pre = Math.floor(L * Math.min(1, frac) * 1.04) + 8192;
      } else pre = INIT;
      for (;;) {
        if (pre >= L) { pre = L; }
        const full = pre === L;
        if (full) {
          out = zlib.gunzipSync(buf.subarray(sp, cEnd + 8), CH);
          break;
        }
        out = zlib.gunzipSync(buf.subarray(sp, sp + 10 + pre), { finishFlush: SYNC, chunkSize: 1 << 18 });
        const nl = out.lastIndexOf(10);
        if (nl >= 0) {
          // last complete line start
          const pl = out.lastIndexOf(10, nl - 1) + 1;
          if (pl + TSLEN < nl && tsOk(out, pl) && cmp(out, pl, endKey) >= 0) {
            out = out.subarray(0, nl + 1);
            break;
          }
        }
        pre = Math.floor(pre * 1.5) + 65536;
      }
    }
    total += countIn(out, startKey, endKey);
  }
  return total;
}

function firstTsStr(buf, p) {
  const out = zlib.inflateRawSync(buf.subarray(p + 10, Math.min(buf.length, p + 10 + 4096)), { finishFlush: SYNC });
  return out.toString("latin1", 0, TSLEN);
}

function countErrors(buf, start, end) {
  if (start >= end) return 0;
  if (buf.length >= SMALL && isAscii24(start) && isAscii24(end)) {
    try {
      const r = fast(buf, start, end);
      countErrors._stats.fast++;
      return r;
    } catch (e) {
      countErrors._stats.bail++;
      // any surprise: general path
    }
  }
  return reference(buf, start, end);
}

// One-time module warm-up: first zlib use and first JIT tiers cost milliseconds; pay them at load.
function warm() {
  try {
    const members = [];
    const base = Date.UTC(2020, 0, 1);
    for (let m = 0; m < 6; m++) {
      const lines = [];
      for (let i = 0; i < 1200; i++) {
        const t = new Date(base + (m * 1200 + i) * 50).toISOString();
        lines.push(t + " GET /api/v1/item/" + ((i * 7919) % 90000) + " " + (i % 7 === 0 ? 500 : 200) + " " + (i % 900) + "ms");
      }
      members.push(zlib.gzipSync(lines.join("\n") + "\n"));
    }
    const g = Buffer.concat(members);
    const s1 = new Date(base + 1500 * 50).toISOString(), e1 = new Date(base + 4000 * 50).toISOString();
    for (let k = 0; k < 3; k++) fast(g, s1, e1);
  } catch (e) { /* warm-up is best effort */ }
}
warm();
countErrors._stats = { fast: 0, bail: 0 };
countErrors._reference = reference;
countErrors._setSmall = (n) => { SMALL = n; };
countErrors._setInit = (n) => { INIT = n; };
module.exports = countErrors;
