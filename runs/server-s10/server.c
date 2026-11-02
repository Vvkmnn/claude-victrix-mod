// Prototype: single-thread epoll HTTP/1.1 server + SQLite (direct, no nginx).
#define _GNU_SOURCE
#include <sqlite3.h>
#include <openssl/hmac.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <fcntl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <errno.h>
#include <signal.h>

static sqlite3 *db; static const char *secret; static time_t t0;
static sqlite3_stmt *st_feed, *st_feed_gen, *st_post, *st_ins, *st_exist, *st_like, *st_health;
static int fast_feed;           // guard: rowid order == (created_at,id) order
static long long last_ts_ms;    // monotonic clamp state is in DB (we read max row on insert)

typedef struct { int fd; char *wbuf; size_t wlen, woff; char rbuf[0]; } conn_t; // simplified below
typedef struct Conn { int fd; char *rb; size_t rn, rcap; char *wb; size_t wn, wo; } Conn;

static void die(const char*m){perror(m);exit(1);}
static void prep(sqlite3_stmt**s,const char*q){ if(sqlite3_prepare_v3(db,q,-1,SQLITE_PREPARE_PERSISTENT,s,0)){fprintf(stderr,"%s: %s\n",q,sqlite3_errmsg(db));exit(1);} }

#define POSTCOLS "p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id)"
static void init_db(void){
  if(sqlite3_open_v2(getenv("SQLITE_PATH"),&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,0)) die("open");
  sqlite3_busy_timeout(db,5000);
  sqlite3_exec(db,"PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA mmap_size=1073741824;PRAGMA cache_size=-100000;PRAGMA wal_autocheckpoint=4000;PRAGMA temp_store=MEMORY;",0,0,0);
  // startup guard: is rowid order identical to (created_at,id) order?
  sqlite3_stmt*c; prep(&c,"SELECT count(*) FROM (SELECT created_at ts, lag(created_at) OVER (ORDER BY id) pv FROM posts) WHERE pv>ts");
  sqlite3_step(c); fast_feed = sqlite3_column_int(c,0)==0; sqlite3_finalize(c);
  prep(&st_feed,"SELECT " POSTCOLS " FROM posts p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC LIMIT 20");
  prep(&st_feed_gen,"SELECT " POSTCOLS " FROM posts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC,p.id DESC LIMIT 20");
  prep(&st_post,"SELECT " POSTCOLS " FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?");
  // monotone clamp: created_at = max(now, last row's created_at) keeps rowid order == created_at order
  prep(&st_ins,"INSERT INTO posts (user_id,body,created_at) VALUES (?,?,max(strftime('%Y-%m-%dT%H:%M:%fZ','now'),(SELECT created_at FROM posts ORDER BY id DESC LIMIT 1))) RETURNING id,created_at");
  prep(&st_exist,"SELECT 1 FROM posts WHERE id=?");
  prep(&st_like,"INSERT INTO likes (user_id,post_id) VALUES (?,?) ON CONFLICT (user_id,post_id) DO NOTHING");
  prep(&st_health,"SELECT 1");
}

// ---- output buffer
typedef struct { char *p; size_t n, cap; } Buf;
static void bput(Buf*b,const char*s,size_t n){ if(b->n+n>b->cap){ while(b->n+n>b->cap) b->cap*=2; b->p=realloc(b->p,b->cap);} memcpy(b->p+b->n,s,n); b->n+=n; }
#define BS(b,s) bput(b,s,sizeof(s)-1)
static void bjson(Buf*b,const unsigned char*s,int n){
  bput(b,"\"",1); int st=0;
  for(int i=0;i<n;i++){ unsigned char c=s[i];
    if(c=='"'||c=='\\'||c<0x20){ if(i>st) bput(b,(char*)s+st,i-st); st=i+1;
      if(c=='"') BS(b,"\\\""); else if(c=='\\') BS(b,"\\\\"); else if(c=='\n') BS(b,"\\n"); else if(c=='\r') BS(b,"\\r"); else if(c=='\t') BS(b,"\\t");
      else { char t[8]; int l=snprintf(t,8,"\\u%04x",c); bput(b,t,l);} } }
  if(n>st) bput(b,(char*)s+st,n-st); bput(b,"\"",1);
}
static void post_row(Buf*b,sqlite3_stmt*s){
  char t[32]; int l=snprintf(t,32,"{\"id\":%lld,\"body\":",sqlite3_column_int64(s,0)); bput(b,t,l);
  bjson(b,sqlite3_column_text(s,1),sqlite3_column_bytes(s,1)); BS(b,",\"created_at\":");
  bjson(b,sqlite3_column_text(s,2),sqlite3_column_bytes(s,2)); BS(b,",\"author\":");
  bjson(b,sqlite3_column_text(s,3),sqlite3_column_bytes(s,3));
  l=snprintf(t,32,",\"like_count\":%lld}",sqlite3_column_int64(s,4)); bput(b,t,l);
}
static const char *reason(int c){ switch(c){case 200:return"OK";case 201:return"Created";case 400:return"Bad Request";case 401:return"Unauthorized";case 404:return"Not Found";case 503:return"Service Unavailable";default:return"Internal Server Error";} }
static void respond(Buf*out,int code,const char*body,size_t n){
  char h[160]; int l=snprintf(h,160,"HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n\r\n",code,reason(code),n);
  bput(out,h,l); bput(out,body,n);
}
static void err(Buf*out,int code,const char*m){ char t[128]; int l=snprintf(t,128,"{\"error\":\"%s\"}",m); respond(out,code,t,l); }

// ---- JWT
static int b64v(int c){ if(c>='A'&&c<='Z')return c-'A'; if(c>='a'&&c<='z')return c-'a'+26; if(c>='0'&&c<='9')return c-'0'+52; if(c=='-')return 62; if(c=='_')return 63; return -1; }
static int b64dec(const char*s,int n,unsigned char*o,int cap){ int bits=0,acc=0,w=0; for(int i=0;i<n;i++){ int v=b64v(s[i]); if(v<0) return -1; acc=(acc<<6)|v; bits+=6; if(bits>=8){ bits-=8; if(w>=cap) return -1; o[w++]=(acc>>bits)&255; } } return w; }
// minimal JSON helpers (flat object lookup of string/number)
static const char *jskip_ws(const char*p,const char*e){ while(p<e&&(*p==' '||*p=='\t'||*p=='\n'||*p=='\r')) p++; return p; }
static const char *jskip_val(const char*p,const char*e);
static const char *jskip_str(const char*p,const char*e){ if(p>=e||*p!='"') return 0; p++; while(p<e){ if(*p=='\\'){ p+=2; continue;} if((unsigned char)*p<0x20) return 0; if(*p=='"') return p+1; p++; } return 0; }
static const char *jskip_val(const char*p,const char*e){
  p=jskip_ws(p,e); if(p>=e) return 0;
  if(*p=='"') return jskip_str(p,e);
  if(*p=='{'||*p=='['){ char close=*p=='{'?'}':']'; int obj=*p=='{'; p=jskip_ws(p+1,e); if(p<e&&*p==close) return p+1;
    for(;;){ if(obj){ p=jskip_str(jskip_ws(p,e),e); if(!p) return 0; p=jskip_ws(p,e); if(p>=e||*p!=':') return 0; p++; }
      p=jskip_val(p,e); if(!p) return 0; p=jskip_ws(p,e); if(p>=e) return 0; if(*p==',') {p++; continue;} if(*p==close) return p+1; return 0; } }
  const char*q=p; while(q<e&&((*q>='0'&&*q<='9')||*q=='-'||*q=='+'||*q=='.'||*q=='e'||*q=='E'||(*q>='a'&&*q<='z'))) q++;
  if(q==p) return 0;
  if((q-p==4&&!memcmp(p,"true",4))||(q-p==5&&!memcmp(p,"false",5))||(q-p==4&&!memcmp(p,"null",4))) return q;
  // number grammar (loose but sufficient)
  const char*r=p; if(*r=='-') r++; if(r>=q||*r<'0'||*r>'9') return 0; return q;
}
// find key in top-level object; returns pointer to value start, sets *vend. returns 0 if absent, (void*)-1 if malformed
static const char *jget(const char*p,const char*e,const char*key,const char**vend){
  const char *found=0; size_t kl=strlen(key); p=jskip_ws(p,e);
  if(p>=e||*p!='{') return (void*)-1; p=jskip_ws(p+1,e); if(p<e&&*p=='}') { p++; goto done; }
  for(;;){ const char*ks=jskip_ws(p,e); const char*ke=jskip_str(ks,e); if(!ke) return (void*)-1; p=jskip_ws(ke,e); if(p>=e||*p!=':') return (void*)-1; p++;
    const char*vs=jskip_ws(p,e); const char*ve=jskip_val(vs,e); if(!ve) return (void*)-1;
    if((size_t)(ke-ks)==kl+2&&!memcmp(ks+1,key,kl)){ found=vs; *vend=ve; }
    p=jskip_ws(ve,e); if(p>=e) return (void*)-1; if(*p==','){p++;continue;} if(*p=='}'){p++;break;} return (void*)-1; }
done: p=jskip_ws(p,e); if(p!=e) return (void*)-1; return found;
}
// decode JSON string literal (with quotes) into out; returns length or -1
static int jdecode(const char*s,const char*e,char*out,int cap){
  int w=0; s++; e--; 
  while(s<e){ unsigned c=(unsigned char)*s++; 
    if(c!='\\'){ if(w>=cap) return -2; out[w++]=c; continue; }
    c=*s++; unsigned cp;
    switch(c){case'"':case'\\':case'/':cp=c;break;case'b':cp=8;break;case'f':cp=12;break;case'n':cp=10;break;case'r':cp=13;break;case't':cp=9;break;
      case'u':{ if(e-s<4) return -1; cp=0; for(int i=0;i<4;i++){ int d=*s++; cp<<=4; if(d>='0'&&d<='9')cp|=d-'0'; else if(d>='a'&&d<='f')cp|=d-'a'+10; else if(d>='A'&&d<='F')cp|=d-'A'+10; else return -1; }
        if(cp>=0xD800&&cp<0xDC00&&e-s>=6&&s[0]=='\\'&&s[1]=='u'){ unsigned lo=0; for(int i=0;i<4;i++){ int d=s[2+i]; lo<<=4; if(d>='0'&&d<='9')lo|=d-'0'; else if(d>='a'&&d<='f')lo|=d-'a'+10; else lo|=d-'A'+10; } if(lo>=0xDC00&&lo<0xE000){ cp=0x10000+((cp-0xD800)<<10)+(lo-0xDC00); s+=6; } }
        break; }
      default: return -1; }
    if(w+4>cap) return -2;
    if(cp<0x80) out[w++]=cp; else if(cp<0x800){ out[w++]=0xC0|(cp>>6); out[w++]=0x80|(cp&63);} else if(cp<0x10000){ out[w++]=0xE0|(cp>>12); out[w++]=0x80|((cp>>6)&63); out[w++]=0x80|(cp&63);} else { out[w++]=0xF0|(cp>>18); out[w++]=0x80|((cp>>12)&63); out[w++]=0x80|((cp>>6)&63); out[w++]=0x80|(cp&63);} }
  return w;
}
static int parse_uint(const char*s,size_t n,long long*o){ if(n==0||n>15) return 0; long long v=0; for(size_t i=0;i<n;i++){ if(s[i]<'0'||s[i]>'9') return 0; v=v*10+(s[i]-'0'); } if(v<=0) return 0; *o=v; return 1; }

// returns 0 ok (uid,uname set), else sets out error
static int auth(const char*hv,size_t hl,Buf*out,long long*uid,char*uname,int ucap){
  if(hl<7||memcmp(hv,"Bearer ",7)){ err(out,401,"missing bearer token"); return 0; }
  hv+=7; hl-=7;
  const char *d1=memchr(hv,'.',hl); const char*d2=d1?memchr(d1+1,'.',hl-(d1+1-hv)):0;
  if(!d1||!d2||memchr(d2+1,'.',hl-(d2+1-hv))) goto bad;
  { unsigned char mac[32]; unsigned ml=32; HMAC(EVP_sha256(),secret,strlen(secret),(const unsigned char*)hv,d2-hv,mac,&ml);
    unsigned char sig[64]; int sl=b64dec(d2+1,hl-(d2+1-hv),sig,64); if(sl!=32||CRYPTO_memcmp(sig,mac,32)) goto bad; }
  { unsigned char hj[256],pj[1024]; int hn=b64dec(hv,d1-hv,hj,256), pn=b64dec(d1+1,d2-d1-1,pj,1024); if(hn<0||pn<0) goto bad;
    const char*ve; const char*v=jget((char*)hj,(char*)hj+hn,"alg",&ve); if(v==(void*)-1||!v||ve-v!=7||memcmp(v,"\"HS256\"",7)) goto bad;
    const char*pe=(char*)pj+pn; v=jget((char*)pj,pe,"exp",&ve); if(v==(void*)-1) goto bad;
    if(v){ char t[40]; size_t l=ve-v; if(l>=40) goto bad; memcpy(t,v,l); t[l]=0; char*q; double ex=strtod(t,&q); if(*q||ex<=(double)time(0)) goto bad; }
    v=jget((char*)pj,pe,"sub",&ve); if(v==(void*)-1) goto bad;
    long long id; if(!v||*v!='"'||!parse_uint(v+1,ve-v-2,&id)){ err(out,401,"invalid token payload"); return 0; }
    v=jget((char*)pj,pe,"username",&ve); if(v==(void*)-1) goto bad;
    if(!v||*v!='"'){ err(out,401,"invalid token payload"); return 0; }
    int n=jdecode(v,ve,uname,ucap-1); if(n<0){ err(out,401,"invalid token payload"); return 0; } uname[n]=0; *uid=id; return 1; }
bad: err(out,401,"invalid or expired token"); return 0;
}

static int strict_id(const char*s,size_t n,long long*o){ return parse_uint(s,n,o); }
static int is_sp(int c){ return c==' '||c=='\t'||c=='\n'||c=='\r'||c=='\f'||c=='\v'; }

static void handle(Buf*out,const char*method,const char*path,size_t pl,const char*auth_h,size_t auth_l,const char*body,size_t bl){
  int get=!strcmp(method,"GET"), post=!strcmp(method,"POST");
  if(get&&pl==7&&!memcmp(path,"/health",7)){
    if(sqlite3_step(st_health)==SQLITE_ROW){ sqlite3_reset(st_health); char t[96]; int l=snprintf(t,96,"{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":%ld}",(long)(time(0)-t0)); respond(out,200,t,l); }
    else { sqlite3_reset(st_health); err(out,503,"x"); }
    return; }
  if(get&&pl==5&&!memcmp(path,"/feed",5)){
    sqlite3_stmt*s=fast_feed?st_feed:st_feed_gen; size_t h0=out->n; BS(out,"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 0000000\r\n\r\n"); size_t b0=out->n;
    BS(out,"{\"posts\":["); int first=1; while(sqlite3_step(s)==SQLITE_ROW){ if(!first) bput(out,",",1); first=0; post_row(out,s);} sqlite3_reset(s); BS(out,"]}");
    char t[8]; snprintf(t,8,"%07zu",out->n-b0); memcpy(out->p+h0+sizeof("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ")-1,t,7); return; }
  if(pl>7&&!memcmp(path,"/posts/",7)||(pl==6&&!memcmp(path,"/posts",6))){
    if(get&&pl>7){ long long id; if(!strict_id(path+7,pl-7,&id)){ err(out,400,"invalid post id"); return; }
      sqlite3_bind_int64(st_post,1,id); if(sqlite3_step(st_post)==SQLITE_ROW){ Buf b={malloc(1024),0,1024}; BS(&b,"{\"post\":"); post_row(&b,st_post); BS(&b,"}"); respond(out,200,b.p,b.n); free(b.p);} else err(out,404,"post not found"); sqlite3_reset(st_post); return; }
    if(post&&pl==6){
      long long uid; char un[256]; if(!auth(auth_h,auth_l,out,&uid,un,sizeof un)) return;
      const char*ve; const char*v=jget(body,body+bl,"body",&ve);
      if(v==(void*)-1){ err(out,400,"malformed JSON body"); return; }
      if(!v||*v!='"'){ err(out,400,"body is required"); return; }
      static char dec[16384]; int n=jdecode(v,ve,dec,sizeof dec); if(n==-2){ err(out,400,"body must be at most 500 characters"); return; } if(n<0){ err(out,400,"malformed JSON body"); return; }
      int a=0,z=n; while(a<z&&is_sp((unsigned char)dec[a])) a++; while(z>a&&is_sp((unsigned char)dec[z-1])) z--;
      if(z==a){ err(out,400,"body is required"); return; }
      int cps=0; for(int i=a;i<z;i++) if(((unsigned char)dec[i]&0xC0)!=0x80) cps++;
      if(cps>500){ err(out,400,"body must be at most 500 characters"); return; }
      sqlite3_bind_int64(st_ins,1,uid); sqlite3_bind_text(st_ins,2,dec+a,z-a,SQLITE_STATIC);
      if(sqlite3_step(st_ins)!=SQLITE_ROW){ sqlite3_reset(st_ins); err(out,500,"internal server error"); return; }
      Buf b={malloc(1024),0,1024}; char t[48]; int l=snprintf(t,48,"{\"post\":{\"id\":%lld,\"body\":",sqlite3_column_int64(st_ins,0)); bput(&b,t,l);
      bjson(&b,(unsigned char*)dec+a,z-a); BS(&b,",\"created_at\":"); bjson(&b,sqlite3_column_text(st_ins,1),sqlite3_column_bytes(st_ins,1)); BS(&b,",\"author\":"); bjson(&b,(unsigned char*)un,strlen(un)); BS(&b,",\"like_count\":0}}");
      sqlite3_reset(st_ins); respond(out,201,b.p,b.n); free(b.p); return; }
    const char*sl=pl>7?memchr(path+7,'/',pl-7):0;
    if(post&&sl&&(size_t)(path+pl-sl)==5&&!memcmp(sl,"/like",5)){
      long long uid; char un[256]; if(!auth(auth_h,auth_l,out,&uid,un,sizeof un)) return;
      long long id; if(!strict_id(path+7,sl-(path+7),&id)){ err(out,400,"invalid post id"); return; }
      sqlite3_bind_int64(st_exist,1,id); int ex=sqlite3_step(st_exist)==SQLITE_ROW; sqlite3_reset(st_exist); if(!ex){ err(out,404,"post not found"); return; }
      sqlite3_bind_int64(st_like,1,uid); sqlite3_bind_int64(st_like,2,id); int rc=sqlite3_step(st_like); sqlite3_reset(st_like);
      if(rc!=SQLITE_DONE){ err(out,500,"internal server error"); return; }
      int fresh=sqlite3_changes(db)>0; char t[96]; int l=snprintf(t,96,"{\"liked\":true,\"already_liked\":%s,\"post_id\":%lld}",fresh?"false":"true",id); respond(out,fresh?201:200,t,l); return; }
  }
  err(out,404,"not found");
}

// parse one request from rb[0..rn); return consumed bytes, 0 if incomplete, -1 on bad
static long parse_req(Conn*c,Buf*out,int*close_after){
  char*b=c->rb; size_t n=c->rn; char*he=memmem(b,n,"\r\n\r\n",4); if(!he) return n>16384?-1:0;
  size_t hl=he+4-b; b[hl-2]=0; // terminate headers
  char*sp1=memchr(b,' ',hl); if(!sp1) return -1; *sp1=0; char*path=sp1+1; char*sp2=memchr(path,' ',hl-(path-b)); if(!sp2) return -1; *sp2=0;
  char*q=memchr(path,'?',sp2-path); size_t pl=(q?q:sp2)-path;
  const char*auth_h=0; size_t auth_l=0; size_t clen=0; *close_after=0;
  char*ln=strchr(sp2+1,'\n'); 
  while(ln&&ln+1<b+hl){ char*s=ln+1; char*e=strchr(s,'\r'); if(!e) break; 
    if(e-s>15&&!strncasecmp(s,"content-length:",15)){ clen=strtoul(s+15,0,10); }
    else if(e-s>14&&!strncasecmp(s,"authorization:",14)){ s+=14; while(*s==' ') s++; auth_h=s; auth_l=e-s; }
    else if(e-s>=17&&!strncasecmp(s,"connection: close",17)) *close_after=1;
    ln=e+1; }
  if(clen>16384) return -1;
  if(n<hl+clen) return 0;
  handle(out,b,path,pl,auth_h,auth_l,b+hl,clen);
  return hl+clen;
}

static void cclose(int ep,Conn*c){ epoll_ctl(ep,EPOLL_CTL_DEL,c->fd,0); close(c->fd); free(c->rb); free(c->wb); free(c); }
static int flush(int ep,Conn*c){
  while(c->wo<c->wn){ ssize_t w=send(c->fd,c->wb+c->wo,c->wn-c->wo,MSG_NOSIGNAL); if(w<0){ if(errno==EAGAIN){ struct epoll_event ev={.events=EPOLLIN|EPOLLOUT,.data.ptr=c}; epoll_ctl(ep,EPOLL_CTL_MOD,c->fd,&ev); return 1;} return -1; } c->wo+=w; }
  c->wn=c->wo=0; return 0;
}
int main(void){
  signal(SIGPIPE,SIG_IGN); t0=time(0); secret=getenv("JWT_SECRET"); init_db();
  const char*host=getenv("HOST"); int port=atoi(getenv("PORT")?getenv("PORT"):"3000");
  int ls=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK,0); int one=1; setsockopt(ls,SOL_SOCKET,SO_REUSEADDR,&one,4);
  struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(port)}; inet_pton(AF_INET,host?host:"0.0.0.0",&a.sin_addr);
  if(bind(ls,(void*)&a,sizeof a)) die("bind"); listen(ls,4096);
  int ep=epoll_create1(0); struct epoll_event ev={.events=EPOLLIN,.data.ptr=0}; epoll_ctl(ep,EPOLL_CTL_ADD,ls,&ev);
  struct epoll_event evs[256]; static char shared[32768]; Buf out={malloc(65536),0,65536};
  fprintf(stderr,"listening %d fast_feed=%d\n",port,fast_feed);
  for(;;){ int n=epoll_wait(ep,evs,256,-1);
    for(int i=0;i<n;i++){ Conn*c=evs[i].data.ptr;
      if(!c){ for(;;){ int fd=accept4(ls,0,0,SOCK_NONBLOCK); if(fd<0) break; setsockopt(fd,IPPROTO_TCP,TCP_NODELAY,&one,4);
          Conn*nc=calloc(1,sizeof(Conn)); nc->fd=fd; struct epoll_event e={.events=EPOLLIN,.data.ptr=nc}; epoll_ctl(ep,EPOLL_CTL_ADD,fd,&e);} continue; }
      if(evs[i].events&EPOLLOUT){ int f=flush(ep,c); if(f<0){ cclose(ep,c); continue;} if(f==0){ struct epoll_event e={.events=EPOLLIN,.data.ptr=c}; epoll_ctl(ep,EPOLL_CTL_MOD,c->fd,&e);} }
      if(!(evs[i].events&(EPOLLIN|EPOLLHUP|EPOLLERR))) continue;
      // read into shared buffer if no partial state, else append to conn buffer
      ssize_t r; if(c->rn==0){ r=recv(c->fd,shared,sizeof shared-1,0); } else { if(c->rcap-c->rn<4096){ c->rcap=c->rcap*2+4096; c->rb=realloc(c->rb,c->rcap);} r=recv(c->fd,c->rb+c->rn,c->rcap-c->rn-1,0); }
      if(r==0||(r<0&&errno!=EAGAIN)){ cclose(ep,c); continue; } if(r<0) continue;
      char*base; size_t len;
      if(c->rn==0){ base=shared; len=r; } else { c->rn+=r; base=c->rb; len=c->rn; }
      // parse using temporary Conn view
      Conn view=*c; view.rb=base; view.rn=len; size_t off=0; int bad=0,closeit=0; out.n=0;
      while(off<len){ view.rb=base+off; view.rn=len-off; int ca; long used=parse_req(&view,&out,&ca); if(used<0){ bad=1; break;} if(used==0) break; off+=used; if(ca){closeit=1;break;} }
      if(bad){ cclose(ep,c); continue; }
      if(off<len){ size_t rest=len-off; if(base==shared){ if(c->rcap<rest+1){ c->rcap=rest*2+4096; c->rb=realloc(c->rb,c->rcap);} memcpy(c->rb,base+off,rest);} else memmove(c->rb,base+off,rest); c->rn=rest; } else c->rn=0;
      if(out.n){ if(c->wn==0){ ssize_t w=send(c->fd,out.p,out.n,MSG_NOSIGNAL); if(w<0&&errno!=EAGAIN){ cclose(ep,c); continue;} if(w<0) w=0; if((size_t)w<out.n){ size_t rem=out.n-w; c->wb=realloc(c->wb,rem); memcpy(c->wb,out.p+w,rem); c->wn=rem; c->wo=0; struct epoll_event e={.events=EPOLLIN|EPOLLOUT,.data.ptr=c}; epoll_ctl(ep,EPOLL_CTL_MOD,c->fd,&e);} }
        else { c->wb=realloc(c->wb,c->wn+out.n); memcpy(c->wb+c->wn,out.p,out.n); c->wn+=out.n; } }
      if(closeit&&c->wn==0) cclose(ep,c);
    } }
}
