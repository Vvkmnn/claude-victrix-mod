/* Direct, read-only reader for the SQLite file format (https://www.sqlite.org/fileformat2.html),
 * WAL-aware (wal-index layout from SQLite's wal.c). Every call reads pages straight from the
 * mmap'd database / WAL files at the moment of the request: nothing is cached across requests
 * except the file mappings and the schema root page numbers (guarded by the schema cookie).
 *
 * Any fact the fast path relies on that does not hold (unexpected page type, overflow payload,
 * odd serial type, torn wal-index header, frame outside the mapping, schema change, ...) makes the
 * call return BT_FALLBACK and the caller answers that request through plain SQLite instead.
 *
 * Safety model: the process is single-threaded and is the only writer. WAL commits, checkpoints
 * (SQLite's auto-checkpoint, run inside COMMIT) and WAL restarts all happen on this same thread
 * between requests, never while a page pointer from here is live.
 */
#pragma once
#include <stdint.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>

#define BT_OK 0
#define BT_NOTFOUND 1
#define BT_FALLBACK 2

typedef struct {
  int dbfd, walfd, shmfd;
  const uint8_t *db; size_t dbmap;     /* reserved virtual range, MAP_SHARED */
  const uint8_t *wal; size_t walmap;
  const uint8_t *shm; size_t shmmap;
  uint32_t pgsz;
  uint32_t root_posts, root_users, root_feed_idx, root_likes_post_idx;
  uint32_t cookie;
  size_t db_sz, wal_sz, shm_sz;        /* real file sizes, refreshed after every commit */
  /* per-request snapshot */
  uint32_t mxFrame;
  long fallbacks;
} bt_t;

static inline uint32_t be16(const uint8_t *p){return (uint32_t)p[0]<<8|p[1];}
static inline uint32_t be32(const uint8_t *p){return (uint32_t)p[0]<<24|(uint32_t)p[1]<<16|(uint32_t)p[2]<<8|p[3];}
static inline int varint(const uint8_t *p, uint64_t *v){
  uint64_t x=0; for(int i=0;i<8;i++){ x=(x<<7)|(p[i]&0x7f); if(!(p[i]&0x80)){*v=x;return i+1;} }
  x=(x<<8)|p[8]; *v=x; return 9;
}

/* ---- wal-index (shm) ---- */
#define WALIDX_HDR 136
#define HT_NPAGE 4096
#define HT_NPAGE_ONE (HT_NPAGE - WALIDX_HDR/4)
#define HT_NSLOT 8192
#define SHM_BLOCK 32768

static int bt_file_size(int fd, size_t *sz){struct stat st; if(fstat(fd,&st))return -1; *sz=(size_t)st.st_size; return 0;}

/* Take the snapshot for one request: the committed mxFrame from the wal-index header. */
static const uint8_t *bt_page(bt_t *b, uint32_t pgno);
static int bt_snapshot(bt_t *b){
  if(b->shm_sz<SHM_BLOCK){ b->mxFrame=0; return BT_FALLBACK; }
  const uint8_t *h=b->shm;
  if(memcmp(h,h+48,48)!=0) return BT_FALLBACK;          /* torn / in-flux header */
  if(h[12]!=1) return BT_FALLBACK;                       /* isInit */
  uint32_t szp; memcpy(&szp,h+14,2); szp&=0xffff; if(szp==0) szp=65536;
  uint32_t mx; memcpy(&mx,h+16,4);
  if(mx && szp!=b->pgsz) return BT_FALLBACK;
  size_t needshm = (mx<=HT_NPAGE_ONE)?SHM_BLOCK: (size_t)(1+ (mx-HT_NPAGE_ONE+HT_NPAGE-1)/HT_NPAGE)*SHM_BLOCK;
  if(needshm>b->shm_sz) return BT_FALLBACK;
  size_t walend = 32 + (size_t)mx*(24+b->pgsz);
  if(mx && walend>b->wal_sz) return BT_FALLBACK;
  b->mxFrame=mx;
  return BT_OK;
}
static int bt_begin(bt_t *b){
  if(bt_snapshot(b)!=BT_OK) return BT_FALLBACK;
  const uint8_t *p1=bt_page(b,1); if(!p1 || be32(p1+40)!=b->cookie) return BT_FALLBACK;  /* schema changed */
  return BT_OK;
}

/* Find the newest WAL frame <= mxFrame holding page pgno (0 = not in WAL). Mirrors walFindFrame. */
static uint32_t bt_wal_find(const bt_t *b, uint32_t pgno){
  uint32_t mx=b->mxFrame; if(!mx) return 0;
  int lastHash = (mx<=HT_NPAGE_ONE)?0: 1+(int)((mx-HT_NPAGE_ONE-1)/HT_NPAGE);
  for(int ih=lastHash; ih>=0; ih--){
    const uint8_t *blk=b->shm+(size_t)ih*SHM_BLOCK;
    const uint32_t *aPgno=(const uint32_t*)blk; uint32_t iZero=0;
    if(ih==0) aPgno+=WALIDX_HDR/4; else iZero=HT_NPAGE_ONE+(uint32_t)(ih-1)*HT_NPAGE;
    const uint16_t *aHash=(const uint16_t*)(blk+HT_NPAGE*4);
    uint32_t found=0; int nCollide=HT_NSLOT;
    for(uint32_t k=(pgno*383)&(HT_NSLOT-1); aHash[k]; k=(k+1)&(HT_NSLOT-1)){
      uint32_t iFrame=iZero+aHash[k];
      if(iFrame<=mx && iFrame>found && aPgno[aHash[k]-1]==pgno) found=iFrame;
      if(--nCollide==0) return 0xffffffffu;   /* corrupt: caller falls back */
    }
    if(found) return found;
  }
  return 0;
}

static const uint8_t *bt_page(bt_t *b, uint32_t pgno){
  if(pgno==0) return 0;
  uint32_t f=bt_wal_find(b,pgno);
  if(f==0xffffffffu) return 0;
  if(f){
    const uint8_t *fr=b->wal+32+(size_t)(f-1)*(24+b->pgsz);
    if(be32(fr)!=pgno) return 0;                  /* frame header must name the page */
    return fr+24;
  }
  size_t off=(size_t)(pgno-1)*b->pgsz;
  if(off+b->pgsz>b->db_sz) return 0;
  return b->db+off;
}
static inline const uint8_t *bt_hdr(const uint8_t *pg, uint32_t pgno){return pgno==1?pg+100:pg;}

/* ---- records ---- */
typedef struct { int n; uint64_t st[8]; const uint8_t *data[8]; } rec_t;
static uint32_t st_len(uint64_t t){static const uint8_t L[10]={0,1,2,3,4,6,8,8,0,0}; if(t<10) return L[t]; if(t<12) return 0xffffffff; return (uint32_t)((t-12)/2);}
static int rec_parse(const uint8_t *p, uint32_t len, rec_t *r){
  uint64_t hs; int k=varint(p,&hs); if(hs>len||hs<1) return -1;
  const uint8_t *h=p+k, *he=p+hs, *d=p+hs, *de=p+len; r->n=0;
  while(h<he){ if(r->n>=8) return -1; uint64_t t; h+=varint(h,&t); uint32_t l=st_len(t); if(l==0xffffffff) return -1;
    if(d+l>de) return -1; r->st[r->n]=t; r->data[r->n]=d; r->n++; d+=l; }
  return 0;
}
static int rec_int(const rec_t *r, int i, int64_t *v){
  if(i>=r->n) return -1; uint64_t t=r->st[i]; const uint8_t *p=r->data[i];
  switch(t){case 8:*v=0;return 0;case 9:*v=1;return 0;
    case 1:*v=(int8_t)p[0];return 0; case 2:*v=(int16_t)be16(p);return 0;
    case 3:{int32_t x=(int32_t)((uint32_t)p[0]<<16|(uint32_t)p[1]<<8|p[2]); if(x&0x800000) x|=(int32_t)0xff000000; *v=x; return 0;}
    case 4:*v=(int32_t)be32(p);return 0;
    case 5:{int64_t x=((int64_t)be16(p)<<32)|be32(p+2); if(x&0x800000000000LL) x|=(int64_t)0xffff000000000000ULL; *v=x; return 0;}
    case 6:*v=(int64_t)(((uint64_t)be32(p)<<32)|be32(p+4));return 0;}
  return -1;
}
static int rec_text(const rec_t *r, int i, const uint8_t **s, uint32_t *l){
  if(i>=r->n) return -1; uint64_t t=r->st[i]; if(t<13||!(t&1)) return -1; *s=r->data[i]; *l=(uint32_t)((t-13)/2); return 0;
}

/* Local payload of a cell; refuses (returns NULL) any payload that spills to overflow pages. */
static const uint8_t *cell_payload(const bt_t *b, const uint8_t *cell, int table_leaf, uint32_t *len, int64_t *rowid){
  uint64_t P; int k=varint(cell,&P); cell+=k;
  if(table_leaf){ uint64_t r; cell+=varint(cell,&r); if(rowid) *rowid=(int64_t)r; }
  uint32_t U=b->pgsz; uint32_t X= table_leaf? U-35 : ((U-12)*64/255)-23;
  if(P>X) return 0;
  *len=(uint32_t)P; return cell;
}

/* ---- table lookup by rowid ---- */
static int bt_table_get(bt_t *b, uint32_t root, int64_t rowid, rec_t *out){
  uint32_t pg=root;
  for(int depth=0; depth<24; depth++){
    const uint8_t *page=bt_page(b,pg); if(!page) return BT_FALLBACK;
    const uint8_t *h=bt_hdr(page,pg); uint8_t type=h[0]; uint32_t n=be16(h+3);
    if(type==5){
      const uint8_t *cp=h+12; uint32_t lo=0, hi=n;   /* first cell with key >= rowid */
      while(lo<hi){ uint32_t mid=(lo+hi)/2; const uint8_t *c=page+be16(cp+2*mid); uint64_t key; varint(c+4,&key);
        if((int64_t)key<rowid) lo=mid+1; else hi=mid; }
      pg = lo<n ? be32(page+be16(cp+2*lo)) : be32(h+8);
    } else if(type==13){
      const uint8_t *cp=h+8; uint32_t lo=0, hi=n;
      while(lo<hi){ uint32_t mid=(lo+hi)/2; const uint8_t *c=page+be16(cp+2*mid); uint64_t P,key; int k=varint(c,&P); varint(c+k,&key);
        if((int64_t)key<rowid) lo=mid+1; else hi=mid; }
      if(lo>=n) return BT_NOTFOUND;
      const uint8_t *c=page+be16(cp+2*lo); uint32_t len; int64_t key;
      const uint8_t *pl=cell_payload(b,c,1,&len,&key); if(!pl) return BT_FALLBACK;
      if(key!=rowid) return BT_NOTFOUND;
      if(rec_parse(pl,len,out)) return BT_FALLBACK;
      return BT_OK;
    } else return BT_FALLBACK;
  }
  return BT_FALLBACK;
}

/* ---- index cursor (in-order traversal with an explicit stack) ---- */
typedef struct { uint32_t pg; const uint8_t *page; const uint8_t *h; uint32_t n; uint32_t i; int leaf; } frame_t;
typedef struct { bt_t *b; frame_t st[24]; int top; int eof; } icur_t;

static int icur_push(icur_t *c, uint32_t pg){
  if(c->top>=23) return -1; const uint8_t *page=bt_page(c->b,pg); if(!page) return -1;
  const uint8_t *h=bt_hdr(page,pg); if(h[0]!=2 && h[0]!=10) return -1;
  frame_t *f=&c->st[++c->top]; f->pg=pg; f->page=page; f->h=h; f->n=be16(h+3); f->i=0; f->leaf=(h[0]==10); return 0;
}
static inline const uint8_t *icell(const frame_t *f, uint32_t i){ return f->page+be16(f->h+(f->leaf?8:12)+2*i); }
static inline uint32_t ichild(const frame_t *f, uint32_t i){ return i<f->n ? be32(icell(f,i)) : be32(f->h+8); }
static int icur_entry(icur_t *c, rec_t *r){
  frame_t *f=&c->st[c->top]; const uint8_t *cell=icell(f,f->i); if(!f->leaf) cell+=4;
  uint32_t len; const uint8_t *pl=cell_payload(c->b,cell,0,&len,0); if(!pl) return -1;
  return rec_parse(pl,len,r);
}
/* climb until an entry is found; returns 0 positioned, 1 eof, -1 fallback */
static int icur_up(icur_t *c){
  c->top--;
  while(c->top>=0){ frame_t *f=&c->st[c->top]; if(f->i<f->n) return 0; c->top--; }
  c->eof=1; return 1;
}
static int icur_descend_left(icur_t *c, uint32_t pg){
  for(;;){ if(icur_push(c,pg)) return -1; frame_t *f=&c->st[c->top]; if(f->leaf) break; pg=ichild(f,0); }
  if(c->st[c->top].n==0) return icur_up(c);
  return 0;
}
static int icur_first(icur_t *c, bt_t *b, uint32_t root){ c->b=b; c->top=-1; c->eof=0; return icur_descend_left(c,root); }
static int icur_next(icur_t *c){
  frame_t *f=&c->st[c->top];
  if(f->leaf){ f->i++; if(f->i<f->n) return 0; return icur_up(c); }
  f->i++; return icur_descend_left(c, ichild(f,f->i));
}
/* first field of the current index entry as an integer, without parsing the whole record */
static inline int icur_first_int(icur_t *c, int64_t *v){
  frame_t *f=&c->st[c->top]; const uint8_t *cell=icell(f,f->i); if(!f->leaf) cell+=4;
  uint8_t P=cell[0], hs=cell[1], t=cell[2];
  if(P<0x80 && hs<0x80 && hs>=2 && t>=1 && t<=4 && P<=1002){ const uint8_t *d=cell+1+hs;
    switch(t){case 1:*v=(int8_t)d[0];return 0;case 2:*v=(int16_t)be16(d);return 0;
      case 3:{int32_t x=(int32_t)((uint32_t)d[0]<<16|(uint32_t)d[1]<<8|d[2]); if(x&0x800000) x|=(int32_t)0xff000000; *v=x; return 0;}
      case 4:*v=(int32_t)be32(d);return 0;} }
  rec_t r; if(icur_entry(c,&r)) return -1; return rec_int(&r,0,v);
}
/* position at the first entry whose first field (integer) >= key */
static int icur_seek_int(icur_t *c, bt_t *b, uint32_t root, int64_t key){
  c->b=b; c->top=-1; c->eof=0; uint32_t pg=root;
  for(;;){
    if(icur_push(c,pg)) return -1; frame_t *f=&c->st[c->top];
    uint32_t lo=0, hi=f->n;
    while(lo<hi){ uint32_t mid=(lo+hi)/2; f->i=mid; int64_t v;
      if(icur_first_int(c,&v)) return -1;
      if(v<key) lo=mid+1; else hi=mid; }
    f->i=lo;
    if(f->leaf){ if(lo<f->n) return 0; return icur_up(c); }
    pg=ichild(f,lo);
  }
}

/* ---- schema ---- */
static int bt_load_schema(bt_t *b){
  if(bt_snapshot(b)!=BT_OK) return -1;
  const uint8_t *p1=bt_page(b,1); if(!p1) return -1;
  if(be32(p1+56)!=1) return -1;                         /* UTF-8 text encoding */
  if(p1[20]!=0) return -1;                              /* no reserved bytes per page */
  b->cookie=be32(p1+40);
  b->root_posts=b->root_users=b->root_feed_idx=b->root_likes_post_idx=0;
  /* sqlite_schema is a small table rooted at page 1: walk it with a leaf scan */
  uint32_t stack[32]; int sp=0; stack[sp++]=1;
  while(sp){
    uint32_t pg=stack[--sp]; const uint8_t *page=bt_page(b,pg); if(!page) return -1; const uint8_t *h=bt_hdr(page,pg);
    uint32_t n=be16(h+3);
    if(h[0]==5){ for(uint32_t i=0;i<n;i++){ if(sp>=31) return -1; stack[sp++]=be32(page+be16(h+12+2*i)); } if(sp>=31) return -1; stack[sp++]=be32(h+8); continue; }
    if(h[0]!=13) return -1;
    for(uint32_t i=0;i<n;i++){ uint32_t len; int64_t rid; const uint8_t *pl=cell_payload(b,page+be16(h+8+2*i),1,&len,&rid);
      if(!pl) continue; rec_t r; if(rec_parse(pl,len,&r)) continue; const uint8_t *nm; uint32_t nl; int64_t root;
      if(rec_text(&r,1,&nm,&nl)||rec_int(&r,3,&root)) continue;
#define IS(s) (nl==sizeof(s)-1 && !memcmp(nm,s,nl))
      if(IS("posts")) b->root_posts=(uint32_t)root; else if(IS("users")) b->root_users=(uint32_t)root;
      else if(IS("posts_created_at_id_idx")) b->root_feed_idx=(uint32_t)root; else if(IS("likes_post_id_idx")) b->root_likes_post_idx=(uint32_t)root;
#undef IS
    }
  }
  return (b->root_posts&&b->root_users&&b->root_feed_idx&&b->root_likes_post_idx)?0:-1;
}

static void bt_refresh_sizes(bt_t *b);
static int bt_open(bt_t *b, const char *path){
  memset(b,0,sizeof *b); char p[4096];
  b->dbfd=open(path,O_RDONLY); if(b->dbfd<0) return -1;
  uint8_t h[100]; if(pread(b->dbfd,h,100,0)!=100) return -1;
  b->pgsz=be16(h+16); if(b->pgsz==1) b->pgsz=65536;
  if(h[18]!=2||h[19]!=2) return -1;                     /* WAL mode */
  b->dbmap=(size_t)1<<34; b->db=mmap(0,b->dbmap,PROT_READ,MAP_SHARED|MAP_NORESERVE,b->dbfd,0); if(b->db==MAP_FAILED) return -1;
  snprintf(p,sizeof p,"%s-wal",path); b->walfd=open(p,O_RDONLY);
  snprintf(p,sizeof p,"%s-shm",path); b->shmfd=open(p,O_RDONLY);
  if(b->walfd<0||b->shmfd<0) return -1;
  b->walmap=(size_t)1<<34; b->wal=mmap(0,b->walmap,PROT_READ,MAP_SHARED|MAP_NORESERVE,b->walfd,0); if(b->wal==MAP_FAILED) return -1;
  b->shmmap=(size_t)1<<26; b->shm=mmap(0,b->shmmap,PROT_READ,MAP_SHARED|MAP_NORESERVE,b->shmfd,0); if(b->shm==MAP_FAILED) return -1;
  bt_refresh_sizes(b);
  return bt_load_schema(b);
}
/* The mappings reserve a large range; touching a page past EOF would SIGBUS, so every access is
 * bounded by the real file sizes. Called at open and after every commit (the only time they grow). */
static void bt_refresh_sizes(bt_t *b){
  bt_file_size(b->dbfd,&b->db_sz); bt_file_size(b->walfd,&b->wal_sz); bt_file_size(b->shmfd,&b->shm_sz);
  if(b->db_sz>b->dbmap) b->db_sz=b->dbmap; if(b->wal_sz>b->walmap) b->wal_sz=b->walmap; if(b->shm_sz>b->shmmap) b->shm_sz=b->shmmap;
}
