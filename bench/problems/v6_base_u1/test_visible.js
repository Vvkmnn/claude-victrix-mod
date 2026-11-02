const zlib = require("zlib"); const f = require("./solution.js");
const log = ["2026-10-01T00:00:00.000Z GET /a 500 10ms","2026-10-01T00:30:00.000Z GET /b 200 10ms","2026-10-01T01:00:00.000Z POST /c 500 12ms"].join("\n")+"\n";
const g = zlib.gzipSync(log);
if (f(g,"2026-10-01T00:00:00.000Z","2026-10-01T01:00:00.000Z") !== 1) throw new Error("case 1");
if (f(g,"2026-10-01T00:00:00.000Z","2026-10-02T00:00:00.000Z") !== 2) throw new Error("case 2");
console.log("visible tests passed");
