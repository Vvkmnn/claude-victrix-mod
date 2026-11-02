// $12 server challenge: single-thread epoll HTTP server in C.
// Writes: SQLite (WAL, group commit). Reads: direct B-tree walk of the SQLite file + WAL (RAW=1, default),
// guarded; any anomaly falls back to the plain SQLite statements (also selectable globally with RAW=0).
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <pthread.h>
#include <setjmp.h>
#include <signal.h>
#include <sqlite3.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

typedef uint8_t u8; typedef uint16_t u16; typedef uint32_t u32; typedef int64_t i64; typedef uint64_t u64;

/* ---------------------------------------------------------------- SHA-256 / HMAC */
static const u32 K256[64] = {
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
#define ROR(x,n) (((x)>>(n))|((x)<<(32-(n))))
static void sha_block(u32 *h, const u8 *p) {
  u32 w[64], a,b,c,d,e,f,g,hh;
  for (int i=0;i<16;i++) w[i]=(u32)p[4*i]<<24|(u32)p[4*i+1]<<16|(u32)p[4*i+2]<<8|p[4*i+3];
  for (int i=16;i<64;i++){u32 s0=ROR(w[i-15],7)^ROR(w[i-15],18)^(w[i-15]>>3),s1=ROR(w[i-2],17)^ROR(w[i-2],19)^(w[i-2]>>10);w[i]=w[i-16]+s0+w[i-7]+s1;}
  a=h[0];b=h[1];c=h[2];d=h[3];e=h[4];f=h[5];g=h[6];hh=h[7];
  for (int i=0;i<64;i++){u32 S1=ROR(e,6)^ROR(e,11)^ROR(e,25),ch=(e&f)^(~e&g),t1=hh+S1+ch+K256[i]+w[i],S0=ROR(a,2)^ROR(a,13)^ROR(a,22),mj=(a&b)^(a&c)^(b&c),t2=S0+mj;
    hh=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;}
  h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;
}
static const u32 H0[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
// continue hash from state `st` (which has absorbed `prior` bytes), over msg, finalize into out[32]
static void sha_fin(const u32 *st, u64 prior, const u8 *msg, size_t len, u8 *out) {
  u32 h[8]; memcpy(h,st,32); u8 tail[128]; size_t i=0;
  for (; i+64<=len; i+=64) sha_block(h,msg+i);
  size_t r=len-i; memcpy(tail,msg+i,r); tail[r++]=0x80;
  size_t tl=(r+8<=64)?64:128; memset(tail+r,0,tl-r);
  u64 bits=(prior+len)*8; for(int k=0;k<8;k++) tail[tl-1-k]=(u8)(bits>>(8*k));
  for (size_t o=0;o<tl;o+=64) sha_block(h,tail+o);
  for (int k=0;k<8;k++){out[4*k]=h[k]>>24;out[4*k+1]=h[k]>>16;out[4*k+2]=h[k]>>8;out[4*k+3]=h[k];}
}
static u32 ipad_st[8], opad_st[8];
static void hmac_init(const char *key, size_t kl) {
  u8 k[64]={0}, blk[64];
  if (kl>64){ sha_fin(H0,0,(const u8*)key,kl,k); } else memcpy(k,key,kl);
  memcpy(ipad_st,H0,32); for(int i=0;i<64;i++) blk[i]=k[i]^0x36; sha_block(ipad_st,blk);
  memcpy(opad_st,H0,32); for(int i=0;i<64;i++) blk[i]=k[i]^0x5c; sha_block(opad_st,blk);
}
static void hmac(const u8 *msg, size_t len, u8 *out) {
  u8 in[32]; sha_fin(ipad_st,64,msg,len,in); sha_fin(opad_st,64,in,32,out);
}
static const char B64U[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
static int b64u_val(u8 c){ if(c>='A'&&c<='Z')return c-'A'; if(c>='a'&&c<='z')return c-'a'+26; if(c>='0'&&c<='9')return c-'0'+52; if(c=='-')return 62; if(c=='_')return 63; return -1; }
static int b64u_dec(const u8 *s, size_t n, u8 *out, size_t cap, size_t *ol) {
  size_t o=0; u32 acc=0; int bits=0;
  for (size_t i=0;i<n;i++){ int v=b64u_val(s[i]); if(v<0) return -1; acc=(acc<<6)|v; bits+=6; if(bits>=8){bits-=8; if(o>=cap) return -1; out[o++]=(u8)(acc>>bits);} }
  if (n%4==1) return -1; *ol=o; return 0;
}

/* ---------------------------------------------------------------- JSON scanner */
typedef struct { const u8 *p,*e; } J;
static void jws(J*j){ while(j->p<j->e && (*j->p==' '||*j->p=='\t'||*j->p=='\n'||*j->p=='\r')) j->p++; }
static int hex4(const u8*p){ int v=0; for(int i=0;i<4;i++){ int c=p[i]; if(c>='0'&&c<='9')c-='0'; else if(c>='a'&&c<='f')c=c-'a'+10; else if(c>='A'&&c<='F')c=c-'A'+10; else return -1; v=v*16+c;} return v; }
static size_t put_utf8(u8*o,u32 c){ if(c<0x80){o[0]=c;return 1;} if(c<0x800){o[0]=0xC0|c>>6;o[1]=0x80|(c&63);return 2;} if(c<0x10000){o[0]=0xE0|c>>12;o[1]=0x80|((c>>6)&63);o[2]=0x80|(c&63);return 3;} o[0]=0xF0|c>>18;o[1]=0x80|((c>>12)&63);o[2]=0x80|((c>>6)&63);o[3]=0x80|(c&63);return 4; }
// parse a string starting at the opening quote. Decodes into out (cap bytes max stored), *n = total decoded length. 0 ok.
static int jstr(J*j, u8*out, size_t cap, size_t*n) {
  if (j->p>=j->e||*j->p!='"') return -1; j->p++; size_t o=0;
  #define EMIT(b) do{ if(out&&o<cap) out[o]=(b); o++; }while(0)
  for(;;){ if(j->p>=j->e) return -1; u8 c=*j->p++;
    if (c=='"') break; if (c<0x20) return -1;
    if (c!='\\') { EMIT(c); continue; }
    if (j->p>=j->e) return -1; c=*j->p++;
    switch(c){ case '"':EMIT('"');break; case '\\':EMIT('\\');break; case '/':EMIT('/');break; case 'b':EMIT('\b');break; case 'f':EMIT('\f');break; case 'n':EMIT('\n');break; case 'r':EMIT('\r');break; case 't':EMIT('\t');break;
      case 'u': { if (j->e-j->p<4) return -1; int u=hex4(j->p); if(u<0) return -1; j->p+=4; u32 cp=u;
        if (u>=0xD800&&u<0xDC00&&j->e-j->p>=6&&j->p[0]=='\\'&&j->p[1]=='u'){ int l=hex4(j->p+2); if(l>=0xDC00&&l<0xE000){cp=0x10000+((u-0xD800)<<10)+(l-0xDC00); j->p+=6;} }
        u8 t[4]; size_t k=put_utf8(t,cp); for(size_t i=0;i<k;i++) EMIT(t[i]); break; }
      default: return -1; } }
  if(n)*n=o; return 0; }
static int jskip(J*j,int depth);
static int jnum(J*j,const u8**s,size_t*l){ const u8*b=j->p; if(j->p<j->e&&*j->p=='-')j->p++; if(j->p>=j->e)return -1;
  if(*j->p=='0')j->p++; else if(*j->p>='1'&&*j->p<='9'){ while(j->p<j->e&&*j->p>='0'&&*j->p<='9')j->p++; } else return -1;
  if(j->p<j->e&&*j->p=='.'){ j->p++; if(j->p>=j->e||*j->p<'0'||*j->p>'9')return -1; while(j->p<j->e&&*j->p>='0'&&*j->p<='9')j->p++; }
  if(j->p<j->e&&(*j->p=='e'||*j->p=='E')){ j->p++; if(j->p<j->e&&(*j->p=='+'||*j->p=='-'))j->p++; if(j->p>=j->e||*j->p<'0'||*j->p>'9')return -1; while(j->p<j->e&&*j->p>='0'&&*j->p<='9')j->p++; }
  if(s)*s=b; if(l)*l=j->p-b; return 0; }
static int jskip(J*j,int depth){ if(depth>64) return -1; jws(j); if(j->p>=j->e) return -1; u8 c=*j->p;
  if(c=='"') return jstr(j,NULL,0,NULL);
  if(c=='{'){ j->p++; jws(j); if(j->p<j->e&&*j->p=='}'){j->p++;return 0;} for(;;){ jws(j); if(jstr(j,NULL,0,NULL))return -1; jws(j); if(j->p>=j->e||*j->p!=':')return -1; j->p++; if(jskip(j,depth+1))return -1; jws(j); if(j->p>=j->e)return -1; if(*j->p==','){j->p++;continue;} if(*j->p=='}'){j->p++;return 0;} return -1; } }
  if(c=='['){ j->p++; jws(j); if(j->p<j->e&&*j->p==']'){j->p++;return 0;} for(;;){ if(jskip(j,depth+1))return -1; jws(j); if(j->p>=j->e)return -1; if(*j->p==','){j->p++;continue;} if(*j->p==']'){j->p++;return 0;} return -1; } }
  if(c=='-'||(c>='0'&&c<='9')) return jnum(j,NULL,NULL);
  if(j->e-j->p>=4&&!memcmp(j->p,"true",4)){j->p+=4;return 0;} if(j->e-j->p>=5&&!memcmp(j->p,"false",5)){j->p+=5;return 0;} if(j->e-j->p>=4&&!memcmp(j->p,"null",4)){j->p+=4;return 0;}
  return -1; }
// Top-level object scan. For each wanted key returns type: 0 absent, 's' string (decoded in buf), 'n' number (numtxt), 'o' other.
typedef struct { const char*name; int type; u8*buf; size_t cap, len; double num; } JKey;
// returns: 0 ok, -1 malformed, 1 valid JSON but not an object
static int jscan(const u8*s,size_t n,JKey*keys,int nk) {
  J j={s,s+n}; jws(&j); if(j.p>=j.e) return -1;
  if(*j.p!='{'){ if(jskip(&j,0)) return -1; jws(&j); return j.p==j.e?1:-1; }
  j.p++; jws(&j);
  if(j.p<j.e&&*j.p=='}'){ j.p++; jws(&j); return j.p==j.e?0:-1; }
  for(;;){ u8 kb[40]; size_t kl; jws(&j); if(jstr(&j,kb,sizeof kb,&kl)) return -1; jws(&j); if(j.p>=j.e||*j.p!=':') return -1; j.p++; jws(&j); if(j.p>=j.e) return -1;
    JKey*m=NULL; if(kl<sizeof kb) for(int i=0;i<nk;i++) if(strlen(keys[i].name)==kl&&!memcmp(keys[i].name,kb,kl)){m=&keys[i];break;}
    if(m){ if(*j.p=='"'){ if(jstr(&j,m->buf,m->cap,&m->len)) return -1; m->type='s'; }
           else if(*j.p=='-'||(*j.p>='0'&&*j.p<='9')){ const u8*ns; size_t nl; if(jnum(&j,&ns,&nl)) return -1; char t[64]; size_t c=nl<63?nl:63; memcpy(t,ns,c); t[c]=0; m->num=strtod(t,NULL); m->type='n'; }
           else { if(jskip(&j,1)) return -1; m->type='o'; } }
    else if(jskip(&j,1)) return -1;
    jws(&j); if(j.p>=j.e) return -1; if(*j.p==','){j.p++;continue;} if(*j.p=='}'){j.p++;break;} return -1; }
  jws(&j); return j.p==j.e?0:-1; }

/* ---------------------------------------------------------------- output helpers */
static char *op; // output cursor
static inline void put(const char*s,size_t n){ memcpy(op,s,n); op+=n; }
#define PUTS(s) put(s,sizeof(s)-1)
static void put_u64(u64 v){ char t[24]; int n=0; do{t[n++]='0'+v%10;v/=10;}while(v); while(n) *op++=t[--n]; }
static const char HEXD[]="0123456789abcdef";
static void put_json_str(const u8*s,size_t n){ // content only, no quotes
  size_t i=0, st=0;
  for(;i<n;i++){ u8 c=s[i]; if(c>=0x20&&c!='"'&&c!='\\') continue;
    put((const char*)s+st,i-st); st=i+1;
    switch(c){ case '"':PUTS("\\\"");break; case '\\':PUTS("\\\\");break; case '\n':PUTS("\\n");break; case '\r':PUTS("\\r");break; case '\t':PUTS("\\t");break; case '\b':PUTS("\\b");break; case '\f':PUTS("\\f");break;
      default: PUTS("\\u00"); *op++=HEXD[c>>4]; *op++=HEXD[c&15]; } }
  put((const char*)s+st,n-st); }

/* ---------------------------------------------------------------- raw SQLite reader */
static sqlite3 *db;
static int g_raw = 1;           // global switch (RAW env, startup self-check)
static const u8 *dbmap; static size_t dbmap_len; static int dbfd = -1; static u32 db_pages;
static const u8 *walmap; static int walfd = -1;
static const u8 *shmmap; static size_t shmmap_len; static int shmfd = -1;
#define PSZ 4096
#define WAL_MAP_SZ (1ULL<<32)
static u32 root_posts, root_users, root_likes_idx, root_feed_idx;
static jmp_buf bail;
#define BAIL() longjmp(bail,1)
static unsigned long stat_raw_ok, stat_fallback;

static inline u32 be32(const u8*p){ return (u32)p[0]<<24|(u32)p[1]<<16|(u32)p[2]<<8|p[3]; }
static inline u32 be16(const u8*p){ return (u32)p[0]<<8|p[1]; }
static int map_db(void) {
  struct stat st; if (fstat(dbfd,&st)) return -1;
  if (dbmap) munmap((void*)dbmap, dbmap_len);
  dbmap_len = st.st_size & ~(size_t)(PSZ-1);
  dbmap = mmap(NULL, dbmap_len, PROT_READ, MAP_SHARED|MAP_POPULATE, dbfd, 0);
  if (dbmap==MAP_FAILED){ dbmap=NULL; return -1; }
  db_pages = dbmap_len/PSZ; return 0; }
static int map_shm(void) {
  struct stat st; if (fstat(shmfd,&st)) return -1;
  if (shmmap) munmap((void*)shmmap, shmmap_len);
  shmmap_len = st.st_size;
  shmmap = mmap(NULL, shmmap_len, PROT_READ, MAP_SHARED, shmfd, 0);
  if (shmmap==MAP_FAILED){ shmmap=NULL; shmmap_len=0; return -1; }
  return 0; }
// WAL index lookup (format documented in sqlite's wal.c / https://sqlite.org/walformat.html)
static u32 wal_find(u32 pgno, u32 mx) {
  u32 lastblk = mx<=4062 ? 0 : 1 + (mx-4062-1)/4096;
  if (!shmmap || shmmap_len < (size_t)(lastblk+1)*32768) { if (map_shm() || shmmap_len < (size_t)(lastblk+1)*32768) BAIL(); }
  for (int blk=(int)lastblk; blk>=0; blk--) {
    const u8 *base = shmmap + (size_t)blk*32768;
    const u8 *apgno = blk==0 ? base+136 : base;      // entry k (1-based) is at apgno + 4*(k-1)
    const u16 *hash = (const u16*)(base+16384);
    u32 izero = blk==0 ? 0 : 4062 + (u32)(blk-1)*4096;
    u32 best = 0; u32 h = (pgno*383u)&8191;
    u16 k;
    while ((k = hash[h]) != 0) {
      if (k > 4096) BAIL();
      u32 fr = izero + k;
      if (fr<=mx && *(const u32*)(apgno+4*(k-1))==pgno && fr>best) best=fr;
      h = (h+1)&8191; }
    if (best) return best; }
  return 0; }
static u32 g_mx;   // WAL mxFrame snapshot for the current read
static inline const u8 *getpage(u32 pgno) {
  if (pgno==0) BAIL();
  if (g_mx) {
    u32 f = wal_find(pgno, g_mx);
    if (f) { const u8 *fr = walmap + 32 + (size_t)(f-1)*(PSZ+24);
             if (be32(fr)!=pgno) BAIL();           // guard: frame header must name this page
             return fr+24; } }
  if (pgno>db_pages) { if (map_db() || pgno>db_pages) BAIL(); }
  return dbmap + (size_t)(pgno-1)*PSZ; }

static inline int varint(const u8*p, i64*v){ u64 x=0; for(int i=0;i<8;i++){ x=(x<<7)|(p[i]&0x7f); if(!(p[i]&0x80)){*v=(i64)x;return i+1;} } x=(x<<8)|p[8]; *v=(i64)x; return 9; }

typedef struct { int st; i64 iv; const u8 *p; u32 n; } Col;
static const u8 stlen[12]={0,1,2,3,4,6,8,8,0,0,0,0};
// parse first `want` columns of a record
static void rec_cols(const u8*pl, u32 plen, Col*c, int want) {
  i64 hl; int hn=varint(pl,&hl); if(hl>plen||hl<hn) BAIL();
  const u8 *h=pl+hn, *he=pl+hl, *d=pl+hl;
  for(int i=0;i<want;i++){
    if(h>=he) BAIL(); i64 st; h+=varint(h,&st); c[i].st=(int)st; c[i].p=d; c[i].iv=0; c[i].n=0;
    u32 sz;
    if(st<12){ if(st==10||st==11) BAIL(); sz=stlen[st]; if(st>=1&&st<=6){ i64 v=(int8_t)d[0]; if(d+sz>pl+plen) BAIL(); for(u32 k=1;k<sz;k++) v=(v<<8)|d[k]; c[i].iv=v; } else if(st==9) c[i].iv=1; }
    else { sz=(u32)((st-12)/2 + ((st&1)? 0:0)); sz = (st&1)? (u32)((st-13)/2) : (u32)((st-12)/2); }
    if(d+sz>pl+plen) BAIL(); c[i].n=sz; d+=sz; } }
static inline int istext(const Col*c){ return c->st>=13 && (c->st&1); }
static inline int isint(const Col*c){ return (c->st>=1&&c->st<=6)||c->st==8||c->st==9; }

// page header helpers. All our b-trees are on pages >= 2 (offset 0).
static inline u32 ncells(const u8*p){ return be16(p+3); }
static inline const u8 *cell(const u8*p, int hdr, u32 i){ u32 off=be16(p+hdr+2*i); if(off<hdr||off>=PSZ) BAIL(); return p+off; }

// table b-tree: find row by rowid, return payload ptr/len
static const u8 *table_find(u32 root, i64 rowid, u32*plen) {
  u32 pg=root;
  for(int depth=0; depth<10; depth++){
    const u8 *p=getpage(pg); u8 t=p[0]; u32 n=ncells(p);
    if(t==0x05){ // interior: cells [child u32][rowid varint]
      u32 lo=0, hi=n; // first cell with key >= rowid
      while(lo<hi){ u32 m=(lo+hi)/2; const u8*c=cell(p,12,m); i64 k; varint(c+4,&k); if(k<rowid) lo=m+1; else hi=m; }
      if(lo<n) pg=be32(cell(p,12,lo)); else pg=be32(p+8);
    } else if(t==0x0d){
      u32 lo=0, hi=n;
      while(lo<hi){ u32 m=(lo+hi)/2; const u8*c=cell(p,8,m); i64 pl,k; int a=varint(c,&pl); varint(c+a,&k); if(k<rowid) lo=m+1; else hi=m; }
      if(lo>=n) return NULL;
      const u8*c=cell(p,8,lo); i64 pl,k; int a=varint(c,&pl); int b=varint(c+a,&k);
      if(k!=rowid) return NULL;
      if(pl>PSZ-35) BAIL();          // overflow pages: not handled, fall back
      *plen=(u32)pl; return c+a+b;
    } else BAIL(); }
  BAIL(); return NULL; }

// index b-tree: count entries whose first column == key (integer)
static u32 idx_count(u32 pg, i64 key, int depth) {
  if(depth>10) BAIL();
  const u8 *p=getpage(pg); u8 t=p[0]; u32 n=ncells(p); int hdr=(t==0x02)?12:8;
  if(t!=0x02&&t!=0x0a) BAIL();
  // binary search first cell with first column >= key
  u32 lo=0, hi=n;
  while(lo<hi){ u32 m=(lo+hi)/2; const u8*c=cell(p,hdr,m); const u8*q=c+(t==0x02?4:0); i64 pl; q+=varint(q,&pl); if(pl>1000) BAIL(); Col col[1]; rec_cols(q,(u32)pl,col,1); if(!isint(&col[0])) BAIL(); if(col[0].iv<key) lo=m+1; else hi=m; }
  u32 cnt=0;
  if(t==0x0a){ for(u32 i=lo;i<n;i++){ const u8*q=cell(p,8,i); i64 pl; q+=varint(q,&pl); Col col[1]; rec_cols(q,(u32)pl,col,1); if(col[0].iv!=key) break; cnt++; } return cnt; }
  for(u32 i=lo;i<n;i++){
    const u8*c=cell(p,12,i); const u8*q=c+4; i64 pl; q+=varint(q,&pl); Col col[1]; rec_cols(q,(u32)pl,col,1);
    cnt+=idx_count(be32(c),key,depth+1);          // left subtree may hold keys == key
    if(col[0].iv!=key) return cnt;                // first key > key: nothing further right matters
    cnt++; }                                      // the interior entry itself
  return cnt+idx_count(be32(p+8),key,depth+1); }

// feed index: first `want` entries in index order (created_at DESC, id DESC); store rowid (last column)
static int feed_collect(u32 pg, i64*ids, int have, int want, int depth) {
  if(depth>10) BAIL();
  const u8 *p=getpage(pg); u8 t=p[0]; u32 n=ncells(p);
  if(t==0x0a){ for(u32 i=0;i<n&&have<want;i++){ const u8*q=cell(p,8,i); i64 pl; q+=varint(q,&pl); if(pl>1000) BAIL(); Col col[3]; rec_cols(q,(u32)pl,col,3); if(!isint(&col[2])) BAIL(); ids[have++]=col[2].iv; } return have; }
  if(t!=0x02) BAIL();
  for(u32 i=0;i<n&&have<want;i++){
    const u8*c=cell(p,12,i); have=feed_collect(be32(c),ids,have,want,depth+1); if(have>=want) return have;
    const u8*q=c+4; i64 pl; q+=varint(q,&pl); if(pl>1000) BAIL(); Col col[3]; rec_cols(q,(u32)pl,col,3); if(!isint(&col[2])) BAIL(); ids[have++]=col[2].iv; }
  if(have<want) have=feed_collect(be32(p+8),ids,have,want,depth+1);
  return have; }

// emit post JSON from raw tables. returns 0 if row missing
static int raw_post(i64 id) {
  u32 pl; const u8*r=table_find(root_posts,id,&pl); if(!r) return 0;
  Col c[4]; rec_cols(r,pl,c,4); if(!isint(&c[1])||!istext(&c[2])||!istext(&c[3])) BAIL();
  u32 ul; const u8*ur=table_find(root_users,c[1].iv,&ul); if(!ur) BAIL();
  Col u[2]; rec_cols(ur,ul,u,2); if(!istext(&u[1])) BAIL();
  u32 lc=idx_count(root_likes_idx,id,0);
  PUTS("{\"id\":"); put_u64((u64)id); PUTS(",\"body\":\""); put_json_str(c[2].p,c[2].n); PUTS("\",\"created_at\":\""); put((const char*)c[3].p,c[3].n);
  PUTS("\",\"author\":\""); put_json_str(u[1].p,u[1].n); PUTS("\",\"like_count\":"); put_u64(lc); *op++='}';
  return 1; }

/* ---------------------------------------------------------------- SQLite statements */
static sqlite3_stmt *s_feed, *s_post, *s_health, *s_exists, *s_like, *s_ins, *s_begin, *s_commit, *s_rollback;
static void emit_row(sqlite3_stmt*s) {
  PUTS("{\"id\":"); put_u64((u64)sqlite3_column_int64(s,0)); PUTS(",\"body\":\""); put_json_str(sqlite3_column_text(s,1),sqlite3_column_bytes(s,1));
  PUTS("\",\"created_at\":\""); put((const char*)sqlite3_column_text(s,2),sqlite3_column_bytes(s,2));
  PUTS("\",\"author\":\""); put_json_str(sqlite3_column_text(s,3),sqlite3_column_bytes(s,3)); PUTS("\",\"like_count\":"); put_u64((u64)sqlite3_column_int64(s,4)); *op++='}'; }
static int sql_post(i64 id) { sqlite3_bind_int64(s_post,1,id); int found=0; if(sqlite3_step(s_post)==SQLITE_ROW){ emit_row(s_post); found=1; } sqlite3_reset(s_post); return found; }
static void sql_feed(void) { int first=1; while(sqlite3_step(s_feed)==SQLITE_ROW){ if(!first)*op++=','; first=0; emit_row(s_feed);} sqlite3_reset(s_feed); }

// snapshot WAL state for a raw read; returns 0 if raw is not usable right now
static inline int raw_begin(void) {
  if(!g_raw) return 0;
  if(!shmmap && map_shm()) return 0;
  if(shmmap_len<32768) { if(map_shm()||shmmap_len<32768) return 0; }
  g_mx = *(const u32*)(shmmap+16);
  if (*(const u8*)(shmmap+12)!=1) return 0;            // WalIndexHdr.isInit
  if (g_mx && *(const u16*)(shmmap+14)!=PSZ) return 0; // page size
  return 1; }
static int get_post(i64 id, char *mark) {   // returns found; output appended at op
  if(raw_begin()){
    if(!setjmp(bail)){ int r=raw_post(id); stat_raw_ok++; return r; }
    op=mark; stat_fallback++; }
  return sql_post(id); }
static void get_feed(char *mark) {
  if(raw_begin()){
    if(!setjmp(bail)){ i64 ids[20]; int n=feed_collect(root_feed_idx,ids,0,20,0);
      for(int i=0;i<n;i++){ if(i)*op++=','; if(!raw_post(ids[i])) BAIL(); }
      stat_raw_ok++; return; }
    op=mark; stat_fallback++; }
  sql_feed(); }

/* ---------------------------------------------------------------- HTTP */
typedef struct Conn { int fd; u32 inlen, outlen, outoff; u8 *in; u8 *out; u16 npend; u8 closing, wantout; } Conn;
static Conn *conns; static int maxfd; static int epfd, lfd;
static time_t t_start;
static char obuf[1<<20];
#define BODY_AT 192
static const char *jwt_secret;

static void conn_close(Conn*c);
static void ep_mod(Conn*c,int out){ struct epoll_event e={.events=EPOLLIN|EPOLLRDHUP|(out?EPOLLOUT:0),.data.ptr=c}; epoll_ctl(epfd,EPOLL_CTL_MOD,c->fd,&e); c->wantout=out; }
static void send_all(Conn*c,const char*b,size_t n) {
  if(c->closing) return;
  if(c->outlen==0){ ssize_t w=send(c->fd,b,n,MSG_NOSIGNAL); if(w==(ssize_t)n) return; if(w<0){ if(errno!=EAGAIN&&errno!=EWOULDBLOCK&&errno!=EINTR){ c->closing=1; return; } w=0; } b+=w; n-=w; }
  c->out=realloc(c->out,c->outlen+n); memcpy(c->out+c->outlen,b,n); c->outlen+=n; if(!c->wantout) ep_mod(c,1); }
static const char *status_text(int s){ switch(s){case 200:return "OK";case 201:return "Created";case 400:return "Bad Request";case 401:return "Unauthorized";case 404:return "Not Found";case 503:return "Service Unavailable";default:return "Internal Server Error";} }
// body was built at obuf+BODY_AT .. op. finalize with header and send.
static void finish(Conn*c,int status,int keep) {
  size_t bl=op-(obuf+BODY_AT); char h[160]; int hl=snprintf(h,sizeof h,"HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n%s\r\n",status,status_text(status),bl,keep?"":"Connection: close\r\n");
  char *start=obuf+BODY_AT-hl; memcpy(start,h,hl); send_all(c,start,hl+bl); if(!keep) c->closing=1; }
static void err(Conn*c,int status,const char*msg,int keep){ op=obuf+BODY_AT; PUTS("{\"error\":\""); put(msg,strlen(msg)); PUTS("\"}"); finish(c,status,keep); }

/* pending writes (group commit) */
typedef struct { Conn *c; int kind; int keep; i64 uid; i64 pid; char user[64]; u32 ulen; u32 boff, blen; } Pend;
#define MAXPEND 4096
static Pend pend[MAXPEND]; static int npend; static char parena[MAXPEND*2048+4096]; static u32 parena_len;
static int g_dbg; static double mono(void){ struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec+t.tv_nsec*1e-9; }
static void flush_pending(void) {
  if(!npend) return; double T0=g_dbg?mono():0; int N0=npend;
  int ok = sqlite3_step(s_begin)==SQLITE_DONE; sqlite3_reset(s_begin);
  struct R { int status; i64 id; char ts[32]; int already; } *res = malloc(sizeof(struct R)*npend);
  for(int i=0;i<npend;i++){ Pend*p=&pend[i]; struct R*r=&res[i]; r->status=500;
    if(!ok) continue;
    if(p->kind==0){ sqlite3_bind_int64(s_ins,1,p->uid); sqlite3_bind_text(s_ins,2,parena+p->boff,p->blen,SQLITE_STATIC);
      if(sqlite3_step(s_ins)==SQLITE_ROW){ r->id=sqlite3_column_int64(s_ins,0); snprintf(r->ts,sizeof r->ts,"%s",sqlite3_column_text(s_ins,1)); r->status=201; }
      sqlite3_reset(s_ins); }
    else { sqlite3_bind_int64(s_exists,1,p->pid); int ex=sqlite3_step(s_exists)==SQLITE_ROW; sqlite3_reset(s_exists);
      if(!ex) r->status=404; else { sqlite3_bind_int64(s_like,1,p->uid); sqlite3_bind_int64(s_like,2,p->pid);
        if(sqlite3_step(s_like)==SQLITE_DONE){ r->already = sqlite3_changes(db)==0; r->status = r->already?200:201; } sqlite3_reset(s_like); } } }
  int committed = ok && sqlite3_step(s_commit)==SQLITE_DONE; sqlite3_reset(s_commit);
  if(ok && !committed){ sqlite3_step(s_rollback); sqlite3_reset(s_rollback); }
  for(int i=0;i<npend;i++){ Pend*p=&pend[i]; struct R*r=&res[i]; Conn*c=p->c; c->npend--;
    int st = committed? r->status : 500;
    op=obuf+BODY_AT;
    if(st==500) PUTS("{\"error\":\"internal server error\"}");
    else if(st==404) PUTS("{\"error\":\"post not found\"}");
    else if(p->kind==0){ PUTS("{\"post\":{\"id\":"); put_u64((u64)r->id); PUTS(",\"body\":\""); put_json_str((u8*)parena+p->boff,p->blen); PUTS("\",\"created_at\":\""); put(r->ts,strlen(r->ts)); PUTS("\",\"author\":\""); put_json_str((u8*)p->user,p->ulen); PUTS("\",\"like_count\":0}}"); }
    else { PUTS("{\"liked\":true,\"already_liked\":"); if(r->already) PUTS("true"); else PUTS("false"); PUTS(",\"post_id\":"); put_u64((u64)p->pid); *op++='}'; }
    finish(c,st,p->keep); }
  free(res); npend=0; parena_len=0;
  if(g_dbg){ double d=mono()-T0; if(d>0.005) fprintf(stderr,"slow flush %d writes %.1f ms\n",N0,d*1e3); } }

static int ci_eq(const u8*s,size_t n,const char*lit){ size_t l=strlen(lit); if(n<l) return 0; for(size_t i=0;i<l;i++){ u8 a=s[i]; if(a>='A'&&a<='Z')a+=32; if(a!=lit[i]) return 0; } return 1; }

// returns 0 ok (uid,user set), else sends error and returns 1
static int auth(Conn*c,const u8*h,size_t hl,int keep,i64*uid,char*user,u32*ulen) {
  if(!h||hl<7||memcmp(h,"Bearer ",7)){ err(c,401,"missing bearer token",keep); return 1; }
  const u8*t=h+7; size_t tl=hl-7;
  const u8*d1=memchr(t,'.',tl); if(!d1) goto inval; const u8*d2=memchr(d1+1,'.',tl-(d1+1-t)); if(!d2) goto inval;
  if(memchr(d2+1,'.',tl-(d2+1-t))) goto inval;
  { size_t sl=tl-(d2+1-t); if(sl!=43) goto inval;
    u8 mac[32]; hmac(t,d2-t,mac); u8 sig[40]; size_t sn; if(b64u_dec(d2+1,sl,sig,sizeof sig,&sn)||sn!=32) goto inval;
    u8 diff=0; for(int i=0;i<32;i++) diff|=mac[i]^sig[i]; if(diff) goto inval;
    u8 hb[256]; size_t hn; if(b64u_dec(t,d1-t,hb,sizeof hb,&hn)) goto inval;
    u8 alg[16]; JKey hk[1]={{"alg",0,alg,sizeof alg-1,0,0}}; if(jscan(hb,hn,hk,1)!=0||hk[0].type!='s'||hk[0].len!=5||memcmp(alg,"HS256",5)) goto inval;
    u8 pb[512]; size_t pn; if(b64u_dec(d1+1,d2-d1-1,pb,sizeof pb,&pn)) goto inval;
    u8 sub[32], un[64]; JKey pk[4]={{"sub",0,sub,sizeof sub,0,0},{"username",0,un,sizeof un,0,0},{"exp",0,NULL,0,0,0},{"nbf",0,NULL,0,0,0}};
    if(jscan(pb,pn,pk,4)!=0) goto inval;
    time_t now=time(NULL);
    if(pk[2].type=='n' && !(pk[2].num > (double)now)) goto inval;
    if(pk[3].type=='n' && pk[3].num > (double)now) goto inval;
    if(pk[0].type!='s'||pk[0].len==0||pk[0].len>=sizeof sub||pk[1].type!='s'||pk[1].len>=sizeof un) { err(c,401,"invalid token payload",keep); return 1; }
    i64 v=0; for(size_t i=0;i<pk[0].len;i++){ if(sub[i]<'0'||sub[i]>'9'||v>(INT64_MAX-9)/10){ err(c,401,"invalid token payload",keep); return 1; } v=v*10+(sub[i]-'0'); }
    if(v<=0||(pk[0].len>1&&sub[0]=='0')){ err(c,401,"invalid token payload",keep); return 1; }
    *uid=v; memcpy(user,un,pk[1].len); *ulen=pk[1].len; return 0; }
inval: err(c,401,"invalid or expired token",keep); return 1; }

static int parse_id(const u8*s,size_t n,i64*id){ if(n==0||n>18) return 0; i64 v=0; for(size_t i=0;i<n;i++){ if(s[i]<'0'||s[i]>'9') return 0; v=v*10+(s[i]-'0'); } if(v<=0) return 0; *id=v; return 1; }
static int is_ws_utf8(const u8*s,size_t n,size_t*adv,int fwd) { // helper unused for ASCII fast path
  (void)s;(void)n;(void)adv;(void)fwd; return 0; }

static size_t trim_ws(const u8**sp,size_t n) { // JS String.prototype.trim semantics (common code points)
  const u8*s=*sp;
  for(;;){ if(!n)break; u8 c=*s;
    if(c==' '||(c>=9&&c<=13)){s++;n--;continue;}
    if(n>=2&&c==0xC2&&s[1]==0xA0){s+=2;n-=2;continue;}
    if(n>=3&&c==0xE1&&s[1]==0x9A&&s[2]==0x80){s+=3;n-=3;continue;}
    if(n>=3&&c==0xE2&&s[1]==0x80&&((s[2]>=0x80&&s[2]<=0x8A)||s[2]==0xA8||s[2]==0xA9||s[2]==0xAF)){s+=3;n-=3;continue;}
    if(n>=3&&c==0xE2&&s[1]==0x81&&s[2]==0x9F){s+=3;n-=3;continue;}
    if(n>=3&&c==0xE3&&s[1]==0x80&&s[2]==0x80){s+=3;n-=3;continue;}
    if(n>=3&&c==0xEF&&s[1]==0xBB&&s[2]==0xBF){s+=3;n-=3;continue;}
    break; }
  for(;;){ if(!n)break; u8 c=s[n-1];
    if(c==' '||(c>=9&&c<=13)){n--;continue;}
    if(n>=2&&c==0xA0&&s[n-2]==0xC2){n-=2;continue;}
    if(n>=3){ u8 a=s[n-3],b=s[n-2];
      if(a==0xE1&&b==0x9A&&c==0x80){n-=3;continue;}
      if(a==0xE2&&b==0x80&&((c>=0x80&&c<=0x8A)||c==0xA8||c==0xA9||c==0xAF)){n-=3;continue;}
      if(a==0xE2&&b==0x81&&c==0x9F){n-=3;continue;}
      if(a==0xE3&&b==0x80&&c==0x80){n-=3;continue;}
      if(a==0xEF&&b==0xBB&&c==0xBF){n-=3;continue;} }
    break; }
  *sp=s; return n; }

static void queue_write(Conn*c,int kind,int keep,i64 uid,i64 pid,const char*user,u32 ulen,const u8*body,u32 blen) {
  if(npend>=MAXPEND||parena_len+blen+8>sizeof parena) flush_pending();
  Pend*p=&pend[npend++]; p->c=c; p->kind=kind; p->keep=keep; p->uid=uid; p->pid=pid; p->ulen=ulen; memcpy(p->user,user,ulen); p->boff=parena_len; p->blen=blen; if(blen) memcpy(parena+parena_len,body,blen); parena_len+=blen; c->npend++; }

// handle one complete request. Returns after queueing or answering.
static void handle(Conn*c,const u8*m,size_t ml,const u8*path,size_t pl,const u8*auth_h,size_t auth_l,const u8*body,size_t bl,int keep) {
  const u8*q=memchr(path,'?',pl); if(q) pl=q-path;
  int isget = ml==3&&!memcmp(m,"GET",3), ispost = ml==4&&!memcmp(m,"POST",4);
  op=obuf+BODY_AT; char*mark=op;
  if(isget){
    if(pl==5&&!memcmp(path,"/feed",5)){ PUTS("{\"posts\":["); get_feed(op); PUTS("]}"); finish(c,200,keep); return; }
    if(pl==7&&!memcmp(path,"/health",7)){
      int ok = sqlite3_step(s_health)==SQLITE_ROW; sqlite3_reset(s_health);
      if(ok){ PUTS("{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":"); put_u64((u64)(time(NULL)-t_start)); *op++='}'; finish(c,200,keep); }
      else { PUTS("{\"status\":\"degraded\",\"db\":\"unreachable\",\"error\":\"select failed\"}"); finish(c,503,keep); } return; }
    if(pl>=7&&!memcmp(path,"/posts/",7)){
      i64 id; if(!parse_id(path+7,pl-7,&id)){ if(!memchr(path+7,'/',pl-7)){ err(c,400,"invalid post id",keep); return; } }
      else { mark=op; if(get_post(id,mark)){ char*e=op; size_t n=e-mark; memmove(mark+8,mark,n); memcpy(mark,"{\"post\":",8); op=mark+8+n; *op++='}'; finish(c,200,keep); } else err(c,404,"post not found",keep); return; } } }
  else if(ispost){
    if(pl==6&&!memcmp(path,"/posts",6)){
      i64 uid; char user[64]; u32 ul; if(auth(c,auth_h,auth_l,keep,&uid,user,&ul)) return;
      static u8 bb[20480]; JKey k[1]={{"body",0,bb,sizeof bb,0,0}};
      int r=jscan(body,bl,k,1);
      if(r<0){ err(c,400,"malformed JSON body",keep); return; }
      if(r>0||k[0].type!='s'){ err(c,400,"body is required",keep); return; }
      if(k[0].len>=sizeof bb){ err(c,400,"body must be at most 500 characters",keep); return; }
      const u8*s=bb; size_t n=trim_ws(&s,k[0].len);
      if(n==0){ err(c,400,"body is required",keep); return; }
      size_t cp=0; for(size_t i=0;i<n;i++) if((s[i]&0xC0)!=0x80) cp++;
      if(cp>500){ err(c,400,"body must be at most 500 characters",keep); return; }
      queue_write(c,0,keep,uid,0,user,ul,s,(u32)n); return; }
    if(pl>=7&&!memcmp(path,"/posts/",7)){
      const u8*e=path+7; size_t rl=pl-7; const u8*sl=memchr(e,'/',rl);
      if(sl&&(size_t)(pl-(sl-path))==5&&!memcmp(sl,"/like",5)){
        i64 uid; char user[64]; u32 ul; if(auth(c,auth_h,auth_l,keep,&uid,user,&ul)) return;
        i64 id; if(!parse_id(e,sl-e,&id)){ err(c,400,"invalid post id",keep); return; }
        queue_write(c,1,keep,uid,id,user,ul,NULL,0); return; } } }
  err(c,404,"not found",keep); }

// parse and serve as many complete requests as are in buf; returns bytes consumed; sets *bad on protocol error
static size_t parse_buf(Conn*c,const u8*buf,size_t len) {
  size_t off=0;
  while(off<len && !c->closing){
    const u8*s=buf+off; size_t rem=len-off;
    // find end of headers
    const u8*he=NULL; for(size_t i=0;i+3<rem;i++){ if(s[i]=='\r'&&s[i+1]=='\n'&&s[i+2]=='\r'&&s[i+3]=='\n'){ he=s+i; break; } }
    if(!he){ if(rem>16384){ c->closing=1; } break; }
    size_t hlen=he-s+4;
    const u8*sp1=memchr(s,' ',hlen); if(!sp1){ c->closing=1; break; } const u8*sp2=memchr(sp1+1,' ',(s+hlen)-(sp1+1)); if(!sp2){ c->closing=1; break; }
    const u8*eol=memchr(sp2,'\r',(s+hlen)-sp2);
    int http10 = (size_t)(eol-sp2-1)==8 && sp2[8]=='0';
    int keep = !http10; size_t clen=0; const u8*auth_h=NULL; size_t auth_l=0; int chunked=0;
    const u8*ln=eol+2;
    while(ln<he+2){ const u8*le=memchr(ln,'\r',(s+hlen)-ln); if(!le||le==ln) break; size_t l=le-ln;
      if(l>=15&&ci_eq(ln,l,"content-length:")){ const u8*v=ln+15; while(v<le&&*v==' ')v++; for(;v<le&&*v>='0'&&*v<='9';v++) clen=clen*10+(*v-'0'); if(clen>(1u<<24)) clen=1u<<24; }
      else if(l>=14&&ci_eq(ln,l,"authorization:")){ const u8*v=ln+14; while(v<le&&*v==' ')v++; auth_h=v; auth_l=le-v; }
      else if(l>=11&&ci_eq(ln,l,"connection:")){ const u8*v=ln+11; while(v<le&&*v==' ')v++; if(ci_eq(v,le-v,"close")) keep=0; else if(ci_eq(v,le-v,"keep-alive")) keep=1; }
      else if(l>=18&&ci_eq(ln,l,"transfer-encoding:")){ chunked=1; }
      ln=le+2; }
    if(chunked){ err(c,400,"malformed JSON body",0); break; }
    if(rem<hlen+clen) break;
    int post = (size_t)(sp1-s)==4&&!memcmp(s,"POST",4);
    handle(c,s,sp1-s,sp1+1,sp2-(sp1+1),auth_h,auth_l,s+hlen,clen,keep);
    off+=hlen+clen;
    if(post && off<len) flush_pending();   // keep response order if the client pipelines
  }
  return off; }

static void conn_close(Conn*c) {
  if(c->npend) flush_pending();
  if(c->fd<0) return;
  epoll_ctl(epfd,EPOLL_CTL_DEL,c->fd,NULL); close(c->fd);
  free(c->in); free(c->out); memset(c,0,sizeof *c); c->fd=-1; }

static u8 rbuf[1<<16];
static void on_readable(Conn*c) {
  ssize_t r;
  if(c->inlen==0){
    r=recv(c->fd,rbuf,sizeof rbuf,0);
    if(r<=0){ if(r<0&&(errno==EAGAIN||errno==EINTR)) return; conn_close(c); return; }
    size_t used=parse_buf(c,rbuf,r);
    if(!c->closing&&used<(size_t)r){ c->inlen=r-used; c->in=realloc(c->in,c->inlen); memcpy(c->in,rbuf+used,c->inlen); }
  } else {
    c->in=realloc(c->in,c->inlen+sizeof rbuf);
    r=recv(c->fd,c->in+c->inlen,sizeof rbuf,0);
    if(r<=0){ if(r<0&&(errno==EAGAIN||errno==EINTR)) return; conn_close(c); return; }
    c->inlen+=r; size_t used=parse_buf(c,c->in,c->inlen);
    if(used>=c->inlen){ free(c->in); c->in=NULL; c->inlen=0; } else { memmove(c->in,c->in+used,c->inlen-used); c->inlen-=used; }
  }
  if(c->closing && c->npend==0 && c->outlen==0) conn_close(c); }
static void on_writable(Conn*c) {
  while(c->outoff<c->outlen){ ssize_t w=send(c->fd,c->out+c->outoff,c->outlen-c->outoff,MSG_NOSIGNAL); if(w<0){ if(errno==EAGAIN) return; c->closing=1; break; } c->outoff+=w; }
  free(c->out); c->out=NULL; c->outlen=c->outoff=0; ep_mod(c,0); if(c->closing) conn_close(c); }

static void prep(sqlite3_stmt**s,const char*sql){ if(sqlite3_prepare_v3(db,sql,-1,SQLITE_PREPARE_PERSISTENT,s,NULL)){ fprintf(stderr,"prepare failed: %s: %s\n",sql,sqlite3_errmsg(db)); exit(1);} }
static void load_roots(void) {
  sqlite3_stmt*s; sqlite3_prepare_v2(db,"SELECT name,rootpage FROM sqlite_master WHERE name IN ('users','posts','posts_created_at_id_idx','likes_post_id_idx')",-1,&s,NULL);
  int got=0; while(sqlite3_step(s)==SQLITE_ROW){ const char*n=(const char*)sqlite3_column_text(s,0); u32 r=sqlite3_column_int(s,1);
    if(!strcmp(n,"users")) root_users=r, got|=1; else if(!strcmp(n,"posts")) root_posts=r, got|=2; else if(!strcmp(n,"posts_created_at_id_idx")) root_feed_idx=r, got|=4; else root_likes_idx=r, got|=8; }
  sqlite3_finalize(s); if(got!=15) g_raw=0; }
static void raw_selfcheck(void) {
  // compare raw vs sqlite on feed + sample posts; disable raw on any mismatch
  if(!g_raw) return;
  static char a[1<<18], b[1<<18];
  for(int t=0;t<2&&g_raw;t++){ op=a; PUTS("{\"posts\":["); if(t==0) get_feed(op); else sql_feed(); PUTS("]}"); size_t la=op-a; if(t==0) { memcpy(b,a,la); b[la]=0; stat_fallback=0; } else { if(la!=strlen(b)||memcmp(a,b,la)||stat_fallback) g_raw=0; } }
  for(int i=0;i<2000&&g_raw;i++){ i64 id=1+(i64)i*251; char*x=a; op=x; int f1=0,f2; if(raw_begin()&&!setjmp(bail)){ f1=raw_post(id); } else { g_raw=0; break; } size_t l1=op-x; memcpy(b,x,l1); op=x; f2=sql_post(id); size_t l2=op-x; if(f1!=f2||l1!=l2||memcmp(b,x,l1)) g_raw=0; }
  fprintf(stderr,"raw reader %s\n",g_raw?"enabled":"DISABLED (self-check)"); }


// Background PASSIVE checkpointer on its own connection: keeps checkpoint copy + fsync stalls out of the event loop.
static const char *g_path;
static void *ckpt_thread(void*arg) {
  (void)arg; sqlite3 *d2; if(sqlite3_open_v2(g_path,&d2,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,NULL)) return NULL;
  sqlite3_busy_timeout(d2,5000); sqlite3_exec(d2,"PRAGMA synchronous=NORMAL;PRAGMA wal_autocheckpoint=0;",NULL,NULL,NULL);
  for(;;){ usleep(250000); int nlog=0,nck=0; sqlite3_wal_checkpoint_v2(d2,NULL,SQLITE_CHECKPOINT_PASSIVE,&nlog,&nck); }
  return NULL; }
static void on_term(int sig){ (void)sig; fprintf(stderr,"raw_ok=%lu fallback=%lu\n",stat_raw_ok,stat_fallback); _exit(0); }
int main(void) {
  signal(SIGPIPE,SIG_IGN); signal(SIGTERM,on_term);
  const char*path=getenv("SQLITE_PATH"); const char*host=getenv("HOST"); const char*port=getenv("PORT"); jwt_secret=getenv("JWT_SECRET");
  if(!path) path="feed.db"; if(!host) host="127.0.0.1"; if(!port) port="3000"; if(!jwt_secret) jwt_secret="twelve-dollar-challenge";
  g_dbg=getenv("DEBUG")!=NULL; const char*rawenv=getenv("RAW"); if(rawenv&&rawenv[0]=='0') g_raw=0;
  hmac_init(jwt_secret,strlen(jwt_secret)); t_start=time(NULL);
  if(sqlite3_open_v2(path,&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,NULL)){ fprintf(stderr,"open failed\n"); return 1; }
  sqlite3_busy_timeout(db,5000);
  const char*ac=getenv("WAL_AUTOCKPT"); char pr[512];
  snprintf(pr,sizeof pr,"PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA wal_autocheckpoint=%s;PRAGMA cache_size=-65536;PRAGMA mmap_size=1073741824;PRAGMA temp_store=MEMORY;",(getenv("CKPT_THREAD")&&getenv("CKPT_THREAD")[0]=='0')?(ac?ac:"4000"):"0");
  char*em=NULL; if(sqlite3_exec(db,pr,NULL,NULL,&em)){ fprintf(stderr,"pragma: %s\n",em); return 1; }
  const char *psel="SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id";
  char q[512];
  snprintf(q,sizeof q,"%s ORDER BY p.created_at DESC, p.id DESC LIMIT 20",psel); prep(&s_feed,q);
  snprintf(q,sizeof q,"%s WHERE p.id=?",psel); prep(&s_post,q);
  prep(&s_health,"SELECT 1"); prep(&s_exists,"SELECT 1 FROM posts WHERE id=?");
  prep(&s_like,"INSERT INTO likes (user_id, post_id) VALUES (?, ?) ON CONFLICT (user_id, post_id) DO NOTHING");
  prep(&s_ins,"INSERT INTO posts (user_id, body) VALUES (?, ?) RETURNING id, created_at");
  prep(&s_begin,"BEGIN IMMEDIATE"); prep(&s_commit,"COMMIT"); prep(&s_rollback,"ROLLBACK");
  // raw reader setup
  g_path=path; if(!(getenv("CKPT_THREAD")&&getenv("CKPT_THREAD")[0]=='0')){ pthread_t th; pthread_create(&th,NULL,ckpt_thread,NULL); }
  load_roots();
  { char p2[1024]; dbfd=open(path,O_RDONLY); snprintf(p2,sizeof p2,"%s-wal",path); walfd=open(p2,O_RDONLY); snprintf(p2,sizeof p2,"%s-shm",path); shmfd=open(p2,O_RDONLY);
    if(dbfd<0||walfd<0||shmfd<0||map_db()||map_shm()) g_raw=0;
    else { walmap=mmap(NULL,WAL_MAP_SZ,PROT_READ,MAP_SHARED|MAP_NORESERVE,walfd,0); if(walmap==MAP_FAILED) g_raw=0; } }
  if(g_raw){ // page size / encoding guard
    unsigned char hd[100]; if(pread(dbfd,hd,100,0)!=100||be16(hd+16)!=PSZ||be32(hd+56)!=1) g_raw=0; }
  raw_selfcheck();
  // network
  struct rlimit rl; if(getrlimit(RLIMIT_NOFILE,&rl)==0){ rl.rlim_cur=rl.rlim_max; setrlimit(RLIMIT_NOFILE,&rl); getrlimit(RLIMIT_NOFILE,&rl); }
  maxfd=(int)(rl.rlim_cur>1048576?1048576:rl.rlim_cur); conns=calloc(maxfd,sizeof(Conn)); for(int i=0;i<maxfd;i++) conns[i].fd=-1;
  lfd=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK,0); int one=1; setsockopt(lfd,SOL_SOCKET,SO_REUSEADDR,&one,sizeof one);
  struct sockaddr_in sa={.sin_family=AF_INET,.sin_port=htons(atoi(port))}; inet_pton(AF_INET,host,&sa.sin_addr);
  if(bind(lfd,(void*)&sa,sizeof sa)||listen(lfd,65535)){ perror("bind/listen"); return 1; }
  epfd=epoll_create1(0); struct epoll_event ev={.events=EPOLLIN,.data.ptr=NULL}; epoll_ctl(epfd,EPOLL_CTL_ADD,lfd,&ev);
  fprintf(stderr,"listening %s:%s raw=%d maxfd=%d\n",host,port,g_raw,maxfd);
  struct epoll_event evs[512];
  for(;;){
    int n=epoll_wait(epfd,evs,512,-1); if(n<0){ if(errno==EINTR) continue; perror("epoll_wait"); return 1; }
    for(int i=0;i<n;i++){ Conn*c=evs[i].data.ptr;
      if(!c){ for(;;){ int fd=accept4(lfd,NULL,NULL,SOCK_NONBLOCK); if(fd<0) break; if(fd>=maxfd){ close(fd); continue; }
          setsockopt(fd,IPPROTO_TCP,TCP_NODELAY,&one,sizeof one); Conn*nc=&conns[fd]; memset(nc,0,sizeof *nc); nc->fd=fd;
          struct epoll_event e={.events=EPOLLIN|EPOLLRDHUP,.data.ptr=nc}; epoll_ctl(epfd,EPOLL_CTL_ADD,fd,&e); }
        continue; }
      if(c->fd<0) continue;
      if(evs[i].events&(EPOLLERR|EPOLLHUP)){ conn_close(c); continue; }
      if(evs[i].events&EPOLLOUT) on_writable(c);
      if(c->fd>=0&&(evs[i].events&(EPOLLIN|EPOLLRDHUP))) on_readable(c); }
    flush_pending();
    for(int i=0;i<n;i++){ Conn*c=evs[i].data.ptr; if(c&&c->fd>=0&&c->closing&&c->outlen==0&&c->npend==0) conn_close(c); }
  }
}
