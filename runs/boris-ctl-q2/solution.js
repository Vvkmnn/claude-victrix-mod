"use strict";
let AMT = 0; // amount to add for the last parsed line (0 if not ok)
// Parse one line starting at i (text[i] is not "\n"). Returns index just past the
// line's terminating "\n" (or n), or -1 if the line must go through JSON.parse.
function line(text, i, n) {
  let c = text.charCodeAt(i);
  if (c !== 123) return -1;
  i++;
  let ok = false, amt = 0;
  for (;;) {
    if (text.charCodeAt(i) !== 34) return -1;
    const ks = ++i;
    for (;;) {
      c = text.charCodeAt(i);
      if (c === 34) break;
      if (c === 92 || i >= n) return -1;
      i++;
    }
    const kl = i - ks;
    i++;
    if (text.charCodeAt(i) !== 58) return -1;
    i++;
    c = text.charCodeAt(i);
    let kind = 0; // 1 status, 2 amount
    if (kl === 6) {
      const k0 = text.charCodeAt(ks);
      if (k0 === 115) {
        if (text.charCodeAt(ks + 1) === 116 && text.charCodeAt(ks + 2) === 97 && text.charCodeAt(ks + 3) === 116 &&
            text.charCodeAt(ks + 4) === 117 && text.charCodeAt(ks + 5) === 115) kind = 1;
      } else if (k0 === 97) {
        if (text.charCodeAt(ks + 1) === 109 && text.charCodeAt(ks + 2) === 111 && text.charCodeAt(ks + 3) === 117 &&
            text.charCodeAt(ks + 4) === 110 && text.charCodeAt(ks + 5) === 116) kind = 2;
      }
    }
    if (c === 34) {
      const vs = ++i;
      for (;;) {
        c = text.charCodeAt(i);
        if (c === 34) break;
        if (c === 92 || i >= n) return -1;
        i++;
      }
      if (kind === 1) ok = (i - vs === 2 && text.charCodeAt(vs) === 111 && text.charCodeAt(vs + 1) === 107);
      else if (kind === 2) return -1;
      i++;
    } else if (c === 45 || (c >= 48 && c <= 57)) {
      let neg = false;
      if (c === 45) { neg = true; i++; c = text.charCodeAt(i); }
      if (!(c >= 48 && c <= 57)) return -1;
      let v = 0;
      if (c === 48) i++;
      else do { v = v * 10 + (c - 48); i++; c = text.charCodeAt(i); } while (c >= 48 && c <= 57);
      c = text.charCodeAt(i);
      if (c === 46 || c === 101 || c === 69 || (c >= 48 && c <= 57)) return -1;
      if (kind === 1) ok = false;
      else if (kind === 2) amt = neg ? -v : v;
    } else if (c === 116 || c === 102 || c === 110) {
      if (kind !== 0) return -1;
      i += c === 102 ? 5 : 4;
    } else return -1;
    c = text.charCodeAt(i);
    if (c === 44) { i++; continue; }
    if (c === 125) { i++; break; }
    return -1;
  }
  if (i >= n) { AMT = ok ? amt : 0; return n; }
  if (text.charCodeAt(i) !== 10) return -1;
  AMT = ok ? amt : 0;
  return i + 1;
}


// Fast path: native indexOf scans, O(1) JS work per line.
// Preconditions: the text has no backslash, so strings contain no escapes and
// the only quotes inside a line are string delimiters. Under that, an occurrence
// of the substring "status" (resp. "mount") can only be a key/value/other string
// text; the top-level key "status" (resp. "amount") necessarily produces one.
// We require exactly one occurrence per line, then check it is literally the
// key `"status":` / `"amount":`; hence it IS the (unique, top-level) key and no
// duplicate or nested copy exists. Anything else => return null (generic path).
function fast(t, n) {
  let total = 0, pos = 0;
  let p = t.indexOf("status");
  let a = -1; // cached next "mount" hit; stale (< pos) means "search again"
  while (pos < n) {
    let nl = t.indexOf("\n", pos);
    if (nl < 0) nl = n;
    if (nl === pos) { pos++; continue; }
    if (p < 0 || p > nl) return null;
    // "status": and "amount":
    if (t.charCodeAt(p - 1) !== 34 || t.charCodeAt(p + 6) !== 34 || t.charCodeAt(p + 7) !== 58) return null;
    let c = t.charCodeAt(p + 8);
    if (c === 34) {
      if (t.charCodeAt(p + 9) === 111 && t.charCodeAt(p + 10) === 107 && t.charCodeAt(p + 11) === 34) {
        // ok line: need its unique "amount" key
        if (a < pos) a = t.indexOf("mount", pos);
        if (a < 0 || a > nl) return null;
        if (t.charCodeAt(a - 2) !== 34 || t.charCodeAt(a - 1) !== 97 || t.charCodeAt(a + 5) !== 34 || t.charCodeAt(a + 6) !== 58) return null;
        let w = a + 7;
        c = t.charCodeAt(w);
        let neg = false;
        if (c === 45) { neg = true; w++; c = t.charCodeAt(w); }
        if (!(c >= 48 && c <= 57)) return null;
        let v = 0;
        do { v = v * 10 + (c - 48); w++; c = t.charCodeAt(w); } while (c >= 48 && c <= 57);
        if (c !== 44 && c !== 125) return null;
        total += neg ? -v : v;
        a = t.indexOf("mount", a + 1);
        if (a !== -1 && a < nl) return null;
      }
    } else if (!(c === 45 || (c >= 48 && c <= 57) || c === 116 || c === 102 || c === 110)) return null;
    const np = t.indexOf("status", p + 1);
    if (np !== -1 && np < nl) return null;
    p = np;
    pos = nl + 1;
  }
  return total;
}

module.exports = function sumOk(text) {
  const n = text.length;
  if (text.indexOf("\\") < 0) {
    const r = fast(text, n);
    if (r !== null) return r;
  }
  return generic(text, n);
};

function generic(text, n) {
  let total = 0;
  let i = 0;
  while (i < n) {
    if (text.charCodeAt(i) === 10) { i++; continue; }
    const j = line(text, i, n);
    if (j >= 0) { total += AMT; i = j; }
    else {
      let e = text.indexOf("\n", i);
      if (e < 0) e = n;
      const r = JSON.parse(text.substring(i, e));
      if (r.status === "ok") total += r.amount;
      i = e + 1;
    }
  }
  return total;
}
