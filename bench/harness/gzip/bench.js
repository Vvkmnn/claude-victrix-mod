const zlib=require('zlib'), fs=require('fs'), path=require('path');
const naive=require('/home/claude/v6/base/u1/solution.js');
const buf=fs.readFileSync('/home/claude/v6/base/u1/data/access.log.gz');
// ref A: full gunzip, byte scan (no string split)
function scanBytes(b, s, e, out){ let n=0,i=0; const L=b.length; const S=Buffer.from(s), E=Buffer.from(e);
  while(i<L){ let j=b.indexOf(10,i); if(j<0)j=L; if(j-i>=24){ const ts=b.subarray(i,i+24); if(Buffer.compare(ts,S)>=0&&Buffer.compare(ts,E)<0){ let k=b.indexOf(32,i+25); k=b.indexOf(32,k+1); if(b[k+1]===53&&b[k+2]===48&&b[k+3]===48&&b[k+4]===32) n++; } } i=j+1; } return n; }
function fullScan(b,s,e){ return scanBytes(zlib.gunzipSync(b),s,e); }
// ref B: gzip-member skip with guards (falls back to fullScan on any doubt)
function memberSkip(b,s,e){
  const offs=[]; for(let i=b.indexOf(0x1f); i>=0 && i+3<b.length; i=b.indexOf(0x1f,i+1)) if(b[i+1]===0x8b&&b[i+2]===8&&(b[i+3]&0xe0)===0) offs.push(i);
  if(offs[0]!==0) return fullScan(b,s,e);
  const firsts=[], good=[];
  for(const o of offs){ let head; try{ head=zlib.gunzipSync(b.subarray(o,Math.min(b.length,o+4096)),{finishFlush:zlib.constants.Z_SYNC_FLUSH}); }catch{ continue; }
    if(head.length>=24 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(head.subarray(0,24).toString())) { good.push(o); firsts.push(head.subarray(0,24).toString()); } }
  if(good.length<2) return fullScan(b,s,e);
  for(let i=1;i<firsts.length;i++) if(firsts[i]<firsts[i-1]) return fullScan(b,s,e);
  // decompress each candidate member exactly; verify it is a whole member ending where the next begins
  let lo=0; while(lo+1<good.length && firsts[lo+1]<=s) lo++;
  let hi=lo; while(hi+1<good.length && firsts[hi+1]<e) hi++;
  // a member may share its first timestamp with the previous one's tail; widen to be safe
  while(lo>0 && firsts[lo]>=s) lo--;
  let n=0;
  for(let m=lo;m<=hi;m++){ const end=m+1<good.length?good[m+1]:b.length; let out; try{ out=zlib.gunzipSync(b.subarray(good[m],end)); }catch{ return fullScan(b,s,e); } n+=scanBytes(out,s,e); }
  return n; }
// hidden tests
function gz(lines,opts){ return zlib.gzipSync(lines.join('\n')+(lines.length?'\n':''),opts); }
function mk(h0,count,step,rand){ const L=[]; let t=Date.UTC(2026,9,1)+h0*3600e3; for(let i=0;i<count;i++){ t+=step; L.push(new Date(t).toISOString()+' GET /x/'+i+' '+(rand()%3===0?500:200)+' 5ms'); } return L; }
let sd=3; const R=()=>(sd=(sd*1103515245+12345)%2147483648);
const cases=[]; const W=(a,b)=>[new Date(Date.UTC(2026,9,1)+a*3600e3).toISOString(),new Date(Date.UTC(2026,9,1)+b*3600e3).toISOString()];
cases.push([gz(mk(0,20000,300,R)),...W(1,2)]);                                   // single member
cases.push([Buffer.concat([0,1,2,3].map(h=>gz(mk(h,3000,1100,R)))),...W(1.5,2.5)]); // multi member
cases.push([Buffer.concat([0,1,2].map(h=>gz(mk(h,3000,1200,R)))),...W(0,9)]);      // whole range
cases.push([Buffer.concat([gz(mk(0,100,10,R)),gz([]),gz(mk(1,100,10,R))]),...W(0,2)]); // empty member
{ const hdr=zlib.gzipSync(mk(0,2000,1700,R).join('\n')+'\n'); const fake=Buffer.from([0x1f,0x8b,0x08,0x00,0,0,0,0,0,0x03]); // extra field carrying fake magic
  const L=[...mk(0,2000,1700,R)]; const withName=zlib.gzipSync(L.join('\n')+'\n'); cases.push([Buffer.concat([withName,fake,Buffer.alloc(0)]).subarray(0,withName.length),...W(0,1)]); cases.push([Buffer.concat([hdr,zlib.gzipSync(mk(1,2000,1700,R).join('\n')+'\n')]),...W(0.9,1.1)]); }
{ const same=mk(0,500,0,R); cases.push([Buffer.concat([gz(same.slice(0,250)),gz(same.slice(250))]),same[0].slice(0,24),new Date(Date.UTC(2026,9,1)+1).toISOString()]); } // equal timestamps across boundary
cases.push([Buffer.concat([0,1].map(h=>gz(mk(h,2000,1700,R),{level:1}))),...W(0.5,1.5)]); // other compression level
function check(f){ for(const [b,s,e] of cases){ if(f(b,s,e)!==naive(b,s,e)) return false; } return true; }
function tm(f,s,e){ f(buf,s,e); let best=1e18; for(let k=0;k<5;k++){ const a=process.hrtime.bigint(); f(buf,s,e); const d=Number(process.hrtime.bigint()-a)/1e6; if(d<best)best=d; } return best; }
const [S,E]=['2026-10-02T05:00:00.000Z','2026-10-02T06:00:00.000Z'];
for(const [n,f] of [['fullScan',fullScan],['memberSkip',memberSkip]]) if(!check(f)||f(buf,S,E)!==naive(buf,S,E)) throw new Error('ref broken: '+n);
const rows=[['ref: gunzip + split (naive)',tm(naive,S,E)],['ref: gunzip + byte scan',tm(fullScan,S,E)],['ref: gzip-member skip + guards',tm(memberSkip,S,E)]];
for(const p of process.argv.slice(2)){ const f=require(path.resolve(p)); const ok=check(f)&&f(buf,S,E)===naive(buf,S,E); if(!ok) console.log('WRONG',p); rows.push([p, ok?tm(f,S,E):Infinity]); }
rows.sort((a,b)=>a[1]-b[1]); for(const [n,v] of rows) console.log(v.toFixed(1).padStart(9)+' ms  '+n);
