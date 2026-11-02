import json, os, random, subprocess, sys, time, shutil, tempfile, http.client
root='/home/claude/srv'
runs=sys.argv[1:]  # e.g. s28 s22 s23 s24  (first = SQL reference)
toks=json.load(open(f'{root}/s24/seed/tokens.json'))[:200]
procs=[]; ports={}
for i,r in enumerate(runs):
    sub=[d for d in os.listdir(f'{root}/{r}/submissions')][0]; sd=f'{root}/{r}/submissions/{sub}'
    subprocess.run(['bash',f'{sd}/build.sh'],check=True,capture_output=True)
    t=tempfile.mkdtemp(); db=f'{t}/feed.db'; shutil.copy(f'{root}/s24/seed/feed.db',db)
    port=3500+i; env=dict(os.environ,JWT_SECRET='twelve-dollar-challenge',HOST='127.0.0.1',PORT=str(port),SQLITE_PATH=db)
    procs.append(subprocess.Popen(['bash',f'{sd}/start.sh'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)); ports[r]=port
time.sleep(2)
for r,p in ports.items():
    for _ in range(60):
        try:
            c=http.client.HTTPConnection('127.0.0.1',p,timeout=5); c.request('GET','/health'); c.getresponse().read(); break
        except Exception: time.sleep(1)
conns={r:http.client.HTTPConnection('127.0.0.1',p,timeout=10) for r,p in ports.items()}
def req(r,m,path,body=None,tok=None):
    h={'Content-Type':'application/json'}
    if tok: h['Authorization']='Bearer '+tok
    for a in range(2):
        try:
            conns[r].request(m,path,body=body,headers=h); x=conns[r].getresponse(); return x.status,x.read()
        except Exception:
            conns[r]=http.client.HTTPConnection('127.0.0.1',ports[r],timeout=10)
    return -1,b''
def norm(b):
    try: j=json.loads(b)
    except Exception: return b
    def s(o):
        if isinstance(o,dict): return {k:s(v) for k,v in o.items() if k not in('created_at','uptime_s')}
        if isinstance(o,list): return [s(v) for v in o]
        return o
    return s(j)
rnd=random.Random(int(os.environ.get('SEED','1'))); mism=0; N=int(os.environ.get('N','3000')); maxid=None
bodies=['hi','  pad  ','é ünïcode 🙂','"quotes" \\ back','x'*500,'x'*501,'','   ','line\nbreak','<b>&amp;']
for i in range(N):
    k=rnd.random(); tok=rnd.choice(toks)['token']
    if k<0.35: m,p,b,t='GET','/feed',None,None
    elif k<0.6: m,p,b,t='GET',f'/posts/{rnd.choice([rnd.randint(1,1000),rnd.randint(1,2_000_000),0,-1,"abc"])}',None,None
    elif k<0.8: m,p,b,t='POST','/posts',json.dumps({'body':rnd.choice(bodies)}),tok
    else: m,p,b,t='POST',f'/posts/{rnd.randint(1,1500000)}/like',None,rnd.choice([tok,None])
    res={r:req(r,m,p,b,t) for r in runs}
    ref=res[runs[0]]
    for r in runs[1:]:
        if res[r][0]!=ref[0] or norm(res[r][1])!=norm(ref[1]):
            mism+=1
            if mism<=5: print('MISMATCH',r,m,p,ref[0],res[r][0],str(ref[1])[:120],'|',str(res[r][1])[:120])
print('ops',N,'mismatches',mism)
for pr in procs:
    try: os.killpg(pr.pid,9)
    except Exception: pass
