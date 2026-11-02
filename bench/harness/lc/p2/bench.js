const refs = require('./refs.js'); const path = require('path');
function rng(s){return()=>{s=(s*1103515245+12345)%2147483648;return s;}}
function brute(h){let b=0;for(let i=0;i<h.length;i++)for(let j=i+1;j<h.length;j++)b=Math.max(b,(j-i)*Math.min(h[i],h[j]));return b;}
function correct(f){ const r=rng(7); for(let t=0;t<3000;t++){const n=r()%25, mx=[1,2,10,10000][t%4]; const h=Array.from({length:n},()=>r()%(mx+1)); if(f(h)!==brute(h)) return false;} 
  const big=Array.from({length:200000},(_, k)=>k%2?10000:0); if(f(big)!==refs['two-pointer (classic)'](big)) return false; return true; }
const inputs=[]; for(let s=1;s<=5;s++){const r=rng(s); inputs.push(Array.from({length:1e6},()=>r()%10001));}
// adversarial-ish: ascending then descending (pointers can't stop early), and all-equal
inputs.push(Array.from({length:1e6},(_,k)=>Math.min(k,1e6-1-k)%10001)); inputs.push(new Array(1e6).fill(5000));
function t(f){ for(const h of inputs) f(h); let best=1e9; for(let rep=0;rep<5;rep++){const a=process.hrtime.bigint(); for(const h of inputs) f(h); const d=Number(process.hrtime.bigint()-a)/1e6; if(d<best)best=d;} return best; }
const rows = Object.entries(refs).map(([k,f])=>[k,t(f)]);
for (const p of process.argv.slice(2)) { const f=require(path.resolve(p)); rows.push([p, correct(f)? t(f) : Infinity]); }
rows.sort((a,b)=>a[1]-b[1]); for (const [k,v] of rows) console.log(v.toFixed(2).padStart(10)+' ms  '+k);
