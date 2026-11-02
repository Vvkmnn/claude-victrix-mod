// Prototype: single-thread epoll HTTP/1.1 server + SQLite (system lib). Anka plan prototype.
#define _GNU_SOURCE
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <unistd.h>
#include <fcntl.h>
#include <time.h>
#include <signal.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <sys/resource.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>

/* ---------- SHA256 / HMAC ---------- */
typedef struct { uint32_t h[8]; } sha_state;
static const uint32_t K[64]={0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
#define ROR(x,n) (((x)>>(n))|((x)<<(32-(n))))
static void sha_block(uint32_t*h,const uint8_t*p){
  uint32_t w[64],a,b,c,d,e,f,g,hh,t1,t2;
  for(int i=0;i<16;i++)w[i]=(uint32_t)p[4*i]<<24|p[4*i+1]<<16|p[4*i+2]<<8|p[4*i+3];
  for(int i=16;i<64;i++){uint32_t s0=ROR(w[i-15],7)^ROR(w[i-15],18)^(w[i-15]>>3),s1=ROR(w[i-2],17)^ROR(w[i-2],19)^(w[i-2]>>10);w[i]=w[i-16]+s0+w[i-7]+s1;}
  a=h[0];b=h[1];c=h[2];d=h[3];e=h[4];f=h[5];g=h[6];hh=h[7];
  for(int i=0;i<64;i++){t1=hh+(ROR(e,6)^ROR(e,11)^ROR(e,25))+((e&f)^(~e&g))+K[i]+w[i];t2=(ROR(a,2)^ROR(a,13)^ROR(a,22))+((a&b)^(a&c)^(b&c));hh=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;}
  h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;}
static const uint32_t IV[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
static uint32_t ipad_st[8],opad_st[8];
static void sha_finish(uint32_t*h,const uint8_t*rest,size_t n,uint64_t total,uint8_t*out){
  uint8_t buf[128]; memcpy(buf,rest,n); buf[n]=0x80; size_t pad=(n<56)?64:128; memset(buf+n+1,0,pad-n-1);
  uint64_t bits=total*8; for(int i=0;i<8;i++)buf[pad-1-i]=bits>>(8*i);
  sha_block(h,buf); if(pad==128)sha_block(h,buf+64);
  for(int i=0;i<8;i++){out[4*i]=h[i]>>24;out[4*i+1]=h[i]>>16;out[4*i+2]=h[i]>>8;out[4*i+3]=h[i];}}
static void hmac_init(const char*key,size_t kl){
  uint8_t ip[64],op[64]; memset(ip,0x36,64); memset(op,0x5c,64);
  for(size_t i=0;i<kl;i++){ip[i]^=key[i];op[i]^=key[i];}
  memcpy(ipad_st,IV,32); sha_block(ipad_st,ip); memcpy(opad_st,IV,32); sha_block(opad_st,op);}
static void hmac(const uint8_t*m,size_t n,uint8_t*out){
  uint32_t h[8]; memcpy(h,ipad_st,32); size_t full=n/64*64; for(size_t i=0;i<full;i+=64)sha_block(h,m+i);
  uint8_t inner[32]; sha_finish(h,m+full,n-full,64+n,inner);
  memcpy(h,opad_st,32); sha_finish(h,inner,32,64+32,out);}

/* ---------- base64url ---------- */
static int b64v(int c){if(c>='A'&&c<='Z')return c-'A';if(c>='a'&&c<='z')return c-'a'+26;if(c>='0'&&c<='9')return c-'0'+52;if(c=='-')return 62;if(c=='_')return 63;return -1;}
static int b64dec(const char*s,size_t n,uint8_t*out,size_t*ol){
  size_t o=0;uint32_t acc=0;int bits=0;
  for(size_t i=0;i<n;i++){int v=b64v((unsigned char)s[i]);if(v<0)return -1;acc=acc<<6|v;bits+=6;if(bits>=8){bits-=8;out[o++]=acc>>bits;acc&=(1u<<bits)-1;}}
  *ol=o;return 0;}

/* ---------- JSON mini parser (validating) ---------- */
typedef struct { const char*p,*e; } jp;
static void jws(jp*j){while(j->p<j->e&&(*j->p==' '||*j->p=='\t'||*j->p=='\n'||*j->p=='\r'))j->p++;}
static int hex4(const char*p){int v=0;for(int i=0;i<4;i++){int c=p[i];v<<=4;if(c>='0'&&c<='9')v|=c-'0';else if(c>='a'&&c<='f')v|=c-'a'+10;else if(c>='A'&&c<='F')v|=c-'A'+10;else return -1;}return v;}
static int put8(char*o,int cp){if(cp<0x80){o[0]=cp;return 1;}if(cp<0x800){o[0]=0xC0|cp>>6;o[1]=0x80|(cp&63);return 2;}if(cp<0x10000){o[0]=0xE0|cp>>12;o[1]=0x80|((cp>>6)&63);o[2]=0x80|(cp&63);return 3;}o[0]=0xF0|cp>>18;o[1]=0x80|((cp>>12)&63);o[2]=0x80|((cp>>6)&63);o[3]=0x80|(cp&63);return 4;}
// parse string at *p == '"'; if out!=NULL decode into out (cap >= len), *ol set. returns 0 ok
static int jstr(jp*j,char*out,size_t*ol){
  if(j->p>=j->e||*j->p!='"')return -1; j->p++; size_t o=0;
  while(1){ if(j->p>=j->e)return -1; unsigned char c=*j->p++;
    if(c=='"')break; if(c<0x20)return -1;
    if(c=='\\'){ if(j->p>=j->e)return -1; c=*j->p++; char r;
      switch(c){case '"':r='"';break;case '\\':r='\\';break;case '/':r='/';break;case 'b':r='\b';break;case 'f':r='\f';break;case 'n':r='\n';break;case 'r':r='\r';break;case 't':r='\t';break;
      case 'u':{ if(j->e-j->p<4)return -1; int cp=hex4(j->p); if(cp<0)return -1; j->p+=4;
          if(cp>=0xD800&&cp<0xDC00&&j->e-j->p>=6&&j->p[0]=='\\'&&j->p[1]=='u'){int lo=hex4(j->p+2);if(lo>=0xDC00&&lo<0xE000){cp=0x10000+((cp-0xD800)<<10)+(lo-0xDC00);j->p+=6;}}
          if(cp>=0xD800&&cp<0xE000)cp=0xFFFD;
          if(out)o+=put8(out+o,cp); continue;}
      default:return -1;}
      if(out)out[o++]=r; }
    else if(out)out[o++]=c; }
  if(ol)*ol=o; return 0;}
static int jval(jp*j,int depth);
static int jnum(jp*j,double*d){const char*s=j->p;if(j->p<j->e&&*j->p=='-')j->p++;
  if(j->p>=j->e)return -1; if(*j->p=='0')j->p++;else if(*j->p>='1'&&*j->p<='9'){while(j->p<j->e&&*j->p>='0'&&*j->p<='9')j->p++;}else return -1;
  if(j->p<j->e&&*j->p=='.'){j->p++;if(j->p>=j->e||*j->p<'0'||*j->p>'9')return -1;while(j->p<j->e&&*j->p>='0'&&*j->p<='9')j->p++;}
  if(j->p<j->e&&(*j->p=='e'||*j->p=='E')){j->p++;if(j->p<j->e&&(*j->p=='+'||*j->p=='-'))j->p++;if(j->p>=j->e||*j->p<'0'||*j->p>'9')return -1;while(j->p<j->e&&*j->p>='0'&&*j->p<='9')j->p++;}
  if(d){char t[64];size_t n=j->p-s;if(n>63)n=63;memcpy(t,s,n);t[n]=0;*d=strtod(t,0);}return 0;}
static int jval(jp*j,int depth){ if(depth>64)return -1; jws(j); if(j->p>=j->e)return -1; char c=*j->p;
  if(c=='"')return jstr(j,0,0);
  if(c=='{'){j->p++;jws(j);if(j->p<j->e&&*j->p=='}'){j->p++;return 0;}
    while(1){jws(j);if(jstr(j,0,0))return -1;jws(j);if(j->p>=j->e||*j->p!=':')return -1;j->p++;if(jval(j,depth+1))return -1;jws(j);if(j->p>=j->e)return -1;if(*j->p==','){j->p++;continue;}if(*j->p=='}'){j->p++;return 0;}return -1;}}
  if(c=='['){j->p++;jws(j);if(j->p<j->e&&*j->p==']'){j->p++;return 0;}
    while(1){if(jval(j,depth+1))return -1;jws(j);if(j->p>=j->e)return -1;if(*j->p==','){j->p++;continue;}if(*j->p==']'){j->p++;return 0;}return -1;}}
  if(j->e-j->p>=4&&!memcmp(j->p,"true",4)){j->p+=4;return 0;}
  if(j->e-j->p>=5&&!memcmp(j->p,"false",5)){j->p+=5;return 0;}
  if(j->e-j->p>=4&&!memcmp(j->p,"null",4)){j->p+=4;return 0;}
  return jnum(j,0);}
// Walk top-level object. For each key matching one of wanted, report type: 's' string (decoded into buf), 'n' number, 'o' other.
typedef struct { const char*key; char type; char*sbuf; size_t slen; double num; int seen; } jwant;
// returns 0 ok, -1 malformed. If top-level isn't an object, valid but no keys.
static int jobject(const char*s,size_t n,jwant*w,int nw,char*scratch){
  jp j={s,s+n}; jws(&j); if(j.p>=j.e)return -1;
  if(*j.p!='{'){ if(jval(&j,0))return -1; jws(&j); return j.p==j.e?0:-1; }
  j.p++; jws(&j);
  if(j.p<j.e&&*j.p=='}'){j.p++;jws(&j);return j.p==j.e?0:-1;}
  size_t sp=0;
  while(1){ jws(&j); char kb[64]; size_t kl=0; const char*ks=j.p;
    // key: decode only if short
    jp kj=j; if(jstr(&kj,0,0))return -1; size_t rawlen=kj.p-ks-2;
    int wi=-1; if(rawlen<60){jp k2=j; if(jstr(&k2,kb,&kl))return -1; for(int i=0;i<nw;i++)if(strlen(w[i].key)==kl&&!memcmp(w[i].key,kb,kl)){wi=i;break;}}
    j.p=kj.p; jws(&j); if(j.p>=j.e||*j.p!=':')return -1; j.p++; jws(&j);
    if(wi>=0&&j.p<j.e){ jwant*x=&w[wi]; x->seen=1;
      if(*j.p=='"'){ jp v=j; size_t ol; char*dst=scratch+sp; if(jstr(&v,dst,&ol))return -1; x->type='s'; x->sbuf=dst; x->slen=ol; sp+=ol+1; j.p=v.p; }
      else if(*j.p=='-'||(*j.p>='0'&&*j.p<='9')){ double d; jp v=j; if(jnum(&v,&d))return -1; x->type='n'; x->num=d; j.p=v.p; }
      else { x->type='o'; if(jval(&j,1))return -1; } }
    else if(jval(&j,1))return -1;
    jws(&j); if(j.p>=j.e)return -1; if(*j.p==','){j.p++;continue;} if(*j.p=='}'){j.p++;break;} return -1; }
  jws(&j); return j.p==j.e?0:-1; }

/* ---------- globals ---------- */
static sqlite3*db; static sqlite3_stmt *st_feed,*st_post,*st_ins,*st_exists,*st_like,*st_health;
static time_t t0;
static char outbuf[1<<16]; // response assembly (single thread)

static char*jesc(char*o,const char*s,size_t n){ // JSON string content escape
  for(size_t i=0;i<n;i++){unsigned char c=s[i];
    if(c=='"'){*o++='\\';*o++='"';}else if(c=='\\'){*o++='\\';*o++='\\';}
    else if(c<0x20){ if(c=='\n'){*o++='\\';*o++='n';}else if(c=='\r'){*o++='\\';*o++='r';}else if(c=='\t'){*o++='\\';*o++='t';}else if(c=='\b'){*o++='\\';*o++='b';}else if(c=='\f'){*o++='\\';*o++='f';}else{o+=sprintf(o,"\\u%04x",c);} }
    else *o++=c; }
  return o;}
static char*putlit(char*o,const char*s){size_t n=strlen(s);memcpy(o,s,n);return o+n;}
static char*putint(char*o,long long v){char t[24];int n=0;if(v<0){*o++='-';v=-v;}if(v==0)t[n++]='0';while(v){t[n++]='0'+v%10;v/=10;}while(n)*o++=t[--n];return o;}
static char*put_post(char*o,sqlite3_stmt*s){
  o=putlit(o,"{\"id\":");o=putint(o,sqlite3_column_int64(s,0));
  o=putlit(o,",\"body\":\"");o=jesc(o,(const char*)sqlite3_column_text(s,1),sqlite3_column_bytes(s,1));
  o=putlit(o,"\",\"created_at\":\"");o=jesc(o,(const char*)sqlite3_column_text(s,2),sqlite3_column_bytes(s,2));
  o=putlit(o,"\",\"author\":\"");o=jesc(o,(const char*)sqlite3_column_text(s,3),sqlite3_column_bytes(s,3));
  o=putlit(o,"\",\"like_count\":");o=putint(o,sqlite3_column_int64(s,4));*o++='}';return o;}

#define HDRMAX 160
// build response: body assembled at outbuf+HDRMAX, header prepended. returns pointer & length.
static char*finish(int status,char*bodyend,size_t*len){
  static const char*txt[]={0}; (void)txt;
  const char*reason= status==200?"OK":status==201?"Created":status==400?"Bad Request":status==401?"Unauthorized":status==404?"Not Found":status==503?"Service Unavailable":"Internal Server Error";
  size_t bl=bodyend-(outbuf+HDRMAX);
  char h[HDRMAX]; int hl=snprintf(h,HDRMAX,"HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n\r\n",status,reason,bl);
  char*start=outbuf+HDRMAX-hl; memcpy(start,h,hl); *len=hl+bl; return start;}
static char*err(int status,const char*msg,size_t*len){char*o=outbuf+HDRMAX;o=putlit(o,"{\"error\":\"");o=putlit(o,msg);o=putlit(o,"\"}");return finish(status,o,len);}

/* ---------- auth ---------- */
typedef struct { long long uid; char name[512]; size_t nlen; } auth_t;
// returns 0 ok, 1 missing, 2 invalid, 3 payload
static int do_auth(const char*h,size_t hl,auth_t*a){
  if(!h||hl<7||memcmp(h,"Bearer ",7))return 1;
  const char*t=h+7; size_t tl=hl-7;
  const char*d1=memchr(t,'.',tl); if(!d1)return 2; const char*d2=memchr(d1+1,'.',t+tl-d1-1); if(!d2)return 2; if(memchr(d2+1,'.',t+tl-d2-1))return 2;
  if(tl>1500)return 2;
  uint8_t sig[64],mac[32]; size_t sl; if(b64dec(d2+1,t+tl-d2-1,sig,&sl)||sl!=32)return 2;
  hmac((const uint8_t*)t,d2-t,mac); uint8_t diff=0; for(int i=0;i<32;i++)diff|=mac[i]^sig[i]; if(diff)return 2;
  uint8_t hb[256]; size_t hbl; if(d1-t>300||b64dec(t,d1-t,hb,&hbl))return 2;
  char sc[512]; jwant hw[1]={{"alg",0}}; if(jobject((char*)hb,hbl,hw,1,sc)||hw[0].type!='s'||hw[0].slen!=5||memcmp(hw[0].sbuf,"HS256",5))return 2;
  static uint8_t pb[1200]; size_t pbl; if(b64dec(d1+1,d2-d1-1,pb,&pbl))return 2;
  static char sc2[1400]; jwant pw[3]={{"sub",0},{"username",0},{"exp",0}};
  if(jobject((char*)pb,pbl,pw,3,sc2))return 2;
  if(pw[2].type=='n'){ if(!(pw[2].num>(double)time(0)))return 2; } else if(pw[2].seen)return 2; // non-numeric exp -> invalid
  if(pw[0].type!='s'||pw[1].type!='s')return 3;
  if(pw[0].slen==0||pw[0].slen>15)return 3; long long v=0; for(size_t i=0;i<pw[0].slen;i++){char c=pw[0].sbuf[i];if(c<'0'||c>'9')return 3;v=v*10+(c-'0');} if(v<=0)return 3;
  if(pw[1].slen>=sizeof a->name)return 3;
  a->uid=v; memcpy(a->name,pw[1].sbuf,pw[1].slen); a->nlen=pw[1].slen; return 0;}

static char*auth_err(int r,size_t*len){ return r==1?err(401,"missing bearer token",len):r==2?err(401,"invalid or expired token",len):err(401,"invalid token payload",len);}
static int parse_id(const char*s,size_t n,long long*id){ if(n==0||n>15)return -1; long long v=0; for(size_t i=0;i<n;i++){if(s[i]<'0'||s[i]>'9')return -1;v=v*10+(s[i]-'0');} if(v<=0)return -1; *id=v; return 0;}

static char*handle(const char*method,size_t ml,const char*path,size_t pl,const char*authh,size_t ahl,const char*body,size_t bl,size_t*len){
  const char*q=memchr(path,'?',pl); if(q)pl=q-path;
  int GET=ml==3&&!memcmp(method,"GET",3), POST=ml==4&&!memcmp(method,"POST",4);
  if(GET&&pl==5&&!memcmp(path,"/feed",5)){
    char*o=outbuf+HDRMAX; o=putlit(o,"{\"posts\":["); int first=1;
    while(sqlite3_step(st_feed)==SQLITE_ROW){ if(!first)*o++=','; first=0; o=put_post(o,st_feed);} 
    int rc=sqlite3_reset(st_feed); if(rc!=SQLITE_OK)return err(500,"internal server error",len);
    o=putlit(o,"]}"); return finish(200,o,len);}
  if(GET&&pl==7&&!memcmp(path,"/health",7)){
    int rc=sqlite3_step(st_health); sqlite3_reset(st_health);
    char*o=outbuf+HDRMAX; if(rc!=SQLITE_ROW){o=putlit(o,"{\"status\":\"degraded\",\"db\":\"unreachable\",\"error\":\"");o=jesc(o,sqlite3_errmsg(db),strlen(sqlite3_errmsg(db)));o=putlit(o,"\"}");return finish(503,o,len);}
    o=putlit(o,"{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":");o=putint(o,(long long)(time(0)-t0));*o++='}';return finish(200,o,len);}
  if(GET&&pl>7&&!memcmp(path,"/posts/",7)){
    const char*ids=path+7; size_t il=pl-7; if(memchr(ids,'/',il))return err(404,"not found",len);
    long long id; if(parse_id(ids,il,&id))return err(400,"invalid post id",len);
    sqlite3_bind_int64(st_post,1,id); char*o=outbuf+HDRMAX; int ok=0;
    if(sqlite3_step(st_post)==SQLITE_ROW){ok=1;o=putlit(o,"{\"post\":");o=put_post(o,st_post);*o++='}';}
    sqlite3_reset(st_post); if(!ok)return err(404,"post not found",len); return finish(200,o,len);}
  if(POST&&pl==6&&!memcmp(path,"/posts",6)){
    auth_t a; int r=do_auth(authh,ahl,&a); if(r)return auth_err(r,len);
    static char sc[20000]; jwant w[1]={{"body",0}}; if(bl>16384||jobject(body,bl,w,1,sc))return err(400,"malformed JSON body",len);
    if(w[0].type!='s')return err(400,"body is required",len);
    const char*b=w[0].sbuf; size_t n=w[0].slen; while(n&&(*b==' '||*b=='\t'||*b=='\n'||*b=='\r'||*b=='\v'||*b=='\f')){b++;n--;} while(n&&(b[n-1]==' '||b[n-1]=='\t'||b[n-1]=='\n'||b[n-1]=='\r'||b[n-1]=='\v'||b[n-1]=='\f'))n--;
    if(!n)return err(400,"body is required",len);
    size_t chars=0; for(size_t i=0;i<n;i++)if(((unsigned char)b[i]&0xC0)!=0x80)chars++;
    if(chars>500)return err(400,"body must be at most 500 characters",len);
    sqlite3_bind_int64(st_ins,1,a.uid); sqlite3_bind_text(st_ins,2,b,n,SQLITE_STATIC);
    int rc=sqlite3_step(st_ins); char*o=outbuf+HDRMAX;
    if(rc!=SQLITE_ROW){sqlite3_reset(st_ins);return err(500,"internal server error",len);}
    long long id=sqlite3_column_int64(st_ins,0); char ca[40]; snprintf(ca,40,"%s",sqlite3_column_text(st_ins,1));
    rc=sqlite3_reset(st_ins); if(rc!=SQLITE_OK)return err(500,"internal server error",len);
    o=putlit(o,"{\"post\":{\"id\":");o=putint(o,id);o=putlit(o,",\"body\":\"");o=jesc(o,b,n);o=putlit(o,"\",\"created_at\":\"");o=putlit(o,ca);o=putlit(o,"\",\"author\":\"");o=jesc(o,a.name,a.nlen);o=putlit(o,"\",\"like_count\":0}}");
    return finish(201,o,len);}
  if(POST&&pl>12&&!memcmp(path,"/posts/",7)&&pl>=5&&!memcmp(path+pl-5,"/like",5)){
    const char*ids=path+7; size_t il=pl-12;
    auth_t a; int r=do_auth(authh,ahl,&a); if(r)return auth_err(r,len);
    long long id; if(parse_id(ids,il,&id))return err(400,"invalid post id",len);
    sqlite3_bind_int64(st_exists,1,id); int ex=sqlite3_step(st_exists)==SQLITE_ROW; sqlite3_reset(st_exists); if(!ex)return err(404,"post not found",len);
    sqlite3_bind_int64(st_like,1,a.uid); sqlite3_bind_int64(st_like,2,id);
    int rc=sqlite3_step(st_like); int ch=sqlite3_changes(db); int rc2=sqlite3_reset(st_like); if(rc!=SQLITE_DONE||rc2!=SQLITE_OK)return err(500,"internal server error",len);
    char*o=outbuf+HDRMAX; o=putlit(o,"{\"liked\":true,\"already_liked\":");o=putlit(o,ch?"false":"true");o=putlit(o,",\"post_id\":");o=putint(o,id);*o++='}'; return finish(ch?201:200,o,len);}
  return err(404,"not found",len);}

/* ---------- connections ---------- */
typedef struct { char*buf; uint32_t len; char*out; uint32_t olen,opos; } conn;
static conn*conns; static int ep;
static void closec(int fd){ if(conns[fd].buf)free(conns[fd].buf); if(conns[fd].out)free(conns[fd].out); memset(&conns[fd],0,sizeof(conn)); close(fd);} 
static int flush_out(int fd){ conn*c=&conns[fd]; while(c->opos<c->olen){ ssize_t n=send(fd,c->out+c->opos,c->olen-c->opos,MSG_NOSIGNAL); if(n>0){c->opos+=n;continue;} if(n<0&&(errno==EAGAIN||errno==EINTR)){ struct epoll_event ev={.events=EPOLLIN|EPOLLOUT,.data.fd=fd}; epoll_ctl(ep,EPOLL_CTL_MOD,fd,&ev); return 1;} return -1;}
  free(c->out);c->out=0;c->olen=c->opos=0; return 0;}
static int send_resp(int fd,const char*p,size_t n){ conn*c=&conns[fd];
  if(c->out){ c->out=realloc(c->out,c->olen+n); memcpy(c->out+c->olen,p,n); c->olen+=n; return flush_out(fd);} 
  ssize_t w=send(fd,p,n,MSG_NOSIGNAL); if(w==(ssize_t)n)return 0; if(w<0&&errno!=EAGAIN&&errno!=EINTR)return -1; if(w<0)w=0;
  c->out=malloc(n-w); memcpy(c->out,p+w,n-w); c->olen=n-w; c->opos=0; struct epoll_event ev={.events=EPOLLIN|EPOLLOUT,.data.fd=fd}; epoll_ctl(ep,EPOLL_CTL_MOD,fd,&ev); return 1;}
static char*cfind(const char*h,size_t n,const char*pat){ size_t pl=strlen(pat); for(size_t i=0;i+pl<=n;i++) if(h[i]==pat[0]&&!strncasecmp(h+i,pat,pl))return (char*)h+i; return 0;}
// process buffer; returns bytes consumed, 0 if need more, -1 close
static ssize_t process(int fd,const char*b,size_t n,int*closeafter){
  const char*he=memmem(b,n,"\r\n\r\n",4); if(!he){ return n>16384?-1:0; }
  size_t hl=he-b+4;
  const char*sp1=memchr(b,' ',hl); if(!sp1)return -1; const char*sp2=memchr(sp1+1,' ',b+hl-sp1-1); if(!sp2)return -1;
  const char*le=memchr(b,'\r',hl);
  size_t cl=0; const char*authh=0; size_t ahl=0; *closeafter=0;
  const char*p=le+2;
  while(p<b+hl-2){ const char*e=memchr(p,'\r',b+hl-p); if(!e)break; size_t ll=e-p;
    if(ll>=15&&!strncasecmp(p,"content-length:",15)){ const char*v=p+15; while(*v==' ')v++; cl=strtoul(v,0,10);} 
    else if(ll>=14&&!strncasecmp(p,"authorization:",14)){ const char*v=p+14; while(*v==' ')v++; authh=v; ahl=e-v; }
    else if(ll>=11&&!strncasecmp(p,"connection:",11)){ if(cfind(p+11,ll-11,"close"))*closeafter=1; }
    p=e+2; }
  if(cl>16384+1024){ return -1; }
  if(hl+cl>n)return 0;
  size_t rl; char*r=handle(b,sp1-b,sp1+1,sp2-sp1-1,authh,ahl,b+hl,cl,&rl);
  int s=send_resp(fd,r,rl); if(s<0)return -1;
  return hl+cl;}
static void on_readable(int fd){
  static char rb[32768]; conn*c=&conns[fd];
  while(1){
    ssize_t n=recv(fd,rb,sizeof rb,0);
    if(n==0){closec(fd);return;} if(n<0){ if(errno==EAGAIN)return; if(errno==EINTR)continue; closec(fd);return;}
    const char*data=rb; size_t dl=n; char*joined=0;
    if(c->buf){ c->buf=realloc(c->buf,c->len+n); memcpy(c->buf+c->len,rb,n); c->len+=n; data=c->buf; dl=c->len; joined=c->buf; }
    size_t off=0; int ca=0;
    while(off<dl){ ssize_t u=process(fd,data+off,dl-off,&ca); if(u<0){closec(fd);return;} if(u==0)break; off+=u; if(ca){closec(fd);return;} }
    if(off<dl){ // keep leftover
      size_t rem=dl-off; char*nb=malloc(rem); memcpy(nb,data+off,rem); if(joined)free(joined); c->buf=nb; c->len=rem; }
    else if(joined){ free(joined); c->buf=0; c->len=0; }
    if((size_t)n<sizeof rb)return; // drained (level-triggered will re-fire otherwise)
  }}

static void prep(sqlite3_stmt**s,const char*sql){ if(sqlite3_prepare_v3(db,sql,-1,SQLITE_PREPARE_PERSISTENT,s,0)){fprintf(stderr,"prepare: %s\n",sqlite3_errmsg(db));exit(1);} }
int main(){
  signal(SIGPIPE,SIG_IGN);
  const char*sec=getenv("JWT_SECRET");if(!sec)sec="twelve-dollar-challenge"; hmac_init(sec,strlen(sec));
  const char*path=getenv("SQLITE_PATH"); const char*host=getenv("HOST"); const char*ps=getenv("PORT"); if(!host)host="127.0.0.1"; int port=ps?atoi(ps):3000;
  if(getenv("SQ_SINGLE"))sqlite3_config(SQLITE_CONFIG_SINGLETHREAD); sqlite3_config(SQLITE_CONFIG_MEMSTATUS,0);
  if(sqlite3_open_v2(path,&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,0)){fprintf(stderr,"open failed\n");return 1;}
  sqlite3_busy_timeout(db,5000);
  sqlite3_exec(db,"PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA mmap_size=1073741824;PRAGMA cache_size=-32768;PRAGMA temp_store=MEMORY;",0,0,0);
  prep(&st_feed,"SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id ORDER BY p.created_at DESC,p.id DESC LIMIT 20");
  prep(&st_post,"SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=?");
  prep(&st_ins,"INSERT INTO posts (user_id,body) VALUES (?,?) RETURNING id,created_at");
  prep(&st_exists,"SELECT 1 FROM posts WHERE id=?");
  prep(&st_like,"INSERT INTO likes (user_id,post_id) VALUES (?,?) ON CONFLICT (user_id,post_id) DO NOTHING");
  prep(&st_health,"SELECT 1");
  struct rlimit rl; getrlimit(RLIMIT_NOFILE,&rl); rl.rlim_cur=rl.rlim_max; setrlimit(RLIMIT_NOFILE,&rl); int maxfd=rl.rlim_cur;
  conns=calloc(maxfd+1,sizeof(conn)); t0=time(0);
  int ls=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK,0); int one=1; setsockopt(ls,SOL_SOCKET,SO_REUSEADDR,&one,4);
  struct sockaddr_in sa={.sin_family=AF_INET,.sin_port=htons(port)}; inet_pton(AF_INET,host,&sa.sin_addr);
  if(bind(ls,(void*)&sa,sizeof sa)||listen(ls,65535)){perror("bind/listen");return 1;}
  ep=epoll_create1(0); struct epoll_event ev={.events=EPOLLIN,.data.fd=ls}; epoll_ctl(ep,EPOLL_CTL_ADD,ls,&ev);
  struct epoll_event evs[512];
  while(1){ int n=epoll_wait(ep,evs,512,-1);
    for(int i=0;i<n;i++){ int fd=evs[i].data.fd;
      if(fd==ls){ while(1){ int c=accept4(ls,0,0,SOCK_NONBLOCK); if(c<0)break; if(c>maxfd){close(c);continue;} setsockopt(c,IPPROTO_TCP,TCP_NODELAY,&one,4); struct epoll_event e={.events=EPOLLIN,.data.fd=c}; epoll_ctl(ep,EPOLL_CTL_ADD,c,&e);} continue; }
      if(evs[i].events&(EPOLLERR|EPOLLHUP)&&!(evs[i].events&EPOLLIN)){closec(fd);continue;}
      if(evs[i].events&EPOLLOUT){ int f=flush_out(fd); if(f<0){closec(fd);continue;} if(f==0){struct epoll_event e={.events=EPOLLIN,.data.fd=fd};epoll_ctl(ep,EPOLL_CTL_MOD,fd,&e);} }
      if(evs[i].events&EPOLLIN)on_readable(fd); } }
}
