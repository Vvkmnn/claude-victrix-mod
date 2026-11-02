const zlib = require("zlib");
module.exports = function countErrors(buf, start, end) {
  const text = zlib.gunzipSync(buf).toString("utf8");
  let n = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [ts, , , status] = line.split(" ");
    if (ts >= start && ts < end && status === "500") n++;
  }
  return n;
};
