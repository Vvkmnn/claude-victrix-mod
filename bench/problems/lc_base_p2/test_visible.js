const f = require('./solution.js');
const cases = [[[1,8,6,2,5,4,8,3,7],49],[[1,1],1],[[],0],[[5],0],[[4,3,2,1,4],16],[[1,2,1],2]];
for (const [h, w] of cases) { const g = f(h); if (g !== w) throw new Error(JSON.stringify({h, g, w})); }
console.log('visible tests passed');
