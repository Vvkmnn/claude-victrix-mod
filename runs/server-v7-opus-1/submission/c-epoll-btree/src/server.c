/* $12 server challenge: single-threaded epoll HTTP/1.1 server in C on SQLite.
 *
 * Reads (GET /feed, GET /posts/:id) go through a direct WAL-aware B-tree reader (btree.h) with an
 * automatic per-request fallback to prepared SQLite statements. READER=sqlite forces SQLite.
 * Writes always go through SQLite, batched per event-loop turn into one transaction (group
 * commit); responses for writes are only queued after COMMIT returns.
 */
#define _GNU_SOURCE
#include <sqlite3.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>
#include <time.h>
#include <signal.h>
#include <unistd.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/epoll.h>
#include <sys/resource.h>
#include <sys/uio.h>
#include "sha256.h"
#include "btree.h"

/* ------------------------------------------------------------------ buffers */
typedef struct { char *p; size_t n, cap; } buf_t;
static void buf_reserve(buf_t *b, size_t extra){ if(b->n+extra<=b->cap) return; size_t c=b->cap?b->cap:1024; while(c<b->n+extra) c*=2; b->p=realloc(b->p,c); if(!b->p){perror("realloc");exit(1);} b->cap=c; }
static inline void buf_put(buf_t *b, const void *s, size_t l){ buf_reserve(b,l); memcpy(b->p+b->n,s,l); b->n+=l; }
#define PUTS(b,s) buf_put(b,s,sizeof(s)-1)
static inline void buf_int(buf_t *b, int64_t v){ char t[24]; int i=24; uint64_t u=v<0?(uint64_t)(-v):(uint64_t)v; do{t[--i]='0'+u%10;u/=10;}while(u); if(v<0)t[--i]='-'; buf_put(b,t+i,24-i); }
/* JSON string escaping identical to JavaScript's JSON.stringify for valid UTF-8 input */
static uint8_t JESC[256]; /* 1 = byte needs escaping */
static void jesc_init(void){ for(int i=0;i<0x20;i++) JESC[i]=1; JESC['"']=1; JESC['\\']=1; }
static void buf_jstr(buf_t *b, const uint8_t *s, size_t l){
  if(!JESC[0]) jesc_init();
  buf_reserve(b,l*6+2); char *o=b->p+b->n; *o++='"';
  size_t i=0;
  while(i<l){
    size_t j=i;
    /* 8 bytes at a time: any byte < 0x20, == '"' or == '\\' stops the run */
    while(j+8<=l){ uint64_t v; memcpy(&v,s+j,8);
      uint64_t lo=(v-0x2020202020202020ULL)&~v; uint64_t q=v^0x2222222222222222ULL, bs=v^0x5c5c5c5c5c5c5c5cULL;
      uint64_t t=(lo|((q-0x0101010101010101ULL)&~q)|((bs-0x0101010101010101ULL)&~bs))&0x8080808080808080ULL;
      if(t) break; j+=8; }
    while(j<l && !JESC[s[j]]) j++;
    memcpy(o,s+i,j-i); o+=j-i; i=j;
    if(i>=l) break;
    uint8_t c=s[i++]; *o++='\\';
    switch(c){case '"':*o++='"';break;case '\\':*o++='\\';break;case '\b':*o++='b';break;case '\f':*o++='f';break;
      case '\n':*o++='n';break;case '\r':*o++='r';break;case '\t':*o++='t';break;
      default:{static const char hx[]="0123456789abcdef"; *o++='u';*o++='0';*o++='0';*o++=hx[c>>4];*o++=hx[c&15];}}
  }
  *o++='"'; b->n=o-b->p;
}

/* ------------------------------------------------------------------ globals */
static sqlite3 *db;
static sqlite3_stmt *st_feed, *st_post, *st_exists, *st_ins_post, *st_ins_like, *st_one, *st_begin, *st_commit, *st_rollback;
static bt_t BT; static int use_bt=1;
static hmac_key HK;
static time_t start_time;
static long n_fallback=0, n_req=0;

/* ------------------------------------------------------------------ post object rendering */
static void put_post(buf_t *o, int64_t id, const uint8_t *body, size_t bl, const uint8_t *ca, size_t cl, const uint8_t *au, size_t al, int64_t likes){
  PUTS(o,"{\"id\":"); buf_int(o,id); PUTS(o,",\"body\":"); buf_jstr(o,body,bl);
  PUTS(o,",\"created_at\":"); buf_jstr(o,ca,cl); PUTS(o,",\"author\":"); buf_jstr(o,au,al);
  PUTS(o,",\"like_count\":"); buf_int(o,likes); PUTS(o,"}");
}

/* B-tree path: one post by id (with author and like count). BT_OK / BT_NOTFOUND / BT_FALLBACK. */
static int bt_count_likes(int64_t pid, int64_t *cnt){
  icur_t c; int r=icur_seek_int(&c,&BT,BT.root_likes_post_idx,pid); if(r<0) return BT_FALLBACK;
  int64_t n=0;
  while(r==0){ int64_t v; if(icur_first_int(&c,&v)) return BT_FALLBACK; if(v!=pid) break; n++; r=icur_next(&c); if(r<0) return BT_FALLBACK; }
  *cnt=n; return BT_OK;
}
static int bt_render_post(buf_t *o, int64_t id){
  rec_t p; int r=bt_table_get(&BT,BT.root_posts,id,&p); if(r!=BT_OK) return r;
  int64_t uid; const uint8_t *body,*ca; uint32_t bl,cl;
  if(p.n!=4 || p.st[0]!=0 || rec_int(&p,1,&uid) || rec_text(&p,2,&body,&bl) || rec_text(&p,3,&ca,&cl)) return BT_FALLBACK;
  rec_t u; if(bt_table_get(&BT,BT.root_users,uid,&u)!=BT_OK) return BT_FALLBACK;   /* inner join must match */
  const uint8_t *un; uint32_t ul; if(u.n<2 || rec_text(&u,1,&un,&ul)) return BT_FALLBACK;
  int64_t likes; if(bt_count_likes(id,&likes)!=BT_OK) return BT_FALLBACK;
  put_post(o,id,body,bl,ca,cl,un,ul,likes); return BT_OK;
}
static int bt_feed(buf_t *o){
  size_t mark=o->n; icur_t c; int r=icur_first(&c,&BT,BT.root_feed_idx); if(r<0) return BT_FALLBACK;
  PUTS(o,"{\"posts\":[");
  for(int k=0;k<20 && r==0;k++){
    rec_t e; int64_t rid; if(icur_entry(&c,&e)||e.n!=3||rec_int(&e,2,&rid)){ o->n=mark; return BT_FALLBACK; }
    if(k) PUTS(o,",");
    if(bt_render_post(o,rid)!=BT_OK){ o->n=mark; return BT_FALLBACK; }
    r=icur_next(&c); if(r<0){ o->n=mark; return BT_FALLBACK; }
  }
  PUTS(o,"]}"); return BT_OK;
}

/* SQLite path (reference implementation + fallback) */
static void sql_row_post(buf_t *o, sqlite3_stmt *s){
  put_post(o,sqlite3_column_int64(s,0),sqlite3_column_text(s,1),sqlite3_column_bytes(s,1),sqlite3_column_text(s,2),sqlite3_column_bytes(s,2),
           sqlite3_column_text(s,3),sqlite3_column_bytes(s,3),sqlite3_column_int64(s,4));
}
static int sql_feed(buf_t *o){
  size_t mark=o->n; PUTS(o,"{\"posts\":["); int k=0,rc;
  while((rc=sqlite3_step(st_feed))==SQLITE_ROW){ if(k++) PUTS(o,","); sql_row_post(o,st_feed); }
  sqlite3_reset(st_feed); if(rc!=SQLITE_DONE){ o->n=mark; return -1; }
  PUTS(o,"]}"); return 0;
}
static int sql_post(buf_t *o, int64_t id){ /* 0 ok, 1 not found, -1 error */
  sqlite3_bind_int64(st_post,1,id); int rc=sqlite3_step(st_post), ret;
  if(rc==SQLITE_ROW){ sql_row_post(o,st_post); ret=0; } else ret = rc==SQLITE_DONE?1:-1;
  sqlite3_reset(st_post); return ret;
}

/* ------------------------------------------------------------------ JSON parsing (requests, JWT) */
typedef struct { const char *p, *e; } jp_t;
static void jws(jp_t *j){ while(j->p<j->e && (*j->p==' '||*j->p=='\t'||*j->p=='\n'||*j->p=='\r')) j->p++; }
static void put_utf8(buf_t *o, uint32_t cp){ char t[4]; int n;
  if(cp<0x80){t[0]=cp;n=1;} else if(cp<0x800){t[0]=0xc0|cp>>6;t[1]=0x80|(cp&63);n=2;}
  else if(cp<0x10000){t[0]=0xe0|cp>>12;t[1]=0x80|((cp>>6)&63);t[2]=0x80|(cp&63);n=3;}
  else {t[0]=0xf0|cp>>18;t[1]=0x80|((cp>>12)&63);t[2]=0x80|((cp>>6)&63);t[3]=0x80|(cp&63);n=4;}
  buf_put(o,t,n); }
static int hex4(const char *p, uint32_t *v){ uint32_t x=0; for(int i=0;i<4;i++){ char c=p[i]; x<<=4;
  if(c>='0'&&c<='9')x|=c-'0'; else if(c>='a'&&c<='f')x|=c-'a'+10; else if(c>='A'&&c<='F')x|=c-'A'+10; else return -1;} *v=x; return 0; }
/* parse a JSON string at j->p (which is '"'); unescaped bytes appended to out if out!=NULL */
static int jstring(jp_t *j, buf_t *out){
  j->p++;
  while(j->p<j->e){ unsigned char c=*j->p;
    if(c=='"'){ j->p++; return 0; }
    if(c<0x20) return -1;
    if(c!='\\'){ const char *s=j->p; while(j->p<j->e && *j->p!='"' && *j->p!='\\' && (unsigned char)*j->p>=0x20) j->p++; if(out) buf_put(out,s,j->p-s); continue; }
    if(j->p+1>=j->e) return -1; char x=j->p[1]; j->p+=2; char ch;
    switch(x){case '"':ch='"';break;case '\\':ch='\\';break;case '/':ch='/';break;case 'b':ch='\b';break;case 'f':ch='\f';break;case 'n':ch='\n';break;case 'r':ch='\r';break;case 't':ch='\t';break;
      case 'u':{ uint32_t cp; if(j->e-j->p<4||hex4(j->p,&cp)) return -1; j->p+=4;
        if(cp>=0xd800&&cp<0xdc00 && j->e-j->p>=6 && j->p[0]=='\\'&&j->p[1]=='u'){ uint32_t lo; if(!hex4(j->p+2,&lo)&&lo>=0xdc00&&lo<0xe000){ cp=0x10000+((cp-0xd800)<<10)+(lo-0xdc00); j->p+=6; } }
        if(out) put_utf8(out,cp); continue; }
      default: return -1; }
    if(out) buf_put(out,&ch,1);
  }
  return -1;
}
static int jvalue(jp_t *j, int depth);
static int jnumber(jp_t *j){ const char *s=j->p; if(j->p<j->e&&*j->p=='-') j->p++;
  if(j->p>=j->e) return -1; if(*j->p=='0') j->p++; else if(*j->p>='1'&&*j->p<='9'){ while(j->p<j->e&&*j->p>='0'&&*j->p<='9') j->p++; } else return -1;
  if(j->p<j->e&&*j->p=='.'){ j->p++; if(j->p>=j->e||*j->p<'0'||*j->p>'9') return -1; while(j->p<j->e&&*j->p>='0'&&*j->p<='9') j->p++; }
  if(j->p<j->e&&(*j->p=='e'||*j->p=='E')){ j->p++; if(j->p<j->e&&(*j->p=='+'||*j->p=='-')) j->p++; if(j->p>=j->e||*j->p<'0'||*j->p>'9') return -1; while(j->p<j->e&&*j->p>='0'&&*j->p<='9') j->p++; }
  return j->p>s?0:-1; }
static int jlit(jp_t *j, const char *w){ size_t l=strlen(w); if((size_t)(j->e-j->p)<l||memcmp(j->p,w,l)) return -1; j->p+=l; return 0; }
static int jvalue(jp_t *j, int depth){
  if(depth>64) return -1; jws(j); if(j->p>=j->e) return -1;
  switch(*j->p){
    case '"': return jstring(j,0);
    case '{': j->p++; jws(j); if(j->p<j->e&&*j->p=='}'){j->p++;return 0;}
      for(;;){ jws(j); if(j->p>=j->e||*j->p!='"'||jstring(j,0)) return -1; jws(j); if(j->p>=j->e||*j->p!=':') return -1; j->p++;
        if(jvalue(j,depth+1)) return -1; jws(j); if(j->p>=j->e) return -1; if(*j->p==','){j->p++;continue;} if(*j->p=='}'){j->p++;return 0;} return -1; }
    case '[': j->p++; jws(j); if(j->p<j->e&&*j->p==']'){j->p++;return 0;}
      for(;;){ if(jvalue(j,depth+1)) return -1; jws(j); if(j->p>=j->e) return -1; if(*j->p==','){j->p++;continue;} if(*j->p==']'){j->p++;return 0;} return -1; }
    case 't': return jlit(j,"true"); case 'f': return jlit(j,"false"); case 'n': return jlit(j,"null");
    default: return jnumber(j);
  }
}
/* Parse a top-level JSON document; for top-level object members named in keys[], record the LAST
 * occurrence (JSON.parse semantics): type ('s' string, 'n' number, 'o' other) and the raw span. */
typedef struct { const char *key; char type; const char *s, *e; } jfield_t;
static int jparse_obj(const char *s, size_t l, jfield_t *f, int nf, int *is_obj){
  jp_t j={s,s+l}; *is_obj=0; for(int i=0;i<nf;i++) f[i].type=0;
  jws(&j); if(j.p<j.e && *j.p=='{'){
    *is_obj=1; j.p++; jws(&j);
    if(j.p<j.e&&*j.p=='}') j.p++;
    else for(;;){ jws(&j); if(j.p>=j.e||*j.p!='"') return -1; const char *ks=j.p; if(jstring(&j,0)) return -1; const char *ke=j.p;
      jws(&j); if(j.p>=j.e||*j.p!=':') return -1; j.p++; jws(&j); const char *vs=j.p; if(jvalue(&j,1)) return -1; const char *ve=j.p;
      for(int i=0;i<nf;i++){ size_t kl=strlen(f[i].key); if((size_t)(ke-ks)==kl+2 && !memcmp(ks+1,f[i].key,kl)){ /* exact, unescaped key */
          f[i].type = *vs=='"'?'s' : ((*vs=='-'||(*vs>='0'&&*vs<='9'))?'n':'o'); f[i].s=vs; f[i].e=ve; } }
      jws(&j); if(j.p>=j.e) return -1; if(*j.p==','){j.p++;continue;} if(*j.p=='}'){j.p++;break;} return -1; }
  } else { if(jvalue(&j,0)) return -1; }
  jws(&j); return j.p==j.e?0:-1;
}

/* ------------------------------------------------------------------ JWT */
static int b64url_dec(const char *s, size_t l, uint8_t *out, size_t cap, size_t *ol){
  static int8_t T[256]; static int init=0; if(!init){ memset(T,-1,256); for(int i=0;i<26;i++){T['A'+i]=i;T['a'+i]=26+i;} for(int i=0;i<10;i++)T['0'+i]=52+i; T['-']=62;T['_']=63; init=1; }
  while(l && s[l-1]=='=') l--;
  if(l%4==1) return -1; size_t n=0; uint32_t acc=0; int bits=0;
  for(size_t i=0;i<l;i++){ int v=T[(uint8_t)s[i]]; if(v<0) return -1; acc=(acc<<6)|v; bits+=6; if(bits>=8){ bits-=8; if(n>=cap) return -1; out[n++]=(uint8_t)(acc>>bits); } }
  *ol=n; return 0;
}
/* JSON number -> double (integers and simple decimals; used for exp/nbf) */
static int jnum_val(const char *s, const char *e, double *v){ char t[64]; size_t l=e-s; if(l>=sizeof t) return -1; memcpy(t,s,l); t[l]=0; char *end; *v=strtod(t,&end); return end==t+l?0:-1; }
#define AUTH_MISSING 1
#define AUTH_INVALID 2
#define AUTH_PAYLOAD 3
static int verify_jwt(const char *hdr, size_t hl, int64_t *uid, buf_t *uname){
  if(hl<7 || memcmp(hdr,"Bearer ",7)) return AUTH_MISSING;
  const char *t=hdr+7; size_t tl=hl-7;
  const char *d1=memchr(t,'.',tl); if(!d1) return AUTH_INVALID;
  const char *d2=memchr(d1+1,'.',t+tl-d1-1); if(!d2) return AUTH_INVALID;
  if(memchr(d2+1,'.',t+tl-d2-1)) return AUTH_INVALID;
  uint8_t hb[512], pb[2048], sg[64]; size_t hn,pn,sn;
  if(b64url_dec(t,d1-t,hb,sizeof hb,&hn)) return AUTH_INVALID;
  jfield_t hf[1]={{"alg"}}; int isobj;
  if(jparse_obj((char*)hb,hn,hf,1,&isobj)||!isobj||hf[0].type!='s'||hf[0].e-hf[0].s!=7||memcmp(hf[0].s,"\"HS256\"",7)) return AUTH_INVALID;
  if(b64url_dec(d2+1,t+tl-d2-1,sg,sizeof sg,&sn)||sn!=32) return AUTH_INVALID;
  uint8_t mac[32]; hmac_sha256(&HK,t,d2-t,mac); uint8_t diff=0; for(int i=0;i<32;i++) diff|=mac[i]^sg[i]; if(diff) return AUTH_INVALID;
  if(b64url_dec(d1+1,d2-d1-1,pb,sizeof pb,&pn)) return AUTH_INVALID;
  jfield_t pf[4]={{"sub"},{"username"},{"exp"},{"nbf"}};
  if(jparse_obj((char*)pb,pn,pf,4,&isobj)||!isobj) return AUTH_INVALID;
  double now=(double)time(0), v;
  if(pf[2].type){ if(pf[2].type!='n'||jnum_val(pf[2].s,pf[2].e,&v)) return AUTH_INVALID; if(now>=v) return AUTH_INVALID; }
  if(pf[3].type){ if(pf[3].type!='n'||jnum_val(pf[3].s,pf[3].e,&v)) return AUTH_INVALID; if(now<v) return AUTH_INVALID; }
  if(pf[0].type!='s'||pf[1].type!='s') return AUTH_PAYLOAD;
  buf_t sb={0}; jp_t j={pf[0].s,pf[0].e}; if(jstring(&j,&sb)){ free(sb.p); return AUTH_PAYLOAD; }
  int64_t id=0; int ok=sb.n>0&&sb.n<=18; for(size_t i=0;ok&&i<sb.n;i++){ if(sb.p[i]<'0'||sb.p[i]>'9') ok=0; else id=id*10+(sb.p[i]-'0'); }
  free(sb.p); if(!ok||id<=0) return AUTH_PAYLOAD;
  uname->n=0; jp_t k={pf[1].s,pf[1].e}; if(jstring(&k,uname)) return AUTH_PAYLOAD;
  *uid=id; return 0;
}

/* ------------------------------------------------------------------ connections */
typedef struct conn { int fd; buf_t in, out; size_t in_off; int blocked; int closing; int in_flush; struct conn *next_flush; struct conn *lru_prev,*lru_next; time_t last; } conn_t;
static conn_t **conns; static int nconns_cap; static int epfd, lfd; static long live_conns;
static conn_t *flush_list;
static conn_t *lru_head,*lru_tail; /* least recently active at head */
static void lru_remove(conn_t *c){ if(c->lru_prev) c->lru_prev->lru_next=c->lru_next; else lru_head=c->lru_next; if(c->lru_next) c->lru_next->lru_prev=c->lru_prev; else lru_tail=c->lru_prev; c->lru_prev=c->lru_next=0; }
static void lru_touch(conn_t *c){ lru_remove(c); c->lru_prev=lru_tail; c->lru_next=0; if(lru_tail) lru_tail->lru_next=c; else lru_head=c; lru_tail=c; }
static void conn_close(conn_t *c){ lru_remove(c); epoll_ctl(epfd,EPOLL_CTL_DEL,c->fd,0); close(c->fd); conns[c->fd]=0; free(c->in.p); free(c->out.p); c->fd=-1; live_conns--;
  if(!c->in_flush) free(c); else c->closing=2; }
static void schedule_flush(conn_t *c){ if(!c->in_flush){ c->in_flush=1; c->next_flush=flush_list; flush_list=c; } }

static const char *status_line(int st){ switch(st){case 200:return "200 OK";case 201:return "201 Created";case 400:return "400 Bad Request";case 401:return "401 Unauthorized";case 404:return "404 Not Found";case 503:return "503 Service Unavailable";default:return "500 Internal Server Error";} }
static buf_t BODY; /* scratch body buffer */
static void respond(conn_t *c, int st, const char *body, size_t bl){
  buf_t *o=&c->out; buf_reserve(o,bl+128); PUTS(o,"HTTP/1.1 "); const char *sl=status_line(st); buf_put(o,sl,strlen(sl));
  PUTS(o,"\r\nContent-Type: application/json\r\nContent-Length: "); buf_int(o,(int64_t)bl); PUTS(o,"\r\n\r\n"); buf_put(o,body,bl); schedule_flush(c);
}
#define RESPOND_LIT(c,st,s) respond(c,st,s,sizeof(s)-1)
static void respond_err(conn_t *c, int st, const char *msg){ BODY.n=0; PUTS(&BODY,"{\"error\":\""); buf_put(&BODY,msg,strlen(msg)); PUTS(&BODY,"\"}"); respond(c,st,BODY.p,BODY.n); }

/* ------------------------------------------------------------------ group commit queue */
typedef struct { conn_t *c; int kind; int64_t uid; int64_t pid; buf_t text; buf_t uname; } wreq_t;
static wreq_t *wq; static int wq_n, wq_cap; 

static int parse_id(const char *s, size_t l, int64_t *id){ /* 0 ok, -1 invalid, 1 too large (treated as not found) */
  if(l==0) return -1; for(size_t i=0;i<l;i++) if(s[i]<'0'||s[i]>'9') return -1;
  size_t i=0; while(i<l-1 && s[i]=='0') i++;
  if(l-i>18) return 1; int64_t v=0; for(;i<l;i++) v=v*10+(s[i]-'0'); if(v<=0) return -1; *id=v; return 0; }

static void handle_get_post(conn_t *c, int64_t id){
  BODY.n=0; PUTS(&BODY,"{\"post\":"); int r=BT_FALLBACK;
  if(use_bt && bt_begin(&BT)==BT_OK) r=bt_render_post(&BODY,id);
  if(r==BT_FALLBACK){ if(use_bt) n_fallback++; BODY.n=0; PUTS(&BODY,"{\"post\":"); int s=sql_post(&BODY,id); r= s==0?BT_OK: s==1?BT_NOTFOUND: -1; }
  if(r==BT_OK){ PUTS(&BODY,"}"); respond(c,200,BODY.p,BODY.n); }
  else if(r==BT_NOTFOUND) respond_err(c,404,"post not found");
  else respond_err(c,500,"internal server error");
}
static void handle_feed(conn_t *c){
  BODY.n=0; int r=BT_FALLBACK;
  if(use_bt && bt_begin(&BT)==BT_OK) r=bt_feed(&BODY);
  if(r!=BT_OK){ if(use_bt) n_fallback++; BODY.n=0; if(sql_feed(&BODY)){ respond_err(c,500,"internal server error"); return; } }
  respond(c,200,BODY.p,BODY.n);
}
static void handle_health(conn_t *c){
  int rc=sqlite3_step(st_one); sqlite3_reset(st_one);
  if(rc==SQLITE_ROW){ BODY.n=0; PUTS(&BODY,"{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":"); buf_int(&BODY,(int64_t)(time(0)-start_time)); PUTS(&BODY,"}"); respond(c,200,BODY.p,BODY.n); }
  else { BODY.n=0; PUTS(&BODY,"{\"status\":\"degraded\",\"db\":\"unreachable\",\"error\":"); const char *m=sqlite3_errmsg(db); buf_jstr(&BODY,(const uint8_t*)m,strlen(m)); PUTS(&BODY,"}"); respond(c,503,BODY.p,BODY.n); }
}

static void wq_push(conn_t *c, int kind, int64_t uid, int64_t pid, const char *txt, size_t tl, buf_t *uname){
  if(wq_n==wq_cap){ wq_cap=wq_cap?wq_cap*2:64; wq=realloc(wq,sizeof(wreq_t)*wq_cap); }
  wreq_t *w=&wq[wq_n++]; memset(w,0,sizeof *w); w->c=c; w->kind=kind; w->uid=uid; w->pid=pid;
  if(txt) buf_put(&w->text,txt,tl); buf_put(&w->uname,uname->p,uname->n); c->blocked=1; schedule_flush(c); /* keeps c alive until the commit */
}

static void handle_create(conn_t *c, const char *hdr, size_t hl, const char *body, size_t bl){
  int64_t uid; buf_t un={0};
  int a = hdr? verify_jwt(hdr,hl,&uid,&un) : AUTH_MISSING;
  if(a){ free(un.p); respond_err(c,401, a==AUTH_MISSING?"missing bearer token": a==AUTH_INVALID?"invalid or expired token":"invalid token payload"); return; }
  jfield_t f[1]={{"body"}}; int isobj;
  if(jparse_obj(body,bl,f,1,&isobj)){ free(un.p); respond_err(c,400,"malformed JSON body"); return; }
  if(f[0].type!='s'){ free(un.p); respond_err(c,400,"body is required"); return; }
  buf_t t={0}; jp_t j={f[0].s,f[0].e}; jstring(&j,&t);
  size_t s=0,e=t.n; /* trim ASCII whitespace, and NBSP / BOM / line separators like String.prototype.trim */
  for(;;){ if(s<e && (t.p[s]==' '||(t.p[s]>=9&&t.p[s]<=13))){s++;continue;}
    if(e-s>=2 && (uint8_t)t.p[s]==0xc2 && (uint8_t)t.p[s+1]==0xa0){s+=2;continue;}
    if(e-s>=3 && (uint8_t)t.p[s]==0xef && (uint8_t)t.p[s+1]==0xbb && (uint8_t)t.p[s+2]==0xbf){s+=3;continue;}
    if(e-s>=3 && (uint8_t)t.p[s]==0xe2 && (uint8_t)t.p[s+1]==0x80 && ((uint8_t)t.p[s+2]==0xa8||(uint8_t)t.p[s+2]==0xa9)){s+=3;continue;} break; }
  for(;;){ if(e>s && (t.p[e-1]==' '||(t.p[e-1]>=9&&t.p[e-1]<=13))){e--;continue;}
    if(e-s>=2 && (uint8_t)t.p[e-2]==0xc2 && (uint8_t)t.p[e-1]==0xa0){e-=2;continue;}
    if(e-s>=3 && (uint8_t)t.p[e-3]==0xef && (uint8_t)t.p[e-2]==0xbb && (uint8_t)t.p[e-1]==0xbf){e-=3;continue;}
    if(e-s>=3 && (uint8_t)t.p[e-3]==0xe2 && (uint8_t)t.p[e-2]==0x80 && ((uint8_t)t.p[e-1]==0xa8||(uint8_t)t.p[e-1]==0xa9)){e-=3;continue;} break; }
  if(e==s){ free(t.p); free(un.p); respond_err(c,400,"body is required"); return; }
  size_t chars=0; for(size_t i=s;i<e;i++) if(((uint8_t)t.p[i]&0xc0)!=0x80) chars++;   /* code points, as SQLite length() */
  if(chars>500){ free(t.p); free(un.p); respond_err(c,400,"body must be at most 500 characters"); return; }
  wq_push(c,1,uid,0,t.p+s,e-s,&un); free(t.p); free(un.p);
}
static void handle_like(conn_t *c, const char *hdr, size_t hl, const char *ids, size_t idl){
  int64_t uid; buf_t un={0};
  int a = hdr? verify_jwt(hdr,hl,&uid,&un) : AUTH_MISSING;
  if(a){ free(un.p); respond_err(c,401, a==AUTH_MISSING?"missing bearer token": a==AUTH_INVALID?"invalid or expired token":"invalid token payload"); return; }
  int64_t pid; int r=parse_id(ids,idl,&pid);
  if(r<0){ free(un.p); respond_err(c,400,"invalid post id"); return; }
  if(r>0){ free(un.p); respond_err(c,404,"post not found"); return; }
  wq_push(c,2,uid,pid,0,0,&un); free(un.p);
}

/* Run every queued write in one transaction, then queue the responses. */
static void group_commit(void){
  if(!wq_n) return;
  int brc=sqlite3_step(st_begin); int ok = brc==SQLITE_DONE; if(!ok) fprintf(stderr,"BEGIN failed rc=%d %s autocommit=%d\n",brc,sqlite3_errmsg(db),sqlite3_get_autocommit(db)); sqlite3_reset(st_begin);
  int *res=calloc(wq_n,sizeof(int)); int64_t *rid=calloc(wq_n,sizeof(int64_t)); char (*cat)[32]=calloc(wq_n,32);
  for(int i=0;i<wq_n && ok;i++){ wreq_t *w=&wq[i];
    if(w->kind==1){
      sqlite3_bind_int64(st_ins_post,1,w->uid); sqlite3_bind_text(st_ins_post,2,w->text.p,(int)w->text.n,SQLITE_STATIC);
      int rc=sqlite3_step(st_ins_post);
      if(rc==SQLITE_ROW){ rid[i]=sqlite3_column_int64(st_ins_post,0); snprintf(cat[i],32,"%s",(const char*)sqlite3_column_text(st_ins_post,1)); rc=sqlite3_step(st_ins_post); }
      sqlite3_reset(st_ins_post); res[i]= rc==SQLITE_DONE?201:500;
    } else {
      sqlite3_bind_int64(st_exists,1,w->pid); int rc=sqlite3_step(st_exists); sqlite3_reset(st_exists);
      if(rc==SQLITE_DONE){ res[i]=404; continue; } if(rc!=SQLITE_ROW){ res[i]=500; continue; }
      sqlite3_bind_int64(st_ins_like,1,w->uid); sqlite3_bind_int64(st_ins_like,2,w->pid); rc=sqlite3_step(st_ins_like); sqlite3_reset(st_ins_like);
      res[i]= rc==SQLITE_DONE ? (sqlite3_changes(db)?201:200) : 500;
    }
  }
  if(ok){ int crc=sqlite3_step(st_commit); ok = crc==SQLITE_DONE; if(!ok) fprintf(stderr,"COMMIT failed rc=%d %s\n",crc,sqlite3_errmsg(db)); sqlite3_reset(st_commit); }
  if(!ok){ sqlite3_step(st_rollback); sqlite3_reset(st_rollback); fprintf(stderr,"group commit failed: %s\n",sqlite3_errmsg(db)); }
  for(int i=0;i<wq_n;i++){ wreq_t *w=&wq[i]; conn_t *c=w->c;
    if(c->fd>=0){
      int st= ok?res[i]:500;
      if(st==500) respond_err(c,500,"internal server error");
      else if(st==404) respond_err(c,404,"post not found");
      else if(w->kind==1){ BODY.n=0; PUTS(&BODY,"{\"post\":"); put_post(&BODY,rid[i],(uint8_t*)w->text.p,w->text.n,(uint8_t*)cat[i],strlen(cat[i]),(uint8_t*)w->uname.p,w->uname.n,0); PUTS(&BODY,"}"); respond(c,201,BODY.p,BODY.n); }
      else { BODY.n=0; PUTS(&BODY,"{\"liked\":true,\"already_liked\":"); if(st==200) PUTS(&BODY,"true"); else PUTS(&BODY,"false"); PUTS(&BODY,",\"post_id\":"); buf_int(&BODY,w->pid); PUTS(&BODY,"}"); respond(c,st,BODY.p,BODY.n); }
    }
    c->blocked=0; free(w->text.p); free(w->uname.p);
  }
  free(res); free(rid); free(cat); wq_n=0;
  if(use_bt) bt_refresh_sizes(&BT);
}

/* ------------------------------------------------------------------ HTTP parsing */
static int ieq(const char *a, size_t al, const char *b){ size_t bl=strlen(b); if(al!=bl) return 0; for(size_t i=0;i<al;i++){ char x=a[i]; if(x>='A'&&x<='Z') x+=32; if(x!=b[i]) return 0; } return 1; }
/* process as many complete requests as are buffered; returns -1 to close */
static int process_input(conn_t *c){
  while(!c->blocked && c->in.n > c->in_off){
    char *s=c->in.p+c->in_off; size_t avail=c->in.n-c->in_off;
    char *he = memmem(s,avail,"\r\n\r\n",4);
    if(!he){ if(avail>65536) return -1; return 0; }
    char *sp1=memchr(s,' ',he-s); if(!sp1) return -1; char *sp2=memchr(sp1+1,' ',he-sp1-1); if(!sp2) return -1;
    const char *method=s; size_t ml=sp1-s; const char *path=sp1+1; size_t pl=sp2-sp1-1;
    char *le=memchr(s,'\r',he-s+2);
    int http10 = (le-sp2-1==8 && !memcmp(sp2+1,"HTTP/1.0",8));
    size_t clen=0; const char *auth=0; size_t al=0; int conn_close_hdr=0, keep_alive_hdr=0;
    char *h=le+2;
    while(h<he){ char *e=memmem(h,he+2-h,"\r\n",2); if(!e) break; char *colon=memchr(h,':',e-h);
      if(colon){ const char *v=colon+1; while(v<e&&(*v==' '||*v=='\t')) v++; const char *ve=e; while(ve>v&&(ve[-1]==' '||ve[-1]=='\t')) ve--;
        size_t nl=colon-h;
        if(ieq(h,nl,"content-length")){ clen=0; for(const char *q=v;q<ve;q++){ if(*q<'0'||*q>'9') return -1; clen=clen*10+(*q-'0'); if(clen>1<<20) return -1; } }
        else if(ieq(h,nl,"authorization")){ auth=v; al=ve-v; }
        else if(ieq(h,nl,"connection")){ if(ieq(v,ve-v,"close")) conn_close_hdr=1; else if(ieq(v,ve-v,"keep-alive")) keep_alive_hdr=1; }
        else if(ieq(h,nl,"transfer-encoding")) return -1;   /* chunked request bodies unsupported */
      }
      h=e+2; }
    size_t hdrlen=he+4-s; if(avail<hdrlen+clen) return 0;
    const char *body=he+4;
    n_req++;
    /* route */
    const char *q=memchr(path,'?',pl); if(q) pl=q-path;
    int isget = ml==3&&!memcmp(method,"GET",3), ispost = ml==4&&!memcmp(method,"POST",4);
    if(isget && pl==5 && !memcmp(path,"/feed",5)) handle_feed(c);
    else if(isget && pl==7 && !memcmp(path,"/health",7)) handle_health(c);
    else if(pl>7 && !memcmp(path,"/posts/",7)){
      const char *ids=path+7; size_t idl=pl-7;
      if(idl>5 && !memcmp(ids+idl-5,"/like",5) && ispost){ handle_like(c,auth,al,ids,idl-5); }
      else if(isget && !memchr(ids,'/',idl)){ int64_t id; int r=parse_id(ids,idl,&id); if(r<0) respond_err(c,400,"invalid post id"); else if(r>0) respond_err(c,404,"post not found"); else handle_get_post(c,id); }
      else respond_err(c,404,"not found");
    }
    else if(ispost && pl==6 && !memcmp(path,"/posts",6)) handle_create(c,auth,al,body,clen);
    else respond_err(c,404,"not found");
    c->in_off += hdrlen+clen;
    if(conn_close_hdr || (http10 && !keep_alive_hdr)) c->closing=1;
    if(c->closing) break;
  }
  if(c->in_off==c->in.n){ c->in.n=0; c->in_off=0; if(c->in.cap>16384){ free(c->in.p); c->in.p=0; c->in.cap=0; } }
  return 0;
}

static void flush_conn(conn_t *c){
  c->in_flush=0;
  if(c->closing==2){ free(c); return; }
  while(c->out.n){ ssize_t w=send(c->fd,c->out.p,c->out.n,MSG_NOSIGNAL);
    if(w<0){ if(errno==EAGAIN){ struct epoll_event ev={.events=EPOLLIN|EPOLLOUT|EPOLLRDHUP,.data.ptr=c}; epoll_ctl(epfd,EPOLL_CTL_MOD,c->fd,&ev); return; } conn_close(c); return; }
    if((size_t)w<c->out.n){ memmove(c->out.p,c->out.p+w,c->out.n-w); c->out.n-=w; continue; }
    c->out.n=0; }
  if(c->out.cap>65536){ free(c->out.p); c->out.p=0; c->out.cap=0; }
  if(c->closing){ conn_close(c); return; }
}

static int max_conns;
static void accept_all(void){
  for(;;){ int fd=accept4(lfd,0,0,SOCK_NONBLOCK|SOCK_CLOEXEC);
    if(fd<0){ if(errno==EMFILE||errno==ENFILE){ /* evict the least recently active idle connection */
        conn_t *v=lru_head; while(v && (v->out.n||v->blocked||v->in.n)) v=v->lru_next; if(v){ conn_close(v); continue; } }
      return; }
    if(fd>=nconns_cap){ int nc=nconns_cap*2; while(fd>=nc) nc*=2; conns=realloc(conns,sizeof(conn_t*)*nc); memset(conns+nconns_cap,0,sizeof(conn_t*)*(nc-nconns_cap)); nconns_cap=nc; }
    int one=1; setsockopt(fd,IPPROTO_TCP,TCP_NODELAY,&one,sizeof one);
    conn_t *c=calloc(1,sizeof *c); c->fd=fd; conns[fd]=c; live_conns++; lru_touch(c);
    struct epoll_event ev={.events=EPOLLIN|EPOLLRDHUP,.data.ptr=c}; epoll_ctl(epfd,EPOLL_CTL_ADD,fd,&ev);
    if(max_conns && live_conns>max_conns){ conn_t *v=lru_head; while(v && v!=c && (v->out.n||v->blocked||v->in.n)) v=v->lru_next; if(v&&v!=c) conn_close(v); }
  }
}

static char RB[65536];
static void on_readable(conn_t *c){
  for(;;){
    ssize_t r=recv(c->fd,RB,sizeof RB,0);
    if(r>0){ buf_put(&c->in,RB,r); if((size_t)r<sizeof RB) break; continue; }
    if(r==0){ conn_close(c); return; }
    if(errno==EAGAIN) break; conn_close(c); return; }
  c->last=time(0); lru_touch(c);
  if(process_input(c)<0){ respond_err(c,400,"bad request"); c->closing=1; }
}

static sqlite3_stmt *prep(const char *q){ sqlite3_stmt *s; if(sqlite3_prepare_v3(db,q,-1,SQLITE_PREPARE_PERSISTENT,&s,0)!=SQLITE_OK){ fprintf(stderr,"prepare %s: %s\n",q,sqlite3_errmsg(db)); exit(1);} return s; }

static volatile sig_atomic_t want_stats;
static void on_usr1(int s){ want_stats=1; }
#ifndef NO_MAIN
int main(void){
  signal(SIGPIPE,SIG_IGN); signal(SIGUSR1,on_usr1);
  const char *path=getenv("SQLITE_PATH"), *secret=getenv("JWT_SECRET"), *host=getenv("HOST"), *port=getenv("PORT"), *rd=getenv("READER"), *mc=getenv("MAX_CONNS");
  if(!path||!secret){ fprintf(stderr,"SQLITE_PATH and JWT_SECRET required\n"); return 1; }
  if(!host) host="0.0.0.0"; if(!port) port="3000"; if(rd && !strcmp(rd,"sqlite")) use_bt=0; if(mc) max_conns=atoi(mc);
  struct rlimit rl; if(!getrlimit(RLIMIT_NOFILE,&rl)){ rl.rlim_cur=rl.rlim_max; setrlimit(RLIMIT_NOFILE,&rl); }
  hmac_init_key(&HK,(const uint8_t*)secret,strlen(secret)); start_time=time(0);
  if(sqlite3_open_v2(path,&db,SQLITE_OPEN_READWRITE|SQLITE_OPEN_NOMUTEX,0)!=SQLITE_OK){ fprintf(stderr,"open: %s\n",sqlite3_errmsg(db)); return 1; }
  sqlite3_exec(db,"PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA mmap_size=1073741824; PRAGMA cache_size=-65536; PRAGMA temp_store=MEMORY; PRAGMA busy_timeout=5000;",0,0,0);
  const char *POST_SQL="SELECT p.id, p.body, p.created_at, u.username, (SELECT count(*) FROM likes l WHERE l.post_id = p.id) FROM posts p JOIN users u ON u.id = p.user_id";
  char q[1024];
  snprintf(q,sizeof q,"%s ORDER BY p.created_at DESC, p.id DESC LIMIT 20",POST_SQL); st_feed=prep(q);
  snprintf(q,sizeof q,"%s WHERE p.id = ?",POST_SQL); st_post=prep(q);
  st_exists=prep("SELECT 1 FROM posts WHERE id = ?");
  st_ins_post=prep("INSERT INTO posts (user_id, body) VALUES (?, ?) RETURNING id, created_at");
  st_ins_like=prep("INSERT INTO likes (user_id, post_id) VALUES (?, ?) ON CONFLICT (user_id, post_id) DO NOTHING");
  st_one=prep("SELECT 1"); st_begin=prep("BEGIN IMMEDIATE"); st_commit=prep("COMMIT"); st_rollback=prep("ROLLBACK");
  /* make sure the -wal and -shm files exist and the wal-index is initialised before mapping them */
  { buf_t t={0}; sql_feed(&t); free(t.p); }
  if(use_bt && bt_open(&BT,path)){ fprintf(stderr,"btree reader unavailable, using SQLite for reads\n"); use_bt=0; }
  fprintf(stderr,"reader=%s\n",use_bt?"btree":"sqlite");

  lfd=socket(AF_INET,SOCK_STREAM|SOCK_NONBLOCK|SOCK_CLOEXEC,0); int one=1; setsockopt(lfd,SOL_SOCKET,SO_REUSEADDR,&one,sizeof one);
  struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(atoi(port))}; inet_pton(AF_INET,host,&a.sin_addr);
  if(bind(lfd,(void*)&a,sizeof a)||listen(lfd,65535)){ perror("bind/listen"); return 1; }
  epfd=epoll_create1(EPOLL_CLOEXEC); struct epoll_event ev={.events=EPOLLIN,.data.ptr=0}; epoll_ctl(epfd,EPOLL_CTL_ADD,lfd,&ev);
  nconns_cap=1024; conns=calloc(nconns_cap,sizeof(conn_t*));
  static struct epoll_event evs[1024];
  for(;;){
    int n=epoll_wait(epfd,evs,1024,-1);
    if(want_stats){ want_stats=0; fprintf(stderr,"stats: requests=%ld btree_fallbacks=%ld live_conns=%ld\n",n_req,n_fallback,live_conns); }
    if(n<0) continue;
    for(int i=0;i<n;i++){
      conn_t *c=evs[i].data.ptr;
      if(!c){ accept_all(); continue; }
      if(c->fd<0) continue;
      if(evs[i].events&EPOLLOUT){ struct epoll_event e2={.events=EPOLLIN|EPOLLRDHUP,.data.ptr=c}; epoll_ctl(epfd,EPOLL_CTL_MOD,c->fd,&e2); schedule_flush(c); }
      if(evs[i].events&(EPOLLIN|EPOLLRDHUP|EPOLLHUP|EPOLLERR)) on_readable(c);
    }
    if(wq_n){
      group_commit();
      /* writers may have pipelined more requests behind the write */
      for(conn_t *c=flush_list;c;c=c->next_flush) if(c->fd>=0 && c->in.n>c->in_off) process_input(c);
      if(wq_n) group_commit();
    }
    conn_t *f=flush_list; flush_list=0;
    while(f){ conn_t *nx=f->next_flush; if(f->closing==2){ free(f); } else flush_conn(f); f=nx; }
  }
}
#endif
