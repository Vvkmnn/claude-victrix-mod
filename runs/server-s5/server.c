// Anka prototype: single-thread epoll HTTP/1.1 server, SQLite in-process, hand-rolled JSON.
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
#include <stdint.h>
#include <time.h>
#include <errno.h>
#include <pthread.h>
#include <signal.h>

#define MAXFD 70000
#define RBUF 65536
static sqlite3 *db;
static sqlite3_stmt *S_feed, *S_one, *S_health, *S_ins_post, *S_exists, *S_like;
static const char *secret = "twelve-dollar-challenge";
static time_t t_start;
static const char *path_db;

/* ---------- tiny JSON: validates the whole document, captures chosen top-level keys ---------- */
typedef struct { int type; /*0 absent 1 string 2 number 3 other*/ char *s; size_t n; double num; } Val;
typedef struct { const char *p, *e; int bad; } JP;
static void ws(JP*j){ while(j->p<j->e && (*j->p==' '||*j->p=='\t'||*j->p=='\n'||*j->p=='\r')) j->p++; }
static int hexv(int c){ return c>='0'&&c<='9'?c-'0':c>='a'&&c<='f'?c-'a'+10:c>='A'&&c<='F'?c-'A'+10:-1; }
static size_t put8(char*o,unsigned cp){ if(cp<0x80){o[0]=cp;return 1;} if(cp<0x800){o[0]=0xC0|cp>>6;o[1]=0x80|(cp&63);return 2;}
  if(cp<0x10000){o[0]=0xE0|cp>>12;o[1]=0x80|((cp>>6)&63);o[2]=0x80|(cp&63);return 3;}
  o[0]=0xF0|cp>>18;o[1]=0x80|((cp>>12)&63);o[2]=0x80|((cp>>6)&63);o[3]=0x80|(cp&63);return 4; }
/* parse string at j->p=='"'; if out!=NULL decode into malloc'd buffer */
static int pstr(JP*j, char**out, size_t*outn){
  j->p++; size_t cap = (size_t)(j->e-j->p)+4; char*b = out? malloc(cap):NULL; size_t n=0;
  while(j->p<j->e){ unsigned char c=*j->p++;
    if(c=='"'){ if(out){*out=b;*outn=n;} return 1; }
    if(c<0x20) break;
    if(c=='\\'){ if(j->p>=j->e) break; c=*j->p++; unsigned cp;
      switch(c){ case '"':case '\\':case '/': cp=c;break; case 'b':cp=8;break; case 'f':cp=12;break; case 'n':cp=10;break; case 'r':cp=13;break; case 't':cp=9;break;
        case 'u':{ if(j->e-j->p<4) goto fail; cp=0; for(int i=0;i<4;i++){int h=hexv(j->p[i]); if(h<0) goto fail; cp=cp*16+h;} j->p+=4;
          if(cp>=0xD800&&cp<0xDC00&&j->e-j->p>=6&&j->p[0]=='\\'&&j->p[1]=='u'){ unsigned lo=0; int ok=1; for(int i=0;i<4;i++){int h=hexv(j->p[2+i]); if(h<0){ok=0;break;} lo=lo*16+h;}
            if(ok&&lo>=0xDC00&&lo<0xE000){ cp=0x10000+((cp-0xD800)<<10)+(lo-0xDC00); j->p+=6; } }
          if(cp>=0xD800&&cp<0xE000) cp=0xFFFD; break; }
        default: goto fail; }
      if(b) n+=put8(b+n,cp); }
    else if(b) b[n++]=c; }
fail: free(b); j->bad=1; return 0; }
static int pval(JP*j,int depth, Val*cap);
static int pnum(JP*j,double*d){ const char*s=j->p; if(j->p<j->e&&*j->p=='-')j->p++; if(j->p>=j->e)return 0;
  if(*j->p=='0')j->p++; else if(*j->p>='1'&&*j->p<='9'){while(j->p<j->e&&*j->p>='0'&&*j->p<='9')j->p++;} else return 0;
  if(j->p<j->e&&*j->p=='.'){j->p++; if(j->p>=j->e||*j->p<'0'||*j->p>'9')return 0; while(j->p<j->e&&*j->p>='0'&&*j->p<='9')j->p++;}
  if(j->p<j->e&&(*j->p=='e'||*j->p=='E')){j->p++; if(j->p<j->e&&(*j->p=='+'||*j->p=='-'))j->p++; if(j->p>=j->e||*j->p<'0'||*j->p>'9')return 0; while(j->p<j->e&&*j->p>='0'&&*j->p<='9')j->p++;}
  char t[64]; size_t n=j->p-s; if(n>=sizeof t) n=sizeof t-1; memcpy(t,s,n); t[n]=0; *d=strtod(t,0); return 1; }
/* keys: NULL-terminated list; caps parallel array. Only used at top level. */
static const char **g_keys; static Val *g_caps;
static int pval(JP*j,int depth, Val*cap){
  if(depth>64){j->bad=1;return 0;} ws(j); if(j->p>=j->e){j->bad=1;return 0;}
  char c=*j->p;
  if(c=='"'){ if(cap){cap->type=1;free(cap->s);cap->s=0; return pstr(j,&cap->s,&cap->n);} return pstr(j,0,0); }
  if(c=='{'){ j->p++; ws(j); if(j->p<j->e&&*j->p=='}'){j->p++;if(cap)cap->type=3;return 1;}
    for(;;){ ws(j); if(j->p>=j->e||*j->p!='"'){j->bad=1;return 0;}
      Val*kc=0; char*k=0;size_t kn=0;
      if(depth==0&&g_keys){ if(!pstr(j,&k,&kn))return 0; for(int i=0;g_keys[i];i++) if(strlen(g_keys[i])==kn&&!memcmp(g_keys[i],k,kn)) kc=&g_caps[i]; free(k);} else if(!pstr(j,0,0)) return 0;
      ws(j); if(j->p>=j->e||*j->p!=':'){j->bad=1;return 0;} j->p++;
      if(kc){ kc->type=0; } if(!pval(j,depth+1,kc)) return 0;
      ws(j); if(j->p>=j->e){j->bad=1;return 0;} if(*j->p==','){j->p++;continue;} if(*j->p=='}'){j->p++;break;} j->bad=1;return 0; }
    if(cap&&cap->type==0)cap->type=3; return 1; }
  if(c=='['){ j->p++; ws(j); if(j->p<j->e&&*j->p==']'){j->p++;return 1;}
    for(;;){ if(!pval(j,depth+1,0))return 0; ws(j); if(j->p>=j->e){j->bad=1;return 0;} if(*j->p==','){j->p++;continue;} if(*j->p==']'){j->p++;break;} j->bad=1;return 0; } return 1; }
  if(c=='t'&&j->e-j->p>=4&&!memcmp(j->p,"true",4)){j->p+=4;if(cap)cap->type=3;return 1;}
  if(c=='f'&&j->e-j->p>=5&&!memcmp(j->p,"false",5)){j->p+=5;if(cap)cap->type=3;return 1;}
  if(c=='n'&&j->e-j->p>=4&&!memcmp(j->p,"null",4)){j->p+=4;if(cap)cap->type=3;return 1;}
  double d; if(pnum(j,&d)){ if(cap){cap->type=2;cap->num=d;} return 1; }
  j->bad=1; return 0; }
static int json_doc(const char*s,size_t n,const char**keys,Val*caps){
  for(int i=0;keys[i];i++){caps[i].type=0;caps[i].s=0;}
  JP j={s,s+n,0}; g_keys=keys; g_caps=caps; int ok=pval(&j,0,0); /* depth0 top-level */
  if(ok){ws(&j); if(j.p!=j.e) ok=0;} return ok; }

/* ---------- JWT ---------- */
static int b64d(const char*s,size_t n,unsigned char*o,size_t*on){ static signed char T[256]; static int init;
  if(!init){memset(T,-1,256);for(int i=0;i<26;i++){T['A'+i]=i;T['a'+i]=26+i;}for(int i=0;i<10;i++)T['0'+i]=52+i;T['-']=62;T['_']=63;init=1;}
  size_t m=0; unsigned acc=0; int bits=0; if(n%4==1) return 0;
  for(size_t i=0;i<n;i++){int v=T[(unsigned char)s[i]]; if(v<0)return 0; acc=acc<<6|v; bits+=6; if(bits>=8){bits-=8;o[m++]=(acc>>bits)&255;}}
  *on=m; return 1; }
/* returns 0 ok, 1 missing/invalid token msg, 2 payload invalid */
static int jwt_check(const char*tok,size_t n,long*uid,char*uname,size_t unmax){
  const char*d1=memchr(tok,'.',n); if(!d1)return 1; const char*d2=memchr(d1+1,'.',n-(d1+1-tok)); if(!d2)return 1;
  if(memchr(d2+1,'.',n-(d2+1-tok)))return 1;
  unsigned char mac[32]; unsigned ml=32; HMAC(EVP_sha256(),secret,strlen(secret),(const unsigned char*)tok,d2-tok,mac,&ml);
  unsigned char sig[64]; size_t sn; if(n-(d2+1-tok)!=43||!b64d(d2+1,43,sig,&sn)||sn!=32) return 1;
  unsigned char diff=0; for(int i=0;i<32;i++) diff|=sig[i]^mac[i]; if(diff) return 1;
  unsigned char hb[256]; size_t hn; if(d1-tok>300||!b64d(tok,d1-tok,hb,&hn)) return 1;
  const char*hk[]={"alg",0}; Val hv[1]; if(!json_doc((char*)hb,hn,hk,hv)) return 1;
  int alg_ok = hv[0].type==1&&hv[0].n==5&&!memcmp(hv[0].s,"HS256",5); free(hv[0].s); if(!alg_ok) return 1;
  size_t pl=d2-(d1+1); unsigned char*pb=malloc(pl+4); size_t pn; if(!b64d(d1+1,pl,pb,&pn)){free(pb);return 1;}
  const char*pk[]={"sub","username","exp",0}; Val pv[3]; int ok=json_doc((char*)pb,pn,pk,pv); free(pb); if(!ok){for(int i=0;i<3;i++)free(pv[i].s);return 1;}
  int rc=0;
  if(pv[2].type==2 && pv[2].num <= (double)time(0)) rc=1;
  else if(pv[2].type!=0 && pv[2].type!=2) rc=1;
  if(!rc){ if(pv[0].type!=1||pv[0].n==0||pv[0].n>15||pv[0].s[0]=='0'){rc=2;}
    else { long v=0; for(size_t i=0;i<pv[0].n;i++){ if(pv[0].s[i]<'0'||pv[0].s[i]>'9'){rc=2;break;} v=v*10+pv[0].s[i]-'0'; } if(!rc){*uid=v; if(v<=0)rc=2;} }
    if(!rc&&(pv[1].type!=1||pv[1].n>=unmax)) rc=2;
    if(!rc){ memcpy(uname,pv[1].s,pv[1].n); uname[pv[1].n]=0; } }
  for(int i=0;i<3;i++)free(pv[i].s); return rc; }

/* ---------- output ---------- */
#define HDR 160
typedef struct { char *b; size_t n, cap; } Out;
static void oput(Out*o,const char*s,size_t n){ if(o->n+n>o->cap){o->cap=(o->n+n)*2;o->b=realloc(o->b,o->cap);} memcpy(o->b+o->n,s,n); o->n+=n; }
#define OLIT(o,s) oput(o,s,sizeof(s)-1)
static void ojstr(Out*o,const char*s,size_t n){ static const char hx[]="0123456789abcdef"; oput(o,"\"",1);
  size_t st=0; for(size_t i=0;i<n;i++){ unsigned char c=s[i]; if(c=='"'||c=='\\'||c<0x20){ oput(o,s+st,i-st); st=i+1;
      if(c=='"')OLIT(o,"\\\""); else if(c=='\\')OLIT(o,"\\\\"); else if(c=='\n')OLIT(o,"\\n"); else if(c=='\r')OLIT(o,"\\r"); else if(c=='\t')OLIT(o,"\\t"); else if(c==8)OLIT(o,"\\b"); else if(c==12)OLIT(o,"\\f");
      else { char u[6]={'\\','u','0','0',hx[c>>4],hx[c&15]}; oput(o,u,6);} } }
  oput(o,s+st,n-st); oput(o,"\"",1); }
static void oint(Out*o,long v){ char t[24]; int n=snprintf(t,sizeof t,"%ld",v); oput(o,t,n); }
static void opost(Out*o,sqlite3_stmt*s){ OLIT(o,"{\"id\":"); oint(o,sqlite3_column_int64(s,0)); OLIT(o,",\"body\":"); ojstr(o,(const char*)sqlite3_column_text(s,1),sqlite3_column_bytes(s,1));
  OLIT(o,",\"created_at\":"); ojstr(o,(const char*)sqlite3_column_text(s,2),sqlite3_column_bytes(s,2)); OLIT(o,",\"author\":"); ojstr(o,(const char*)sqlite3_column_text(s,3),sqlite3_column_bytes(s,3));
  OLIT(o,",\"like_count\":"); oint(o,sqlite3_column_int64(s,4)); OLIT(o,"}"); }
static const char*reason(int c){ switch(c){case 200:return"OK";case 201:return"Created";case 400:return"Bad Request";case 401:return"Unauthorized";case 404:return"Not Found";case 503:return"Service Unavailable";default:return"Internal Server Error";} }
/* body already placed at o->b+HDR; prepend header, return start offset */
static size_t seal(Out*o,int code){ char h[HDR]; size_t bl=o->n-HDR; int hl=snprintf(h,sizeof h,"HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n\r\n",code,reason(code),bl);
  size_t st=HDR-hl; memcpy(o->b+st,h,hl); return st; }
static void oinit(Out*o){ o->n=HDR; if(!o->cap){o->cap=8192;o->b=malloc(o->cap);} }
static void err(Out*o,int code,const char*msg){ oinit(o); OLIT(o,"{\"error\":\""); oput(o,msg,strlen(msg)); OLIT(o,"\"}"); o->cap=o->cap; (void)code; }

/* ---------- connections ---------- */
typedef struct { int fd; char *in; size_t inn; char *out; size_t outn, outoff; int blocked, closing; } Conn;
static Conn *conns[MAXFD]; static int ep;
static Out OB; /* scratch response */
typedef struct { Conn*c; int kind; long uid; long pid; char *uname; char *body; size_t bodyn; } Pend;
static Pend *pend; static int npend, cappend;
static void conn_close(Conn*c){ if(!c)return; epoll_ctl(ep,EPOLL_CTL_DEL,c->fd,0); close(c->fd); conns[c->fd]=0; free(c->in); free(c->out); free(c); }
static void send_resp(Conn*c,const char*p,size_t n){
  if(c->outn){ c->out=realloc(c->out,c->outn+n); memcpy(c->out+c->outn,p,n); c->outn+=n; return; }
  ssize_t w=send(c->fd,p,n,MSG_NOSIGNAL|MSG_DONTWAIT); if(w<0){ if(errno==EAGAIN||errno==EWOULDBLOCK) w=0; else { c->closing=1; return; } }
  if((size_t)w<n){ c->outn=n-w; c->out=malloc(c->outn); memcpy(c->out,p+w,c->outn); c->outoff=0;
    struct epoll_event ev={.events=EPOLLIN|EPOLLOUT,.data.fd=c->fd}; epoll_ctl(ep,EPOLL_CTL_MOD,c->fd,&ev); } }
static void reply(Conn*c,int code){ size_t st=seal(&OB,code); send_resp(c,OB.b+st,OB.n-st); }

static void do_feed(Conn*c){ oinit(&OB); OLIT(&OB,"{\"posts\":["); int first=1; int rc;
  while((rc=sqlite3_step(S_feed))==SQLITE_ROW){ if(!first)OLIT(&OB,","); first=0; opost(&OB,S_feed);} sqlite3_reset(S_feed);
  if(rc!=SQLITE_DONE){ err(&OB,500,"internal server error"); reply(c,500); return; }
  OLIT(&OB,"]}"); reply(c,200); }
static void do_post(Conn*c,long id){ sqlite3_bind_int64(S_one,1,id); int rc=sqlite3_step(S_one);
  oinit(&OB);
  if(rc==SQLITE_ROW){ OLIT(&OB,"{\"post\":"); opost(&OB,S_one); OLIT(&OB,"}"); sqlite3_reset(S_one); reply(c,200); }
  else { sqlite3_reset(S_one); if(rc==SQLITE_DONE){ err(&OB,404,"post not found"); reply(c,404);} else { err(&OB,500,"internal server error"); reply(c,500);} } }
static void do_health(Conn*c){ int rc=sqlite3_step(S_health); sqlite3_reset(S_health); oinit(&OB);
  if(rc==SQLITE_ROW){ OLIT(&OB,"{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":"); oint(&OB,(long)(time(0)-t_start)); OLIT(&OB,"}"); reply(c,200); }
  else { OLIT(&OB,"{\"status\":\"degraded\",\"db\":\"unreachable\",\"error\":"); const char*m=sqlite3_errmsg(db); ojstr(&OB,m,strlen(m)); OLIT(&OB,"}"); reply(c,503);} }
static void E(Conn*c,int code,const char*m){ err(&OB,code,m); reply(c,code); }
static void queue_write(Conn*c,int kind,long uid,long pid,const char*un,char*body,size_t bn){
  if(npend==cappend){cappend=cappend?cappend*2:64;pend=realloc(pend,cappend*sizeof(Pend));}
  Pend*p=&pend[npend++]; p->c=c;p->kind=kind;p->uid=uid;p->pid=pid;p->uname=strdup(un);p->body=body;p->bodyn=bn; c->blocked=1; }
/* JS String.prototype.trim whitespace + UTF-16 length */
static size_t u8cp(const char*s,size_t n,unsigned*cp){ unsigned char c=s[0]; if(c<0x80){*cp=c;return 1;} if(c<0xE0&&n>=2){*cp=(c&31)<<6|(s[1]&63);return 2;} if(c<0xF0&&n>=3){*cp=(c&15)<<12|(s[1]&63)<<6|(s[2]&63);return 3;} if(n>=4){*cp=(c&7)<<18|(s[1]&63)<<12|(s[2]&63)<<6|(s[3]&63);return 4;} *cp=0xFFFD;return 1; }
static int isws(unsigned c){ return c==9||c==10||c==11||c==12||c==13||c==32||c==0xA0||c==0x1680||(c>=0x2000&&c<=0x200A)||c==0x2028||c==0x2029||c==0x202F||c==0x205F||c==0x3000||c==0xFEFF; }
static int handle(Conn*c,const char*method,size_t ml,const char*path,size_t pl,const char*auth,size_t al,const char*body,size_t bl){
  int isget=(ml==3&&!memcmp(method,"GET",3)), ispost=(ml==4&&!memcmp(method,"POST",4));
  const char*q=memchr(path,'?',pl); if(q)pl=q-path;
  if(isget&&pl==5&&!memcmp(path,"/feed",5)){ do_feed(c); return 0; }
  if(isget&&pl==7&&!memcmp(path,"/health",7)){ do_health(c); return 0; }
  if(pl>=7&&!memcmp(path,"/posts/",7)&&(isget||ispost)){
    const char*ip=path+7; size_t il=pl-7; int like=0;
    if(ispost&&il>=5&&!memcmp(ip+il-5,"/like",5)){ like=1; il-=5; } else if(ispost) goto nf;
    if(isget&&memchr(ip,'/',il)) goto nf;
    long uid=0; char un[128];
    if(like){ if(!auth||al<7||memcmp(auth,"Bearer ",7)){ E(c,401,"missing bearer token"); return 0; }
      int r=jwt_check(auth+7,al-7,&uid,un,sizeof un); if(r==1){E(c,401,"invalid or expired token");return 0;} if(r==2){E(c,401,"invalid token payload");return 0;} }
    long id=0; int ok=il>0&&il<=18; for(size_t i=0;ok&&i<il;i++){ if(ip[i]<'0'||ip[i]>'9')ok=0; else id=id*10+ip[i]-'0'; }
    if(!ok||id<=0){ E(c,400,"invalid post id"); return 0; }
    if(!like){ do_post(c,id); return 0; }
    queue_write(c,1,uid,id,un,0,0); return 0; }
  if(ispost&&pl==6&&!memcmp(path,"/posts",6)){
    if(!auth||al<7||memcmp(auth,"Bearer ",7)){ E(c,401,"missing bearer token"); return 0; }
    long uid=0; char un[128]; int r=jwt_check(auth+7,al-7,&uid,un,sizeof un); if(r==1){E(c,401,"invalid or expired token");return 0;} if(r==2){E(c,401,"invalid token payload");return 0;}
    const char*k[]={"body",0}; Val v[1]; if(!json_doc(body,bl,k,v)){ free(v[0].s); E(c,400,"malformed JSON body"); return 0; }
    if(v[0].type!=1){ free(v[0].s); E(c,400,"body is required"); return 0; }
    char*s=v[0].s; size_t n=v[0].n, a=0, b=n; unsigned cp; size_t l;
    while(a<b){ l=u8cp(s+a,b-a,&cp); if(!isws(cp))break; a+=l; }
    while(b>a){ size_t st=b-1; while(st>a&&((unsigned char)s[st]&0xC0)==0x80)st--; u8cp(s+st,b-st,&cp); if(!isws(cp))break; b=st; }
    if(a==b){ free(s); E(c,400,"body is required"); return 0; }
    size_t u16=0; for(size_t i=a;i<b;){ l=u8cp(s+i,b-i,&cp); u16+= cp>=0x10000?2:1; i+=l; }
    if(u16>500){ free(s); E(c,400,"body must be at most 500 characters"); return 0; }
    char*cp2=malloc(b-a+1); memcpy(cp2,s+a,b-a); cp2[b-a]=0; free(s); queue_write(c,2,uid,0,un,cp2,b-a); return 0; }
nf: E(c,404,"not found"); return 0; }

static void flush_writes(void){
  if(!npend)return;
  int rc=sqlite3_exec(db,"BEGIN IMMEDIATE",0,0,0); int ok=(rc==SQLITE_OK);
  typedef struct{int code;long pid;int already;char*created;char*body;long id;}R; R*rs=calloc(npend,sizeof(R));
  for(int i=0;i<npend&&ok;i++){ Pend*p=&pend[i];
    if(p->kind==1){ sqlite3_bind_int64(S_exists,1,p->pid); int r=sqlite3_step(S_exists); sqlite3_reset(S_exists);
      if(r==SQLITE_DONE){rs[i].code=404;continue;} if(r!=SQLITE_ROW){ok=0;break;}
      sqlite3_bind_int64(S_like,1,p->uid); sqlite3_bind_int64(S_like,2,p->pid); r=sqlite3_step(S_like); sqlite3_reset(S_like); if(r!=SQLITE_DONE){ok=0;break;}
      rs[i].already = sqlite3_changes(db)==0; rs[i].code= rs[i].already?200:201; rs[i].pid=p->pid; }
    else { sqlite3_bind_int64(S_ins_post,1,p->uid); sqlite3_bind_text(S_ins_post,2,p->body,(int)p->bodyn,SQLITE_STATIC); int r=sqlite3_step(S_ins_post);
      if(r!=SQLITE_ROW){sqlite3_reset(S_ins_post);ok=0;break;} rs[i].id=sqlite3_column_int64(S_ins_post,0); rs[i].created=strdup((const char*)sqlite3_column_text(S_ins_post,1)); sqlite3_reset(S_ins_post); rs[i].code=201; } }
  if(ok) ok = sqlite3_exec(db,"COMMIT",0,0,0)==SQLITE_OK; if(!ok) sqlite3_exec(db,"ROLLBACK",0,0,0);
  for(int i=0;i<npend;i++){ Pend*p=&pend[i]; Conn*c=p->c; oinit(&OB);
    if(!ok){ err(&OB,500,"internal server error"); reply(c,500); }
    else if(rs[i].code==404){ err(&OB,404,"post not found"); reply(c,404); }
    else if(p->kind==1){ OLIT(&OB,"{\"liked\":true,\"already_liked\":"); if(rs[i].already)OLIT(&OB,"true"); else OLIT(&OB,"false"); OLIT(&OB,",\"post_id\":"); oint(&OB,p->pid); OLIT(&OB,"}"); reply(c,rs[i].code); }
    else { OLIT(&OB,"{\"post\":{\"id\":"); oint(&OB,rs[i].id); OLIT(&OB,",\"body\":"); ojstr(&OB,p->body,p->bodyn); OLIT(&OB,",\"created_at\":"); ojstr(&OB,rs[i].created,strlen(rs[i].created));
      OLIT(&OB,",\"author\":"); ojstr(&OB,p->uname,strlen(p->uname)); OLIT(&OB,",\"like_count\":0}}"); reply(c,201); }
    free(rs[i].created); free(p->uname); free(p->body); c->blocked=0; }
  free(rs); int n=npend; Pend*snap=malloc(n*sizeof(Pend)); memcpy(snap,pend,n*sizeof(Pend)); npend=0;
  extern void process(Conn*); for(int i=0;i<n;i++){ Conn*c=snap[i].c; if(conns[c->fd]==c) process(c); } free(snap); }

/* parse as many complete requests as available in c->in */
void process(Conn*c){
  while(c->inn&&!c->blocked&&!c->closing){
    char*b=c->in; char*he=memmem(b,c->inn,"\r\n\r\n",4); if(!he){ if(c->inn>16384) c->closing=1; return; }
    size_t hl=he+4-b; char*le=memchr(b,'\r',hl); const char*m=b; const char*sp=memchr(b,' ',le-b); if(!sp){c->closing=1;return;}
    const char*pth=sp+1; const char*sp2=memchr(pth,' ',le-pth); if(!sp2){c->closing=1;return;}
    const char*auth=0; size_t al=0; size_t cl=0; int close_=0; int chunked=0;
    for(char*l=le+2;l<he+2;){ char*e=memchr(l,'\r',he+2-l); if(!e)break; size_t ln=e-l;
      if(ln>=14&&!strncasecmp(l,"content-length:",15>ln?ln:15)&&l[14]==':'){ const char*v=l+15; while(*v==' ')v++; cl=strtoul(v,0,10); }
      else if(ln>=14&&!strncasecmp(l,"authorization:",14)){ const char*v=l+14; while(*v==' '||*v=='\t')v++; auth=v; al=e-v; }
      else if(ln>=11&&!strncasecmp(l,"connection:",11)){ if(memmem(l+11,ln-11,"close",5)||memmem(l+11,ln-11,"Close",5)) close_=1; }
      else if(ln>=18&&!strncasecmp(l,"transfer-encoding:",18)) chunked=1;
      l=e+2; }
    if(chunked){ c->closing=1; return; }
    if(cl>20000){ c->closing=1; return; }
    if(c->inn<hl+cl) return;
    handle(c,m,sp-m,pth,sp2-pth,auth,al,b+hl,cl);
    size_t used=hl+cl; memmove(c->in,c->in+used,c->inn-used); c->inn-=used;
    if(close_) c->closing=1; }
  if(c->inn==0){ free(c->in); c->in=0; } }

static char RB[RBUF];
static void on_readable(Conn*c){
  for(;;){ ssize_t r=recv(c->fd,RB,RBUF,MSG_DONTWAIT);
    if(r==0){ c->closing=1; break; } if(r<0){ if(errno==EAGAIN)break; c->closing=1; break; }
    c->in=realloc(c->in,c->inn+r); memcpy(c->in+c->inn,RB,r); c->inn+=r; if(r<RBUF)break; }
  process(c); }

static void* ckpt_thread(void*a){ sqlite3*d; sqlite3_open_v2(path_db,&d,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,0); sqlite3_busy_timeout(d,2000);
  for(;;){ usleep(200000); sqlite3_wal_checkpoint_v2(d,0,SQLITE_CHECKPOINT_PASSIVE,0,0); } return 0; }

int main(void){
  signal(SIGPIPE,SIG_IGN); t_start=time(0);
  const char*e=getenv("JWT_SECRET"); if(e)secret=e; path_db=getenv("SQLITE_PATH"); const char*host=getenv("HOST"); if(!host)host="127.0.0.1"; const char*ps=getenv("PORT"); int port=ps?atoi(ps):3000;
  if(sqlite3_open_v2(path_db,&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,0)){fprintf(stderr,"open fail\n");return 1;}
  sqlite3_busy_timeout(db,5000);
  sqlite3_exec(db,"PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA mmap_size=1073741824;PRAGMA cache_size=-65536;PRAGMA temp_store=MEMORY;PRAGMA wal_autocheckpoint=0;",0,0,0);
  #define P(v,s) sqlite3_prepare_v3(db,s,-1,SQLITE_PREPARE_PERSISTENT,&v,0)
  const char*Q="SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id ";
  char qf[600],q1[600]; snprintf(qf,sizeof qf,"%sORDER BY p.created_at DESC, p.id DESC LIMIT 20",Q); snprintf(q1,sizeof q1,"%sWHERE p.id=?",Q);
  P(S_feed,qf); P(S_one,q1); P(S_health,"SELECT 1"); P(S_exists,"SELECT 1 FROM posts WHERE id=?");
  P(S_like,"INSERT INTO likes(user_id,post_id) VALUES(?,?) ON CONFLICT(user_id,post_id) DO NOTHING");
  P(S_ins_post,"INSERT INTO posts(user_id,body) VALUES(?,?) RETURNING id,created_at");
  pthread_t th; pthread_create(&th,0,ckpt_thread,0);
  int ls=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK,0); int one=1; setsockopt(ls,SOL_SOCKET,SO_REUSEADDR,&one,sizeof one);
  struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(port)}; inet_pton(AF_INET,host,&a.sin_addr);
  if(bind(ls,(void*)&a,sizeof a)||listen(ls,65535)){perror("bind/listen");return 1;}
  ep=epoll_create1(0); struct epoll_event ev={.events=EPOLLIN,.data.fd=ls}; epoll_ctl(ep,EPOLL_CTL_ADD,ls,&ev);
  struct epoll_event evs[512];
  for(;;){ int n=epoll_wait(ep,evs,512,-1);
    for(int i=0;i<n;i++){ int fd=evs[i].data.fd;
      if(fd==ls){ for(;;){ int cf=accept4(ls,0,0,SOCK_NONBLOCK); if(cf<0)break; if(cf>=MAXFD){close(cf);continue;} setsockopt(cf,IPPROTO_TCP,TCP_NODELAY,&one,sizeof one);
          Conn*c=calloc(1,sizeof(Conn)); c->fd=cf; conns[cf]=c; struct epoll_event e2={.events=EPOLLIN,.data.fd=cf}; epoll_ctl(ep,EPOLL_CTL_ADD,cf,&e2); } continue; }
      Conn*c=conns[fd]; if(!c)continue;
      if(evs[i].events&(EPOLLERR|EPOLLHUP)){ c->closing=1; }
      if(!c->closing&&(evs[i].events&EPOLLOUT)&&c->outn){ ssize_t w=send(fd,c->out+c->outoff,c->outn-c->outoff,MSG_NOSIGNAL|MSG_DONTWAIT);
        if(w>0){ c->outoff+=w; if(c->outoff==c->outn){ free(c->out);c->out=0;c->outn=c->outoff=0; struct epoll_event e2={.events=EPOLLIN,.data.fd=fd}; epoll_ctl(ep,EPOLL_CTL_MOD,fd,&e2);} } else if(w<0&&errno!=EAGAIN) c->closing=1; }
      if(!c->closing&&(evs[i].events&EPOLLIN)) on_readable(c);
      if(c->closing&&!c->blocked&&!c->outn) conn_close(c); }
    flush_writes();
    for(int i=0;i<n;i++){ int fd=evs[i].data.fd; if(fd==ls)continue; Conn*c=conns[fd]; if(c&&c->closing&&!c->blocked&&!c->outn) conn_close(c); } }
}
