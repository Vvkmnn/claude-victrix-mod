/* Differential test: B-tree reader vs SQLite reference queries, across many committed write
 * batches (crossing wal-index hash blocks, auto-checkpoints and WAL restarts).
 * usage: difftest <copy-of-feed.db> <rounds> */
#define NO_MAIN
#include "../src/server.c"
static int cmp_post(int64_t id){
  buf_t a={0},b={0}; int ra=BT_FALLBACK; if(bt_begin(&BT)==BT_OK) ra=bt_render_post(&a,id);
  int rb=sql_post(&b,id); int ok;
  if(ra==BT_FALLBACK){ n_fallback++; ok=1; } else if(rb==1) ok=(ra==BT_NOTFOUND); else ok=(ra==BT_OK && a.n==b.n && !memcmp(a.p,b.p,a.n));
  if(!ok) fprintf(stderr,"MISMATCH post %lld: bt(%d)=%.*s\n sql(%d)=%.*s\n",(long long)id,ra,(int)a.n,a.p,rb,(int)b.n,b.p);
  free(a.p); free(b.p); return ok; }
static int cmp_feed(void){
  buf_t a={0},b={0}; int ra=BT_FALLBACK; if(bt_begin(&BT)==BT_OK) ra=bt_feed(&a); sql_feed(&b);
  int ok = ra==BT_FALLBACK ? (n_fallback++,1) : (a.n==b.n && !memcmp(a.p,b.p,a.n));
  if(!ok) fprintf(stderr,"MISMATCH feed\n"); free(a.p); free(b.p); return ok; }
static void ref_jstr(buf_t *b,const uint8_t*s,size_t l){ PUTS(b,"\""); for(size_t i=0;i<l;i++){uint8_t c=s[i]; char t[8];
  if(c=='"') PUTS(b,"\\\""); else if(c=='\\') PUTS(b,"\\\\"); else if(c=='\b') PUTS(b,"\\b"); else if(c=='\f') PUTS(b,"\\f"); else if(c=='\n') PUTS(b,"\\n"); else if(c=='\r') PUTS(b,"\\r"); else if(c=='\t') PUTS(b,"\\t");
  else if(c<0x20){ snprintf(t,8,"\\u%04x",c); buf_put(b,t,6);} else buf_put(b,&c,1);} PUTS(b,"\""); }
int main(int argc,char**argv){
  { uint8_t s[600]; for(int t=0;t<300000;t++){ int l=rand()%300; int mode=rand()%3; for(int i=0;i<l;i++) s[i]= mode==0? rand()%256 : mode==1? 32+rand()%95 : "a\"\\\x01\x1f\x7f\x80 "[rand()%9];
      buf_t a={0},b={0}; buf_jstr(&a,s,l); ref_jstr(&b,s,l); if(a.n!=b.n||memcmp(a.p,b.p,a.n)){ fprintf(stderr,"JSTR MISMATCH len %d\n",l); return 1; } free(a.p); free(b.p);} fprintf(stderr,"jstr ok\n"); }
  const char *path=argv[1]; int rounds=atoi(argv[2]); srand(12345);
  sqlite3_open_v2(path,&db,SQLITE_OPEN_READWRITE,0);
  sqlite3_exec(db,"PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA mmap_size=1073741824;",0,0,0);
  const char *POST_SQL="SELECT p.id, p.body, p.created_at, u.username, (SELECT count(*) FROM likes l WHERE l.post_id = p.id) FROM posts p JOIN users u ON u.id = p.user_id";
  char q[1024]; snprintf(q,sizeof q,"%s ORDER BY p.created_at DESC, p.id DESC LIMIT 20",POST_SQL); st_feed=prep(q);
  snprintf(q,sizeof q,"%s WHERE p.id = ?",POST_SQL); st_post=prep(q);
  { buf_t t={0}; sql_feed(&t); free(t.p); }
  if(argc>3) sqlite3_exec(db,"PRAGMA wal_autocheckpoint=0",0,0,0);
  if(bt_open(&BT,path)){ fprintf(stderr,"bt_open failed\n"); return 1; }
  long bad=0, checks=0;
  if(rounds==0){ /* full scan of every seeded id plus the feed */
    for(int64_t id=0; id<=500005; id++){ bad+=!cmp_post(id); checks++; }
    bad+=!cmp_feed(); checks++;
  }
  int64_t maxid=500000;
  for(int r=0;r<rounds;r++){
    sqlite3_exec(db,"BEGIN",0,0,0);
    int nw=1+rand()%40;
    for(int k=0;k<nw;k++){ char sql[700];
      if(rand()%4==0){ int L=1+rand()%400; char body[501]; for(int i=0;i<L;i++) body[i]="abc \"\\\n\tx\x01y/<>&"[rand()%16]; body[L]=0;
        sqlite3_stmt *s; sqlite3_prepare_v2(db,"INSERT INTO posts(user_id,body) VALUES(?,?)",-1,&s,0); sqlite3_bind_int(s,1,1+rand()%50000); sqlite3_bind_text(s,2,body,L,SQLITE_STATIC); sqlite3_step(s); sqlite3_finalize(s); maxid=sqlite3_last_insert_rowid(db); }
      else { int64_t pid = rand()%3? maxid-rand()%50 : 1+rand()%maxid; snprintf(sql,sizeof sql,"INSERT INTO likes(user_id,post_id) VALUES(%d,%lld) ON CONFLICT DO NOTHING",1+rand()%50000,(long long)pid); sqlite3_exec(db,sql,0,0,0); }
    }
    sqlite3_exec(db,"COMMIT",0,0,0); bt_refresh_sizes(&BT);
    bad+=!cmp_feed(); checks++;
    for(int k=0;k<20;k++){ int64_t id = k<10? maxid-rand()%100 : rand()%(maxid+10); bad+=!cmp_post(id); checks++; }
    if(r%5000==0){ uint32_t mx; memcpy(&mx,BT.shm+16,4); fprintf(stderr,"round %d mxFrame=%u fallbacks=%ld bad=%ld\n",r,mx,n_fallback,bad); }
  }
  printf("checks=%ld mismatches=%ld fallbacks=%ld\n",checks,bad,n_fallback); return bad!=0;
}
