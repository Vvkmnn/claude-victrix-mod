module.exports = function sumOk(text) {
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const r = JSON.parse(line);
    if (r.status === "ok") total += r.amount;
  }
  return total;
};
