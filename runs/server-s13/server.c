// Prototype: single-thread epoll HTTP server + SQLite (system lib). Direct on HOST:PORT.
#define _GNU_SOURCE
#include <sqlite3.h>
#include <openssl/sha.h>
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
#include <signal.h>
#include <pthread.h>
#include <sys/resource.h>

#define MAXEV 256
typedef struct { int fd; int len; int cap; char *buf; int outlen, outoff; char *out; int closing; } Conn;

static sqlite3 *db; static sqlite3_stmt *st_feed, *st_feed_gen, *st_post, *st_ins, *st_like_ex, *st_like, *st_health, *st_dv;
static const char *DBPATH; static char SECRET[256]; static int SECLEN;
static SHA256_CTX ictx, octx; static time_t start_t;
static int mono = 1; static char last_ca[32]; static long expect_dv; static long long max_id_seen;

static void die(const char*m){ fprintf(stderr,"fatal: %s (%s)\n",m, db?sqlite3_errmsg(db):""); exit(1);} 
static sqlite3_stmt* prep(const char*q){ sqlite3_stmt*s; if(sqlite3_prepare_v3(db,q,-1,SQLITE_PREPARE_PERSISTENT,&s,0)) die(q); return s; }

/* ---------- JSON helpers ---------- */
static int b64val(int c){ if(c>='A'&&c<='Z')return c-'A'; if(c>='a'&&c<='z')return c-'a'+26; if(c>='0'&&c<='9')return c-'0'+52; if(c=='-')return 62; if(c=='_')return 63; return -1; }
static int b64url_dec(const char*s,int n,unsigned char*o){ int acc=0,bits=0,k=0; for(int i=0;i<n;i++){int v=b64val(s[i]); if(v<0)return -1; acc=(acc<<6)|v; bits+=6; if(bits>=8){bits-=8;o[k++]=(acc>>bits)&255;}} return k; }
static int hex4(const char*p){int v=0;for(int i=0;i<4;i++){int c=p[i];v<<=4; if(c>='0'&&c<='9')v|=c-'0'; else if(c>='a'&&c<='f')v|=c-'a'+10; else if(c>='A'&&c<='F')v|=c-'A'+10; else return -1;} return v;}
static int put_utf8(char*o,unsigned c){ if(c<0x80){o[0]=c;return 1;} if(c<0x800){o[0]=0xC0|(c>>6);o[1]=0x80|(c&63);return 2;} if(c<0x10000){o[0]=0xE0|(c>>12);o[1]=0x80|((c>>6)&63);o[2]=0x80|(c&63);return 3;} o[0]=0xF0|(c>>18);o[1]=0x80|((c>>12)&63);o[2]=0x80|((c>>6)&63);o[3]=0x80|(c&63);return 4; }
/* parse JSON string starting at *p (at the opening quote); decode into out (cap), set *olen; advance *p past closing quote. returns 0 ok */
static int jstr(const char**pp,const char*end,char*out,int cap,int*olen){
  const char*p=*pp; if(p>=end||*p!='"')return -1; p++; int n=0;
  while(p<end){ unsigned char c=*p;
    if(c=='"'){ *pp=p+1; *olen=n; return 0; }
    if(c<0x20) return -1;
    if(c=='\\'){ p++; if(p>=end)return -1; char e=*p++; unsigned cp;
      switch(e){case '"':cp='"';break;case '\\':cp='\\';break;case '/':cp='/';break;case 'b':cp=8;break;case 'f':cp=12;break;case 'n':cp=10;break;case 'r':cp=13;break;case 't':cp=9;break;
        case 'u':{ if(end-p<4)return -1; int h=hex4(p); if(h<0)return -1; p+=4; cp=h;
           if(cp>=0xD800&&cp<0xDC00&&end-p>=6&&p[0]=='\\'&&p[1]=='u'){int l=hex4(p+2); if(l>=0xDC00&&l<0xE000){cp=0x10000+((cp-0xD800)<<10)+(l-0xDC00);p+=6;}}
           if(cp>=0xD800&&cp<0xE000)cp=0xFFFD; break;}
        default:return -1;}
      if(n+4>cap)return -1; n+=put_utf8(out+n,cp);
    } else { if(n+1>cap)return -1; out[n++]=c; p++; }
  }
  return -1;
}
static const char* skipws(const char*p,const char*e){ while(p<e&&(*p==' '||*p=='\t'||*p=='\n'||*p=='\r'))p++; return p; }
/* skip any JSON value; returns pointer after or NULL */
static const char* skipval(const char*p,const char*e,int depth){
  p=skipws(p,e); if(p>=e||depth>64)return NULL;
  if(*p=='"'){ p++; while(p<e){ if(*p=='\\')p+=2; else if(*p=='"')return p+1; else if((unsigned char)*p<0x20)return NULL; else p++; } return NULL; }
  if(*p=='{'||*p=='['){ char close=*p=='{'?'}':']'; int obj=*p=='{'; p++; p=skipws(p,e); if(p<e&&*p==close)return p+1;
    for(;;){ if(obj){ if(p>=e||*p!='"')return NULL; p=skipval(p,e,depth+1); if(!p)return NULL; p=skipws(p,e); if(p>=e||*p!=':')return NULL; p++; }
      p=skipval(p,e,depth+1); if(!p)return NULL; p=skipws(p,e); if(p>=e)return NULL; if(*p==',' ){p++;p=skipws(p,e);continue;} if(*p==close)return p+1; return NULL; } }
  const char*s=p; while(p<e&&(strchr("-+.eE",*p)||(*p>='0'&&*p<='9')||(*p>='a'&&*p<='z')))p++; if(p==s)return NULL;
  { int l=p-s; if(!((l==4&&!memcmp(s,"true",4))||(l==5&&!memcmp(s,"false",5))||(l==4&&!memcmp(s,"null",4)))){ char t[64]; if(l>=63)return NULL; memcpy(t,s,l);t[l]=0; char*q; strtod(t,&q); if(*q)return NULL; } }
  return p;
}
typedef struct { int kind; /*0 none 1 string 2 number 3 other*/ char *s; int slen; double num; } Val;
/* find top-level key in object; fills Val (string decoded into buf). returns 0 ok (key maybe absent: kind 0), -1 malformed. Last duplicate wins. */
static int jget(const char*p,int len,const char*key,Val*v,char*buf,int cap){
  const char*e=p+len; v->kind=0; p=skipws(p,e); if(p>=e||*p!='{')return -1; p++; p=skipws(p,e);
  if(p<e&&*p=='}'){ p=skipws(p+1,e); return p==e?0:-1; }
  char kb[64]; int kl;
  for(;;){ p=skipws(p,e); const char*kp=p; (void)kp; char tmp[64]; if(jstr(&p,e,tmp,sizeof tmp-4,&kl)<0){ /* long key: skip */ p=kp; const char*q=skipval(p,e,0); if(!q)return -1; p=q; kl=-1; }
    p=skipws(p,e); if(p>=e||*p!=':')return -1; p++; p=skipws(p,e);
    int match = kl>=0 && kl==(int)strlen(key) && !memcmp(tmp,key,kl); (void)kb;
    if(match){ if(p<e&&*p=='"'){ int ol; if(jstr(&p,e,buf,cap,&ol)<0)return -1; v->kind=1; v->s=buf; v->slen=ol; }
      else { const char*q=skipval(p,e,0); if(!q)return -1; if(*p=='-'||(*p>='0'&&*p<='9')){ char t[64]; int l=q-p; if(l>63)l=63; memcpy(t,p,l);t[l]=0; v->kind=2; v->num=strtod(t,NULL);} else v->kind=3; p=q; } }
    else { const char*q=skipval(p,e,0); if(!q)return -1; p=q; }
    p=skipws(p,e); if(p>=e)return -1; if(*p==','){p++;continue;} if(*p=='}'){ p=skipws(p+1,e); return p==e?0:-1; } return -1; }
}
static int jesc(char*o,const char*s,int n){ char*w=o; static const char H[]="0123456789abcdef"; for(int i=0;i<n;i++){ unsigned char c=s[i]; if(c=='"'){*w++='\\';*w++='"';} else if(c=='\\'){*w++='\\';*w++='\\';} else if(c<0x20){ if(c=='\n'){*w++='\\';*w++='n';} else if(c=='\r'){*w++='\\';*w++='r';} else if(c=='\t'){*w++='\\';*w++='t';} else { memcpy(w,"\\u00",4);w+=4;*w++=H[c>>4];*w++=H[c&15]; } } else *w++=c; } return w-o; }

/* ---------- JWT ---------- */
static int jwt_verify(const char*tok,int tl,long long*uid,char*uname,int*unl,int*payload_err){
  *payload_err=0; const char*d1=memchr(tok,'.',tl); if(!d1)return -1; const char*d2=memchr(d1+1,'.',tl-(d1+1-tok)); if(!d2)return -1; if(memchr(d2+1,'.',tl-(d2+1-tok)))return -1;
  int sl=tl-(d2+1-tok); if(sl!=43)return -1; unsigned char sig[40]; if(b64url_dec(d2+1,sl,sig)!=32)return -1;
  SHA256_CTX c=ictx; unsigned char in[32],mac[32]; SHA256_Update(&c,tok,d2-tok); SHA256_Final(in,&c); c=octx; SHA256_Update(&c,in,32); SHA256_Final(mac,&c);
  unsigned char diff=0; for(int i=0;i<32;i++)diff|=mac[i]^sig[i]; if(diff)return -1;
  unsigned char hb[256]; int hl=d1-tok; if(hl>340)return -1; int n=b64url_dec(tok,hl,hb); if(n<0)return -1;
  char sb[256]; Val v; if(jget((char*)hb,n,"alg",&v,sb,sizeof sb)<0||v.kind!=1||v.slen!=5||memcmp(v.s,"HS256",5))return -1;
  unsigned char pb[1024]; int pl=d2-(d1+1); if(pl>1300)return -1; n=b64url_dec(d1+1,pl,pb); if(n<0)return -1;
  char xb[512]; if(jget((char*)pb,n,"exp",&v,xb,sizeof xb)<0)return -1; if(v.kind==2 && v.num<=(double)time(NULL))return -1; if(v.kind==1||v.kind==3)return -1;
  *payload_err=1;
  if(jget((char*)pb,n,"sub",&v,xb,sizeof xb)<0)return -1; if(v.kind!=1||v.slen<1||v.slen>15)return -2; long long id=0; for(int i=0;i<v.slen;i++){ if(v.s[i]<'0'||v.s[i]>'9')return -2; id=id*10+(v.s[i]-'0'); } if(id<=0)return -2;
  if(jget((char*)pb,n,"username",&v,uname,512)<0)return -1; if(v.kind!=1)return -2; *unl=v.slen; *uid=id; return 0;
}

/* ---------- HTTP ---------- */
static const char *REASON(int c){ switch(c){case 200:return "OK";case 201:return "Created";case 400:return "Bad Request";case 401:return "Unauthorized";case 404:return "Not Found";case 503:return "Service Unavailable";default:return "Internal Server Error";} }
static int mkresp(char*o,int status,const char*body,int bl,int close_){
  int n=sprintf(o,"HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n%s\r\n",status,REASON(status),bl,close_?"Connection: close\r\n":"");
  memcpy(o+n,body,bl); return n+bl; }
#define ERR(st,msg) do{ const char*_m="{\"error\":\"" msg "\"}"; return mkresp(out,st,_m,sizeof("{\"error\":\"" msg "\"}")-1,close_);}while(0)

static int emit_row(char*w,sqlite3_stmt*s,const char*author,int al){
  char*o=w; o+=sprintf(o,"{\"id\":%lld,\"body\":\"",(long long)sqlite3_column_int64(s,0)); o+=jesc(o,(const char*)sqlite3_column_text(s,1),sqlite3_column_bytes(s,1));
  memcpy(o,"\",\"created_at\":\"",16);o+=16; int cl=sqlite3_column_bytes(s,2); memcpy(o,sqlite3_column_text(s,2),cl);o+=cl;
  memcpy(o,"\",\"author\":\"",12);o+=12; if(author){ o+=jesc(o,author,al);} else o+=jesc(o,(const char*)sqlite3_column_text(s,3),sqlite3_column_bytes(s,3));
  o+=sprintf(o,"\",\"like_count\":%d}",sqlite3_column_int(s,4)); return o-w; }

static int handle(char*out,int outcap,const char*m,int ml,const char*path,int pl,const char*auth,int authlen,const char*body,int bl,int close_){
  (void)outcap; static char tmp[1<<17];
  if(ml==3&&!memcmp(m,"GET",3)){
    if(pl==5&&!memcmp(path,"/feed",5)){
      sqlite3_stmt*s=st_feed;
      if(mono){ if(sqlite3_step(st_dv)==SQLITE_ROW){ long dv=sqlite3_column_int64(st_dv,0); if(dv!=expect_dv){ mono=0; } } sqlite3_reset(st_dv); }
      if(!mono)s=st_feed_gen;
      char*w=tmp; memcpy(w,"{\"posts\":[",10);w+=10; int rc,first=1;
      while((rc=sqlite3_step(s))==SQLITE_ROW){ if(!first)*w++=','; first=0; w+=emit_row(w,s,NULL,0);} 
      sqlite3_reset(s); if(rc!=SQLITE_DONE)ERR(500,"internal server error");
      *w++=']';*w++='}'; return mkresp(out,200,tmp,w-tmp,close_);
    }
    if(pl==7&&!memcmp(path,"/health",7)){
      int rc=sqlite3_step(st_health); sqlite3_reset(st_health);
      if(rc!=SQLITE_ROW){ int n=sprintf(tmp,"{\"status\":\"degraded\",\"db\":\"unreachable\",\"error\":\"unreachable\"}"); return mkresp(out,503,tmp,n,close_);} 
      int n=sprintf(tmp,"{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":%ld}",(long)(time(NULL)-start_t)); return mkresp(out,200,tmp,n,close_);
    }
    if(pl>7&&!memcmp(path,"/posts/",7)&&!memchr(path+7,'/',pl-7)){
      const char*ip=path+7;int il=pl-7; long long id=0; int ok=1; for(int i=0;i<il;i++){ if(ip[i]<'0'||ip[i]>'9'){ok=0;break;} if(id<(1LL<<54))id=id*10+(ip[i]-'0'); }
      if(!ok||id<=0)ERR(400,"invalid post id");
      sqlite3_bind_int64(st_post,1,id); int rc=sqlite3_step(st_post);
      if(rc==SQLITE_ROW){ char*w=tmp; memcpy(w,"{\"post\":",8);w+=8; w+=emit_row(w,st_post,NULL,0);*w++='}'; sqlite3_reset(st_post); return mkresp(out,200,tmp,w-tmp,close_);} 
      sqlite3_reset(st_post); if(rc==SQLITE_DONE)ERR(404,"post not found"); ERR(500,"internal server error");
    }
    ERR(404,"not found");
  }
  if(ml==4&&!memcmp(m,"POST",4)){
    int isposts = pl==6&&!memcmp(path,"/posts",6);
    int islike = pl>12 && !memcmp(path,"/posts/",7) && !memcmp(path+pl-5,"/like",5) && !memchr(path+7,'/',pl-12);
    if(!isposts&&!islike)ERR(404,"not found");
    if(authlen<7||memcmp(auth,"Bearer ",7))ERR(401,"missing bearer token");
    long long uid; char un[512]; int unl,perr; int r=jwt_verify(auth+7,authlen-7,&uid,un,&unl,&perr);
    if(r==-1)ERR(401,"invalid or expired token"); if(r==-2)ERR(401,"invalid token payload");
    if(isposts){
      static char bb[4096]; Val v; if(bl>16384)ERR(400,"malformed JSON body"); char*dec=malloc(bl+8); int jr=jget(body,bl,"body",&v,dec,bl+4); if(jr<0){free(dec);ERR(400,"malformed JSON body");}
      if(v.kind!=1){free(dec);ERR(400,"body is required");}
      const char*s=v.s;int n=v.slen; while(n>0&&(*s==' '||*s=='\t'||*s=='\n'||*s=='\r'||*s=='\f'||*s=='\v')){s++;n--;} while(n>0&&(s[n-1]==' '||s[n-1]=='\t'||s[n-1]=='\n'||s[n-1]=='\r'||s[n-1]=='\f'||s[n-1]=='\v'))n--;
      if(n==0){free(dec);ERR(400,"body is required");}
      int chars=0; for(int i=0;i<n;i++) if(((unsigned char)s[i]&0xC0)!=0x80)chars++;
      if(chars>500){free(dec);ERR(400,"body must be at most 500 characters");}
      (void)bb;
      sqlite3_bind_int64(st_ins,1,uid); sqlite3_bind_text(st_ins,2,s,n,SQLITE_STATIC);
      int rc=sqlite3_step(st_ins);
      if(rc!=SQLITE_ROW){ sqlite3_reset(st_ins); free(dec); ERR(500,"internal server error"); }
      long long id=sqlite3_column_int64(st_ins,0); char ca[40]; snprintf(ca,sizeof ca,"%s",(const char*)sqlite3_column_text(st_ins,1)); sqlite3_reset(st_ins);
      if(strcmp(ca,last_ca)<0||id<=max_id_seen)mono=0; else { snprintf(last_ca,sizeof last_ca,"%s",ca); max_id_seen=id; }
      char*w=tmp; w+=sprintf(w,"{\"post\":{\"id\":%lld,\"body\":\"",id); w+=jesc(w,s,n); w+=sprintf(w,"\",\"created_at\":\"%s\",\"author\":\"",ca); w+=jesc(w,un,unl); w+=sprintf(w,"\",\"like_count\":0}}");
      free(dec); return mkresp(out,201,tmp,w-tmp,close_);
    } else {
      const char*ip=path+7;int il=pl-12; long long id=0; int ok=il>0; for(int i=0;i<il;i++){ if(ip[i]<'0'||ip[i]>'9'){ok=0;break;} if(id<(1LL<<54))id=id*10+(ip[i]-'0'); }
      if(!ok||id<=0)ERR(400,"invalid post id");
      sqlite3_bind_int64(st_like_ex,1,id); int rc=sqlite3_step(st_like_ex); sqlite3_reset(st_like_ex);
      if(rc==SQLITE_DONE)ERR(404,"post not found"); if(rc!=SQLITE_ROW)ERR(500,"internal server error");
      sqlite3_bind_int64(st_like,1,uid); sqlite3_bind_int64(st_like,2,id); rc=sqlite3_step(st_like); sqlite3_reset(st_like); if(rc!=SQLITE_DONE)ERR(500,"internal server error");
      int fresh=sqlite3_changes(db)>0; int n=sprintf(tmp,"{\"liked\":true,\"already_liked\":%s,\"post_id\":%lld}",fresh?"false":"true",id);
      return mkresp(out,fresh?201:200,tmp,n,close_);
    }
  }
  ERR(404,"not found");
}

/* returns: >0 bytes consumed and response in out/outl; 0 need more; -1 bad */
static int process(Conn*c,char*b,int len,char*out,int*outl,int*closeit){
  char*he=memmem(b,len,"\r\n\r\n",4); if(!he){ if(len>16384)return -1; return 0; }
  int hl=he+4-b; char*le=memchr(b,'\r',hl); const char*sp1=memchr(b,' ',le-b); if(!sp1)return -1; const char*sp2=memchr(sp1+1,' ',le-sp1-1); if(!sp2)return -1;
  const char*path=sp1+1; int pl=sp2-path; const char*q=memchr(path,'?',pl); if(q)pl=q-path;
  int http10 = (le-sp2-1==8 && sp2[8]=='0'); int close_=http10;
  const char*auth=""; int authlen=0; long cl=0; int expect=0;
  for(char*p=le+2;p<he+2;){ char*e=memchr(p,'\r',he+2-p); if(!e||e==p)break; int ll=e-p; char*col=memchr(p,':',ll);
    if(col){ int nl=col-p; char*v=col+1; while(v<e&&(*v==' '||*v=='\t'))v++; int vl=e-v;
      if(nl==13&&!strncasecmp(p,"authorization",13)){auth=v;authlen=vl;}
      else if(nl==14&&!strncasecmp(p,"content-length",14)){cl=strtol(v,NULL,10);}
      else if(nl==10&&!strncasecmp(p,"connection",10)){ if(vl>=5&&!strncasecmp(v,"close",5))close_=1; else if(http10&&vl>=10&&!strncasecmp(v,"keep-alive",10))close_=0; }
      else if(nl==6&&!strncasecmp(p,"expect",6)){expect=1;}
      else if(nl==17&&!strncasecmp(p,"transfer-encoding",17)){return -1;} }
    p=e+2; }
  if(cl<0||cl>1<<20)return -1;
  if(len<hl+cl){ if(expect&&len==hl){ static const char c100[]="HTTP/1.1 100 Continue\r\n\r\n"; if(write(c->fd,c100,sizeof c100-1)<0){} } return 0; }
  *outl=handle(out,0,b,sp1-b,path,pl,auth,authlen,b+hl,(int)cl,close_); *closeit=close_; return hl+(int)cl;
}

static int setnb(int fd){ return fcntl(fd,F_SETFL,fcntl(fd,F_GETFL)|O_NONBLOCK); }
static void closec(int ep,Conn*c){ epoll_ctl(ep,EPOLL_CTL_DEL,c->fd,NULL); close(c->fd); free(c->buf); free(c->out); free(c); }

static void* ckpt_thread(void*a){ (void)a; sqlite3*d; sqlite3_open_v2(DBPATH,&d,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,0); sqlite3_busy_timeout(d,1000);
  for(;;){ usleep(500000); int lg=0,ck=0; sqlite3_wal_checkpoint_v2(d,NULL,SQLITE_CHECKPOINT_PASSIVE,&lg,&ck); } return NULL; }

int main(){
  signal(SIGPIPE,SIG_IGN); start_t=time(NULL);
  const char*sp=getenv("SQLITE_PATH"); const char*js=getenv("JWT_SECRET"); const char*host=getenv("HOST"); const char*port=getenv("PORT");
  if(!sp)sp="feed.db"; if(!js)js="twelve-dollar-challenge"; if(!host)host="127.0.0.1"; if(!port)port="3000";
  DBPATH=sp; SECLEN=strlen(js); memcpy(SECRET,js,SECLEN);
  { unsigned char k[64]={0},ip[64],op[64]; if(SECLEN>64){SHA256((unsigned char*)js,SECLEN,k);} else memcpy(k,js,SECLEN); for(int i=0;i<64;i++){ip[i]=k[i]^0x36;op[i]=k[i]^0x5c;} SHA256_Init(&ictx);SHA256_Update(&ictx,ip,64);SHA256_Init(&octx);SHA256_Update(&octx,op,64); }
  sqlite3_config(SQLITE_CONFIG_MULTITHREAD); sqlite3_config(SQLITE_CONFIG_MEMSTATUS,0);
  if(sqlite3_open_v2(sp,&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,0))die("open");
  sqlite3_busy_timeout(db,2000);
  {char pr[300]; sprintf(pr,"PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA cache_size=-65536;PRAGMA wal_autocheckpoint=%d;PRAGMA temp_store=MEMORY;",getenv("CKPT")?atoi(getenv("CKPT")):1000); sqlite3_exec(db,pr,0,0,0);}
  const char*FEED="SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id ";
  char q[600];
  snprintf(q,sizeof q,"%sORDER BY p.id DESC LIMIT 20",FEED); st_feed=prep(q);
  snprintf(q,sizeof q,"%sORDER BY p.created_at DESC, p.id DESC LIMIT 20",FEED); st_feed_gen=prep(q);
  snprintf(q,sizeof q,"%sWHERE p.id=?1",FEED); st_post=prep(q);
  st_ins=prep("INSERT INTO posts (user_id, body) VALUES (?1, ?2) RETURNING id, created_at");
  st_like_ex=prep("SELECT 1 FROM posts WHERE id=?1");
  st_like=prep("INSERT INTO likes (user_id, post_id) VALUES (?1, ?2) ON CONFLICT (user_id, post_id) DO NOTHING");
  st_health=prep("SELECT 1"); st_dv=prep("PRAGMA data_version");
  /* startup guard: id order == (created_at,id) order over all posts */
  { sqlite3_stmt*s=prep("SELECT id, created_at FROM posts INDEXED BY posts_created_at_id_idx ORDER BY created_at, id"); long long prev=0; int bad=0; while(sqlite3_step(s)==SQLITE_ROW){ long long id=sqlite3_column_int64(s,0); if(id<=prev){bad=1;break;} prev=id; snprintf(last_ca,sizeof last_ca,"%s",sqlite3_column_text(s,1)); } sqlite3_finalize(s); max_id_seen=prev; if(bad){mono=0; fprintf(stderr,"mono guard failed: using general feed query\n");} }
  { sqlite3_step(st_dv); expect_dv=sqlite3_column_int64(st_dv,0); sqlite3_reset(st_dv); }
  if(getenv("THR")){pthread_t th; pthread_create(&th,NULL,ckpt_thread,NULL);}
  { struct rlimit rl={65535,65535}; setrlimit(RLIMIT_NOFILE,&rl); }
  int ls=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK,0); int one=1; setsockopt(ls,SOL_SOCKET,SO_REUSEADDR,&one,sizeof one);
  struct sockaddr_in a={0}; a.sin_family=AF_INET; a.sin_port=htons(atoi(port)); inet_pton(AF_INET,host,&a.sin_addr);
  if(bind(ls,(struct sockaddr*)&a,sizeof a))die("bind"); if(listen(ls,65535))die("listen");
  int ep=epoll_create1(0); struct epoll_event ev={.events=EPOLLIN,.data.ptr=NULL}; epoll_ctl(ep,EPOLL_CTL_ADD,ls,&ev);
  struct epoll_event evs[MAXEV]; static char rb[65536]; static char out[1<<17];
  fprintf(stderr,"listening %s:%s mono=%d\n",host,port,mono);
  for(;;){ int n=epoll_wait(ep,evs,MAXEV,-1);
    for(int i=0;i<n;i++){ Conn*c=evs[i].data.ptr;
      if(!c){ for(;;){ int fd=accept4(ls,NULL,NULL,SOCK_NONBLOCK); if(fd<0)break; setsockopt(fd,IPPROTO_TCP,TCP_NODELAY,&one,sizeof one); Conn*nc=calloc(1,sizeof *nc); nc->fd=fd; struct epoll_event e2={.events=EPOLLIN|EPOLLRDHUP,.data.ptr=nc}; epoll_ctl(ep,EPOLL_CTL_ADD,fd,&e2);} continue; }
      if(evs[i].events&EPOLLOUT && c->out){ int w=write(c->fd,c->out+c->outoff,c->outlen-c->outoff); if(w>0)c->outoff+=w; if(w<0&&errno!=EAGAIN){closec(ep,c);continue;} if(c->outoff>=c->outlen){free(c->out);c->out=NULL; struct epoll_event e2={.events=EPOLLIN|EPOLLRDHUP,.data.ptr=c}; epoll_ctl(ep,EPOLL_CTL_MOD,c->fd,&e2); if(c->closing){closec(ep,c);continue;}} else continue; }
      if(!(evs[i].events&(EPOLLIN|EPOLLHUP|EPOLLERR|EPOLLRDHUP)))continue;
      if(c->out)continue;
      int r=read(c->fd,rb,sizeof rb); if(r==0||(r<0&&errno!=EAGAIN)){closec(ep,c);continue;} if(r<0)continue;
      char*b; int len;
      if(c->len){ if(c->len+r>c->cap){c->cap=(c->len+r)*2;c->buf=realloc(c->buf,c->cap);} memcpy(c->buf+c->len,rb,r); c->len+=r; b=c->buf; len=c->len; }
      else { b=rb; len=r; }
      int off=0,dead=0;
      for(;;){ int ol,cl2; int used=process(c,b+off,len-off,out,&ol,&cl2);
        if(used<0){ static const char bad[]="HTTP/1.1 400 Bad Request\r\nContent-Length: 28\r\nConnection: close\r\n\r\n{\"error\":\"malformed request\"}"; if(write(c->fd,bad,sizeof bad-1)<0){} dead=1; break; }
        if(used==0)break;
        off+=used;
        int w=write(c->fd,out,ol); if(w<0&&errno!=EAGAIN){dead=1;break;} if(w<0)w=0;
        if(w<ol){ c->outlen=ol-w; c->out=malloc(c->outlen); memcpy(c->out,out+w,c->outlen); c->outoff=0; c->closing=cl2; struct epoll_event e2={.events=EPOLLOUT|EPOLLRDHUP,.data.ptr=c}; epoll_ctl(ep,EPOLL_CTL_MOD,c->fd,&e2); break; }
        else if(cl2){dead=1;break;}
        if(off>=len)break; }
      if(dead){ closec(ep,c); continue; }
      { int left=len-off;
        if(left>0){ if(b==c->buf){ memmove(c->buf,c->buf+off,left); c->len=left; } else { if(left>c->cap){ c->cap=left*2+256; c->buf=realloc(c->buf,c->cap);} memcpy(c->buf,b+off,left); c->len=left; } }
        else { c->len=0; if(c->buf){free(c->buf);c->buf=NULL;c->cap=0;} } }
    } }
}
