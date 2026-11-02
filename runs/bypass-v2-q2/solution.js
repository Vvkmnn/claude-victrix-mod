function general(text) {
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.status === "ok") total += r.amount;
  }
  return total;
}

function eqAt(t, p, str) {
  for (let i = 0; i < str.length; i++) if (t.charCodeAt(p + i) !== str.charCodeAt(i)) return false;
  return true;
}

function sw(t, p, codes) {
  for (let i = 0; i < codes.length; i++) if (t.charCodeAt(p + i) !== codes[i]) return false;
  return true;
}
const K_ID = [...'{"id":'].map(x => x.charCodeAt(0));
const K_ST = [...',"status":"'].map(x => x.charCodeAt(0));
const K_AM = [...',"amount":'].map(x => x.charCodeAt(0));
const K_CU = [...',"currency":"'].map(x => x.charCodeAt(0));
const K_TS = [...'","ts":"'].map(x => x.charCodeAt(0));

function dig(t, p) { const c = t.charCodeAt(p); return c >= 48 && c <= 57; }

// Fast path: every line must be {"id":<digits>,"status":"<no-escape>","amount":<int>,...}. The tail is
// verified either against the exact observed shape (,"currency":"XXX","ts":"YYYY-MM-DDTHH:MM:SSZ"}) or
// by a per-char scan that bails on backslashes or repeated "status"/"amount" keys.
// Any deviation -> return undefined and the caller uses the general JSON.parse path.
function fast(t) {
  const n = t.length;
  let p = 0, total = 0;
  while (p < n) {
    let c = t.charCodeAt(p);
    if (c === 10) { p++; continue; }
    if (!sw(t, p, K_ID)) return;
    p += 6;
    let d = 0;
    while ((c = t.charCodeAt(p)) >= 48 && c <= 57) { p++; d++; }
    if (d === 0 || !sw(t, p, K_ST)) return;
    p += 11;
    let ok = false;
    if (t.charCodeAt(p) === 111 && t.charCodeAt(p + 1) === 107 && t.charCodeAt(p + 2) === 34) { ok = true; p += 3; }
    else {
      while ((c = t.charCodeAt(p)) !== 34) { if (c !== c || c === 92 || c === 10) return; p++; }
      p++;
    }
    if (!sw(t, p, K_AM)) return;
    p += 10;
    let neg = false;
    c = t.charCodeAt(p);
    if (c === 45) { neg = true; p++; c = t.charCodeAt(p); }
    let v = 0; d = 0;
    while (c >= 48 && c <= 57) { v = v * 10 + (c - 48); p++; d++; c = t.charCodeAt(p); }
    if (d === 0 || d > 10 || (c !== 44 && c !== 125)) return;
    if (ok) total += neg ? -v : v;
    // exact-shape tail
    if (c === 44 && sw(t, p, K_CU)) {
      const q = p + 13;
      const a0 = t.charCodeAt(q), a1 = t.charCodeAt(q + 1), a2 = t.charCodeAt(q + 2);
      if (a0 > 64 && a0 < 91 && a1 > 64 && a1 < 91 && a2 > 64 && a2 < 91 && sw(t, q + 3, K_TS)) {
        const r = q + 11;
        if (t.charCodeAt(r + 4) === 45 && t.charCodeAt(r + 7) === 45 && t.charCodeAt(r + 10) === 84 &&
            t.charCodeAt(r + 13) === 58 && t.charCodeAt(r + 16) === 58 && t.charCodeAt(r + 19) === 90 &&
            t.charCodeAt(r + 20) === 34 && t.charCodeAt(r + 21) === 125 &&
            dig(t, r) && dig(t, r + 1) && dig(t, r + 2) && dig(t, r + 3) && dig(t, r + 5) && dig(t, r + 6) &&
            dig(t, r + 8) && dig(t, r + 9) && dig(t, r + 11) && dig(t, r + 12) && dig(t, r + 14) &&
            dig(t, r + 15) && dig(t, r + 17) && dig(t, r + 18)) {
          c = t.charCodeAt(r + 22);
          if (c === 10) { p = r + 23; continue; }
          if (c !== c) { p = r + 22; continue; }
        }
      }
    }
    // generic tail scan
    while (p < n && (c = t.charCodeAt(p)) !== 10) {
      if (c === 92) return;
      if (c === 34) {
        const q = t.charCodeAt(p + 1);
        if ((q === 115 && eqAt(t, p, '"status"')) || (q === 97 && eqAt(t, p, '"amount"'))) return;
      }
      p++;
    }
  }
  return total;
}

module.exports = function sumOk(text) {
  const r = fast(text);
  return r === undefined ? general(text) : r;
};
