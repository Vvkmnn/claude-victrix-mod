import os, subprocess, sys, time, shutil, tempfile, http.client
root='/home/claude/srv'
def cpu(pgid):
    out=subprocess.run(['ps','-o','times=','-g',str(pgid)],capture_output=True,text=True).stdout.split()
    return sum(int(x) for x in out)  # seconds (coarse)
def cpu_ticks(pgid):
    t=0
    for pid in os.listdir('/proc'):
        if not pid.isdigit(): continue
        try:
            st=open(f'/proc/{pid}/stat').read().rsplit(')',1)[1].split()
            if int(st[2])==pgid: t+=int(st[11])+int(st[12])
        except Exception: pass
    return t/os.sysconf('SC_CLK_TCK')
for i,r in enumerate(sys.argv[1:]):
    sub=os.listdir(f'{root}/{r}/submissions')[0]; sd=f'{root}/{r}/submissions/{sub}'
    subprocess.run(['bash',f'{sd}/build.sh'],check=True,capture_output=True)
    t=tempfile.mkdtemp(); db=f'{t}/feed.db'; shutil.copy(f'{root}/s24/seed/feed.db',db)
    port=3600+i; env=dict(os.environ,JWT_SECRET='twelve-dollar-challenge',HOST='127.0.0.1',PORT=str(port),SQLITE_PATH=db)
    p=subprocess.Popen(['bash',f'{sd}/start.sh'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
    for _ in range(60):
        try: c=http.client.HTTPConnection('127.0.0.1',port,timeout=5); c.request('GET','/health'); c.getresponse().read(); break
        except Exception: time.sleep(1)
    res=[]
    for path in ['/feed','/posts/123456']:
        for _ in range(500): c.request('GET',path); c.getresponse().read()
        a=cpu_ticks(p.pid); n=20000
        for _ in range(n): c.request('GET',path); c.getresponse().read()
        res.append(f'{path} {1e6*(cpu_ticks(p.pid)-a)/n:.1f}us')
    print(r,sub,*res, flush=True)
    os.killpg(p.pid,9)
