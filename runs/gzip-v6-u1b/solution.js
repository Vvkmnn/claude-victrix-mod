const zlib = require("zlib");

// Reference semantics (kept as the guarded fallback).
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

// Compare bytes b[s,e) with ASCII pattern p (Buffer): <0, 0, >0 (lexicographic, shorter-first on tie).
function cmp(b, s, e, p) {
  const m = p.length;
  let i = 0;
  const l = e - s < m ? e - s : m;
  for (; i < l; i++) {
    const d = b[s + i] - p[i];
    if (d !== 0) return d;
  }
  return e - s - m;
}

const OUT = 1 << 20; // decompressed bytes per step

function fast(buf, start, end) {
  const S = Buffer.from(start, "latin1"), E = Buffer.from(end, "latin1");
  // Resumable synchronous inflate through the zlib binding handle (Node's own sync API is one-shot).
  const g = new zlib.Gunzip();
  const h = g._handle, st = g._writeState;
  if (!h || typeof h.writeSync !== "function" || !st) throw new Error("no handle");
  const out = Buffer.allocUnsafe(OUT);
  const flush = zlib.constants.Z_NO_FLUSH;
  let n = 0, tail = null, inPos = 0;
  const len = buf.length;
  for (;;) {
    h.writeSync(flush, buf, inPos, len - inPos, out, 0, OUT);
    const produced = OUT - st[0];
    inPos = len - st[1];
    if (g._hadError) throw new Error("zlib");
    if (produced > 0) {
      const chunk = out.subarray(0, produced);
      const lastNl = chunk.lastIndexOf(10);
      if (lastNl < 0) {
        tail = tail ? Buffer.concat([tail, chunk]) : Buffer.from(chunk);
      } else {
        let skip = false;
        const ls = chunk.lastIndexOf(10, lastNl - 1) + 1;
        if (ls > 0 && lastNl - ls >= S.length) {
          let sp = ls; while (sp < lastNl && chunk[sp] !== 32) sp++;
          if (sp < lastNl && cmp(chunk, ls, sp, S) < 0) skip = true;
        }
        if (!skip) {
          let from = 0;
          if (tail) {
            const f = chunk.indexOf(10);
            const first = Buffer.concat([tail, chunk.subarray(0, f + 1)]);
            const r = scan(first, 0, first.length - 1, S, E);
            if (r < 0) return n + (-r - 1);
            n += r;
            from = f + 1;
          }
          if (from <= lastNl) {
            const r = scan(chunk, from, lastNl, S, E);
            if (r < 0) return n + (-r - 1);
            n += r;
          }
        }
        tail = Buffer.from(chunk.subarray(lastNl + 1));
      }
    }
    if (st[0] !== 0) {
      // output not full: all input consumed or stream ended
      if (st[1] === 0 || produced === 0) break;
    }
  }
  if (inPos < len) throw new Error("trailing data / multi-member");
  if (tail && tail.length) {
    const r = scan(tail, 0, tail.length, S, E);
    n += r < 0 ? -r - 1 : r;
  }
  return n;
}

// Scan lines in b[from, upto) where upto is the index of the newline ending the last line
// (or the end for the final unterminated line). Returns count, or -(count+1) if a line with ts >= end
// was seen (sorted input: stop).
function scan(b, from, upto, S, E) {
  let n = 0, i = from;
  while (i <= upto) {
    let nl = b.indexOf(10, i);
    if (nl < 0 || nl > upto) nl = upto;
    if (nl > i) {
      let sp = i; while (sp < nl && b[sp] !== 32) sp++;
      if (cmp(b, i, sp, E) >= 0) return -(n + 1);
      if (cmp(b, i, sp, S) >= 0) {
        // tokens: ts METHOD path status
        let a = sp, k = 0;
        while (k < 2 && a < nl) { a++; while (a < nl && b[a] !== 32) a++; k++; }
        if (k === 2 && a < nl) {
          const s0 = a + 1;
          let s1 = s0; while (s1 < nl && b[s1] !== 32) s1++;
          if (s1 - s0 === 3 && b[s0] === 53 && b[s0 + 1] === 48 && b[s0 + 2] === 48) n++;
        }
      }
    }
    i = nl + 1;
  }
  return n;
}

module.exports = function countErrors(buf, start, end) {
  // Guard: only the specialised path when its facts hold; otherwise the reference.
  if (typeof start !== "string" || typeof end !== "string" ||
      !/^[\x20-\x7e]*$/.test(start) || !/^[\x20-\x7e]*$/.test(end) ||
      buf.length < 18 || buf[0] !== 0x1f || buf[1] !== 0x8b || buf[2] !== 8) return slow(buf, start, end);
  try { return fast(buf, start, end); } catch (e) { return slow(buf, start, end); }
};
