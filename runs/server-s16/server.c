// Prototype: single-thread epoll HTTP/1.1 server on SQLite (system libsqlite3).
#define _GNU_SOURCE
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <time.h>
#include <pthread.h>
#include <signal.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

/* ---------- SHA-256 / HMAC ---------- */
typedef struct { uint32_t h[8]; uint64_t len; uint8_t buf[64]; int n; } sha_t;
static const uint32_t K[64]={0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
#define ROR(x,n) (((x)>>(n))|((x)<<(32-(n))))
static void sha_block(uint32_t*h,const uint8_t*p){
  uint32_t w[64],a,b,c,d,e,f,g,hh;
  for(int i=0;i<16;i++) w[i]=(uint32_t)p[4*i]<<24|p[4*i+1]<<16|p[4*i+2]<<8|p[4*i+3];
  for(int i=16;i<64;i++){uint32_t s0=ROR(w[i-15],7)^ROR(w[i-15],18)^(w[i-15]>>3),s1=ROR(w[i-2],17)^ROR(w[i-2],19)^(w[i-2]>>10);w[i]=w[i-16]+s0+w[i-7]+s1;}
  a=h[0];b=h[1];c=h[2];d=h[3];e=h[4];f=h[5];g=h[6];hh=h[7];
  for(int i=0;i<64;i++){uint32_t S1=ROR(e,6)^ROR(e,11)^ROR(e,25),ch=(e&f)^(~e&g),t1=hh+S1+ch+K[i]+w[i],S0=ROR(a,2)^ROR(a,13)^ROR(a,22),mj=(a&b)^(a&c)^(b&c),t2=S0+mj;hh=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;}
  h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;}
static void sha_init(sha_t*s){static const uint32_t i[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};memcpy(s->h,i,32);s->len=0;s->n=0;}
static void sha_upd(sha_t*s,const uint8_t*p,size_t l){s->len+=l;
  if(s->n){size_t t=64-s->n;if(t>l)t=l;memcpy(s->buf+s->n,p,t);s->n+=t;p+=t;l-=t;if(s->n==64){sha_block(s->h,s->buf);s->n=0;}}
  while(l>=64){sha_block(s->h,p);p+=64;l-=64;}
  if(l){memcpy(s->buf,p,l);s->n=l;}}
static void sha_fin(sha_t*s,uint8_t*out){uint64_t bits=s->len*8;uint8_t pad[72]={0x80};size_t pl=(s->n<56)?56-s->n:120-s->n;
  uint8_t lb[8];for(int i=0;i<8;i++)lb[i]=bits>>(56-8*i);sha_upd(s,pad,pl);sha_upd(s,lb,8);
  for(int i=0;i<8;i++){out[4*i]=s->h[i]>>24;out[4*i+1]=s->h[i]>>16;out[4*i+2]=s->h[i]>>8;out[4*i+3]=s->h[i];}}
static sha_t HIN,HOUT;
static void hmac_setup(const char*key,size_t kl){uint8_t k[64]={0},ip[64],op[64];if(kl>64){sha_t s;sha_init(&s);sha_upd(&s,(uint8_t*)key,kl);sha_fin(&s,k);}else memcpy(k,key,kl);
  for(int i=0;i<64;i++){ip[i]=k[i]^0x36;op[i]=k[i]^0x5c;}sha_init(&HIN);sha_upd(&HIN,ip,64);sha_init(&HOUT);sha_upd(&HOUT,op,64);}
static void hmac(const uint8_t*m,size_t l,uint8_t*out){sha_t a=HIN;uint8_t d[32];sha_upd(&a,m,l);sha_fin(&a,d);sha_t b=HOUT;sha_upd(&b,d,32);sha_fin(&b,out);}

/* ---------- base64url ---------- */
static const char B64[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
static int8_t B64D[256];
static void b64init(){memset(B64D,-1,256);for(int i=0;i<64;i++)B64D[(uint8_t)B64[i]]=i;}
static void b64enc32(const uint8_t*in,char*out){int o=0;for(int i=0;i<30;i+=3){uint32_t v=in[i]<<16|in[i+1]<<8|in[i+2];out[o++]=B64[v>>18];out[o++]=B64[(v>>12)&63];out[o++]=B64[(v>>6)&63];out[o++]=B64[v&63];}
  uint32_t v=in[30]<<16|in[31]<<8;out[o++]=B64[v>>18];out[o++]=B64[(v>>12)&63];out[o++]=B64[(v>>6)&63];} // 43 chars
static int b64dec(const char*s,size_t n,char*out,size_t cap){ // unpadded url-safe
  size_t o=0;uint32_t acc=0;int bits=0;if(n%4==1)return -1;
  for(size_t i=0;i<n;i++){int v=B64D[(uint8_t)s[i]];if(v<0)return -1;acc=acc<<6|v;bits+=6;if(bits>=8){bits-=8;if(o>=cap)return -1;out[o++]=(acc>>bits)&255;}}
  return o;}

/* ---------- JSON ---------- */
typedef struct { const char*s; const char*e; } sp_t; // raw value span
static const char* jws(const char*p,const char*e){while(p<e&&(*p==' '||*p=='\t'||*p=='\n'||*p=='\r'))p++;return p;}
static const char* jstr(const char*p,const char*e){ // p at opening quote; returns after closing or NULL
  p++;while(p<e){unsigned char c=*p;if(c=='"')return p+1;if(c<0x20)return NULL;
    if(c=='\\'){p++;if(p>=e)return NULL;c=*p;if(c=='u'){if(e-p<5)return NULL;for(int i=1;i<=4;i++){if(!((p[i]>='0'&&p[i]<='9')||(p[i]>='a'&&p[i]<='f')||(p[i]>='A'&&p[i]<='F')))return NULL;}p+=5;continue;}
      if(!strchr("\"\\/bfnrt",c))return NULL;}
    p++;}
  return NULL;}
static const char* jval(const char*p,const char*e,int depth){
  p=jws(p,e);if(p>=e||depth>64)return NULL;
  switch(*p){
  case '"':return jstr(p,e);
  case '{':{p=jws(p+1,e);if(p<e&&*p=='}')return p+1;for(;;){p=jws(p,e);if(p>=e||*p!='"')return NULL;p=jstr(p,e);if(!p)return NULL;p=jws(p,e);if(p>=e||*p!=':')return NULL;p=jval(p+1,e,depth+1);if(!p)return NULL;p=jws(p,e);if(p>=e)return NULL;if(*p==','){p++;continue;}if(*p=='}')return p+1;return NULL;}}
  case '[':{p=jws(p+1,e);if(p<e&&*p==']')return p+1;for(;;){p=jval(p,e,depth+1);if(!p)return NULL;p=jws(p,e);if(p>=e)return NULL;if(*p==','){p++;continue;}if(*p==']')return p+1;return NULL;}}
  case 't':if(e-p>=4&&!memcmp(p,"true",4))return p+4;return NULL;
  case 'f':if(e-p>=5&&!memcmp(p,"false",5))return p+5;return NULL;
  case 'n':if(e-p>=4&&!memcmp(p,"null",4))return p+4;return NULL;
  default:{if(*p=='-')p++;if(p>=e)return NULL;if(*p=='0')p++;else if(*p>='1'&&*p<='9'){while(p<e&&*p>='0'&&*p<='9')p++;}else return NULL;
    if(p<e&&*p=='.'){p++;if(p>=e||*p<'0'||*p>'9')return NULL;while(p<e&&*p>='0'&&*p<='9')p++;}
    if(p<e&&(*p=='e'||*p=='E')){p++;if(p<e&&(*p=='+'||*p=='-'))p++;if(p>=e||*p<'0'||*p>'9')return NULL;while(p<e&&*p>='0'&&*p<='9')p++;}
    return p;}}}
// decode JSON string span (with quotes) into out (cap), returns length or -1
static int jdecode(const char*p,const char*e,char*out,int cap){ int o=0; p++; e--; 
  while(p<e){ if(o+4>=cap) return -1; unsigned char c=*p;
    if(c!='\\'){out[o++]=c;p++;continue;}
    p++;c=*p++;
    switch(c){case 'b':out[o++]='\b';break;case 'f':out[o++]='\f';break;case 'n':out[o++]='\n';break;case 'r':out[o++]='\r';break;case 't':out[o++]='\t';break;
      case 'u':{unsigned cp=strtoul((char[]){p[0],p[1],p[2],p[3],0},0,16);p+=4;
        if(cp>=0xD800&&cp<0xDC00&&e-p>=6&&p[0]=='\\'&&p[1]=='u'){unsigned lo=strtoul((char[]){p[2],p[3],p[4],p[5],0},0,16);if(lo>=0xDC00&&lo<0xE000){cp=0x10000+((cp-0xD800)<<10)+(lo-0xDC00);p+=6;}}
        if(cp<0x80)out[o++]=cp;else if(cp<0x800){out[o++]=0xC0|cp>>6;out[o++]=0x80|(cp&63);}else if(cp<0x10000){out[o++]=0xE0|cp>>12;out[o++]=0x80|((cp>>6)&63);out[o++]=0x80|(cp&63);}else{out[o++]=0xF0|cp>>18;out[o++]=0x80|((cp>>12)&63);out[o++]=0x80|((cp>>6)&63);out[o++]=0x80|(cp&63);}
        break;}
      default:out[o++]=c;}}
  return o;}
// Top-level object member lookup (last duplicate wins). returns 1 ok parse, 0 malformed. *found span or s=NULL.
static int jobj_get(const char*s,size_t n,const char*key,sp_t*found){
  const char*e=s+n,*p=jws(s,e);found->s=found->e=NULL;
  if(p>=e)return 0; const char*end=jval(p,e,0); if(!end)return 0; if(jws(end,e)!=e)return 0;
  if(*p!='{')return 1; // valid non-object: no members
  size_t kl=strlen(key);p=jws(p+1,e);if(*p=='}')return 1;
  for(;;){p=jws(p,e);const char*ks=p;const char*ke=jstr(p,e);p=jws(ke,e)+1;const char*vs=jws(p,e);const char*ve=jval(vs,e,1);
    char kb[64];int match=0;if((size_t)(ke-ks)<60){int l=jdecode(ks,ke,kb,64);if(l==(int)kl&&!memcmp(kb,key,kl))match=1;}
    if(match){found->s=vs;found->e=ve;}
    p=jws(ve,e);if(*p==','){p++;continue;}return 1;}}

/* ---------- state ---------- */
static sqlite3*db;
static sqlite3_stmt *S_feed,*S_post,*S_exists,*S_like,*S_ins,*S_health;
static struct timespec T0;
static char outbuf_scratch[1<<17];

typedef struct { int fd; char*in; int inlen,incap; char*out; int outlen,outcap,off; int dirty,closing; } conn_t;
static conn_t *conns; static int *dirtyl; static int ndirty;
static int in_txn;

static void oapp(conn_t*c,const char*s,int n){ if(c->outlen+n>c->outcap){int nc=c->outcap?c->outcap*2:1024;while(nc<c->outlen+n)nc*=2;c->out=realloc(c->out,nc);c->outcap=nc;} memcpy(c->out+c->outlen,s,n);c->outlen+=n; if(!c->dirty){c->dirty=1;dirtyl[ndirty++]=c->fd;} }

static int jesc(char*o,const unsigned char*s,int n){char*q=o;for(int i=0;i<n;i++){unsigned char c=s[i];
  if(c=='"'){*q++='\\';*q++='"';}else if(c=='\\'){*q++='\\';*q++='\\';}else if(c<0x20){static const char H[]="0123456789abcdef";if(c=='\n'){*q++='\\';*q++='n';}else if(c=='\r'){*q++='\\';*q++='r';}else if(c=='\t'){*q++='\\';*q++='t';}else{memcpy(q,"\\u00",4);q+=4;*q++=H[c>>4];*q++=H[c&15];}}else *q++=c;}
  return q-o;}

static void respond(conn_t*c,int status,const char*body,int bl){
  static const char*ST[600];
  const char*st = status==200?"200 OK":status==201?"201 Created":status==400?"400 Bad Request":status==401?"401 Unauthorized":status==404?"404 Not Found":status==503?"503 Service Unavailable":"500 Internal Server Error";(void)ST;
  char h[160];int n=snprintf(h,sizeof h,"HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n",st,bl);
  oapp(c,h,n);oapp(c,body,bl);}
static void err(conn_t*c,int status,const char*msg){char b[96];int n=snprintf(b,sizeof b,"{\"error\":\"%s\"}",msg);respond(c,status,b,n);}

// post JSON into buffer from current row of stmt (cols: id, body, created_at, username, like_count)
static char* emit_post(char*q,sqlite3_stmt*s){
  q+=sprintf(q,"{\"id\":%lld,\"body\":\"",sqlite3_column_int64(s,0));
  q+=jesc(q,sqlite3_column_text(s,1),sqlite3_column_bytes(s,1));
  memcpy(q,"\",\"created_at\":\"",16);q+=16;int l=sqlite3_column_bytes(s,2);memcpy(q,sqlite3_column_text(s,2),l);q+=l;
  memcpy(q,"\",\"author\":\"",12);q+=12;q+=jesc(q,sqlite3_column_text(s,3),sqlite3_column_bytes(s,3));
  q+=sprintf(q,"\",\"like_count\":%lld}",sqlite3_column_int64(s,4));return q;}

/* ---------- auth ---------- */
static int64_t A_uid; static char A_name[512]; static int A_nlen;
static int auth(conn_t*c,const char*h,int hl){
  if(!h||hl<7||strncmp(h,"Bearer ",7)){err(c,401,"missing bearer token");return 1;}
  const char*t=h+7;int tl=hl-7;
  const char*d1=memchr(t,'.',tl);const char*d2=d1?memchr(d1+1,'.',t+tl-d1-1):NULL;
  if(!d1||!d2||memchr(d2+1,'.',t+tl-d2-1)||t+tl-d2-1!=43){err(c,401,"invalid or expired token");return 1;}
  uint8_t mac[32];char ex[43];hmac((const uint8_t*)t,d2-t,mac);b64enc32(mac,ex);
  int diff=0;for(int i=0;i<43;i++)diff|=ex[i]^d2[1+i];
  if(diff){err(c,401,"invalid or expired token");return 1;}
  char hb[256],pb[2048];int hn=b64dec(t,d1-t,hb,sizeof hb),pn=b64dec(d1+1,d2-d1-1,pb,sizeof pb);
  sp_t a,sub,un,exp;
  if(hn<0||pn<0||!jobj_get(hb,hn,"alg",&a)||!a.s||a.e-a.s!=7||memcmp(a.s,"\"HS256\"",7)||!jobj_get(pb,pn,"exp",&exp)){err(c,401,"invalid or expired token");return 1;}
  if(exp.s){ char f=*exp.s; if(f=='"'||f=='t'||f=='f'||f=='n'||f=='{'||f=='['||strtod(exp.s,NULL)<=(double)time(NULL)){err(c,401,"invalid or expired token");return 1;} }
  jobj_get(pb,pn,"sub",&sub);jobj_get(pb,pn,"username",&un);
  int ok=sub.s&&*sub.s=='"'&&un.s&&*un.s=='"';
  if(ok){ // sub: digits only, >0
    const char*p=sub.s+1,*q=sub.e-1; ok=(q>p&&q-p<=15); int64_t v=0; for(;ok&&p<q;p++){ if(*p<'0'||*p>'9')ok=0; else v=v*10+(*p-'0'); } if(ok&&v<=0)ok=0; A_uid=v; }
  if(ok){ A_nlen=jdecode(un.s,un.e,A_name,sizeof A_name); if(A_nlen<0)ok=0; }
  if(!ok){err(c,401,"invalid token payload");return 1;}
  return 0;}

/* ---------- handlers ---------- */
static void h_feed(conn_t*c){
  char*q=outbuf_scratch;memcpy(q,"{\"posts\":[",10);q+=10;int first=1;
  while(sqlite3_step(S_feed)==SQLITE_ROW){ if(!first)*q++=',';first=0;q=emit_post(q,S_feed);}
  sqlite3_reset(S_feed);memcpy(q,"]}",2);q+=2;respond(c,200,outbuf_scratch,q-outbuf_scratch);}
static int64_t parse_id(const char*p,int n){ if(n<=0||n>15)return -1;int64_t v=0;for(int i=0;i<n;i++){if(p[i]<'0'||p[i]>'9')return -1;v=v*10+p[i]-'0';}return v>0?v:-1;}
static void h_post(conn_t*c,int64_t id){
  sqlite3_bind_int64(S_post,1,id);
  if(sqlite3_step(S_post)==SQLITE_ROW){char*q=outbuf_scratch;memcpy(q,"{\"post\":",8);q+=8;q=emit_post(q,S_post);*q++='}';sqlite3_reset(S_post);respond(c,200,outbuf_scratch,q-outbuf_scratch);}
  else{sqlite3_reset(S_post);err(c,404,"post not found");}}
static void begin_txn(){ if(!in_txn){sqlite3_exec(db,"BEGIN IMMEDIATE",0,0,0);in_txn=1;} }
static void h_like(conn_t*c,int64_t id){
  sqlite3_bind_int64(S_exists,1,id);int ex=sqlite3_step(S_exists)==SQLITE_ROW;sqlite3_reset(S_exists);
  if(!ex){err(c,404,"post not found");return;}
  begin_txn();
  sqlite3_bind_int64(S_like,1,A_uid);sqlite3_bind_int64(S_like,2,id);
  int rc=sqlite3_step(S_like);sqlite3_reset(S_like);
  if(rc!=SQLITE_DONE){err(c,500,"internal server error");return;}
  int ins=sqlite3_changes(db)>0;char b[96];int n=snprintf(b,sizeof b,"{\"liked\":true,\"already_liked\":%s,\"post_id\":%lld}",ins?"false":"true",(long long)id);
  respond(c,ins?201:200,b,n);}
static int is_ws_at(const unsigned char*p,const unsigned char*e,int*len){ unsigned c=*p;
  if(c==' '||(c>=9&&c<=13)){*len=1;return 1;}
  if(c==0xC2&&e-p>=2&&p[1]==0xA0){*len=2;return 1;}
  if(c==0xEF&&e-p>=3&&p[1]==0xBB&&p[2]==0xBF){*len=3;return 1;}
  if(c==0xE2&&e-p>=3){unsigned v=p[1]<<8|p[2]; if((v>=0x8080&&v<=0x808A)||v==0x80A8||v==0x80A9||v==0x80AF||v==0x819F){*len=3;return 1;}}
  if(c==0xE3&&e-p>=3&&p[1]==0x80&&p[2]==0x80){*len=3;return 1;}
  if(c==0xE1&&e-p>=3&&p[1]==0x9A&&p[2]==0x80){*len=3;return 1;}
  return 0;}
static void h_create(conn_t*c,const char*body,int bl){
  sp_t b;if(!jobj_get(body,bl,"body",&b)){err(c,400,"malformed JSON body");return;}
  if(!b.s||*b.s!='"'){err(c,400,"body is required");return;}
  static char txt[16384];int n=jdecode(b.s,b.e,txt,sizeof txt);if(n<0){err(c,400,"body must be at most 500 characters");return;}
  unsigned char*s=(unsigned char*)txt,*e=s+n;int l;
  while(s<e&&is_ws_at(s,e,&l))s+=l;
  for(;;){ // trim trailing: try ws lengths 1..3 ending at e
    int done=1; for(int k=1;k<=3&&e-s>=k;k++){int ll;if(is_ws_at(e-k,e,&ll)&&ll==k){e-=k;done=0;break;}} if(done)break;}
  if(e==s){err(c,400,"body is required");return;}
  int chars=0;for(unsigned char*p=s;p<e;p++)if((*p&0xC0)!=0x80)chars++;
  if(chars>500){err(c,400,"body must be at most 500 characters");return;}
  begin_txn();
  sqlite3_bind_int64(S_ins,1,A_uid);sqlite3_bind_text(S_ins,2,(char*)s,e-s,SQLITE_STATIC);
  if(sqlite3_step(S_ins)!=SQLITE_ROW){sqlite3_reset(S_ins);err(c,500,"internal server error");return;}
  char*q=outbuf_scratch;q+=sprintf(q,"{\"post\":{\"id\":%lld,\"body\":\"",sqlite3_column_int64(S_ins,0));
  q+=jesc(q,s,e-s);memcpy(q,"\",\"created_at\":\"",16);q+=16;int cl=sqlite3_column_bytes(S_ins,1);memcpy(q,sqlite3_column_text(S_ins,1),cl);q+=cl;
  memcpy(q,"\",\"author\":\"",12);q+=12;q+=jesc(q,(unsigned char*)A_name,A_nlen);memcpy(q,"\",\"like_count\":0}}",18);q+=18;
  sqlite3_reset(S_ins);respond(c,201,outbuf_scratch,q-outbuf_scratch);}
static void h_health(conn_t*c){
  int rc=sqlite3_step(S_health);sqlite3_reset(S_health);char b[200];int n;
  if(rc==SQLITE_ROW){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);n=snprintf(b,sizeof b,"{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":%ld}",(long)(t.tv_sec-T0.tv_sec));respond(c,200,b,n);}
  else{n=snprintf(b,sizeof b,"{\"status\":\"degraded\",\"db\":\"unreachable\",\"error\":\"unreachable\"}");respond(c,503,b,n);}}

/* ---------- HTTP ---------- */
static int ieq(const char*a,const char*b,int n){for(int i=0;i<n;i++){char x=a[i],y=b[i];if(x>='A'&&x<='Z')x+=32;if(x!=y)return 0;}return 1;}
// returns bytes consumed, 0 if incomplete, -1 close
static int handle(conn_t*c,const char*buf,int len){
  const char*he=memmem(buf,len,"\r\n\r\n",4);if(!he){return len>65536?-1:0;}
  int hlen=he+4-buf;const char*p=buf,*le=memchr(p,'\r',hlen);
  const char*m=p,*sp1=memchr(p,' ',le-p);if(!sp1)return -1;const char*pa=sp1+1,*sp2=memchr(pa,' ',le-pa);if(!sp2)return -1;
  const char*auth_h=NULL;int auth_l=0;long cl=0;int close_=0;
  for(p=le+2;p<he+2;){const char*e=memchr(p,'\r',he+2-p);if(!e||e==p)break;const char*col=memchr(p,':',e-p);
    if(col){int nl=col-p;const char*v=col+1;while(v<e&&(*v==' '||*v=='\t'))v++;int vl=e-v;
      if(nl==13&&ieq(p,"authorization",13)){auth_h=v;auth_l=vl;}
      else if(nl==14&&ieq(p,"content-length",14)){cl=strtol(v,NULL,10);}
      else if(nl==10&&ieq(p,"connection",10)){if(vl>=5&&ieq(v,"close",5))close_=1;}}
    p=e+2;}
  if(cl<0||cl>65536)return -1;
  if(len-hlen<cl)return 0;
  const char*body=buf+hlen;int total=hlen+cl;
  int ml=sp1-m;const char*path=pa;int pl=sp2-pa;const char*qm=memchr(pa,'?',pl);if(qm)pl=qm-pa;
  int isget=ml==3&&!memcmp(m,"GET",3),ispost=ml==4&&!memcmp(m,"POST",4);
  if(isget&&pl==5&&!memcmp(path,"/feed",5))h_feed(c);
  else if(isget&&pl==7&&!memcmp(path,"/health",7))h_health(c);
  else if(isget&&pl>=7&&!memcmp(path,"/posts/",7)){int64_t id=parse_id(path+7,pl-7);if(id<0)err(c,400,"invalid post id");else h_post(c,id);}
  else if(ispost&&pl==6&&!memcmp(path,"/posts",6)){if(!auth(c,auth_h,auth_l))h_create(c,body,cl);}
  else if(ispost&&pl>=12&&!memcmp(path,"/posts/",7)&&!memcmp(path+pl-5,"/like",5)){
    if(!auth(c,auth_h,auth_l)){int64_t id=parse_id(path+7,pl-12);if(id<0)err(c,400,"invalid post id");else h_like(c,id);}}
  else err(c,404,"not found");
  if(close_)c->closing=1;
  return total;}

static int ep;
static void closeconn(conn_t*c){epoll_ctl(ep,EPOLL_CTL_DEL,c->fd,0);close(c->fd);free(c->in);free(c->out);int fd=c->fd;memset(c,0,sizeof *c);c->fd=0;(void)fd;}
static void flush(conn_t*c){
  while(c->off<c->outlen){ssize_t w=send(c->fd,c->out+c->off,c->outlen-c->off,MSG_NOSIGNAL);
    if(w<0){if(errno==EAGAIN){struct epoll_event ev={.events=EPOLLIN|EPOLLOUT,.data.fd=c->fd};epoll_ctl(ep,EPOLL_CTL_MOD,c->fd,&ev);return;}closeconn(c);return;}
    c->off+=w;}
  c->outlen=c->off=0; if(c->outcap>16384){free(c->out);c->out=NULL;c->outcap=0;}
  if(c->closing)closeconn(c);}

static void *ckpt_thread(void*arg){
  sqlite3*d;sqlite3_open_v2((char*)arg,&d,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,0);sqlite3_busy_timeout(d,2000);
  for(;;){usleep(1000000);sqlite3_wal_checkpoint_v2(d,NULL,SQLITE_CHECKPOINT_PASSIVE,NULL,NULL);}
  return NULL;}

int main(){
  signal(SIGPIPE,SIG_IGN);b64init();clock_gettime(CLOCK_MONOTONIC,&T0);
  const char*sec=getenv("JWT_SECRET");hmac_setup(sec,strlen(sec));
  const char*path=getenv("SQLITE_PATH"),*host=getenv("HOST"),*ps=getenv("PORT");
  if(sqlite3_open_v2(path,&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,0)){fprintf(stderr,"open fail\n");return 1;}
  sqlite3_busy_timeout(db,5000);
  sqlite3_exec(db,"PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA wal_autocheckpoint=0;PRAGMA mmap_size=1073741824;PRAGMA cache_size=-262144;PRAGMA temp_store=MEMORY;",0,0,0);
  #define P(s,q) if(sqlite3_prepare_v3(db,q,-1,SQLITE_PREPARE_PERSISTENT,&s,0)){fprintf(stderr,"prep: %s\n",sqlite3_errmsg(db));return 1;}
  const char*cols="p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id)";
  char q[600];
  snprintf(q,sizeof q,"SELECT %s FROM posts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC,p.id DESC LIMIT 20",cols);P(S_feed,q);
  snprintf(q,sizeof q,"SELECT %s FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?1",cols);P(S_post,q);
  P(S_exists,"SELECT 1 FROM posts WHERE id=?1");
  P(S_like,"INSERT INTO likes (user_id,post_id) VALUES (?1,?2) ON CONFLICT (user_id,post_id) DO NOTHING");
  P(S_ins,"INSERT INTO posts (user_id,body) VALUES (?1,?2) RETURNING id,created_at");
  P(S_health,"SELECT 1");
  pthread_t th;pthread_create(&th,0,ckpt_thread,(void*)path);
  conns=calloc(1<<17,sizeof(conn_t));dirtyl=malloc(sizeof(int)*(1<<17));
  int ls=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK,0);int one=1;setsockopt(ls,SOL_SOCKET,SO_REUSEADDR,&one,sizeof one);
  struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(atoi(ps?ps:"3000"))};inet_pton(AF_INET,host?host:"127.0.0.1",&a.sin_addr);
  if(bind(ls,(void*)&a,sizeof a)||listen(ls,4096)){perror("bind");return 1;}
  ep=epoll_create1(0);struct epoll_event ev={.events=EPOLLIN,.data.fd=ls};epoll_ctl(ep,EPOLL_CTL_ADD,ls,&ev);
  static struct epoll_event evs[512];static char rbuf[70000];
  for(;;){
    int n=epoll_wait(ep,evs,512,-1);
    for(int i=0;i<n;i++){int fd=evs[i].data.fd;
      if(fd==ls){for(;;){int cfd=accept4(ls,0,0,SOCK_NONBLOCK);if(cfd<0)break;if(cfd>=(1<<17)){close(cfd);continue;}
          conns[cfd].fd=cfd;struct epoll_event e2={.events=EPOLLIN,.data.fd=cfd};epoll_ctl(ep,EPOLL_CTL_ADD,cfd,&e2);}continue;}
      conn_t*c=&conns[fd];
      if(evs[i].events&EPOLLOUT){flush(c);if(!c->fd)continue;if(c->off>=c->outlen){struct epoll_event e2={.events=EPOLLIN,.data.fd=fd};epoll_ctl(ep,EPOLL_CTL_MOD,fd,&e2);}}
      if(!(evs[i].events&(EPOLLIN|EPOLLHUP|EPOLLERR)))continue;
      ssize_t r=read(fd,rbuf,sizeof rbuf);
      if(r<=0){if(r<0&&errno==EAGAIN)continue;closeconn(c);continue;}
      const char*data=rbuf;int dl=r;
      if(c->inlen){if(c->inlen+dl>c->incap){c->incap=(c->inlen+dl)*2;c->in=realloc(c->in,c->incap);}memcpy(c->in+c->inlen,rbuf,dl);c->inlen+=dl;data=c->in;dl=c->inlen;}
      int off=0;
      while(off<dl&&!c->closing){int u=handle(c,data+off,dl-off);if(u<0){c->closing=1;break;}if(u==0)break;off+=u;}
      if(off<dl&&!c->closing){ if(data==rbuf||off>0){ if(data==rbuf){ if(dl-off>c->incap){c->incap=(dl-off)*2;c->in=realloc(c->in,c->incap);} memcpy(c->in,data+off,dl-off);} else memmove(c->in,c->in+off,dl-off);} c->inlen=dl-off;}
      else c->inlen=0;
    }
    if(in_txn){sqlite3_exec(db,"COMMIT",0,0,0);in_txn=0;}
    for(int i=0;i<ndirty;i++){conn_t*c=&conns[dirtyl[i]];if(!c->fd)continue;c->dirty=0;flush(c);}
    ndirty=0;
  }}
