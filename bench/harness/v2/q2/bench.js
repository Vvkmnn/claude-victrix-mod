const fs=require('fs'), path=require('path');
const naive=require('/home/claude/v2/base/q2/solution.js');
const text=fs.readFileSync('/home/claude/v2/base/q2/data/events.ndjson','utf8');
function fast(t){ // fixed-layout fast path + per-line fallback
  let tot=0,i=0,n=t.length; const P='{"id":', S=',"status":"', A='","amount":';
  while(i<n){ let e=t.indexOf('\n',i); if(e<0)e=n; if(e===i){i++;continue;}
    let ok=t.startsWith(P,i); let j=i+6; if(ok){ while(j<e){const c=t.charCodeAt(j); if(c<48||c>57)break; j++;} ok=t.startsWith(S,j); }
    if(ok){ j+=11; const s0=j; while(j<e&&t.charCodeAt(j)!==34&&t.charCodeAt(j)!==92)j++; const isOk=(j-s0===2&&t.charCodeAt(s0)===111&&t.charCodeAt(s0+1)===107); ok=t.charCodeAt(j)===34&&t.startsWith(A,j);
      if(ok){ j+=11; let neg=false; if(t.charCodeAt(j)===45){neg=true;j++;} let v=0,d=0; while(j<e){const c=t.charCodeAt(j); if(c<48||c>57)break; v=v*10+(c-48); j++; d++;}
        const tail=t.slice(j,e); ok=d>0&&d<11&&(tail==='}'||(tail.charCodeAt(0)===44&&tail.indexOf('"status"')<0&&tail.indexOf('"amount"')<0&&tail.indexOf('\\')<0&&tail.indexOf('{',1)<0&&tail.endsWith('}')));
        if(ok){ if(isOk) tot+=neg?-v:v; i=e+1; continue; } } }
    const r=JSON.parse(t.slice(i,e)); if(r.status==='ok') tot+=r.amount; i=e+1; }
  return tot; }
const hidden=[
 '{"status":"ok","amount":5,"id":1}\n{"amount":7,"status":"ok"}\n',
 '{"id":1, "status": "ok", "amount": 5}\n{ "id":2,"status":"ok","amount":3 }\n',
 '{"id":1,"status":"o\\u006b","amount":5}\n{"id":2,"status":"ok\\"","amount":9}\n',
 '{"id":1,"status":"failed","amount":5,"status":"ok"}\n{"id":2,"status":"ok","amount":5,"amount":11}\n',
 '{"id":1,"status":"failed","amount":5,"note":{"status":"ok","amount":99}}\n',
 '{"id":1,"status":"ok","amount":-2147483647,"currency":"AUD","ts":"x"}\r\n{"id":2,"status":"ok","amount":2147483647}',
 '\n\n{"id":1,"status":"ok","amount":0}\n\n', '', '{"id":1,"status":"OK","amount":5}\n{"id":2,"status":"ok ","amount":5}\n',
 '{"id":1,"status":"ok","amount":5,"currency":"A\\"UD","ts":"z"}\n{"id":2,"status":"ok","amount":1e2}\n'];
function check(f){ for(const h of hidden){ let w; try{w=naive(h);}catch(e){continue;} if(f(h)!==w){ return false;} } return f(text)===naive(text); }
function tm(f){ f(text); let b=1e18; for(let k=0;k<5;k++){const a=process.hrtime.bigint(); f(text); const d=Number(process.hrtime.bigint()-a)/1e6; if(d<b)b=d;} return b; }
if(!check(fast)) throw new Error('ref broken');
const rows=[['ref: split + JSON.parse',tm(naive)],['ref: fixed-layout scan + per-line fallback',tm(fast)]];
for(const p of process.argv.slice(2)){ const f=require(path.resolve(p)); const ok=check(f); if(!ok) console.log('WRONG',p); rows.push([p, ok?tm(f):Infinity]); }
rows.sort((a,b)=>a[1]-b[1]); for(const [n,v] of rows) console.log(v.toFixed(1).padStart(9)+' ms  '+n);
