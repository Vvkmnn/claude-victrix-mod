// $12 server: single-threaded epoll HTTP/1.1 server in C + SQLite (system libsqlite3).
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <signal.h>
#include <sqlite3.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

/* ---------------- SHA-256 / HMAC ---------------- */
static const uint32_t K[64] = {
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
#define ROR(x,n) (((x)>>(n))|((x)<<(32-(n))))
typedef struct { uint32_t h[8]; uint8_t buf[64]; uint64_t len; size_t bl; } sha_t;
static void sha_block(uint32_t *h, const uint8_t *p) {
  uint32_t w[64], a,b,c,d,e,f,g,hh;
  for (int i=0;i<16;i++) w[i]=(uint32_t)p[4*i]<<24|p[4*i+1]<<16|p[4*i+2]<<8|p[4*i+3];
  for (int i=16;i<64;i++){uint32_t s0=ROR(w[i-15],7)^ROR(w[i-15],18)^(w[i-15]>>3),s1=ROR(w[i-2],17)^ROR(w[i-2],19)^(w[i-2]>>10);w[i]=w[i-16]+s0+w[i-7]+s1;}
  a=h[0];b=h[1];c=h[2];d=h[3];e=h[4];f=h[5];g=h[6];hh=h[7];
  for (int i=0;i<64;i++){
    uint32_t S1=ROR(e,6)^ROR(e,11)^ROR(e,25),ch=(e&f)^(~e&g),t1=hh+S1+ch+K[i]+w[i];
    uint32_t S0=ROR(a,2)^ROR(a,13)^ROR(a,22),mj=(a&b)^(a&c)^(b&c),t2=S0+mj;
    hh=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
  }
  h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;
}
static void sha_init(sha_t *s){static const uint32_t i[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};memcpy(s->h,i,32);s->len=0;s->bl=0;}
static void sha_update(sha_t *s,const uint8_t *p,size_t n){
  s->len+=n;
  if (s->bl){size_t t=64-s->bl;if(t>n)t=n;memcpy(s->buf+s->bl,p,t);s->bl+=t;p+=t;n-=t;if(s->bl==64){sha_block(s->h,s->buf);s->bl=0;}}
  while(n>=64){sha_block(s->h,p);p+=64;n-=64;}
  if(n){memcpy(s->buf,p,n);s->bl=n;}
}
static void sha_final(sha_t *s,uint8_t *out){
  uint64_t bits=s->len*8; uint8_t pad=0x80; sha_update(s,&pad,1);
  uint8_t z=0; while(s->bl!=56) sha_update(s,&z,1);
  uint8_t l[8]; for(int i=0;i<8;i++) l[i]=bits>>(56-8*i); sha_update(s,l,8);
  for(int i=0;i<8;i++){out[4*i]=s->h[i]>>24;out[4*i+1]=s->h[i]>>16;out[4*i+2]=s->h[i]>>8;out[4*i+3]=s->h[i];}
}
static sha_t g_ipad, g_opad;
static void hmac_setkey(const char *key){
  uint8_t k[64]={0}, t[64]; size_t n=strlen(key);
  if(n>64){sha_t s;sha_init(&s);sha_update(&s,(const uint8_t*)key,n);sha_final(&s,k);} else memcpy(k,key,n);
  for(int i=0;i<64;i++)t[i]=k[i]^0x36; sha_init(&g_ipad);sha_update(&g_ipad,t,64);
  for(int i=0;i<64;i++)t[i]=k[i]^0x5c; sha_init(&g_opad);sha_update(&g_opad,t,64);
}
static void hmac(const uint8_t *m,size_t n,uint8_t *out){
  sha_t s=g_ipad; uint8_t in[32]; sha_update(&s,m,n); sha_final(&s,in);
  s=g_opad; sha_update(&s,in,32); sha_final(&s,out);
}
static const char B64U[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
static int b64u_val(int c){
  if(c>='A'&&c<='Z')return c-'A'; if(c>='a'&&c<='z')return c-'a'+26; if(c>='0'&&c<='9')return c-'0'+52;
  if(c=='-')return 62; if(c=='_')return 63; return -1;
}
// decode unpadded base64url; returns length or -1
static int b64u_dec(const char *s,size_t n,uint8_t *out){
  if(n%4==1) return -1;
  size_t o=0; uint32_t acc=0; int bits=0;
  for(size_t i=0;i<n;i++){int v=b64u_val((unsigned char)s[i]); if(v<0)return -1; acc=acc<<6|v;bits+=6; if(bits>=8){bits-=8;out[o++]=acc>>bits;acc&=(1u<<bits)-1;}}
  return (int)o;
}

/* ---------------- JSON ---------------- */
typedef struct { char t; /* 0 absent, 's','n','o' */ const char *s; size_t n; double num; } jv_t;
typedef struct { const char *p,*e; char *arena,*ap,*ae; } jp_t;
static void ws(jp_t *j){while(j->p<j->e&&(*j->p==' '||*j->p=='\t'||*j->p=='\n'||*j->p=='\r'))j->p++;}
static int hex4(const char *p){int v=0;for(int i=0;i<4;i++){int c=p[i];v<<=4;if(c>='0'&&c<='9')v|=c-'0';else if(c>='a'&&c<='f')v|=c-'a'+10;else if(c>='A'&&c<='F')v|=c-'A'+10;else return -1;}return v;}
static char *put_utf8(char *o,unsigned c){
  if(c<0x80)*o++=c; else if(c<0x800){*o++=0xC0|c>>6;*o++=0x80|(c&63);}
  else if(c<0x10000){*o++=0xE0|c>>12;*o++=0x80|((c>>6)&63);*o++=0x80|(c&63);}
  else{*o++=0xF0|c>>18;*o++=0x80|((c>>12)&63);*o++=0x80|((c>>6)&63);*o++=0x80|(c&63);}
  return o;
}
// parse string at j->p (after opening quote consumed? no: at the quote). decode into arena if want.
static int jstr(jp_t *j,const char **os,size_t *on,int want){
  if(j->p>=j->e||*j->p!='"')return -1; j->p++;
  char *o=j->ap; char *start=o;
  while(1){
    if(j->p>=j->e)return -1;
    unsigned char c=*j->p;
    if(c=='"'){j->p++;break;}
    if(c<0x20)return -1;
    if(c=='\\'){
      j->p++; if(j->p>=j->e)return -1; c=*j->p++;
      unsigned cp;
      switch(c){case '"':cp='"';break;case '\\':cp='\\';break;case '/':cp='/';break;case 'b':cp=8;break;case 'f':cp=12;break;case 'n':cp=10;break;case 'r':cp=13;break;case 't':cp=9;break;
        case 'u':{ if(j->e-j->p<4)return -1; int v=hex4(j->p); if(v<0)return -1; j->p+=4; cp=v;
          if(cp>=0xD800&&cp<0xDC00){ if(j->e-j->p>=6&&j->p[0]=='\\'&&j->p[1]=='u'){int v2=hex4(j->p+2); if(v2>=0xDC00&&v2<0xE000){cp=0x10000+((cp-0xD800)<<10)+(v2-0xDC00);j->p+=6;} else cp=0xFFFD;} else cp=0xFFFD; }
          else if(cp>=0xDC00&&cp<0xE000)cp=0xFFFD;
          break;}
        default:return -1;}
      if(want){ if(o+4>j->ae)return -1; o=put_utf8(o,cp);}
    } else {
      if(want){ if(o>=j->ae)return -1; *o++=c; }
      j->p++;
    }
  }
  if(want){*os=start;*on=o-start;j->ap=o;}
  return 0;
}
static int jval(jp_t *j,int depth,jv_t *out,int want);
static int jskip_container(jp_t *j,int depth){
  char open=*j->p++; char close=open=='{'?'}':']';
  ws(j); if(j->p<j->e&&*j->p==close){j->p++;return 0;}
  while(1){
    ws(j);
    if(open=='{'){ if(jstr(j,0,0,0))return -1; ws(j); if(j->p>=j->e||*j->p!=':')return -1; j->p++; }
    if(jval(j,depth+1,NULL,0))return -1;
    ws(j); if(j->p>=j->e)return -1;
    if(*j->p==','){j->p++;continue;}
    if(*j->p==close){j->p++;return 0;}
    return -1;
  }
}
static int jval(jp_t *j,int depth,jv_t *out,int want){
  if(depth>64)return -1; ws(j); if(j->p>=j->e)return -1;
  char c=*j->p;
  if(c=='"'){ const char *s;size_t n; if(jstr(j,&s,&n,want))return -1; if(out){out->t='s';out->s=s;out->n=n;} return 0;}
  if(c=='{'||c=='['){ if(jskip_container(j,depth))return -1; if(out)out->t='o'; return 0;}
  if(c=='t'||c=='f'||c=='n'){ const char *w=c=='t'?"true":c=='f'?"false":"null"; size_t l=strlen(w); if((size_t)(j->e-j->p)<l||memcmp(j->p,w,l))return -1; j->p+=l; if(out)out->t='o'; return 0;}
  // number
  const char *q=j->p; if(q<j->e&&*q=='-')q++;
  if(q>=j->e)return -1;
  if(*q=='0')q++; else if(*q>='1'&&*q<='9'){while(q<j->e&&*q>='0'&&*q<='9')q++;} else return -1;
  if(q<j->e&&*q=='.'){q++; if(q>=j->e||*q<'0'||*q>'9')return -1; while(q<j->e&&*q>='0'&&*q<='9')q++;}
  if(q<j->e&&(*q=='e'||*q=='E')){q++; if(q<j->e&&(*q=='+'||*q=='-'))q++; if(q>=j->e||*q<'0'||*q>'9')return -1; while(q<j->e&&*q>='0'&&*q<='9')q++;}
  if(out){char tmp[64]; size_t l=q-j->p; if(l>=sizeof tmp)l=sizeof tmp-1; memcpy(tmp,j->p,l);tmp[l]=0; out->t='n'; out->num=strtod(tmp,NULL);}
  j->p=q; return 0;
}
// Parse a complete JSON document. Returns 0 ok (object), -1 malformed, -2 valid but not an object.
// keys[i] -> vals[i] (last duplicate wins).
static int jparse(const char *s,size_t n,char *arena,size_t asz,const char **keys,jv_t *vals,int nk){
  jp_t j={s,s+n,arena,arena,arena+asz};
  for(int i=0;i<nk;i++)vals[i].t=0;
  ws(&j); if(j.p>=j.e)return -1;
  if(*j.p!='{'){ jv_t d; if(jval(&j,0,&d,0))return -1; ws(&j); return j.p==j.e?-2:-1; }
  j.p++; ws(&j);
  if(j.p<j.e&&*j.p=='}'){j.p++;}
  else while(1){
    ws(&j); const char *k;size_t kn; if(jstr(&j,&k,&kn,1))return -1;
    ws(&j); if(j.p>=j.e||*j.p!=':')return -1; j.p++;
    int idx=-1; for(int i=0;i<nk;i++) if(strlen(keys[i])==kn&&!memcmp(keys[i],k,kn)){idx=i;break;}
    jv_t v; v.t=0; if(jval(&j,1,&v,idx>=0))return -1;
    if(idx>=0)vals[idx]=v;
    ws(&j); if(j.p>=j.e)return -1;
    if(*j.p==','){j.p++;continue;}
    if(*j.p=='}'){j.p++;break;}
    return -1;
  }
  ws(&j); return j.p==j.e?0:-1;
}

/* ---------------- globals ---------------- */
static sqlite3 *db;
static sqlite3_stmt *st_feed,*st_post,*st_ins,*st_like_chk,*st_like_ins,*st_begin,*st_commit,*st_health;
static int txn_open=0;
static time_t start_time;
static char arena[1<<17];

static void die(const char *m){fprintf(stderr,"fatal: %s\n",m);exit(1);}
static void prep(sqlite3_stmt **s,const char *sql){ if(sqlite3_prepare_v3(db,sql,-1,SQLITE_PREPARE_PERSISTENT,s,NULL)!=SQLITE_OK){fprintf(stderr,"prepare: %s\n%s\n",sqlite3_errmsg(db),sql);exit(1);} }

/* ---------------- response buffer ---------------- */
#define HDR_RESERVE 160
static char rbuf[1<<18];
static size_t rlen; // body length, body starts at rbuf+HDR_RESERVE
static char *RB(void){return rbuf+HDR_RESERVE+rlen;}
static void rcat(const char *s,size_t n){memcpy(RB(),s,n);rlen+=n;}
#define RLIT(s) rcat(s,sizeof(s)-1)
static void rnum(long long v){ char t[24];int n=0; unsigned long long u=v<0?-(unsigned long long)v:v; if(v<0)*RB()='-',rlen++; do{t[n++]='0'+u%10;u/=10;}while(u); while(n)*RB()=t[--n],rlen++; }
static const char HEXD[]="0123456789abcdef";
static inline int needs_esc8(uint64_t w){
  const uint64_t ones=0x0101010101010101ULL, hi=0x8080808080808080ULL;
  uint64_t lt=(w-ones*0x20)&~w&hi;
  uint64_t q=w^(ones*0x22), b=w^(ones*0x5c);
  uint64_t zq=(q-ones)&~q&hi, zb=(b-ones)&~b&hi;
  return (lt|zq|zb)!=0;
}
static void rjson_str(const char *s,size_t n){
  char *o=RB(); *o++='"';
  size_t i=0;
  while(i<n){
    while(i+8<=n){ uint64_t w; memcpy(&w,s+i,8); if(needs_esc8(w))break; memcpy(o,&w,8); o+=8; i+=8; }
    size_t lim=i+8<n?i+8:n;
    for(;i<lim;i++){
      unsigned char c=s[i];
      if(c>=0x20&&c!='"'&&c!='\\'){*o++=c;continue;}
      switch(c){case '"':*o++='\\';*o++='"';break;case '\\':*o++='\\';*o++='\\';break;case '\n':*o++='\\';*o++='n';break;case '\r':*o++='\\';*o++='r';break;case '\t':*o++='\\';*o++='t';break;case 8:*o++='\\';*o++='b';break;case 12:*o++='\\';*o++='f';break;
        default:*o++='\\';*o++='u';*o++='0';*o++='0';*o++=HEXD[c>>4];*o++=HEXD[c&15];}
    }
  }
  *o++='"'; rlen=o-(rbuf+HDR_RESERVE);
}
static void rpost_row(sqlite3_stmt *s){
  RLIT("{\"id\":"); rnum(sqlite3_column_int64(s,0));
  RLIT(",\"body\":"); rjson_str((const char*)sqlite3_column_text(s,1),sqlite3_column_bytes(s,1));
  RLIT(",\"created_at\":"); rjson_str((const char*)sqlite3_column_text(s,2),sqlite3_column_bytes(s,2));
  RLIT(",\"author\":"); rjson_str((const char*)sqlite3_column_text(s,3),sqlite3_column_bytes(s,3));
  RLIT(",\"like_count\":"); rnum(sqlite3_column_int64(s,4)); RLIT("}");
}

/* ---------------- request handling ---------------- */
typedef struct { int status; int close; } resp_t;
static const char *statustext(int s){switch(s){case 200:return "200 OK";case 201:return "201 Created";case 400:return "400 Bad Request";case 401:return "401 Unauthorized";case 404:return "404 Not Found";case 413:return "413 Payload Too Large";case 503:return "503 Service Unavailable";default:return "500 Internal Server Error";}}
static void err(int status,const char *msg){ rlen=0; RLIT("{\"error\":\""); rcat(msg,strlen(msg)); RLIT("\"}"); }

static int parse_id(const char *s,size_t n,long long *id){
  if(n==0||n>18)return 0; long long v=0;
  for(size_t i=0;i<n;i++){ if(s[i]<'0'||s[i]>'9')return 0; v=v*10+(s[i]-'0'); }
  if(v<=0)return 0; *id=v; return 1;
}
// Returns 0 ok. On failure writes error into rbuf and sets *status.
static int auth(const char *h,size_t hn,long long *uid,char *uname,size_t *unlen,int *status){
  if(!h||hn<7||memcmp(h,"Bearer ",7)){*status=401;err(401,"missing bearer token");return -1;}
  const char *t=h+7; size_t tn=hn-7;
  while(tn&&(t[tn-1]==' '||t[tn-1]=='\t'))tn--;
  #define BADTOK do{*status=401;err(401,"invalid or expired token");return -1;}while(0)
  const char *d1=memchr(t,'.',tn); if(!d1)BADTOK;
  const char *d2=memchr(d1+1,'.',tn-(d1+1-t)); if(!d2)BADTOK;
  if(memchr(d2+1,'.',tn-(d2+1-t)))BADTOK;
  size_t signed_n=d2-t, sn=tn-(signed_n+1);
  if(sn!=43||signed_n>2000)BADTOK;
  uint8_t mac[32]; hmac((const uint8_t*)t,signed_n,mac);
  char enc[43]; { int o=0; for(int i=0;i<30;i+=3){uint32_t v=mac[i]<<16|mac[i+1]<<8|mac[i+2];enc[o++]=B64U[v>>18];enc[o++]=B64U[(v>>12)&63];enc[o++]=B64U[(v>>6)&63];enc[o++]=B64U[v&63];}
    uint32_t v=mac[30]<<16|mac[31]<<8; enc[o++]=B64U[v>>18];enc[o++]=B64U[(v>>12)&63];enc[o++]=B64U[(v>>6)&63]; }
  unsigned diff=0; for(int i=0;i<43;i++)diff|=enc[i]^d2[1+i]; if(diff)BADTOK;
  uint8_t dec[1600]; char dj[1600];
  int hl=b64u_dec(t,d1-t,dec); if(hl<0)BADTOK;
  const char *hk[1]={"alg"}; jv_t hv[1];
  memcpy(dj,dec,hl);
  if(jparse(dj,hl,arena,sizeof arena,hk,hv,1)!=0||hv[0].t!='s'||hv[0].n!=5||memcmp(hv[0].s,"HS256",5))BADTOK;
  int pl=b64u_dec(d1+1,d2-d1-1,dec); if(pl<0)BADTOK;
  const char *pk[3]={"sub","username","exp"}; jv_t pv[3];
  if(jparse((char*)dec,pl,arena,sizeof arena,pk,pv,3)!=0)BADTOK;
  if(pv[2].t){ if(pv[2].t!='n')BADTOK; if((double)time(NULL)>=pv[2].num)BADTOK; }
  long long id;
  if(pv[0].t!='s'||!parse_id(pv[0].s,pv[0].n,&id)||pv[1].t!='s'||pv[1].n>=256){*status=401;err(401,"invalid token payload");return -1;}
  *uid=id; memcpy(uname,pv[1].s,pv[1].n); *unlen=pv[1].n; return 0;
}

static void db_begin(void){ if(!txn_open){ sqlite3_step(st_begin); sqlite3_reset(st_begin); txn_open=1; } }
static void db_commit(void){ if(txn_open){ if(sqlite3_step(st_commit)!=SQLITE_DONE){fprintf(stderr,"commit failed: %s\n",sqlite3_errmsg(db));} sqlite3_reset(st_commit); txn_open=0; } }

static int h_health(void){
  int ok = sqlite3_step(st_health)==SQLITE_ROW; sqlite3_reset(st_health);
  rlen=0;
  if(ok){ RLIT("{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":"); rnum((long long)(time(NULL)-start_time)); RLIT("}"); return 200; }
  RLIT("{\"status\":\"degraded\",\"db\":\"unreachable\",\"error\":"); const char *m=sqlite3_errmsg(db); rjson_str(m,strlen(m)); RLIT("}"); return 503;
}
static int h_feed(void){
  rlen=0; RLIT("{\"posts\":[");
  int first=1, rc;
  while((rc=sqlite3_step(st_feed))==SQLITE_ROW){ if(!first)RLIT(","); first=0; rpost_row(st_feed); }
  sqlite3_reset(st_feed);
  if(rc!=SQLITE_DONE){err(500,"internal server error");return 500;}
  RLIT("]}"); return 200;
}
static int h_post(long long id){
  sqlite3_bind_int64(st_post,1,id);
  int rc=sqlite3_step(st_post); rlen=0;
  if(rc==SQLITE_ROW){ RLIT("{\"post\":"); rpost_row(st_post); RLIT("}"); sqlite3_reset(st_post); return 200; }
  sqlite3_reset(st_post);
  if(rc==SQLITE_DONE){err(404,"post not found");return 404;}
  err(500,"internal server error"); return 500;
}
static int utf8_trim_bounds(const char *s,size_t n,size_t *a,size_t *b){
  // trim ASCII whitespace plus common unicode spaces (NBSP, U+2028/9, BOM etc.)
  size_t i=0,e=n;
  for(;;){
    if(i<e&&((unsigned char)s[i]==' '||(s[i]>=9&&s[i]<=13))){i++;continue;}
    if(e-i>=2&&(unsigned char)s[i]==0xC2&&((unsigned char)s[i+1]==0xA0||(unsigned char)s[i+1]==0x85&&0)){i+=2;continue;}
    if(e-i>=3&&(unsigned char)s[i]==0xEF&&(unsigned char)s[i+1]==0xBB&&(unsigned char)s[i+2]==0xBF){i+=3;continue;}
    if(e-i>=3&&(unsigned char)s[i]==0xE2&&(unsigned char)s[i+1]==0x80&&(((unsigned char)s[i+2]>=0x80&&(unsigned char)s[i+2]<=0x8A)||(unsigned char)s[i+2]==0xA8||(unsigned char)s[i+2]==0xA9||(unsigned char)s[i+2]==0xAF)){i+=3;continue;}
    if(e-i>=3&&(unsigned char)s[i]==0xE3&&(unsigned char)s[i+1]==0x80&&(unsigned char)s[i+2]==0x80){i+=3;continue;}
    break;
  }
  for(;;){
    if(e>i&&((unsigned char)s[e-1]==' '||(s[e-1]>=9&&s[e-1]<=13))){e--;continue;}
    if(e-i>=2&&(unsigned char)s[e-2]==0xC2&&(unsigned char)s[e-1]==0xA0){e-=2;continue;}
    if(e-i>=3&&(unsigned char)s[e-3]==0xEF&&(unsigned char)s[e-2]==0xBB&&(unsigned char)s[e-1]==0xBF){e-=3;continue;}
    if(e-i>=3&&(unsigned char)s[e-3]==0xE2&&(unsigned char)s[e-2]==0x80&&(((unsigned char)s[e-1]>=0x80&&(unsigned char)s[e-1]<=0x8A)||(unsigned char)s[e-1]==0xA8||(unsigned char)s[e-1]==0xA9||(unsigned char)s[e-1]==0xAF)){e-=3;continue;}
    if(e-i>=3&&(unsigned char)s[e-3]==0xE3&&(unsigned char)s[e-2]==0x80&&(unsigned char)s[e-1]==0x80){e-=3;continue;}
    break;
  }
  *a=i;*b=e; return 0;
}
static int h_create(long long uid,const char *un,size_t unl,const char *body,size_t bn){
  const char *keys[1]={"body"}; jv_t v[1];
  int r=jparse(body,bn,arena,sizeof arena,keys,v,1);
  if(r==-1){err(400,"malformed JSON body");return 400;}
  if(r==-2||v[0].t!='s'){err(400,"body is required");return 400;}
  size_t a,b; utf8_trim_bounds(v[0].s,v[0].n,&a,&b);
  if(a>=b){err(400,"body is required");return 400;}
  const char *t=v[0].s+a; size_t tn=b-a;
  size_t cps=0; for(size_t i=0;i<tn;i++) if(((unsigned char)t[i]&0xC0)!=0x80)cps++;
  if(cps>500){err(400,"body must be at most 500 characters");return 400;}
  db_begin();
  sqlite3_bind_int64(st_ins,1,uid); sqlite3_bind_text(st_ins,2,t,(int)tn,SQLITE_STATIC);
  int rc=sqlite3_step(st_ins);
  if(rc!=SQLITE_ROW){ fprintf(stderr,"insert: %s\n",sqlite3_errmsg(db)); sqlite3_reset(st_ins); err(500,"internal server error"); return 500; }
  long long id=sqlite3_column_int64(st_ins,0);
  rlen=0; RLIT("{\"post\":{\"id\":"); rnum(id); RLIT(",\"body\":"); rjson_str(t,tn);
  RLIT(",\"created_at\":"); rjson_str((const char*)sqlite3_column_text(st_ins,1),sqlite3_column_bytes(st_ins,1));
  RLIT(",\"author\":"); rjson_str(un,unl); RLIT(",\"like_count\":0}}");
  sqlite3_reset(st_ins); return 201;
}
static int h_like(long long uid,long long pid){
  sqlite3_bind_int64(st_like_chk,1,pid); int rc=sqlite3_step(st_like_chk); sqlite3_reset(st_like_chk);
  if(rc==SQLITE_DONE){err(404,"post not found");return 404;}
  if(rc!=SQLITE_ROW){err(500,"internal server error");return 500;}
  db_begin();
  sqlite3_bind_int64(st_like_ins,1,uid); sqlite3_bind_int64(st_like_ins,2,pid);
  rc=sqlite3_step(st_like_ins); int ch=sqlite3_changes(db); sqlite3_reset(st_like_ins);
  if(rc!=SQLITE_DONE){ fprintf(stderr,"like: %s\n",sqlite3_errmsg(db)); err(500,"internal server error"); return 500; }
  rlen=0; RLIT("{\"liked\":true,\"already_liked\":"); if(ch)RLIT("false"); else RLIT("true"); RLIT(",\"post_id\":"); rnum(pid); RLIT("}");
  return ch?201:200;
}

typedef struct { const char *auth; size_t authn; } hdrs_t;
// route a request; returns status; response body in rbuf
static int route(const char *m,size_t mn,const char *path,size_t pn,const char *authh,size_t authn,const char *body,size_t bn){
  int isget=(mn==3&&!memcmp(m,"GET",3)), ispost=(mn==4&&!memcmp(m,"POST",4));
  long long id; long long uid; char un[256]; size_t unl; int status;
  if(isget){
    if(pn==5&&!memcmp(path,"/feed",5))return h_feed();
    if(pn==7&&!memcmp(path,"/health",7))return h_health();
    if(pn>7&&!memcmp(path,"/posts/",7)){
      if(!parse_id(path+7,pn-7,&id)){ if(memchr(path+7,'/',pn-7)){err(404,"not found");return 404;} err(400,"invalid post id");return 400; }
      return h_post(id);
    }
  } else if(ispost){
    if(pn==6&&!memcmp(path,"/posts",6)){
      if(auth(authh,authn,&uid,un,&unl,&status))return status;
      return h_create(uid,un,unl,body,bn);
    }
    if(pn>7&&!memcmp(path,"/posts/",7)){
      const char *rest=path+7; size_t rn=pn-7;
      if(rn>5&&!memcmp(rest+rn-5,"/like",5)){
        if(auth(authh,authn,&uid,un,&unl,&status))return status;
        if(!parse_id(rest,rn-5,&id)){ if(memchr(rest,'/',rn-5)){err(404,"not found");return 404;} err(400,"invalid post id");return 400; }
        return h_like(uid,id);
      }
    }
  }
  err(404,"not found"); return 404;
}

/* ---------------- connections ---------------- */
typedef struct { char *in; uint32_t inlen,incap; char *out; uint32_t outlen,outoff; uint8_t want_out,closing,deferred; } conn_t;
static conn_t *conns; static int nconns;
static int epfd;
static int *deferred_fds; static int ndeferred;
static char rdbuf[1<<16];

static void conn_close(int fd){
  conn_t *c=&conns[fd]; free(c->in); free(c->out); memset(c,0,sizeof *c);
  epoll_ctl(epfd,EPOLL_CTL_DEL,fd,NULL); close(fd);
}
static void conn_flush(int fd){
  conn_t *c=&conns[fd];
  while(c->outoff<c->outlen){
    ssize_t n=send(fd,c->out+c->outoff,c->outlen-c->outoff,MSG_NOSIGNAL);
    if(n<0){ if(errno==EINTR)continue; if(errno==EAGAIN){ if(!c->want_out){struct epoll_event ev={.events=EPOLLIN|EPOLLOUT,.data.fd=fd};epoll_ctl(epfd,EPOLL_CTL_MOD,fd,&ev);c->want_out=1;} return;} conn_close(fd); return; }
    c->outoff+=n;
  }
  c->outlen=c->outoff=0;
  if(c->want_out){struct epoll_event ev={.events=EPOLLIN,.data.fd=fd};epoll_ctl(epfd,EPOLL_CTL_MOD,fd,&ev);c->want_out=0;}
  if(c->closing)conn_close(fd);
}
static void out_append(conn_t *c,const char *p,size_t n){
  if(c->outlen==0) c->outoff=0;
  char *b=realloc(c->out,c->outlen+n); if(!b)die("oom"); c->out=b; memcpy(c->out+c->outlen,p,n); c->outlen+=n;
}
static void emit(int fd,int status,int close_after){
  conn_t *c=&conns[fd];
  char h[HDR_RESERVE]; int hl=snprintf(h,sizeof h,"HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n%s\r\n",statustext(status),rlen,close_after?"Connection: close\r\n":"");
  char *start=rbuf+HDR_RESERVE-hl; memcpy(start,h,hl);
  size_t tot=hl+rlen;
  if(close_after)c->closing=1;
  if(c->outlen==0&&!txn_open){
    ssize_t n=send(fd,start,tot,MSG_NOSIGNAL);
    if(n==(ssize_t)tot){ if(close_after)conn_close(fd); return; }
    if(n<0&&errno!=EAGAIN&&errno!=EINTR){conn_close(fd);return;}
    out_append(c,start+(n>0?n:0),tot-(n>0?n:0)); conn_flush(fd); return;
  }
  out_append(c,start,tot);
  if(txn_open&&!c->deferred){c->deferred=1;deferred_fds[ndeferred++]=fd;}
  else if(!txn_open)conn_flush(fd);
}
static int ci_prefix(const char *s,size_t n,const char *lit){size_t l=strlen(lit);if(n<l)return 0;for(size_t i=0;i<l;i++){char a=s[i];if(a>='A'&&a<='Z')a+=32;if(a!=lit[i])return 0;}return 1;}
#define MAX_REQ 65536
// parse as many complete requests as available in buf; returns bytes consumed, or -1 if conn closed
static ssize_t process(int fd,const char *buf,size_t len){
  size_t off=0;
  while(off<len){
    const char *p=buf+off; size_t avail=len-off;
    const char *he=memmem(p,avail,"\r\n\r\n",4);
    if(!he){ if(avail>MAX_REQ){ rlen=0; err(400,"bad request"); emit(fd,400,1); return -1;} break; }
    size_t hlen=he-p+4;
    const char *sp1=memchr(p,' ',hlen); if(!sp1){rlen=0;err(400,"bad request");emit(fd,400,1);return -1;}
    const char *sp2=memchr(sp1+1,' ',he-sp1-1); if(!sp2){rlen=0;err(400,"bad request");emit(fd,400,1);return -1;}
    const char *eol=memchr(p,'\r',hlen);
    int http10 = (size_t)(eol-sp2-1)==8 && sp2[8]=='0';
    const char *q=memchr(sp1+1,'?',sp2-sp1-1);
    const char *path=sp1+1; size_t pn=(q?q:sp2)-path;
    const char *authh=NULL; size_t authn=0; long clen=0; int conn_close_req=http10, chunked=0;
    const char *l=eol+2;
    while(l<he){
      const char *le=memchr(l,'\r',he+2-l); size_t ln=le-l; if(ln==0)break;
      if(ci_prefix(l,ln,"authorization:")){const char *v=l+14;size_t vn=ln-14;while(vn&&(*v==' '||*v=='\t')){v++;vn--;}authh=v;authn=vn;}
      else if(ci_prefix(l,ln,"content-length:")){clen=strtol(l+15,NULL,10);}
      else if(ci_prefix(l,ln,"connection:")){ const char *v=l+11;size_t vn=ln-11; for(size_t i=0;i+5<=vn;i++) if(ci_prefix(v+i,vn-i,"close")){conn_close_req=1;break;} if(http10){ for(size_t i=0;i+10<=vn;i++) if(ci_prefix(v+i,vn-i,"keep-alive")){conn_close_req=0;break;} } }
      else if(ci_prefix(l,ln,"transfer-encoding:")){chunked=1;}
      l=le+2;
    }
    if(chunked||clen<0||clen>MAX_REQ){ rlen=0; err(400,"bad request"); emit(fd,400,1); return -1; }
    if(avail<hlen+(size_t)clen)break;
    int st=route(p,sp1-p,path,pn,authh,authn,p+hlen,clen);
    off+=hlen+clen;
    emit(fd,st,conn_close_req);
    if(conn_close_req)return -1;
  }
  return off;
}
static void conn_readable(int fd){
  conn_t *c=&conns[fd];
  for(;;){
    ssize_t n=recv(fd,rdbuf,sizeof rdbuf,0);
    if(n==0){ conn_close(fd); return; }
    if(n<0){ if(errno==EINTR)continue; if(errno==EAGAIN)return; conn_close(fd); return; }
    const char *buf; size_t len;
    if(c->inlen){ if(c->inlen+n>c->incap){c->incap=(c->inlen+n)*2;c->in=realloc(c->in,c->incap);if(!c->in)die("oom");} memcpy(c->in+c->inlen,rdbuf,n);c->inlen+=n; buf=c->in;len=c->inlen; }
    else {buf=rdbuf;len=n;}
    ssize_t used=process(fd,buf,len);
    if(used<0)return; // connection already closed or closing (flush will close it)
    if(c->inlen){ memmove(c->in,c->in+used,c->inlen-used); c->inlen-=used; if(!c->inlen){free(c->in);c->in=NULL;c->incap=0;} }
    else if((size_t)used<len){ size_t rest=len-used; c->incap=rest<512?512:rest; c->in=malloc(c->incap); memcpy(c->in,rdbuf+used,rest); c->inlen=rest; }
    if(n<(ssize_t)sizeof rdbuf)return;
  }
}

int main(void){
  signal(SIGPIPE,SIG_IGN);
  const char *path=getenv("SQLITE_PATH"); if(!path)die("SQLITE_PATH");
  const char *sec=getenv("JWT_SECRET"); if(!sec)die("JWT_SECRET"); hmac_setkey(sec);
  const char *host=getenv("HOST"); if(!host)host="0.0.0.0"; const char *ps=getenv("PORT"); int port=ps?atoi(ps):3000;
  start_time=time(NULL);
  struct rlimit rl; if(getrlimit(RLIMIT_NOFILE,&rl)==0){rl.rlim_cur=rl.rlim_max;setrlimit(RLIMIT_NOFILE,&rl);} 
  int maxfd=(int)(rl.rlim_cur>1000000?1000000:rl.rlim_cur); nconns=maxfd+16;
  conns=calloc(nconns,sizeof(conn_t)); deferred_fds=malloc(sizeof(int)*(nconns+16)); if(!conns||!deferred_fds)die("oom");

  sqlite3_config(SQLITE_CONFIG_MEMSTATUS,0);
  if(sqlite3_open_v2(path,&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,NULL)!=SQLITE_OK)die("open db");
  sqlite3_busy_timeout(db,5000);
  sqlite3_exec(db,"PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA mmap_size=1073741824; PRAGMA cache_size=-65536; PRAGMA wal_autocheckpoint=3000; PRAGMA temp_store=MEMORY;",NULL,NULL,NULL);
  prep(&st_feed,"SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC,p.id DESC LIMIT 20");
  prep(&st_post,"SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?1");
  prep(&st_ins,"INSERT INTO posts(user_id,body) VALUES(?1,?2) RETURNING id,created_at");
  prep(&st_like_chk,"SELECT 1 FROM posts WHERE id=?1");
  prep(&st_like_ins,"INSERT INTO likes(user_id,post_id) VALUES(?1,?2) ON CONFLICT(user_id,post_id) DO NOTHING");
  prep(&st_begin,"BEGIN"); prep(&st_commit,"COMMIT"); prep(&st_health,"SELECT 1");

  int ls=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK,0); int one=1;
  setsockopt(ls,SOL_SOCKET,SO_REUSEADDR,&one,sizeof one); setsockopt(ls,IPPROTO_TCP,TCP_NODELAY,&one,sizeof one);
  int da=1; setsockopt(ls,IPPROTO_TCP,TCP_DEFER_ACCEPT,&da,sizeof da);
  struct sockaddr_in sa={.sin_family=AF_INET,.sin_port=htons(port)}; inet_pton(AF_INET,host,&sa.sin_addr);
  if(bind(ls,(struct sockaddr*)&sa,sizeof sa))die("bind"); if(listen(ls,8192))die("listen");
  epfd=epoll_create1(0);
  struct epoll_event ev={.events=EPOLLIN,.data.fd=ls}; epoll_ctl(epfd,EPOLL_CTL_ADD,ls,&ev);
  static struct epoll_event evs[1024];
  for(;;){
    int n=epoll_wait(epfd,evs,1024,-1);
    if(n<0){ if(errno==EINTR)continue; die("epoll"); }
    for(int i=0;i<n;i++){
      int fd=evs[i].data.fd;
      if(fd==ls){
        for(;;){ int cfd=accept4(ls,NULL,NULL,SOCK_NONBLOCK); if(cfd<0)break; if(cfd>=nconns){close(cfd);continue;}
          struct epoll_event e2={.events=EPOLLIN,.data.fd=cfd}; epoll_ctl(epfd,EPOLL_CTL_ADD,cfd,&e2); }
        continue;
      }
      if(evs[i].events&(EPOLLERR|EPOLLHUP)&&!(evs[i].events&EPOLLIN)){ conn_close(fd); continue; }
      if(evs[i].events&EPOLLOUT)conn_flush(fd);
      if(evs[i].events&EPOLLIN&&conns[fd].closing==0)conn_readable(fd);
    }
    if(txn_open){
      db_commit();
      for(int i=0;i<ndeferred;i++){ int fd=deferred_fds[i]; conns[fd].deferred=0; if(conns[fd].outlen||conns[fd].closing) conn_flush(fd); }
      ndeferred=0;
    }
  }
}
