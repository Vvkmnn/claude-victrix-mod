// $12 server challenge: single-file C server. epoll + hand-rolled HTTP/JSON/HS256 + libsqlite3.
// Direct on 0.0.0.0:80 (no nginx). Multi-process (shared listen socket) only to lift the per-process fd cap.
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <emmintrin.h>
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
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define RBUF 65536
#define MAXBODY 16384

// ---------------- SHA-256 / HMAC ----------------
typedef struct { uint32_t h[8]; uint64_t n; uint8_t b[64]; uint32_t bl; } sha_t;
static const uint32_t K[64] = {
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
#define ROR(x,n) (((x)>>(n))|((x)<<(32-(n))))
static void sha_block(uint32_t *h, const uint8_t *p) {
  uint32_t w[64], a,b,c,d,e,f,g,hh;
  for (int i=0;i<16;i++) w[i]=(uint32_t)p[4*i]<<24|(uint32_t)p[4*i+1]<<16|(uint32_t)p[4*i+2]<<8|p[4*i+3];
  for (int i=16;i<64;i++){uint32_t s0=ROR(w[i-15],7)^ROR(w[i-15],18)^(w[i-15]>>3),s1=ROR(w[i-2],17)^ROR(w[i-2],19)^(w[i-2]>>10);w[i]=w[i-16]+s0+w[i-7]+s1;}
  a=h[0];b=h[1];c=h[2];d=h[3];e=h[4];f=h[5];g=h[6];hh=h[7];
  for (int i=0;i<64;i++){
    uint32_t S1=ROR(e,6)^ROR(e,11)^ROR(e,25),ch=(e&f)^(~e&g),t1=hh+S1+ch+K[i]+w[i];
    uint32_t S0=ROR(a,2)^ROR(a,13)^ROR(a,22),mj=(a&b)^(a&c)^(b&c),t2=S0+mj;
    hh=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;}
  h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;
}
static void sha_init(sha_t *s){static const uint32_t i0[8]={0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};memcpy(s->h,i0,32);s->n=0;s->bl=0;}
static void sha_upd(sha_t *s,const uint8_t *d,size_t l){
  s->n+=l;
  if(s->bl){size_t t=64-s->bl;if(t>l)t=l;memcpy(s->b+s->bl,d,t);s->bl+=t;d+=t;l-=t;if(s->bl==64){sha_block(s->h,s->b);s->bl=0;}}
  while(l>=64){sha_block(s->h,d);d+=64;l-=64;}
  if(l){memcpy(s->b,d,l);s->bl=l;}
}
static void sha_fin(sha_t *s,uint8_t *out){
  uint64_t bits=s->n*8;uint8_t pad[72]={0x80};size_t pl=(s->bl<56)?56-s->bl:120-s->bl;
  uint8_t len[8];for(int i=0;i<8;i++)len[i]=bits>>(56-8*i);
  sha_upd(s,pad,pl);sha_upd(s,len,8);
  for(int i=0;i<8;i++){out[4*i]=s->h[i]>>24;out[4*i+1]=s->h[i]>>16;out[4*i+2]=s->h[i]>>8;out[4*i+3]=s->h[i];}
}
static sha_t g_in, g_out; // states after absorbing ipad / opad
static void hmac_setup(const char *key, size_t kl){
  uint8_t k[64]={0},ip[64],op[64];
  if(kl>64){sha_t s;sha_init(&s);sha_upd(&s,(const uint8_t*)key,kl);sha_fin(&s,k);}else memcpy(k,key,kl);
  for(int i=0;i<64;i++){ip[i]=k[i]^0x36;op[i]=k[i]^0x5c;}
  sha_init(&g_in);sha_upd(&g_in,ip,64);sha_init(&g_out);sha_upd(&g_out,op,64);
}
static void hmac(const uint8_t *m,size_t l,uint8_t *out){
  sha_t s=g_in;uint8_t d[32];sha_upd(&s,m,l);sha_fin(&s,d);
  s=g_out;sha_upd(&s,d,32);sha_fin(&s,out);
}
static const char B64U[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
static int b64u_dec(const char *s,size_t n,uint8_t *out,size_t *ol){ // unpadded base64url
  static int8_t T[256];static int init=0;
  if(!init){memset(T,-1,256);for(int i=0;i<64;i++)T[(uint8_t)B64U[i]]=i;init=1;}
  size_t o=0;uint32_t acc=0;int bits=0;
  if(n%4==1)return -1;
  for(size_t i=0;i<n;i++){int v=T[(uint8_t)s[i]];if(v<0)return -1;acc=(acc<<6)|v;bits+=6;if(bits>=8){bits-=8;out[o++]=(acc>>bits)&255;}}
  *ol=o;return 0;
}

// ---------------- mini JSON ----------------
typedef struct { const char *p,*e; } jp_t;
static void jws(jp_t *j){while(j->p<j->e&&(*j->p==' '||*j->p=='\t'||*j->p=='\n'||*j->p=='\r'))j->p++;}
static int hex4(const char *p){int v=0;for(int i=0;i<4;i++){char c=p[i];v<<=4;if(c>='0'&&c<='9')v|=c-'0';else if(c>='a'&&c<='f')v|=c-'a'+10;else if(c>='A'&&c<='F')v|=c-'A'+10;else return -1;}return v;}
static int put_utf8(char *o,uint32_t c){
  if(c<0x80){o[0]=c;return 1;}
  if(c<0x800){o[0]=0xC0|c>>6;o[1]=0x80|(c&63);return 2;}
  if(c<0x10000){o[0]=0xE0|c>>12;o[1]=0x80|((c>>6)&63);o[2]=0x80|(c&63);return 3;}
  o[0]=0xF0|c>>18;o[1]=0x80|((c>>12)&63);o[2]=0x80|((c>>6)&63);o[3]=0x80|(c&63);return 4;
}
// parse a string at j->p ('"'); decode into out (cap oc). returns decoded length or -1 (syntax) / -2 (too long)
static int jstr(jp_t *j,char *out,size_t oc){
  if(j->p>=j->e||*j->p!='"')return -1;j->p++;size_t o=0;
  for(;;){
    if(j->p>=j->e)return -1;
    unsigned char c=*j->p++;
    if(c=='"')break;
    if(c<0x20)return -1;
    char tmp[4];int tl=0;
    if(c=='\\'){
      if(j->p>=j->e)return -1;c=*j->p++;
      switch(c){case '"':case '\\':case '/':tmp[0]=c;tl=1;break;case 'b':tmp[0]='\b';tl=1;break;case 'f':tmp[0]='\f';tl=1;break;
        case 'n':tmp[0]='\n';tl=1;break;case 'r':tmp[0]='\r';tl=1;break;case 't':tmp[0]='\t';tl=1;break;
        case 'u':{ if(j->e-j->p<4)return -1;int u=hex4(j->p);if(u<0)return -1;j->p+=4;uint32_t cp=u;
          if(u>=0xD800&&u<0xDC00&&j->e-j->p>=6&&j->p[0]=='\\'&&j->p[1]=='u'){int l=hex4(j->p+2);if(l>=0xDC00&&l<0xE000){cp=0x10000+((u-0xD800)<<10)+(l-0xDC00);j->p+=6;}}
          if(cp>=0xD800&&cp<0xE000)cp=0xFFFD;
          tl=put_utf8(tmp,cp);break;}
        default:return -1;}
    } else {tmp[0]=c;tl=1;}
    if(out){ if(o+tl>oc)return -2; memcpy(out+o,tmp,tl);} else if(o+tl>oc) { /* counting only */ }
    o+=tl;
  }
  return (int)o;
}
static int jskip(jp_t *j,int depth);
static int jskip(jp_t *j,int depth){
  if(depth>32)return -1;jws(j);if(j->p>=j->e)return -1;char c=*j->p;
  if(c=='"'){char dummy[1];jp_t t=*j;int r=jstr(&t,NULL,1<<30);(void)dummy;if(r<0)return -1;*j=t;return 0;}
  if(c=='{'){j->p++;jws(j);if(j->p<j->e&&*j->p=='}'){j->p++;return 0;}
    for(;;){jws(j);if(jstr(j,NULL,1<<30)<0)return -1;jws(j);if(j->p>=j->e||*j->p!=':')return -1;j->p++;if(jskip(j,depth+1))return -1;jws(j);if(j->p>=j->e)return -1;
      if(*j->p==','){j->p++;continue;}if(*j->p=='}'){j->p++;return 0;}return -1;}}
  if(c=='['){j->p++;jws(j);if(j->p<j->e&&*j->p==']'){j->p++;return 0;}
    for(;;){if(jskip(j,depth+1))return -1;jws(j);if(j->p>=j->e)return -1;if(*j->p==','){j->p++;continue;}if(*j->p==']'){j->p++;return 0;}return -1;}}
  if(!strncmp(j->p,"true",j->e-j->p>=4?4:j->e-j->p)&&j->e-j->p>=4){j->p+=4;return 0;}
  if(j->e-j->p>=5&&!strncmp(j->p,"false",5)){j->p+=5;return 0;}
  if(j->e-j->p>=4&&!strncmp(j->p,"null",4)){j->p+=4;return 0;}
  // number
  const char *s=j->p;if(j->p<j->e&&*j->p=='-')j->p++;
  if(j->p>=j->e)return -1;
  if(*j->p=='0')j->p++;else if(*j->p>='1'&&*j->p<='9'){while(j->p<j->e&&*j->p>='0'&&*j->p<='9')j->p++;}else return -1;
  if(j->p<j->e&&*j->p=='.'){j->p++;const char *d=j->p;while(j->p<j->e&&*j->p>='0'&&*j->p<='9')j->p++;if(j->p==d)return -1;}
  if(j->p<j->e&&(*j->p=='e'||*j->p=='E')){j->p++;if(j->p<j->e&&(*j->p=='+'||*j->p=='-'))j->p++;const char *d=j->p;while(j->p<j->e&&*j->p>='0'&&*j->p<='9')j->p++;if(j->p==d)return -1;}
  return j->p>s?0:-1;
}

// ---------------- DB ----------------
static sqlite3 *db;
static sqlite3_stmt *st_feed,*st_post,*st_exists,*st_ins_post,*st_ins_like,*st_health;
static void die(const char *m){fprintf(stderr,"fatal: %s (%s)\n",m,db?sqlite3_errmsg(db):"");exit(1);}
static sqlite3_stmt *prep(const char *sql){sqlite3_stmt *s;if(sqlite3_prepare_v3(db,sql,-1,SQLITE_PREPARE_PERSISTENT,&s,NULL))die(sql);return s;}
static void db_open(const char *path){
  if(sqlite3_open_v2(path,&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,NULL))die("open");
  sqlite3_busy_timeout(db,10000);
  sqlite3_exec(db,"PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA mmap_size=1073741824;PRAGMA cache_size=-8192;PRAGMA wal_autocheckpoint=4000;PRAGMA temp_store=MEMORY;",0,0,0);
  { const char *wcp=getenv("WALCP");if(wcp){char b[64];snprintf(b,sizeof b,"PRAGMA wal_autocheckpoint=%d;",atoi(wcp));sqlite3_exec(db,b,0,0,0);} }
  const char *cols="SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id ";
  char q[512];
  snprintf(q,sizeof q,"%sORDER BY p.created_at DESC, p.id DESC LIMIT 20",cols);st_feed=prep(q);
  snprintf(q,sizeof q,"%sWHERE p.id=?1",cols);st_post=prep(q);
  st_exists=prep("SELECT 1 FROM posts WHERE id=?1");
  st_ins_post=prep("INSERT INTO posts (user_id,body) VALUES (?1,?2) RETURNING id,created_at");
  st_ins_like=prep("INSERT INTO likes (user_id,post_id) VALUES (?1,?2) ON CONFLICT (user_id,post_id) DO NOTHING");
  st_health=prep("SELECT 1");
}

// ---------------- output buffer ----------------
static char *ob; static size_t ol, ocap;
static void oensure(size_t n){if(ol+n>ocap){while(ol+n>ocap)ocap*=2;ob=realloc(ob,ocap);if(!ob)exit(2);}}
static void oraw(const char *s,size_t n){oensure(n);memcpy(ob+ol,s,n);ol+=n;}
#define OLIT(s) oraw(s,sizeof(s)-1)
static void ostr(const char *s,size_t n){ // JSON string with quotes
  oensure(n*6+2);char *o=ob+ol;*o++='"';
  size_t i=0;
  while(i<n){
    // copy the longest run with nothing to escape, 16 bytes at a time
    while(i+16<=n){
      __m128i v=_mm_loadu_si128((const __m128i*)(s+i));
      __m128i bad=_mm_or_si128(_mm_or_si128(_mm_cmpeq_epi8(v,_mm_set1_epi8('"')),_mm_cmpeq_epi8(v,_mm_set1_epi8('\\'))),
                               _mm_cmpeq_epi8(_mm_min_epu8(v,_mm_set1_epi8(0x1f)),v)); // v<=0x1f
      int m=_mm_movemask_epi8(bad);
      if(m){int k=__builtin_ctz(m);_mm_storeu_si128((__m128i*)o,v);o+=k;i+=k;break;}
      _mm_storeu_si128((__m128i*)o,v);o+=16;i+=16;
    }
    if(i>=n)break;
    unsigned char c=s[i];
    if(c=='"'){*o++='\\';*o++='"';}else if(c=='\\'){*o++='\\';*o++='\\';}
    else if(c>=0x20)*o++=c;
    else switch(c){case '\n':*o++='\\';*o++='n';break;case '\r':*o++='\\';*o++='r';break;case '\t':*o++='\\';*o++='t';break;case '\b':*o++='\\';*o++='b';break;case '\f':*o++='\\';*o++='f';break;
      default:o+=sprintf(o,"\\u%04x",c);}
    i++;
  }
  *o++='"';ol=o-ob;
}
static void oint(long long v){oensure(24);char t[24];int n=0;unsigned long long u=v<0?-(unsigned long long)v:v;do{t[n++]='0'+u%10;u/=10;}while(u);if(v<0)ob[ol++]='-';while(n)ob[ol++]=t[--n];}
static void opost_row(sqlite3_stmt *s){
  OLIT("{\"id\":");oint(sqlite3_column_int64(s,0));
  OLIT(",\"body\":");ostr((const char*)sqlite3_column_text(s,1),sqlite3_column_bytes(s,1));
  OLIT(",\"created_at\":");ostr((const char*)sqlite3_column_text(s,2),sqlite3_column_bytes(s,2));
  OLIT(",\"author\":");ostr((const char*)sqlite3_column_text(s,3),sqlite3_column_bytes(s,3));
  OLIT(",\"like_count\":");oint(sqlite3_column_int64(s,4));OLIT("}");
}


#define HDRMAX 128
static void begin_resp(void){ol=HDRMAX;}
// ---------------- raw snapshot reader (bypasses the SQL engine for the hot GETs) ----------------
// Reads pages exactly as SQLite would: newest WAL frame <= mxFrame (via the shared wal-index), else the db file.
// A SQLite read transaction (an un-reset statement) is held open around every raw read: it pins the WAL (no
// checkpoint/restart can run past our read mark), so the pages we see are a consistent snapshot. Any surprise
// (layout, overflow, schema change, short file) returns -1 and the caller falls back to the SQL path.
static int raw_on=1, raw_diff=0; static long raw_hits=0,raw_miss=0;
static sqlite3_stmt *st_snap;
static int dbfd=-1,walfd=-1,shmfd=-1;
static const uint8_t *dbmap,*walmap,*shmmap; static size_t dbmaplen,walmaplen,shmmaplen;
static uint32_t PS=0, root_posts,root_users,root_pidx,root_lidx, schema_cookie;
static uint32_t mxf; // current snapshot's mxFrame
static inline uint32_t be32(const uint8_t *p){return (uint32_t)p[0]<<24|(uint32_t)p[1]<<16|(uint32_t)p[2]<<8|p[3];}
static inline uint32_t be16(const uint8_t *p){return (uint32_t)p[0]<<8|p[1];}
// Files are mapped once, at a fixed huge virtual size (pages beyond EOF are never touched: every access is first
// checked against the file's real size). Mappings never move, so page pointers stay valid for a whole request.
static const size_t MAPSZ[3]={1UL<<36,1UL<<36,1UL<<32}; // db, wal, shm virtual sizes
static int remap(int fd,const uint8_t **m,size_t *ml,size_t need){
  // *ml = known real file size (bytes); *m = fixed mapping
  if(fd<0)return -1;
  if(!*m){
    size_t vs=fd==dbfd?MAPSZ[0]:fd==walfd?MAPSZ[1]:MAPSZ[2];
    void *p=mmap(NULL,vs,PROT_READ,MAP_SHARED|MAP_NORESERVE,fd,0);
    if(p==MAP_FAILED)return -1;*m=p;*ml=0;
  }
  if(*ml>=need)return 0;
  struct stat sb;if(fstat(fd,&sb))return -1;
  *ml=sb.st_size;
  return *ml>=need?0:-1;
}
// consistent read of the wal-index header; returns mxFrame or 0xFFFFFFFF on failure
static uint32_t wal_snapshot(void){
  if(remap(shmfd,&shmmap,&shmmaplen,136))return 0xFFFFFFFFu;
  for(int t=0;t<100;t++){
    uint8_t a[48],b[48];memcpy(a,shmmap,48);__atomic_thread_fence(__ATOMIC_ACQUIRE);memcpy(b,shmmap+48,48);
    if(!memcmp(a,b,48)){ uint32_t szp=*(uint16_t*)(a+14); if(szp==1)szp=65536; uint32_t mx=*(uint32_t*)(a+16); if(szp==0&&mx==0)return 0; /* never-written WAL */ if(szp!=PS)return 0xFFFFFFFFu; return mx;}
  }
  return 0xFFFFFFFFu;
}
static const uint8_t *getpage(uint32_t pgno){
  if(pgno==0)return NULL;
  uint32_t frame=0;
  if(mxf){
    uint32_t last=(mxf+33)/4096; // table index of mxFrame
    size_t need=(size_t)(last+1)*32768;
    if(shmmaplen<need&&remap(shmfd,&shmmap,&shmmaplen,need))return NULL;
    for(int h=(int)last;h>=0&&!frame;h--){
      const uint8_t *blk=shmmap+(size_t)h*32768;
      const uint32_t *apg=(const uint32_t*)(blk+(h==0?136:0));
      const uint16_t *ah=(const uint16_t*)(blk+16384);
      uint32_t zero=h==0?0:4062+(h-1)*4096;
      uint32_t k=(pgno*383u)&8191;int guard=8192;
      uint16_t v;
      while((v=ah[k])!=0){
        uint32_t f=v+zero;
        if(f<=mxf&&apg[v-1]==pgno)frame=f; // keep scanning: later frame wins (collisions are in insertion order)
        if(--guard==0)return NULL;
        k=(k+1)&8191;
      }
    }
  }
  if(frame){
    size_t off=32+(size_t)(frame-1)*(PS+24)+24;
    if(walmaplen<off+PS&&remap(walfd,&walmap,&walmaplen,off+PS))return NULL;
    return walmap+off;
  }
  size_t off=(size_t)(pgno-1)*PS;
  if(dbmaplen<off+PS&&remap(dbfd,&dbmap,&dbmaplen,off+PS))return NULL;
  return dbmap+off;
}
static inline int varint(const uint8_t *p,const uint8_t *end,uint64_t *v){
  uint64_t r=0;for(int i=0;i<8;i++){if(p+i>=end)return 0;r=(r<<7)|(p[i]&0x7f);if(!(p[i]&0x80)){*v=r;return i+1;}}
  if(p+8>=end)return 0;r=(r<<8)|p[8];*v=r;return 9;
}
// decoded record: up to 4 columns
typedef struct { int n; int64_t iv[4]; const uint8_t *tp[4]; uint32_t tl[4]; uint8_t kind[4]; /*0 null,1 int,2 text,3 other*/ } rec_t;
static int parse_rec(const uint8_t *p,const uint8_t *end,rec_t *r){
  uint64_t hs;int n=varint(p,end,&hs);if(!n||hs>(uint64_t)(end-p)||hs<2)return -1;
  const uint8_t *h=p+n,*he=p+hs,*d=he;r->n=0;
  while(h<he){uint64_t st;int m=varint(h,he,&st);if(!m)return -1;h+=m;if(r->n>=4)return -1;int i=r->n++;
    r->kind[i]=3;r->iv[i]=0;
    if(st==0)r->kind[i]=0;
    else if(st>=1&&st<=6){static const int sz[7]={0,1,2,3,4,6,8};int s=sz[st];if(d+s>end)return -1;int64_t v=(int8_t)d[0];for(int k=1;k<s;k++)v=(v<<8)|d[k];r->iv[i]=v;r->kind[i]=1;d+=s;}
    else if(st==8){r->iv[i]=0;r->kind[i]=1;}
    else if(st==9){r->iv[i]=1;r->kind[i]=1;}
    else if(st>=13&&(st&1)){uint32_t l=(st-13)/2;if(d+l>end)return -1;r->tp[i]=d;r->tl[i]=l;r->kind[i]=2;d+=l;}
    else return -1; // floats, blobs, reserved: not expected
  }
  return 0;
}
// table leaf lookup: returns payload record for rowid; 1 found, 0 absent (proven), -1 unsure
typedef struct { uint32_t root; const uint8_t *P; int64_t lo,hi; } hint_t; // leaf last used by this request/snapshot
static hint_t hints[2]; // 0 posts, 1 users
static int leaf_find(const uint8_t *P,int64_t rowid,rec_t *r){
  const uint8_t *H=P;uint32_t nc=be16(H+3);uint32_t lo=0,hi=nc;
  while(lo<hi){uint32_t mid=(lo+hi)/2;uint32_t co=be16(H+8+2*mid);if(co>=PS)return -1;uint64_t pl,key;int a=varint(P+co,P+PS,&pl);if(!a)return -1;int b=varint(P+co+a,P+PS,&key);if(!b)return -1;
    if((int64_t)key<rowid)lo=mid+1;else hi=mid;}
  if(lo>=nc)return 0;
  uint32_t co=be16(H+8+2*lo);uint64_t pl,key;int a=varint(P+co,P+PS,&pl);int b=varint(P+co+a,P+PS,&key);
  if((int64_t)key!=rowid)return 0;
  if(pl>PS-35||co+a+b+pl>PS)return -1;
  return parse_rec(P+co+a+b,P+co+a+b+pl,r)?-1:1;
}
static int table_get(uint32_t root,int64_t rowid,rec_t *r){
  hint_t *ht=root==root_posts?&hints[0]:&hints[1];
  if(ht->P&&rowid>=ht->lo&&rowid<=ht->hi){int g=leaf_find(ht->P,rowid,r);if(g==1)return 1;}
  uint32_t pg=root;
  for(int depth=0;depth<8;depth++){
    const uint8_t *P=getpage(pg);if(!P)return -1;
    const uint8_t *H=P+(pg==1?100:0);
    uint32_t nc=be16(H+3);
    if(H[0]==5){ // interior
      if(nc==0)return -1;
      uint32_t lo=0,hi=nc; // first cell with key>=rowid
      while(lo<hi){uint32_t mid=(lo+hi)/2;uint32_t co=be16(H+12+2*mid);if(co>=PS)return -1;uint64_t key;if(!varint(P+co+4,P+PS,&key))return -1;if((int64_t)key>=rowid)hi=mid;else lo=mid+1;}
      if(lo<nc){uint32_t co=be16(H+12+2*lo);pg=be32(P+co);}else pg=be32(H+8);
      continue;
    }
    if(H[0]!=13)return -1;
    if(nc>0&&pg!=1){ // remember this leaf's key range for the rest of this request
      uint32_t c0=be16(H+8),c1=be16(H+8+2*(nc-1));uint64_t pl,k0,k1;int a0=varint(P+c0,P+PS,&pl);int a1=varint(P+c1,P+PS,&pl);
      if(c0<PS&&c1<PS&&varint(P+c0+a0,P+PS,&k0)&&varint(P+c1+a1,P+PS,&k1)){ht->P=P;ht->lo=(int64_t)k0;ht->hi=(int64_t)k1;}
    }
    return leaf_find(P,rowid,r);
  }
  return -1;
}
// index entry key = first column integer (post_id). cell payload at p
static inline int idx_first(const uint8_t *P,uint32_t co,int interior,int64_t *k){
  uint64_t pl;const uint8_t *q=P+co+(interior?4:0);int a=varint(q,P+PS,&pl);if(!a)return -1;
  if(pl>PS-40)return -1;
  q+=a;uint64_t hs;int n=varint(q,P+PS,&hs);if(!n||hs<2||hs>9)return -1;
  uint64_t st;if(!varint(q+n,P+PS,&st))return -1;
  static const int sz[10]={0,1,2,3,4,6,8,0,0,0};
  if(st==8){*k=0;return 0;} if(st==9){*k=1;return 0;}
  if(st<1||st>6)return -1;
  const uint8_t *d=q+hs;int s=sz[st];int64_t v=(int8_t)d[0];for(int i=1;i<s;i++)v=(v<<8)|d[i];*k=v;return 0;
}
// count entries with first column == P in index subtree; returns count or -1
static int64_t idx_count(uint32_t pg,int64_t P,int depth){
  if(depth>8)return -1;
  const uint8_t *B=getpage(pg);if(!B)return -1;
  const uint8_t *H=B+(pg==1?100:0);uint32_t nc=be16(H+3);int interior=(H[0]==2);
  if(!interior&&H[0]!=10)return -1;
  const uint8_t *cp=H+(interior?12:8);
  uint32_t lo=0,hi=nc;
  while(lo<hi){uint32_t mid=(lo+hi)/2;uint32_t co=be16(cp+2*mid);if(co>=PS)return -1;int64_t k;if(idx_first(B,co,interior,&k))return -1;if(k>=P)hi=mid;else lo=mid+1;}
  int64_t total=0;
  if(!interior){for(uint32_t i=lo;i<nc;i++){uint32_t co=be16(cp+2*i);int64_t k;if(idx_first(B,co,0,&k))return -1;if(k!=P)break;total++;}return total;}
  for(uint32_t i=lo;i<nc;i++){
    uint32_t co=be16(cp+2*i);int64_t k;if(idx_first(B,co,1,&k))return -1;
    int64_t c=idx_count(be32(B+co),P,depth+1);if(c<0)return -1;total+=c;
    if(k!=P)return total; // cell key > P: nothing further right
    total++;
  }
  int64_t c=idx_count(be32(H+8),P,depth+1);if(c<0)return -1;return total+c;
}
static int64_t cnt_lo,cnt_span;static int32_t cnt_tab[256];
// in-order walk of index entries with first column in [cnt_lo, cnt_lo+cnt_span): bumps cnt_tab[k-cnt_lo]
static int idx_range(uint32_t pg,int depth){
  if(depth>8)return -1;
  const uint8_t *B=getpage(pg);if(!B)return -1;
  const uint8_t *H=B+(pg==1?100:0);uint32_t nc=be16(H+3);int interior=(H[0]==2);
  if(!interior&&H[0]!=10)return -1;
  const uint8_t *cp=H+(interior?12:8);
  uint32_t lo=0,hi=nc;
  while(lo<hi){uint32_t mid=(lo+hi)/2;uint32_t co=be16(cp+2*mid);if(co>=PS)return -1;int64_t k;if(idx_first(B,co,interior,&k))return -1;if(k>=cnt_lo)hi=mid;else lo=mid+1;}
  for(uint32_t i=lo;i<nc;i++){
    uint32_t co=be16(cp+2*i);int64_t k;if(idx_first(B,co,interior,&k))return -1;
    if(interior&&idx_range(be32(B+co),depth+1))return -1;
    if(k>=cnt_lo+cnt_span)return 0;
    if(k>=cnt_lo)cnt_tab[k-cnt_lo]++;
  }
  if(interior)return idx_range(be32(H+8),depth+1);
  return 0;
}
static int raw_emit_post(int64_t id,const rec_t *pr,int64_t lc){
  // pr: [id(null), user_id, body, created_at]
  rec_t ur;if(pr->n<4||pr->kind[1]!=1||pr->kind[2]!=2||pr->kind[3]!=2)return -1;
  int g=table_get(root_users,pr->iv[1],&ur);if(g!=1)return -1; // missing user -> let SQL decide
  if(ur.n<2||ur.kind[1]!=2)return -1;
  if(lc<0){lc=idx_count(root_lidx,id,0);if(lc<0)return -1;}
  OLIT("{\"id\":");oint(id);
  OLIT(",\"body\":");ostr((const char*)pr->tp[2],pr->tl[2]);
  OLIT(",\"created_at\":");ostr((const char*)pr->tp[3],pr->tl[3]);
  OLIT(",\"author\":");ostr((const char*)ur.tp[1],ur.tl[1]);
  OLIT(",\"like_count\":");oint(lc);OLIT("}");return 0;
}
// begin snapshot: returns 0 ok
static int snap_begin(void){
  hints[0].P=hints[1].P=NULL;
  if(sqlite3_step(st_snap)!=SQLITE_ROW){sqlite3_reset(st_snap);return -1;}
  mxf=wal_snapshot();
  if(mxf==0xFFFFFFFFu){sqlite3_reset(st_snap);return -1;}
  const uint8_t *p1=getpage(1);
  if(!p1||be32(p1+40)!=schema_cookie){sqlite3_reset(st_snap);return -1;}
  return 0;
}
static void snap_end(void){if(!raw_diff)sqlite3_reset(st_snap);} // RAWDIFF keeps the snapshot until the SQL re-check is done
// 1 handled (response built), 0 not handled -> use SQL
static int raw_post(int64_t id){
  if(!raw_on)return 0;
  if(snap_begin())return 0;
  size_t save=ol;begin_resp();OLIT("{\"post\":");
  rec_t pr;int ok=0;
  if(table_get(root_posts,id,&pr)==1&&raw_emit_post(id,&pr,-1)==0){OLIT("}");ok=1;}
  snap_end();
  if(!ok){sqlite3_reset(st_snap);ol=save;raw_miss++;return 0;}
  raw_hits++;return 1;
}
static int raw_feed(void){
  if(!raw_on)return 0;
  if(snap_begin())return 0;
  int ok=0;size_t save=ol;begin_resp();OLIT("{\"posts\":[");
  const uint8_t *B;uint32_t pg=root_pidx;
  for(int d=0;d<8;d++){
    B=getpage(pg);if(!B)goto out;
    const uint8_t *H=B+(pg==1?100:0);
    if(H[0]==2){uint32_t nc=be16(H+3);if(!nc)goto out;uint32_t co=be16(H+12);pg=be32(B+co);continue;}
    if(H[0]!=10)goto out;
    uint32_t nc=be16(H+3);if(nc<20)goto out;
    int64_t ids[20];int64_t mn=INT64_MAX,mx=INT64_MIN;
    for(int i=0;i<20;i++){
      uint32_t co=be16(H+8+2*i);if(co>=PS)goto out;
      uint64_t pl;int a=varint(B+co,B+PS,&pl);if(!a||pl>PS-40)goto out;
      rec_t er;if(parse_rec(B+co+a,B+co+a+pl,&er)||er.n<3||er.kind[1]!=1||er.kind[0]!=2)goto out;
      ids[i]=er.iv[1];if(ids[i]<mn)mn=ids[i];if(ids[i]>mx)mx=ids[i];
    }
    int batched=(mx-mn<256);
    if(batched){memset(cnt_tab,0,sizeof cnt_tab);cnt_lo=mn;cnt_span=mx-mn+1;if(idx_range(root_lidx,0))goto out;}
    for(int i=0;i<20;i++){
      uint32_t co=be16(H+8+2*i);uint64_t pl;int a=varint(B+co,B+PS,&pl);
      rec_t er;parse_rec(B+co+a,B+co+a+pl,&er);
      int64_t id=ids[i];
      rec_t pr;if(table_get(root_posts,id,&pr)!=1)goto out;
      if(pr.n<4||pr.kind[3]!=2||pr.tl[3]!=er.tl[0]||memcmp(pr.tp[3],er.tp[0],er.tl[0]))goto out; // index entry must agree with the row
      if(i)OLIT(",");
      if(raw_emit_post(id,&pr,batched?cnt_tab[id-mn]:-1))goto out;
    }
    OLIT("]}");ok=1;break;
  }
out:
  snap_end();
  if(!ok){sqlite3_reset(st_snap);ol=save;raw_miss++;return 0;}
  raw_hits++;return 1;
}
static int raw_on_orig=1;static int raw_on_orig_dummy(void){return raw_on_orig;}
static void raw_init(const char *path){
  const char *e=getenv("RAWREAD");if(e&&*e=='0'){raw_on=0;raw_on_orig=0;return;}
  raw_diff=getenv("RAWDIFF")!=NULL;
  char p2[4096];
  dbfd=open(path,O_RDONLY);snprintf(p2,sizeof p2,"%s-wal",path);walfd=open(p2,O_RDONLY);snprintf(p2,sizeof p2,"%s-shm",path);shmfd=open(p2,O_RDONLY);
  if(dbfd<0||walfd<0||shmfd<0){fprintf(stderr,"raw: open fds %d %d %d\n",dbfd,walfd,shmfd);raw_on=0;return;}
  sqlite3_stmt *s;
  if(sqlite3_prepare_v2(db,"PRAGMA page_size",-1,&s,0)||sqlite3_step(s)!=SQLITE_ROW){raw_on=0;return;}PS=sqlite3_column_int(s,0);sqlite3_finalize(s);
  if(PS!=4096){raw_on=0;return;}
  if(sqlite3_prepare_v2(db,"SELECT name,rootpage FROM sqlite_schema WHERE rootpage>0",-1,&s,0)){raw_on=0;return;}
  int got=0;
  while(sqlite3_step(s)==SQLITE_ROW){const char *n=(const char*)sqlite3_column_text(s,0);uint32_t r=sqlite3_column_int(s,1);
    if(!strcmp(n,"posts")){root_posts=r;got|=1;}else if(!strcmp(n,"users")){root_users=r;got|=2;}
    else if(!strcmp(n,"posts_created_at_id_idx")){root_pidx=r;got|=4;}else if(!strcmp(n,"likes_post_id_idx")){root_lidx=r;got|=8;}}
  sqlite3_finalize(s);
  if(got!=15){raw_on=0;return;}
  // db header: reserved bytes 0, UTF-8, read the schema cookie under a snapshot
  st_snap=prep("SELECT 1 FROM posts WHERE id=1");
  if(sqlite3_step(st_snap)!=SQLITE_ROW){raw_on=0;return;}
  mxf=wal_snapshot();
  if(mxf==0xFFFFFFFFu){sqlite3_reset(st_snap);raw_on=0;return;}
  const uint8_t *p1=getpage(1);
  if(!p1||p1[20]!=0||be32(p1+56)!=1){sqlite3_reset(st_snap);raw_on=0;return;}
  schema_cookie=be32(p1+40);sqlite3_reset(st_snap);
}

// ---------------- request handling ----------------
static time_t t_start;
static const char *status_text(int c){switch(c){case 200:return "OK";case 201:return "Created";case 400:return "Bad Request";case 401:return "Unauthorized";case 404:return "Not Found";case 503:return "Service Unavailable";default:return "Internal Server Error";}}
static size_t hdr_off; // where the body started in ob (after reserving header space)
// finalize: write header right-aligned just before body, return pointer/len of full response
static char *end_resp(int code,size_t *len,int close_after){
  size_t bl=ol-HDRMAX;char h[HDRMAX];
  int n=snprintf(h,sizeof h,"HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n%s\r\n",code,status_text(code),bl,close_after?"Connection: close\r\n":"");
  char *start=ob+HDRMAX-n;memcpy(start,h,n);*len=ol-(HDRMAX-n);return start;
}
static void err(int code,const char *msg){begin_resp();OLIT("{\"error\":\"");oraw(msg,strlen(msg));OLIT("\"}");}
static int g_code;
static void set(int code){g_code=code;}

static int parse_id(const char *s,size_t n,long long *id){
  if(n==0||n>18)return 0;long long v=0;for(size_t i=0;i<n;i++){if(s[i]<'0'||s[i]>'9')return 0;v=v*10+(s[i]-'0');}
  if(v<=0)return 0;*id=v;return 1;
}
typedef struct { long long uid; char uname[256]; size_t unl; } auth_t;
// returns 0 ok, else sets error response
static int do_auth(const char *h,size_t hl,auth_t *a){
  if(!h||hl<7||memcmp(h,"Bearer ",7)){err(401,"missing bearer token");set(401);return -1;}
  h+=7;hl-=7;
  // trim trailing spaces
  while(hl&&(h[hl-1]==' '||h[hl-1]=='\t'))hl--;
  const char *d1=memchr(h,'.',hl);if(!d1)goto bad;
  const char *d2=memchr(d1+1,'.',hl-(d1+1-h));if(!d2)goto bad;
  if(memchr(d2+1,'.',hl-(d2+1-h)))goto bad;
  size_t signed_len=d2-h;
  if(signed_len>1500||hl-signed_len-1!=43)goto bad;
  uint8_t mac[32],sig[64];size_t sl=0;
  hmac((const uint8_t*)h,signed_len,mac);
  if(b64u_dec(d2+1,43,sig,&sl)||sl!=32)goto bad;
  uint8_t diff=0;for(int i=0;i<32;i++)diff|=mac[i]^sig[i];
  if(diff)goto bad;
  {
    uint8_t hdr[256];size_t hlen=0;
    if(b64u_dec(h,d1-h,hdr,&hlen)||hlen>=sizeof hdr)goto bad;
    jp_t j={(char*)hdr,(char*)hdr+hlen};jws(&j);if(j.p>=j.e||*j.p!='{')goto bad;j.p++;
    int alg_ok=0;jws(&j);
    if(j.p<j.e&&*j.p=='}')goto bad;
    for(;;){char k[32];jws(&j);int kl=jstr(&j,k,sizeof k);if(kl==-2){kl=-3;}if(kl==-1)goto bad;jws(&j);if(j.p>=j.e||*j.p!=':')goto bad;j.p++;jws(&j);
      if(kl==3&&!memcmp(k,"alg",3)){char v[16];jp_t t=j;int vl=jstr(&t,v,sizeof v);if(vl==5&&!memcmp(v,"HS256",5))alg_ok=1;else alg_ok=0;if(jskip(&j,0))goto bad;}
      else if(jskip(&j,0))goto bad;
      jws(&j);if(j.p>=j.e)goto bad;if(*j.p==','){j.p++;continue;}if(*j.p=='}')break;goto bad;}
    if(!alg_ok)goto bad;
  }
  {
    uint8_t pl[1400];size_t plen=0;
    if(b64u_dec(h+(d1-h)+1,d2-d1-1,pl,&plen)||plen>=sizeof pl)goto bad;
    jp_t j={(char*)pl,(char*)pl+plen};jws(&j);if(j.p>=j.e||*j.p!='{')goto bad;j.p++;jws(&j);
    int have_sub=0,sub_ok=0,have_un=0;double exp_v=0;int have_exp=0,exp_bad=0;a->uid=0;
    if(j.p<j.e&&*j.p=='}'){j.p++;goto payload_done;}
    for(;;){char k[16];jws(&j);int kl=jstr(&j,k,sizeof k);if(kl==-1)goto bad;jws(&j);if(j.p>=j.e||*j.p!=':')goto bad;j.p++;jws(&j);
      if(kl==3&&!memcmp(k,"sub",3)){have_sub=1;sub_ok=0;
        if(j.p<j.e&&*j.p=='"'){char v[32];jp_t t=j;int vl=jstr(&t,v,sizeof v);if(vl>0){long long id;if(parse_id(v,vl,&id)){a->uid=id;sub_ok=1;}}}
        if(jskip(&j,0))goto bad;}
      else if(kl==8&&!memcmp(k,"username",8)){
        if(j.p<j.e&&*j.p=='"'){jp_t t=j;int vl=jstr(&t,a->uname,sizeof a->uname);if(vl>=0){a->unl=vl;have_un=1;}else if(vl==-1)goto bad; else have_un=0;}else have_un=0;
        if(jskip(&j,0))goto bad;}
      else if(kl==3&&!memcmp(k,"exp",3)){have_exp=1;
        if(j.p<j.e&&((*j.p>='0'&&*j.p<='9')||*j.p=='-')){exp_v=strtod(j.p,NULL);exp_bad=0;}else exp_bad=1;
        if(jskip(&j,0))goto bad;}
      else if(jskip(&j,0))goto bad;
      jws(&j);if(j.p>=j.e)goto bad;if(*j.p==','){j.p++;continue;}if(*j.p=='}'){j.p++;break;}goto bad;}
payload_done:
    if(have_exp){ if(exp_bad)goto bad; if(exp_v<=(double)time(NULL))goto bad; }
    if(!have_sub||!sub_ok||!have_un){err(401,"invalid token payload");set(401);return -1;}
  }
  return 0;
bad:
  err(401,"invalid or expired token");set(401);return -1;
}

static void diff_post(long long id);
static void resp_post_by_id(long long id){
  if(raw_post(id)){set(200);if(raw_diff)diff_post(id);return;}
  sqlite3_stmt *s=st_post;sqlite3_bind_int64(s,1,id);
  int rc=sqlite3_step(s);
  if(rc==SQLITE_ROW){begin_resp();OLIT("{\"post\":");opost_row(s);OLIT("}");set(200);}
  else if(rc==SQLITE_DONE){err(404,"post not found");set(404);}
  else {err(500,"internal server error");set(500);}
  sqlite3_reset(s);
}

static void diff_feed(void);
static void handle(const char *m,size_t ml,const char *path,size_t pl,const char *auth,size_t al,const char *body,size_t bl){
  // strip query string
  const char *q=memchr(path,'?',pl);if(q)pl=q-path;
  int isget=(ml==3&&!memcmp(m,"GET",3)),ispost=(ml==4&&!memcmp(m,"POST",4));
  if(isget&&pl==5&&!memcmp(path,"/feed",5)){
    if(raw_feed()){set(200);if(raw_diff)diff_feed();return;}
    sqlite3_stmt *s=st_feed;begin_resp();OLIT("{\"posts\":[");int n=0,rc;
    while((rc=sqlite3_step(s))==SQLITE_ROW){if(n++)OLIT(",");opost_row(s);}
    sqlite3_reset(s);
    if(rc!=SQLITE_DONE){err(500,"internal server error");set(500);return;}
    OLIT("]}");set(200);return;
  }
  if(isget&&pl==7&&!memcmp(path,"/health",7)){
    int rc=sqlite3_step(st_health);sqlite3_reset(st_health);
    if(rc==SQLITE_ROW){begin_resp();OLIT("{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":");oint(time(NULL)-t_start);OLIT("}");set(200);}
    else{begin_resp();OLIT("{\"status\":\"degraded\",\"db\":\"unreachable\",\"error\":");const char *e=sqlite3_errmsg(db);ostr(e,strlen(e));OLIT("}");set(503);}
    return;
  }
  if(pl>7&&!memcmp(path,"/posts/",7)){
    const char *idp=path+7;size_t il=pl-7;
    if(isget){long long id;if(!parse_id(idp,il,&id)){err(400,"invalid post id");set(400);return;}resp_post_by_id(id);return;}
    if(ispost){
      const char *sl=memchr(idp,'/',il);
      if(sl&&il-(sl-idp)==5&&!memcmp(sl,"/like",5)){
        auth_t a;if(do_auth(auth,al,&a))return;
        long long id;if(!parse_id(idp,sl-idp,&id)){err(400,"invalid post id");set(400);return;}
        sqlite3_bind_int64(st_exists,1,id);int rc=sqlite3_step(st_exists);sqlite3_reset(st_exists);
        if(rc==SQLITE_DONE){err(404,"post not found");set(404);return;}
        if(rc!=SQLITE_ROW){err(500,"internal server error");set(500);return;}
        sqlite3_bind_int64(st_ins_like,1,a.uid);sqlite3_bind_int64(st_ins_like,2,id);
        rc=sqlite3_step(st_ins_like);int ch=sqlite3_changes(db);sqlite3_reset(st_ins_like);
        if(rc!=SQLITE_DONE){err(500,"internal server error");set(500);return;}
        begin_resp();OLIT("{\"liked\":true,\"already_liked\":");if(ch)OLIT("false");else OLIT("true");OLIT(",\"post_id\":");oint(id);OLIT("}");set(ch?201:200);return;
      }
    }
  }
  if(ispost&&pl==6&&!memcmp(path,"/posts",6)){
    auth_t a;if(do_auth(auth,al,&a))return;
    jp_t j={body,body+bl};jws(&j);
    static char bd[MAXBODY+8];int blen=-100;int have=0,isstr=0;
    if(j.p>=j.e||*j.p!='{'){ if(jskip(&j,0)==0){jws(&j);if(j.p==j.e){err(400,"body is required");set(400);return;}} err(400,"malformed JSON body");set(400);return; }
    j.p++;jws(&j);
    if(j.p<j.e&&*j.p=='}'){j.p++;}
    else for(;;){char k[8];jws(&j);int kl=jstr(&j,k,sizeof k);if(kl==-1)goto malformed;jws(&j);if(j.p>=j.e||*j.p!=':')goto malformed;j.p++;jws(&j);
      if(kl==4&&!memcmp(k,"body",4)){have=1;isstr=0;
        if(j.p<j.e&&*j.p=='"'){jp_t t=j;blen=jstr(&t,bd,MAXBODY);if(blen==-2){blen=MAXBODY+1;} if(blen==-1)goto malformed;isstr=1;}
        if(jskip(&j,0))goto malformed;}
      else if(jskip(&j,0))goto malformed;
      jws(&j);if(j.p>=j.e)goto malformed;if(*j.p==','){j.p++;continue;}if(*j.p=='}'){j.p++;break;}goto malformed;}
    jws(&j);if(j.p!=j.e)goto malformed;
    if(!have||!isstr){err(400,"body is required");set(400);return;}
    if(blen>MAXBODY){err(400,"body must be at most 500 characters");set(400);return;}
    {
      const char *b=bd;size_t n=blen;
      while(n&&(*b==' '||*b=='\t'||*b=='\n'||*b=='\r'||*b=='\f'||*b=='\v')){b++;n--;}
      while(n&&(b[n-1]==' '||b[n-1]=='\t'||b[n-1]=='\n'||b[n-1]=='\r'||b[n-1]=='\f'||b[n-1]=='\v'))n--;
      if(!n){err(400,"body is required");set(400);return;}
      size_t cps=0;for(size_t i=0;i<n;i++)if(((unsigned char)b[i]&0xC0)!=0x80)cps++;
      if(cps>500){err(400,"body must be at most 500 characters");set(400);return;}
      sqlite3_bind_int64(st_ins_post,1,a.uid);sqlite3_bind_text(st_ins_post,2,b,n,SQLITE_STATIC);
      int rc=sqlite3_step(st_ins_post);
      if(rc!=SQLITE_ROW){sqlite3_reset(st_ins_post);err(500,"internal server error");set(500);return;}
      long long id=sqlite3_column_int64(st_ins_post,0);
      begin_resp();OLIT("{\"post\":{\"id\":");oint(id);OLIT(",\"body\":");ostr(b,n);
      OLIT(",\"created_at\":");ostr((const char*)sqlite3_column_text(st_ins_post,1),sqlite3_column_bytes(st_ins_post,1));
      OLIT(",\"author\":");ostr(a.uname,a.unl);OLIT(",\"like_count\":0}}");
      rc=sqlite3_reset(st_ins_post);
      if(rc!=SQLITE_OK){err(500,"internal server error");set(500);return;}
      set(201);return;
    }
malformed:
    err(400,"malformed JSON body");set(400);return;
  }
  err(404,"not found");set(404);
}


// differential self-check (RAWDIFF=1): recompute via SQL and abort on any byte difference
static void diff_feed(void){
  size_t l1=ol-HDRMAX;char *a=malloc(l1);memcpy(a,ob+HDRMAX,l1);
  int saved=raw_on;raw_on=0;sqlite3_stmt *s=st_feed;begin_resp();OLIT("{\"posts\":[");int n=0;
  while(sqlite3_step(s)==SQLITE_ROW){if(n++)OLIT(",");opost_row(s);}sqlite3_reset(s);OLIT("]}");raw_on=saved;
  if(ol-HDRMAX!=l1||memcmp(a,ob+HDRMAX,l1)){fprintf(stderr,"RAWDIFF MISMATCH feed\nraw: %.*s\nsql: %.*s\n",(int)l1,a,(int)(ol-HDRMAX),ob+HDRMAX);abort();}
  free(a);sqlite3_reset(st_snap);
}
static void diff_post(long long id){
  size_t l1=ol-HDRMAX;char *a=malloc(l1);memcpy(a,ob+HDRMAX,l1);
  sqlite3_stmt *s=st_post;sqlite3_bind_int64(s,1,id);begin_resp();
  if(sqlite3_step(s)==SQLITE_ROW){OLIT("{\"post\":");opost_row(s);OLIT("}");}
  sqlite3_reset(s);
  if(ol-HDRMAX!=l1||memcmp(a,ob+HDRMAX,l1)){fprintf(stderr,"RAWDIFF MISMATCH post %lld\nraw: %.*s\nsql: %.*s\n",id,(int)l1,a,(int)(ol-HDRMAX),ob+HDRMAX);abort();}
  free(a);sqlite3_reset(st_snap);
}

// ---------------- connections ----------------
typedef struct { char *buf; uint32_t len; } conn_t;
static conn_t *conns; static int nconn=0, maxconn=55000;
static int ep, lfd;

static void closec(int fd){
  if(conns[fd].buf){free(conns[fd].buf);conns[fd].buf=NULL;}conns[fd].len=0;
  close(fd);nconn--;
}
static int send_all(int fd,const char *p,size_t n){ // blocking-ish: spin on EAGAIN with poll via epoll is overkill; responses are small
  while(n){ssize_t w=send(fd,p,n,MSG_NOSIGNAL);if(w<0){if(errno==EINTR)continue;if(errno==EAGAIN){ // wait for writability
        struct timespec ts={0,200000};nanosleep(&ts,0);continue;}return -1;}p+=w;n-=w;}
  return 0;
}
static const char *hfind(const char *h,const char *he,const char *name,size_t nl,size_t *vl){ // case-insens header value
  const char *p=h;
  while(p<he){const char *e=memchr(p,'\n',he-p);if(!e)e=he;
    if((size_t)(e-p)>nl+1&&p[nl]==':'&&!strncasecmp(p,name,nl)){const char *v=p+nl+1;while(v<e&&(*v==' '||*v=='\t'))v++;const char *ve=e;if(ve>v&&ve[-1]=='\r')ve--;while(ve>v&&(ve[-1]==' '||ve[-1]=='\t'))ve--;*vl=ve-v;return v;}
    p=e+1;}
  return NULL;
}
// process buffer; returns bytes consumed, or -1 on fatal (close). *need set to nothing; incomplete -> returns 0
static long process(int fd,const char *buf,size_t len,int *close_after){
  size_t used=0;
  while(used<len){
    const char *r=buf+used;size_t rl=len-used;
    const char *he=memmem(r,rl,"\r\n\r\n",4);
    if(!he){ if(rl>16384)return -1; break; }
    size_t hlen=he-r+4;
    const char *sp1=memchr(r,' ',hlen);const char *le=memchr(r,'\r',hlen);
    if(!sp1||!le||sp1>le)return -1;
    const char *sp2=memchr(sp1+1,' ',le-sp1-1);if(!sp2)return -1;
    size_t cl=0;size_t vl;
    const char *hs=le+2;
    const char *v=hfind(hs,r+hlen,"Content-Length",14,&vl);
    if(v){ if(vl==0||vl>9)return -1; for(size_t i=0;i<vl;i++){if(v[i]<'0'||v[i]>'9')return -1;cl=cl*10+(v[i]-'0');} if(cl>1<<20)return -1; }
    if(hfind(hs,r+hlen,"Transfer-Encoding",17,&vl))return -1;
    if(hlen+cl>rl)break; // need more
    const char *au=hfind(hs,r+hlen,"Authorization",13,&vl);size_t al=au?vl:0;
    int ca=0;const char *cn=hfind(hs,r+hlen,"Connection",10,&vl);
    int http10=(le-sp2-1==8&&!memcmp(sp2+1,"HTTP/1.0",8));
    if(cn&&vl==5&&!strncasecmp(cn,"close",5))ca=1;
    if(http10&&!(cn&&vl==10&&!strncasecmp(cn,"keep-alive",10)))ca=1;
    set(500);
    handle(r,sp1-r,sp1+1,sp2-sp1-1,au,al,r+hlen,cl);
    size_t outl;char *o=end_resp(g_code,&outl,ca);
    if(send_all(fd,o,outl))return -1;
    used+=hlen+cl;
    if(ca){*close_after=1;return used;}
  }
  return used;
}
static char rb[RBUF];
static void on_readable(int fd){
  conn_t *c=&conns[fd];
  char *buf=rb;size_t have=0;
  if(c->len){ memcpy(rb,c->buf,c->len);have=c->len; }
  ssize_t n=recv(fd,rb+have,RBUF-have,0);
  if(n==0||(n<0&&errno!=EAGAIN&&errno!=EINTR)){closec(fd);return;}
  if(n<0)return;
  have+=n;int ca=0;
  long used=process(fd,buf,have,&ca);
  if(used<0||ca){closec(fd);return;}
  size_t rem=have-used;
  if(rem==0){ if(c->buf){free(c->buf);c->buf=NULL;}c->len=0; }
  else { if(rem>=RBUF){closec(fd);return;} c->buf=realloc(c->buf,rem);memcpy(c->buf,rb+used,rem);c->len=rem; }
}
static int listening=1;
static void on_accept(void){
  for(;;){
    if(nconn>=maxconn){ epoll_ctl(ep,EPOLL_CTL_DEL,lfd,NULL);listening=0;return; }
    int fd=accept4(lfd,NULL,NULL,SOCK_NONBLOCK);
    if(fd<0)return;
    int one=1;setsockopt(fd,IPPROTO_TCP,TCP_NODELAY,&one,sizeof one);
    if(fd>=65536*4){close(fd);continue;}
    struct epoll_event ev={.events=EPOLLIN|EPOLLRDHUP,.data.fd=fd};
    if(epoll_ctl(ep,EPOLL_CTL_ADD,fd,&ev)){close(fd);continue;}
    nconn++;
  }
}
static void worker(void){
  struct rlimit rl;getrlimit(RLIMIT_NOFILE,&rl);rl.rlim_cur=rl.rlim_max;setrlimit(RLIMIT_NOFILE,&rl);
  size_t nf=rl.rlim_cur>262144?262144:rl.rlim_cur;
  if((int)nf-64<maxconn)maxconn=(int)nf-64;
  conns=calloc(nf+64,sizeof(conn_t));
  ocap=1<<16;ob=malloc(ocap);
  const char *path=getenv("SQLITE_PATH");if(!path)die("SQLITE_PATH");
  db_open(path);
  raw_init(path);
  if(getenv("SELFBENCH")){
    raw_on_orig=raw_on;
    const char *rq[3]={"/feed","/posts/499990","/posts/12345"};
    for(int k=0;k<3;k++)for(int mode=0;mode<2;mode++){
      raw_on=mode&&raw_on_orig_dummy();
      struct timespec a,b;int N=k==0?20000:200000;clock_gettime(CLOCK_THREAD_CPUTIME_ID,&a);
      for(int i=0;i<N;i++)handle("GET",3,rq[k],strlen(rq[k]),NULL,0,NULL,0);
      clock_gettime(CLOCK_THREAD_CPUTIME_ID,&b);
      printf("%s raw=%d: %.2f us/req (raw_miss=%ld raw_hits=%ld, %zu bytes)\n",rq[k],mode,((b.tv_sec-a.tv_sec)*1e9+(b.tv_nsec-a.tv_nsec))/N/1e3,raw_miss,raw_hits,ol-HDRMAX);
    }
    exit(0);
  }
  ep=epoll_create1(0);
  struct epoll_event ev={.events=EPOLLIN|EPOLLEXCLUSIVE,.data.fd=lfd};
  epoll_ctl(ep,EPOLL_CTL_ADD,lfd,&ev);
  struct epoll_event evs[512];
  for(;;){
    int n=epoll_wait(ep,evs,512,listening?-1:1000);
    for(int i=0;i<n;i++){
      int fd=evs[i].data.fd;
      if(fd==lfd){on_accept();continue;}
      if(evs[i].events&(EPOLLERR|EPOLLHUP)&&!(evs[i].events&EPOLLIN)){closec(fd);continue;}
      on_readable(fd);
    }
    if(!listening&&nconn<maxconn-256){struct epoll_event e2={.events=EPOLLIN|EPOLLEXCLUSIVE,.data.fd=lfd};epoll_ctl(ep,EPOLL_CTL_ADD,lfd,&e2);listening=1;}
  }
}
int main(void){
  signal(SIGPIPE,SIG_IGN);
  const char *sec=getenv("JWT_SECRET");if(!sec)sec="twelve-dollar-challenge";
  hmac_setup(sec,strlen(sec));
  const char *host=getenv("HOST"),*port=getenv("PORT");
  struct sockaddr_in sa={.sin_family=AF_INET,.sin_port=htons(port?atoi(port):3000)};
  if(!host||inet_pton(AF_INET,host,&sa.sin_addr)!=1)sa.sin_addr.s_addr=INADDR_ANY;
  lfd=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK,0);int one=1;setsockopt(lfd,SOL_SOCKET,SO_REUSEADDR,&one,sizeof one);
  if(bind(lfd,(struct sockaddr*)&sa,sizeof sa)||listen(lfd,65535)){perror("bind/listen");return 1;}
  t_start=time(NULL);
  const char *w=getenv("WORKERS");int nw=w?atoi(w):6;if(nw<1)nw=1;
  const char *mc=getenv("MAXCONN");if(mc)maxconn=atoi(mc);
  // verify DB opens in the parent first (fail fast)
  for(int i=1;i<nw;i++){pid_t p=fork();if(p==0){worker();return 0;}}
  worker();
  return 0;
}
