"use strict";
// Obvious version (reference semantics, also the guarded fallback).
function slowLine(line) {
  const r = JSON.parse(line);
  return r.status === "ok" ? r.amount : 0;
}
function slow(text) {
  let total = 0;
  for (const line of text.split("\n")) {
    if (line) total += slowLine(line);
  }
  return total;
}

const STR = '"[^"\\\\\\n]*"';
const GEN = '(?:"[^"\\\\\\n]*"|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?|true|false|null)';

// Learn the line layout (key order) from the first non-empty line and compile one sticky regex that
// matches a COMPLETE line of that exact layout: flat object, distinct keys, no whitespace, no escapes.
// A line matching it is therefore provably flat with exactly one status and one amount key.
function compile(text) {
  let s = 0;
  while (text.charCodeAt(s) === 10) s++;
  let e = text.indexOf("\n", s);
  if (e === -1) e = text.length;
  const line = text.slice(s, e);
  const kv = /"([^"\\]*)":("[^"\\]*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)([,}])/y;
  if (line.charCodeAt(0) !== 123) return null;
  let p = 1, seen = new Set(), si = false, ai = false;
  const parts = []; // [prefix-literal-or-null, kind] per key, in order
  for (;;) {
    kv.lastIndex = p;
    const m = kv.exec(line);
    if (m === null) return null;
    const k = m[1];
    if (seen.has(k)) return null;
    seen.add(k);
    let kind;
    if (k === "status") { kind = "S"; si = true; }
    else if (k === "amount") { kind = "A"; ai = true; }
    else if (m[2].charCodeAt(0) === 34) kind = STR; // same type as first line; other shapes take the per-line path
    else if (/^-?\d+$/.test(m[2])) kind = "-?\\d+";
    else kind = GEN;
    parts.push([k.replace(/[\\^$.*+?()[\]{}|\/-]/g, "\\$&"), kind]);
    p = kv.lastIndex;
    if (m[3] === "}") break;
  }
  if (p !== line.length || !si || !ai) return null;
  const build = (sv, av) => "\\{" + parts.map(([k, kind]) => '"' + k + '":' + (kind === "S" ? sv : kind === "A" ? av : kind)).join(",") + "\\}(?:\\n|$)";
  const okLine = build('"ok"', "(-?\\d+)");
  const notOk = build('"(?!ok")[^"\\\\\\n]*"', "-?\\d+");
  const anyLine = build('"([^"\\\\\\n]*)"', "(-?\\d+)");
  // bulk: any run of non-ok lines, then one ok line (amount captured) or end of input
  return {
    bulk: new RegExp("(?:" + notOk.replace("(?:\\n|$)", "\\n") + ")*(?:" + okLine + "|$)", "y"),
    one: new RegExp(anyLine, "y"),
  };
}

module.exports = function sumOk(text) {
  const n = text.length;
  if (n === 0) return 0;
  const c = compile(text);
  if (c === null) return slow(text);
  const { bulk, one } = c;
  let total = 0, pos = 0;
  while (pos < n) {
    bulk.lastIndex = pos;
    const m = bulk.exec(text);
    if (m !== null) {
      if (m[1] !== undefined) total += +m[1];
      pos = bulk.lastIndex;
      continue;
    }
    // A line in the upcoming run deviates from the learned layout (or is blank): walk it line by line,
    // using the obvious JSON.parse only for the deviating line, then resume bulk mode after it.
    for (;;) {
      one.lastIndex = pos;
      const r = one.exec(text);
      if (r !== null) {
        if (r[1] === "ok") total += +r[2];
        pos = one.lastIndex;
        if (pos >= n) break;
        continue;
      }
      let e = text.indexOf("\n", pos);
      if (e === -1) e = n;
      if (e > pos) total += slowLine(text.slice(pos, e));
      pos = e + 1;
      break;
    }
  }
  return total;
};
