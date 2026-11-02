// prototype: single-thread epoll + sqlite, direct on HOST:PORT
#define _GNU_SOURCE
#include <sqlite3.h>
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
#include <sys/resource.h>
#include <signal.h>
#include <pthread.h>
static const char*DBP;
static void*ckthread(void*a){sqlite3*c;sqlite3_open_v2(DBP,&c,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,0);sqlite3_busy_timeout(c,5000);sqlite3_exec(c,"PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;",0,0,0);int n=0,l,k;for(;;){usleep(250000);sqlite3_wal_checkpoint_v2(c,0,SQLITE_CHECKPOINT_PASSIVE,&l,&k);if(++n%40==0)sqlite3_wal_checkpoint_v2(c,0,SQLITE_CHECKPOINT_TRUNCATE,&l,&k);}return 0;}

/* ---- sha256 / hmac ---- */
static const uint32_t K[64]={0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
#define ROR(x,n) (((x)>>(n))|((x)<<(32-(n))))
typedef struct{uint32_t h[8];uint8_t b[64];uint64_t n;int l;}sha_t;
static void blk(sha_t*s,const uint8_t*p){uint32_t w[64],a,b,c,d,e,f,g,h;for(int i=0;i<16;i++)w[i]=p[4*i]<<24|p[4*i+1]<<16|p[4*i+2]<<8|p[4*i+3];
 for(int i=16;i<64;i++){uint32_t s0=ROR(w[i-15],7)^ROR(w[i-15],18)^(w[i-15]>>3),s1=ROR(w[i-2],17)^ROR(w[i-2],19)^(w[i-2]>>10);w[i]=w[i-16]+s0+w[i-7]+s1;}
 a=s->h[0];b=s->h[1];c=s->h[2];d=s->h[3];e=s->h[4];f=s->h[5];g=s->h[6];h=s->h[7];
 for(int i=0;i<64;i++){uint32_t t1=h+(ROR(e,6)^ROR(e,11)^ROR(e,25))+((e&f)^(~e&g))+K[i]+w[i],t2=(ROR(a,2)^ROR(a,13)^ROR(a,22))+((a&b)^(a&c)^(b&c));h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;}
 s->h[0]+=a;s->h[1]+=b;s->h[2]+=c;s->h[3]+=d;s->h[4]+=e;s->h[5]+=f;s->h[6]+=g;s->h[7]+=h;}
static void sinit(sha_t*s){static const uint32_t i[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};memcpy(s->h,i,32);s->n=0;s->l=0;}
static void supd(sha_t*s,const uint8_t*p,size_t n){s->n+=n;while(n){int k=64-s->l;if((size_t)k>n)k=n;memcpy(s->b+s->l,p,k);s->l+=k;p+=k;n-=k;if(s->l==64){blk(s,s->b);s->l=0;}}}
static void sfin(sha_t*s,uint8_t*o){uint64_t bits=s->n*8;uint8_t pad=0x80;supd(s,&pad,1);pad=0;while(s->l!=56)supd(s,&pad,1);uint8_t L[8];for(int i=0;i<8;i++)L[i]=bits>>(56-8*i);supd(s,L,8);for(int i=0;i<8;i++){o[4*i]=s->h[i]>>24;o[4*i+1]=s->h[i]>>16;o[4*i+2]=s->h[i]>>8;o[4*i+3]=s->h[i];}}
static sha_t ipad_s,opad_s; // precomputed key states
static void hmac_init(const char*key){uint8_t k[64]={0},p[64];size_t n=strlen(key);memcpy(k,key,n);for(int i=0;i<64;i++)p[i]=k[i]^0x36;sinit(&ipad_s);supd(&ipad_s,p,64);for(int i=0;i<64;i++)p[i]=k[i]^0x5c;sinit(&opad_s);supd(&opad_s,p,64);}
static void hmac(const uint8_t*m,size_t n,uint8_t*out){sha_t s=ipad_s;uint8_t in[32];supd(&s,m,n);sfin(&s,in);s=opad_s;supd(&s,in,32);sfin(&s,out);}

/* ---- base64url ---- */
static int b64v(int c){if(c>='A'&&c<='Z')return c-'A';if(c>='a'&&c<='z')return c-'a'+26;if(c>='0'&&c<='9')return c-'0'+52;if(c=='-')return 62;if(c=='_')return 63;return -1;}
static int b64dec(const char*s,size_t n,uint8_t*o){size_t m=0;uint32_t acc=0;int bits=0;for(size_t i=0;i<n;i++){int v=b64v(s[i]);if(v<0)return -1;acc=acc<<6|v;bits+=6;if(bits>=8){bits-=8;o[m++]=acc>>bits;}}return m;}

/* ---- tiny JSON scanner: find top-level key, return value start ---- */
static const char*skipws(const char*p,const char*e){while(p<e&&(*p==' '||*p=='\t'||*p=='\n'||*p=='\r'))p++;return p;}
// parse JSON string at p (pointing at '"'), unescape into out (cap), returns pointer after closing quote or NULL
static const char*jstr(const char*p,const char*e,char*out,int cap,int*len){ if(p>=e||*p!='"')return NULL;p++;int n=0;
 while(p<e&&*p!='"'){unsigned c=(unsigned char)*p;if(c<0x20)return NULL;
  if(c=='\\'){p++;if(p>=e)return NULL;switch(*p){case '"':c='"';break;case '\\':c='\\';break;case '/':c='/';break;case 'b':c=8;break;case 'f':c=12;break;case 'n':c=10;break;case 'r':c=13;break;case 't':c=9;break;
    case 'u':{if(p+4>=e)return NULL;unsigned u=0;for(int i=1;i<=4;i++){int h=p[i];int v=h>='0'&&h<='9'?h-'0':h>='a'&&h<='f'?h-'a'+10:h>='A'&&h<='F'?h-'A'+10:-1;if(v<0)return NULL;u=u<<4|v;}p+=4;
       if(u>=0xD800&&u<0xDC00&&p+6<e&&p[1]=='\\'&&p[2]=='u'){unsigned l=0;for(int i=3;i<=6;i++){int h=p[i];int v=h>='0'&&h<='9'?h-'0':h>='a'&&h<='f'?h-'a'+10:h>='A'&&h<='F'?h-'A'+10:-1;if(v<0)return NULL;l=l<<4|v;}if(l>=0xDC00&&l<0xE000){u=0x10000+((u-0xD800)<<10)+(l-0xDC00);p+=6;}}
       if(n+4>=cap)return NULL; if(u<0x80)out[n++]=u;else if(u<0x800){out[n++]=0xC0|u>>6;out[n++]=0x80|(u&63);}else if(u<0x10000){out[n++]=0xE0|u>>12;out[n++]=0x80|((u>>6)&63);out[n++]=0x80|(u&63);}else{out[n++]=0xF0|u>>18;out[n++]=0x80|((u>>12)&63);out[n++]=0x80|((u>>6)&63);out[n++]=0x80|(u&63);} p++;continue;}
    default:return NULL;} }
  if(n+1>=cap)return NULL; out[n++]=c;p++;}
 if(p>=e)return NULL; out[n]=0;*len=n;return p+1;}
static const char*skipval(const char*p,const char*e); 
static const char*skipval(const char*p,const char*e){p=skipws(p,e);if(p>=e)return NULL;
 if(*p=='"'){static char t[2048];int l;return jstr(p,e,t,sizeof t,&l);}
 if(*p=='{'||*p=='['){char o=*p,c=o=='{'?'}':']';p++;p=skipws(p,e);if(p<e&&*p==c)return p+1;
  for(;;){ if(o=='{'){static char t[2048];int l;p=skipws(p,e);p=jstr(p,e,t,sizeof t,&l);if(!p)return NULL;p=skipws(p,e);if(p>=e||*p!=':')return NULL;p++;}
   p=skipval(p,e);if(!p)return NULL;p=skipws(p,e);if(p>=e)return NULL;if(*p==','){p++;continue;}if(*p==c)return p+1;return NULL;}}
 const char*q=p;while(q<e&&((*q>='0'&&*q<='9')||*q=='-'||*q=='+'||*q=='.'||*q=='e'||*q=='E'||(*q>='a'&&*q<='z')))q++; if(q==p)return NULL;return q;}
// iterate object; for key matching `want`, set *vs to value start. returns 0 ok (obj valid), -1 invalid
static int jfind(const char*s,size_t n,const char*want,const char**vs){const char*p=s,*e=s+n;*vs=NULL;p=skipws(p,e);if(p>=e||*p!='{')return -1;p++;p=skipws(p,e);if(p<e&&*p=='}'){p++;p=skipws(p,e);return p==e?0:-1;}
 for(;;){static char k[2048];int l;p=skipws(p,e);p=jstr(p,e,k,sizeof k,&l);if(!p)return -1;p=skipws(p,e);if(p>=e||*p!=':')return -1;p++;p=skipws(p,e);if(!strcmp(k,want))*vs=p;p=skipval(p,e);if(!p)return -1;p=skipws(p,e);if(p>=e)return -1;if(*p==','){p++;continue;}if(*p=='}'){p++;p=skipws(p,e);return p==e?0:-1;}return -1;}}

/* ---- globals ---- */
static sqlite3*db;
static sqlite3_stmt*st_feed,*st_post,*st_ins,*st_exists,*st_like,*st_health;
static time_t t0;
static char *out; static size_t outcap=1<<20;

static int esc(char*o,const char*s,int n){int m=0;for(int i=0;i<n;i++){unsigned char c=s[i];if(c=='"'||c=='\\'){o[m++]='\\';o[m++]=c;}else if(c==10){o[m++]='\\';o[m++]='n';}else if(c=='\r'){o[m++]='\\';o[m++]='r';}else if(c=='\t'){o[m++]='\\';o[m++]='t';}else if(c==8){o[m++]='\\';o[m++]='b';}else if(c==12){o[m++]='\\';o[m++]='f';}else if(c<0x20){m+=sprintf(o+m,"\\u%04x",c);}else o[m++]=c;}return m;}
static int post_json(char*o,sqlite3_stmt*s,const char*user,int ulen){ // columns id,body,created_at,username,count
 int m=sprintf(o,"{\"id\":%lld,\"body\":\"",(long long)sqlite3_column_int64(s,0));
 m+=esc(o+m,(const char*)sqlite3_column_text(s,1),sqlite3_column_bytes(s,1));
 m+=sprintf(o+m,"\",\"created_at\":\"%s\",\"author\":\"",(const char*)sqlite3_column_text(s,2));
 if(user)m+=esc(o+m,user,ulen);else m+=esc(o+m,(const char*)sqlite3_column_text(s,3),sqlite3_column_bytes(s,3));
 m+=sprintf(o+m,"\",\"like_count\":%d}",sqlite3_column_int(s,4));return m;}

typedef struct{char*buf;size_t len;char*ob;size_t olen,ooff;}conn_t;
static conn_t*conns[70000];
static int ep;

static int respond(char*resp,int status,const char*body,int blen){
 const char*txt=status==200?"OK":status==201?"Created":status==400?"Bad Request":status==401?"Unauthorized":status==404?"Not Found":status==503?"Service Unavailable":"Internal Server Error";
 int m=sprintf(resp,"HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n",status,txt,blen);memcpy(resp+m,body,blen);return m+blen;}
#define ERR(code,msg) do{ const char*_b="{\"error\":\"" msg "\"}"; return respond(resp,code,_b,sizeof(_b)?(int)strlen(_b):0);}while(0)

static int parse_id(const char*s,int n,long long*id){if(n<=0||n>18)return 0;long long v=0;for(int i=0;i<n;i++){if(s[i]<'0'||s[i]>'9')return 0;v=v*10+s[i]-'0';}if(v<=0)return 0;*id=v;return 1;}

// auth: returns 0 ok, else error response length via resp
static int auth(const char*h,int hn,long long*uid,char*uname,int*ulen,char*resp,int*rl){
 #define AE(code,msg) do{const char*_b="{\"error\":\"" msg "\"}";*rl=respond(resp,code,_b,(int)strlen(_b));return -1;}while(0)
 if(!h||hn<7||memcmp(h,"Bearer ",7))AE(401,"missing bearer token");
 const char*t=h+7;int tn=hn-7;
 const char*d1=memchr(t,'.',tn);if(!d1)AE(401,"invalid or expired token");const char*d2=memchr(d1+1,'.',tn-(d1+1-t));if(!d2||memchr(d2+1,'.',tn-(d2+1-t)))AE(401,"invalid or expired token");
 uint8_t mac[32],sig[64];int sl=b64dec(d2+1,tn-(d2+1-t),sig);
 hmac((const uint8_t*)t,d2-t,mac);
 if(sl!=32||(tn-(d2+1-t))!=43||memcmp(mac,sig,32))AE(401,"invalid or expired token");
 static uint8_t hb[512],pb[1024];int hl=b64dec(t,d1-t,hb),pl=b64dec(d1+1,d2-d1-1,pb);if(hl<0||pl<0||hl>500||pl>1000)AE(401,"invalid or expired token");
 const char*v;if(jfind((char*)hb,hl,"alg",&v)<0||!v)AE(401,"invalid or expired token");{char a[16];int l;if(!jstr(v,(char*)hb+hl,a,sizeof a,&l)||strcmp(a,"HS256"))AE(401,"invalid or expired token");}
 if(jfind((char*)pb,pl,"exp",&v)<0)AE(401,"invalid or expired token");
 if(v){char*endp;double ex=strtod(v,&endp);if(endp==v||ex<=(double)time(NULL))AE(401,"invalid or expired token");}
 // exp absent: treat as valid (matches common libs)
 if(jfind((char*)pb,pl,"sub",&v)<0)AE(401,"invalid or expired token");
 long long id=0;{char s[64];int l;if(!v||*v!='"'||!jstr(v,(char*)pb+pl,s,sizeof s,&l)||!parse_id(s,l,&id))AE(401,"invalid token payload");}
 if(jfind((char*)pb,pl,"username",&v)<0||!v)AE(401,"invalid token payload");
 {int l;if(*v!='"'||!jstr(v,(char*)pb+pl,uname,256,&l))AE(401,"invalid token payload");*ulen=l;}
 *uid=id;return 0;}

static int handle(const char*m,int mn,const char*path,int pn,const char*authh,int an,const char*body,int bn,char*resp){
 char*o=out+4096; int bl;
 #define SEND(code) return respond(resp,code,o,bl)
 if(mn==3&&!memcmp(m,"GET",3)){
  if(pn==7&&!memcmp(path,"/health",7)){ if(sqlite3_step(st_health)!=SQLITE_ROW){sqlite3_reset(st_health);ERR(503,"x");} sqlite3_reset(st_health);
    bl=sprintf(o,"{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":%ld}",(long)(time(NULL)-t0));SEND(200);}
  if(pn==5&&!memcmp(path,"/feed",5)){ bl=sprintf(o,"{\"posts\":[");int first=1;int rc;while((rc=sqlite3_step(st_feed))==SQLITE_ROW){if(!first)o[bl++]=',';first=0;o[bl++]='{'-0; bl--; bl+=post_json(o+bl,st_feed,NULL,0);}
    sqlite3_reset(st_feed);o[bl++]=']';o[bl++]='}';SEND(200);}
  if(pn>7&&!memcmp(path,"/posts/",7)){long long id;if(!parse_id(path+7,pn-7,&id))ERR(400,"invalid post id");
    sqlite3_bind_int64(st_post,1,id);if(sqlite3_step(st_post)!=SQLITE_ROW){sqlite3_reset(st_post);ERR(404,"post not found");}
    bl=sprintf(o,"{\"post\":");bl+=post_json(o+bl,st_post,NULL,0);o[bl++]='}';sqlite3_reset(st_post);SEND(200);}
  ERR(404,"not found");}
 if(mn==4&&!memcmp(m,"POST",4)){
  int islike=0;long long pid=0;
  if(pn==6&&!memcmp(path,"/posts",6)){}
  else if(pn>12&&!memcmp(path,"/posts/",7)&&!memcmp(path+pn-5,"/like",5)){islike=1;}
  else ERR(404,"not found");
  long long uid;char un[256];int ul,rl;
  if(auth(authh,an,&uid,un,&ul,resp,&rl)<0)return rl;
  if(islike){ if(!parse_id(path+7,pn-12,&pid))ERR(400,"invalid post id");
    sqlite3_bind_int64(st_exists,1,pid);int r=sqlite3_step(st_exists);sqlite3_reset(st_exists);if(r!=SQLITE_ROW)ERR(404,"post not found");
    sqlite3_bind_int64(st_like,1,uid);sqlite3_bind_int64(st_like,2,pid);r=sqlite3_step(st_like);sqlite3_reset(st_like);if(r!=SQLITE_DONE)ERR(500,"internal server error");
    int ins=sqlite3_changes(db);bl=sprintf(o,"{\"liked\":true,\"already_liked\":%s,\"post_id\":%lld}",ins?"false":"true",pid);SEND(ins?201:200);}
  const char*v;if(jfind(body,bn,"body",&v)<0){const char*q=skipws(body,body+bn);const char*r=bn?skipval(q,body+bn):NULL;if(r&&skipws(r,body+bn)==body+bn)ERR(400,"body is required");ERR(400,"malformed JSON body");}
  static char b[4096];int l;if(!v||*v!='"'||!jstr(v,body+bn,b,sizeof b,&l)){ if(v&&*v=='"')ERR(400,"body must be at most 500 characters"); ERR(400,"body is required");}
  char*s=b;int e=l;while(e>0&&s[e-1]&&strchr(" \t\n\r\f\v",s[e-1]))e--;while(e>0&&*s&&strchr(" \t\n\r\f\v",*s)){s++;e--;}
  if(e==0)ERR(400,"body is required");
  int cp=0;for(int i=0;i<e;i++)if((s[i]&0xC0)!=0x80)cp++; if(cp>500)ERR(400,"body must be at most 500 characters");
  sqlite3_bind_int64(st_ins,1,uid);sqlite3_bind_text(st_ins,2,s,e,SQLITE_STATIC);
  if(sqlite3_step(st_ins)!=SQLITE_ROW){sqlite3_reset(st_ins);ERR(500,"internal server error");}
  bl=sprintf(o,"{\"post\":{\"id\":%lld,\"body\":\"",(long long)sqlite3_column_int64(st_ins,0));bl+=esc(o+bl,s,e);
  bl+=sprintf(o+bl,"\",\"created_at\":\"%s\",\"author\":\"",(const char*)sqlite3_column_text(st_ins,1));bl+=esc(o+bl,un,ul);bl+=sprintf(o+bl,"\",\"like_count\":0}}");
  sqlite3_reset(st_ins);SEND(201);}
 ERR(404,"not found");}

// returns consumed bytes, 0 if incomplete, -1 if bad; appends response to resp
static int one_request(const char*buf,size_t n,char*resp,int*rl,int*close_){
 const char*he=memmem(buf,n,"\r\n\r\n",4);if(!he)return 0;size_t hl=he+4-buf;
 const char*sp1=memchr(buf,' ',hl);if(!sp1)return -1;const char*sp2=memchr(sp1+1,' ',hl-(sp1+1-buf));if(!sp2)return -1;
 const char*path=sp1+1;int pn=sp2-path;const char*q=memchr(path,'?',pn);if(q)pn=q-path;
 const char*authh=NULL;int an=0;long cl=0;*close_=0;
 const char*p=memchr(buf,'\n',hl);p++;
 while(p<he){const char*le=memchr(p,'\n',he+2-p);if(!le)break;int ll=le-p;if(ll>0&&p[ll-1]=='\r')ll--;
  if(ll>=14&&!strncasecmp(p,"authorization:",14)){const char*v=p+14;while(v<p+ll&&(*v==' '||*v=='\t'))v++;authh=v;an=p+ll-v;}
  else if(ll>=15&&!strncasecmp(p,"content-length:",15))cl=atol(p+15);
  else if(ll>=11&&!strncasecmp(p,"connection:",11)){if(memmem(p+11,ll-11,"close",5))*close_=1;}
  p=le+1;}
 if(cl<0||cl>65536)return -1;
 if(hl+cl>n)return 0;
 *rl=handle(buf,sp1-buf,path,pn,authh,an,buf+hl,cl,resp);
 return hl+cl;}

static void closec(int fd){epoll_ctl(ep,EPOLL_CTL_DEL,fd,0);close(fd);if(conns[fd]){free(conns[fd]->buf);free(conns[fd]->ob);free(conns[fd]);conns[fd]=0;}}

static void flushc(int fd){conn_t*c=conns[fd];while(c->ooff<c->olen){ssize_t w=send(fd,c->ob+c->ooff,c->olen-c->ooff,MSG_NOSIGNAL);if(w<0){if(errno==EAGAIN)return;closec(fd);return;}c->ooff+=w;}
 free(c->ob);c->ob=0;c->olen=c->ooff=0;struct epoll_event ev={.events=EPOLLIN,.data.fd=fd};epoll_ctl(ep,EPOLL_CTL_MOD,fd,&ev);}

static char rbuf[1<<17];
int main(){
 signal(SIGPIPE,SIG_IGN);
 
 const char*path=getenv("SQLITE_PATH"),*sec=getenv("JWT_SECRET"),*host=getenv("HOST"),*port=getenv("PORT");
 hmac_init(sec?sec:"");t0=time(NULL);out=malloc(outcap);
 struct rlimit rl={65535,65535};setrlimit(RLIMIT_NOFILE,&rl);
 if(sqlite3_open_v2(path,&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,0)){fprintf(stderr,"open fail\n");return 1;}
 sqlite3_busy_timeout(db,5000);DBP=path;if(getenv("CKPT_BG")){sqlite3_exec(db,"PRAGMA wal_autocheckpoint=0;",0,0,0);pthread_t th;pthread_create(&th,0,ckthread,0);}
 sqlite3_exec(db,"PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA mmap_size=1073741824;PRAGMA cache_size=-32768;PRAGMA temp_store=MEMORY;",0,0,0);
 const char*pc="SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id ";
 char sql[600];
 snprintf(sql,sizeof sql,"%sORDER BY p.created_at DESC,p.id DESC LIMIT 20",pc);sqlite3_prepare_v3(db,sql,-1,SQLITE_PREPARE_PERSISTENT,&st_feed,0);
 snprintf(sql,sizeof sql,"%sWHERE p.id=?",pc);sqlite3_prepare_v3(db,sql,-1,SQLITE_PREPARE_PERSISTENT,&st_post,0);
 sqlite3_prepare_v3(db,"INSERT INTO posts(user_id,body) VALUES(?,?) RETURNING id,created_at",-1,SQLITE_PREPARE_PERSISTENT,&st_ins,0);
 sqlite3_prepare_v3(db,"SELECT 1 FROM posts WHERE id=?",-1,SQLITE_PREPARE_PERSISTENT,&st_exists,0);
 sqlite3_prepare_v3(db,"INSERT INTO likes(user_id,post_id) VALUES(?,?) ON CONFLICT(user_id,post_id) DO NOTHING",-1,SQLITE_PREPARE_PERSISTENT,&st_like,0);
 sqlite3_prepare_v3(db,"SELECT 1",-1,SQLITE_PREPARE_PERSISTENT,&st_health,0);
 int ls=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK,0);int one=1;setsockopt(ls,SOL_SOCKET,SO_REUSEADDR,&one,4);
 struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(atoi(port?port:"3000"))};inet_pton(AF_INET,host?host:"127.0.0.1",&a.sin_addr);
 if(bind(ls,(void*)&a,sizeof a)||listen(ls,65535)){perror("bind");return 1;}
 ep=epoll_create1(0);struct epoll_event ev={.events=EPOLLIN,.data.fd=ls};epoll_ctl(ep,EPOLL_CTL_ADD,ls,&ev);
 static struct epoll_event evs[512];
 for(;;){int n=epoll_wait(ep,evs,512,-1);
  for(int i=0;i<n;i++){int fd=evs[i].data.fd;
   if(fd==ls){for(;;){int c=accept4(ls,0,0,SOCK_NONBLOCK);if(c<0)break;if(c>=70000){close(c);continue;}setsockopt(c,IPPROTO_TCP,TCP_NODELAY,&one,4);struct epoll_event e={.events=EPOLLIN,.data.fd=c};epoll_ctl(ep,EPOLL_CTL_ADD,c,&e);}continue;}
   if(evs[i].events&EPOLLOUT){if(conns[fd])flushc(fd);if(!(evs[i].events&EPOLLIN))continue;}
   conn_t*c=conns[fd];
   if(c&&c->ob)continue; // backpressure
   ssize_t r=recv(fd,rbuf,sizeof rbuf-1,0);
   if(r==0||(r<0&&errno!=EAGAIN&&errno!=EINTR)){closec(fd);continue;} if(r<0)continue;
   const char*data=rbuf;size_t dn=r;char*tmp=NULL;
   if(c&&c->len){tmp=malloc(c->len+r);memcpy(tmp,c->buf,c->len);memcpy(tmp+c->len,rbuf,r);data=tmp;dn=c->len+r;free(c->buf);c->buf=0;c->len=0;}
   static char resp[1<<20];size_t rl2=0;int cl_=0,bad=0;
   while(dn){int rl3,cls;int u=one_request(data,dn,resp+rl2,&rl3,&cls);if(u<0){bad=1;break;}if(u==0)break;rl2+=rl3;data+=u;dn-=u;if(cls){cl_=1;break;}}
   if(dn&&!bad&&!cl_){if(!conns[fd])conns[fd]=calloc(1,sizeof(conn_t));conns[fd]->buf=malloc(dn);memcpy(conns[fd]->buf,data,dn);conns[fd]->len=dn;}
   free(tmp);
   if(bad){const char*b="{\"error\":\"internal server error\"}";rl2+=respond(resp+rl2,400,b,strlen(b));cl_=1;}
   size_t off=0;while(off<rl2){ssize_t w=send(fd,resp+off,rl2-off,MSG_NOSIGNAL);if(w<0){if(errno==EAGAIN)break;cl_=1;break;}off+=w;}
   if(off<rl2&&!cl_){if(!conns[fd])conns[fd]=calloc(1,sizeof(conn_t));conn_t*cc=conns[fd];cc->olen=rl2-off;cc->ob=malloc(cc->olen);memcpy(cc->ob,resp+off,cc->olen);cc->ooff=0;struct epoll_event e={.events=EPOLLIN|EPOLLOUT,.data.fd=fd};epoll_ctl(ep,EPOLL_CTL_MOD,fd,&e);}
   if(cl_)closec(fd);
  }}
}
