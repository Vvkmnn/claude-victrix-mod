const f = require("./solution.js");
const t = '{"id":1,"status":"ok","amount":5}\n{"id":2,"status":"failed","amount":7}\n{"id":3,"status":"ok","amount":-2}\n';
if (f(t) !== 3) throw new Error("case 1"); if (f("") !== 0) throw new Error("case 2");
console.log("visible tests passed");
