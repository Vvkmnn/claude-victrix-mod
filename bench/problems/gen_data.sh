#!/usr/bin/env bash
# Regenerates the deterministic datasets used by the experiments (they were too large to ship).
# Usage: bash gen_data.sh   (run from this problems/ folder; needs python3 and node)
set -euo pipefail
cd "$(dirname "$0")"

mkdir -p v2_base_q1/data && python3 - <<'E'
import random, datetime
random.seed(3); t=datetime.datetime(2026,3,1); lv=["INFO","WARN","ERROR","DEBUG"]
with open("v2_base_q1/data/app.log","w") as f:
    for i in range(1_500_000):
        t+=datetime.timedelta(seconds=random.choice([0,0,1,1,2,3]))
        f.write(f"{t:%Y-%m-%d %H:%M:%S} {random.choice(lv)} user={random.randint(1,99999)} req={i} took={random.randint(1,999)}ms\n")
E

mkdir -p v2_base_q2/data && node -e '
let s=5; const r=()=>(s=(s*1103515245+12345)%2147483648); const st=["ok","ok","ok","failed","pending"]; const out=[];
for(let i=0;i<1000000;i++){ out.push(JSON.stringify({id:i+1,status:st[r()%5],amount:r()%100000,currency:"AUD",ts:"2026-10-"+String(1+r()%28).padStart(2,"0")+"T10:00:00Z"})); }
require("fs").writeFileSync("v2_base_q2/data/events.ndjson", out.join("\n")+"\n");'

mkdir -p v2_base_q3/data && python3 - <<'E'
import random
random.seed(9); N=1_000_000
with open("v2_base_q3/data/accounts.tsv","w") as f:
    for i in range(N): f.write(f"u{i:07d}\t{random.randint(0,10**12)}\n")
with open("v2_base_q3/data/queries.txt","w") as f:
    for _ in range(2_000_000): f.write(f"u{random.randrange(N):07d}\n")
E

mkdir -p v2_base_q4/data && python3 - <<'E'
import random, array
random.seed(11)
open("v2_base_q4/data/readings.u32le","wb").write(array.array("I",(random.randint(0,59999) for _ in range(10_000_000))).tobytes())
E

mkdir -p v2_base_q5/data && python3 - <<'E'
import random, string
random.seed(13)
with open("v2_base_q5/data/orders.csv","w") as f:
    f.write("id,name,qty,price\n")
    for i in range(3_000_000):
        nm="".join(random.choice(string.ascii_lowercase) for _ in range(10))
        f.write(f"{i+1:08d},{nm},{random.randint(0,999):06d},{random.randint(0,99999):06d}\n")
E

mkdir -p v2_base_q6/data && python3 - <<'E'
import random, string
random.seed(17); U=string.ascii_uppercase
with open("v2_base_q6/data/ids.txt","w") as f:
    for _ in range(5_000_000):
        s="".join(random.choice(U) for _ in range(3))+"-"+f"{random.randint(0,999999):06d}"
        if random.random()<0.03:
            i=random.randrange(10); s=s[:i]+random.choice("a0Z-x9")+s[i+1:]
        f.write(s+"\n")
E

mkdir -p v6_base_u1/data && node -e '
const zlib=require("zlib"),fs=require("fs"); let s=7; const r=()=>(s=(s*1103515245+12345)%2147483648);
const parts=[]; const t0=Date.UTC(2026,9,1);
for(let h=0;h<48;h++){ const lines=[]; let t=t0+h*3600e3;
  for(let i=0;i<60000;i++){ t+=r()%120; const st=[200,200,200,200,304,404,500][r()%7];
    lines.push(new Date(t).toISOString()+" "+["GET","POST"][r()%2]+" /api/v1/item/"+(r()%100000)+" "+st+" "+(r()%900+10)+"ms"); }
  parts.push(zlib.gzipSync(lines.join("\n")+"\n",{level:6})); }
fs.writeFileSync("v6_base_u1/data/access.log.gz",Buffer.concat(parts));'

mkdir -p v7_base_u2/data && python3 - <<'E'
import random, struct
random.seed(21); t=1793491200000
with open("v7_base_u2/data/sensors.bin","wb") as f:
    buf=bytearray()
    for i in range(4_000_000):
        t+=random.choice([0,10,20,40,80]); buf+=struct.pack("<QIf",t,random.randint(1,64),random.gauss(20,5))
        if len(buf)>1<<20: f.write(buf); buf=bytearray()
    f.write(buf)
E
echo "done. The \$12 server challenge: git clone https://github.com/arjaythedev/twelve-dollar-server-challenge && bash seed/make-seed.sh"
