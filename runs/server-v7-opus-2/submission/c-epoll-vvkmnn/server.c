// $12 server challenge: single-threaded epoll HTTP/1.1 server in C over SQLite.
// One event loop thread does all HTTP + SQL; one background thread runs WAL checkpoints.
// Writes in one loop iteration are group-committed in one transaction before any response is sent.
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <openssl/hmac.h>
#include <openssl/sha.h>
#include <pthread.h>
#include <signal.h>
#include <sqlite3.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <sys/resource.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <sched.h>
#include <time.h>
#include <unistd.h>

#define MAXEV 1024
#define RBUF (64 * 1024)
#define MAXREQ (32 * 1024)
#define MAXPEND 4096

static int env_int(const char *k, int d) { const char *v = getenv(k); return v && *v ? atoi(v) : d; }

// ---------- per-connection state: kept tiny so idle connections cost ~nothing in user space ----------
typedef struct { char *in; uint32_t inlen; char *out; uint32_t outlen, outoff; uint8_t closing; } conn_t;
static conn_t *conns; static int nconns;

// ---------- output buffer (shared, per loop iteration) ----------
typedef struct { char *p; size_t len, cap; } buf_t;
static void bgrow(buf_t *b, size_t n) { if (b->len + n > b->cap) { while (b->len + n > b->cap) b->cap = b->cap ? b->cap * 2 : 65536; b->p = realloc(b->p, b->cap); } }
static inline void bput(buf_t *b, const char *s, size_t n) { bgrow(b, n); memcpy(b->p + b->len, s, n); b->len += n; }
static inline void bputs(buf_t *b, const char *s) { bput(b, s, strlen(s)); }
static inline void bint(buf_t *b, long long v) { char t[24]; int n = snprintf(t, sizeof t, "%lld", v); bput(b, t, n); }
static void bjstr(buf_t *b, const unsigned char *s, int n) {
  bgrow(b, (size_t)n * 6 + 2); char *o = b->p + b->len; *o++ = '"';
  for (int i = 0; i < n; i++) { unsigned char c = s[i];
    if (c == '"' || c == '\\') { *o++ = '\\'; *o++ = c; }
    else if (c < 0x20) { switch (c) { case '\n': *o++='\\';*o++='n'; break; case '\r': *o++='\\';*o++='r'; break; case '\t': *o++='\\';*o++='t'; break;
        default: o += sprintf(o, "\\u%04x", c); } }
    else *o++ = c; }
  *o++ = '"'; b->len = o - b->p;
}

// ---------- SQLite ----------
static sqlite3 *db; static const char *dbpath;
static sqlite3_stmt *st_feed, *st_post, *st_ins_post, *st_ins_like, *st_exists, *st_one, *st_user;
static int feed_by_id = 0;  // specialization switch, see PLAN.md (off: use the spec's ORDER BY)
static void die(const char *m) { fprintf(stderr, "fatal: %s: %s\n", m, db ? sqlite3_errmsg(db) : ""); exit(1); }
static sqlite3_stmt *prep(const char *sql) { sqlite3_stmt *s; if (sqlite3_prepare_v3(db, sql, -1, SQLITE_PREPARE_PERSISTENT, &s, 0)) die(sql); return s; }
#define POSTCOLS "SELECT p.id, p.body, p.created_at, u.username, (SELECT count(*) FROM likes l WHERE l.post_id = p.id) FROM posts p JOIN users u ON u.id = p.user_id "

static void *ckpt_thread(void *arg) {
  (void)arg; sqlite3 *c;
  if (sqlite3_open_v2(dbpath, &c, SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX, 0)) return 0;
  sqlite3_busy_timeout(c, 1000);
  for (;;) { sleep(1); int logn = 0, ck = 0; sqlite3_wal_checkpoint_v2(c, 0, SQLITE_CHECKPOINT_PASSIVE, &logn, &ck); }
}

static void db_open(int ckpt) {
  dbpath = getenv("SQLITE_PATH"); if (!dbpath) dbpath = "feed.db";
  if (sqlite3_open_v2(dbpath, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX, 0)) die("open");
  char sql[256]; snprintf(sql, sizeof sql, "PRAGMA mmap_size=%d", env_int("MMAP_MB", 1024) << 20);
  const char *pr[] = {"PRAGMA journal_mode=WAL", "PRAGMA synchronous=NORMAL", sql, "PRAGMA cache_size=-8192",
                      "PRAGMA temp_store=MEMORY", "PRAGMA wal_autocheckpoint=0", 0};
  for (int i = 0; pr[i]; i++) if (sqlite3_exec(db, pr[i], 0, 0, 0)) die(pr[i]);
  sqlite3_busy_timeout(db, 5000);
  st_feed = prep(feed_by_id ? POSTCOLS "ORDER BY p.id DESC LIMIT 20" : POSTCOLS "ORDER BY p.created_at DESC, p.id DESC LIMIT 20");
  st_post = prep(POSTCOLS "WHERE p.id = ?");
  st_ins_post = prep("INSERT INTO posts (user_id, body) VALUES (?, ?) RETURNING id, created_at");
  st_ins_like = prep("INSERT INTO likes (user_id, post_id) VALUES (?, ?) ON CONFLICT (user_id, post_id) DO NOTHING");
  st_exists = prep("SELECT 1 FROM posts WHERE id = ?");
  st_user = prep("SELECT 1 FROM users WHERE id = ?");
  st_one = prep("SELECT 1");
  if (ckpt && env_int("CKPT_THREAD", 1)) { pthread_t t; pthread_create(&t, 0, ckpt_thread, 0); }
  else if (!env_int("CKPT_THREAD", 1)) sqlite3_exec(db, "PRAGMA wal_autocheckpoint=1000", 0, 0, 0);
}

static void post_obj(buf_t *b, sqlite3_stmt *s) {
  bputs(b, "{\"id\":"); bint(b, sqlite3_column_int64(s, 0));
  bputs(b, ",\"body\":"); bjstr(b, sqlite3_column_text(s, 1), sqlite3_column_bytes(s, 1));
  bputs(b, ",\"created_at\":"); bjstr(b, sqlite3_column_text(s, 2), sqlite3_column_bytes(s, 2));
  bputs(b, ",\"author\":"); bjstr(b, sqlite3_column_text(s, 3), sqlite3_column_bytes(s, 3));
  bputs(b, ",\"like_count\":"); bint(b, sqlite3_column_int64(s, 4)); bputs(b, "}");
}

// ---------- JWT (HS256) ----------
static HMAC_CTX *hmac_base;
static int b64url_dec(const char *s, int n, unsigned char *out) {
  static signed char T[256]; static int init = 0;
  if (!init) { memset(T, -1, 256); const char *a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"; for (int i = 0; i < 64; i++) T[(unsigned char)a[i]] = i; init = 1; }
  int o = 0; unsigned v = 0, bits = 0;
  for (int i = 0; i < n; i++) { int d = T[(unsigned char)s[i]]; if (d < 0) return -1; v = (v << 6) | d; bits += 6; if (bits >= 8) { bits -= 8; out[o++] = (v >> bits) & 0xff; } }
  if (bits >= 6) return -1;
  return o;
}
// minimal JSON value scanner: returns pointer after value or NULL
static const char *jws(const char *p, const char *e) { while (p < e && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++; return p; }
static const char *jstr_end(const char *p, const char *e) { // p at opening quote; returns after closing quote
  p++; while (p < e) { if (*p == '\\') { p += 2; continue; } if (*p == '"') return p + 1; if ((unsigned char)*p < 0x20) return 0; p++; } return 0; }
static const char *jval(const char *p, const char *e, int depth) {
  p = jws(p, e); if (p >= e || depth > 32) return 0;
  if (*p == '"') return jstr_end(p, e);
  if (*p == '{' || *p == '[') { char close = *p == '{' ? '}' : ']'; int obj = *p == '{'; p = jws(p + 1, e);
    if (p < e && *p == close) return p + 1;
    for (;;) { if (obj) { p = jws(p, e); if (p >= e || *p != '"') return 0; p = jstr_end(p, e); if (!p) return 0; p = jws(p, e); if (p >= e || *p != ':') return 0; p++; }
      p = jval(p, e, depth + 1); if (!p) return 0; p = jws(p, e); if (p >= e) return 0;
      if (*p == ',') { p++; continue; } if (*p == close) return p + 1; return 0; } }
  if (*p == '-' || (*p >= '0' && *p <= '9')) { const char *s = p; if (*p == '-') p++; if (p >= e || !isdigit((unsigned char)*p)) return 0;
    if (*p == '0') p++; else while (p < e && isdigit((unsigned char)*p)) p++;
    if (p < e && *p == '.') { p++; if (p >= e || !isdigit((unsigned char)*p)) return 0; while (p < e && isdigit((unsigned char)*p)) p++; }
    if (p < e && (*p == 'e' || *p == 'E')) { p++; if (p < e && (*p == '+' || *p == '-')) p++; if (p >= e || !isdigit((unsigned char)*p)) return 0; while (p < e && isdigit((unsigned char)*p)) p++; }
    (void)s; return p; }
  if (e - p >= 4 && !memcmp(p, "true", 4)) return p + 4;
  if (e - p >= 5 && !memcmp(p, "false", 5)) return p + 5;
  if (e - p >= 4 && !memcmp(p, "null", 4)) return p + 4;
  return 0;
}
// find top-level key in a JSON object; sets *vs,*ve to value span. returns 1 found, 0 not found, -1 malformed
static int jget(const char *p, const char *e, const char *key, const char **vs, const char **ve) {
  int found = 0; size_t kl = strlen(key);
  p = jws(p, e); if (p >= e || *p != '{') return -1; p = jws(p + 1, e);
  if (p < e && *p == '}') { p++; goto tail; }
  for (;;) { p = jws(p, e); if (p >= e || *p != '"') return -1; const char *ks = p + 1; const char *ke = jstr_end(p, e); if (!ke) return -1;
    p = jws(ke, e); if (p >= e || *p != ':') return -1; p = jws(p + 1, e); const char *v = p; p = jval(p, e, 1); if (!p) return -1;
    if ((size_t)(ke - 1 - ks) == kl && !memcmp(ks, key, kl)) { *vs = v; *ve = p; found = 1; } // last wins (like JSON.parse)
    p = jws(p, e); if (p >= e) return -1; if (*p == ',') { p++; continue; } if (*p == '}') { p++; break; } return -1; }
tail: p = jws(p, e); if (p != e) return -1; return found;
}
// decode JSON string literal [s,e) (with quotes) into out (UTF-8). returns length or -1
static int junescape(const char *s, const char *e, char *out) {
  int o = 0; s++; e--;
  while (s < e) { unsigned char c = *s++;
    if (c != '\\') { out[o++] = c; continue; }
    if (s >= e) return -1; c = *s++;
    switch (c) { case '"': out[o++] = '"'; break; case '\\': out[o++] = '\\'; break; case '/': out[o++] = '/'; break;
      case 'b': out[o++] = 8; break; case 'f': out[o++] = 12; break; case 'n': out[o++] = 10; break; case 'r': out[o++] = 13; break; case 't': out[o++] = 9; break;
      case 'u': { if (e - s < 4) return -1; unsigned cp = 0; for (int i = 0; i < 4; i++) { char h = s[i]; cp <<= 4;
          if (h >= '0' && h <= '9') cp |= h - '0'; else if (h >= 'a' && h <= 'f') cp |= h - 'a' + 10; else if (h >= 'A' && h <= 'F') cp |= h - 'A' + 10; else return -1; }
        s += 4;
        if (cp >= 0xD800 && cp < 0xDC00 && e - s >= 6 && s[0] == '\\' && s[1] == 'u') { unsigned lo = 0; int okh = 1;
          for (int i = 0; i < 4; i++) { char h = s[2 + i]; lo <<= 4; if (h >= '0' && h <= '9') lo |= h - '0'; else if (h >= 'a' && h <= 'f') lo |= h - 'a' + 10; else if (h >= 'A' && h <= 'F') lo |= h - 'A' + 10; else okh = 0; }
          if (okh && lo >= 0xDC00 && lo < 0xE000) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); s += 6; } }
        if (cp >= 0xD800 && cp < 0xE000) cp = 0xFFFD;
        if (cp < 0x80) out[o++] = cp; else if (cp < 0x800) { out[o++] = 0xC0 | (cp >> 6); out[o++] = 0x80 | (cp & 63); }
        else if (cp < 0x10000) { out[o++] = 0xE0 | (cp >> 12); out[o++] = 0x80 | ((cp >> 6) & 63); out[o++] = 0x80 | (cp & 63); }
        else { out[o++] = 0xF0 | (cp >> 18); out[o++] = 0x80 | ((cp >> 12) & 63); out[o++] = 0x80 | ((cp >> 6) & 63); out[o++] = 0x80 | (cp & 63); }
        break; }
      default: return -1; } }
  return o;
}

// returns 0 ok (uid, uname filled), 1 missing bearer, 2 invalid, 3 bad payload
static int auth(const char *h, int hl, long long *uid, char *uname, int *unl) {
  if (!h || hl < 7 || memcmp(h, "Bearer ", 7)) return 1;
  const char *t = h + 7; int tl = hl - 7;
  const char *d1 = memchr(t, '.', tl); if (!d1) return 2;
  const char *d2 = memchr(d1 + 1, '.', t + tl - d1 - 1); if (!d2) return 2;
  if (memchr(d2 + 1, '.', t + tl - d2 - 1)) return 2;
  unsigned char sig[64]; int sl = b64url_dec(d2 + 1, t + tl - d2 - 1, sig); if (sl != 32) return 2;
  unsigned char mac[32]; unsigned ml = 32;
  HMAC_CTX *c = HMAC_CTX_new(); HMAC_CTX_copy(c, hmac_base);
  HMAC_Update(c, (const unsigned char *)t, d2 - t); HMAC_Final(c, mac, &ml); HMAC_CTX_free(c);
  if (CRYPTO_memcmp(mac, sig, 32)) return 2;
  char hd[512], pl[2048]; int hn = (d1 - t) * 3 / 4 + 3, pn = (d2 - d1 - 1) * 3 / 4 + 3;
  if (hn > (int)sizeof hd || pn > (int)sizeof pl) return 2;
  hn = b64url_dec(t, d1 - t, (unsigned char *)hd); pn = b64url_dec(d1 + 1, d2 - d1 - 1, (unsigned char *)pl);
  if (hn < 0 || pn < 0) return 2;
  const char *vs, *ve;
  if (jget(hd, hd + hn, "alg", &vs, &ve) != 1 || ve - vs != 7 || memcmp(vs, "\"HS256\"", 7)) return 2;
  int r = jget(pl, pl + pn, "exp", &vs, &ve); if (r < 0) return 2;
  if (r == 1) { if (*vs == '"' || *vs == '{' || *vs == '[' || *vs == 't' || *vs == 'f' || *vs == 'n') return 2;
    double exp = strtod(vs, 0); if ((double)time(0) >= exp) return 2; }
  if (jget(pl, pl + pn, "sub", &vs, &ve) != 1 || *vs != '"') return 3;
  long long id = 0; const char *q = vs + 1; if (q >= ve - 1 || *q == '0') return 3;
  for (; q < ve - 1; q++) { if (*q < '0' || *q > '9') return 3; id = id * 10 + (*q - '0'); if (id > (1LL << 53)) return 3; }
  if (jget(pl, pl + pn, "username", &vs, &ve) != 1 || *vs != '"') return 3;
  int n = junescape(vs, ve, uname); if (n < 0 || n > 1000) return 3;
  *uid = id; *unl = n; return 0;
}

// ---------- HTTP ----------
static time_t start_time;
static buf_t body, out;
static int coalesce = 0;           // switch: share one feed read among requests served in the same loop iteration (OFF: rule 5 risk)
static size_t feed_cache_len; static int feed_valid; // valid only within one iteration, invalidated by any write

static const char *status_line(int s) {
  switch (s) { case 200: return "HTTP/1.1 200 OK\r\n"; case 201: return "HTTP/1.1 201 Created\r\n"; case 400: return "HTTP/1.1 400 Bad Request\r\n";
    case 401: return "HTTP/1.1 401 Unauthorized\r\n"; case 404: return "HTTP/1.1 404 Not Found\r\n"; case 503: return "HTTP/1.1 503 Service Unavailable\r\n";
    default: return "HTTP/1.1 500 Internal Server Error\r\n"; } }
static void frame(buf_t *o, int status, const char *b, size_t bl, int close_) {
  bputs(o, status_line(status)); bputs(o, "Content-Type: application/json\r\nContent-Length: "); bint(o, bl);
  if (close_) bputs(o, "\r\nConnection: close"); bput(o, "\r\n\r\n", 4); bput(o, b, bl);
}
static void err(const char *msg) { body.len = 0; bputs(&body, "{\"error\":\""); bputs(&body, msg); bputs(&body, "\"}"); }

static int parse_id(const char *s, int n, long long *id) {
  if (n <= 0 || n > 16) return 0;
  long long v = 0;
  for (int i = 0; i < n; i++) { if (s[i] < '0' || s[i] > '9') return 0; v = v * 10 + (s[i] - '0'); }
  if (v <= 0) return 0;
  *id = v; return 1;
}
static int utf8_len(const char *s, int n) { int c = 0; for (int i = 0; i < n; i++) if (((unsigned char)s[i] & 0xC0) != 0x80) c++; return c; }

static buf_t feedbuf;
static void do_feed(void) {
  if (coalesce && feed_valid) { body.len = 0; bput(&body, feedbuf.p, feed_cache_len); return; }
  body.len = 0; bputs(&body, "{\"posts\":[");
  int first = 1, rc;
  while ((rc = sqlite3_step(st_feed)) == SQLITE_ROW) { if (!first) bputs(&body, ","); first = 0; post_obj(&body, st_feed); }
  sqlite3_reset(st_feed);
  if (rc != SQLITE_DONE) { err("internal server error"); return; }
  bputs(&body, "]}");
  if (coalesce) { feedbuf.len = 0; bput(&feedbuf, body.p, body.len); feed_cache_len = body.len; feed_valid = 1; }
}
static int do_post(long long id) {
  sqlite3_bind_int64(st_post, 1, id); int rc = sqlite3_step(st_post); body.len = 0;
  if (rc == SQLITE_ROW) { bputs(&body, "{\"post\":"); post_obj(&body, st_post); bputs(&body, "}"); sqlite3_reset(st_post); return 200; }
  sqlite3_reset(st_post);
  if (rc == SQLITE_DONE) { err("post not found"); return 404; }
  err("internal server error"); return 500;
}

// A deferred write: validated and authenticated already; executed at the end of the loop iteration
// inside one short BEGIN IMMEDIATE..COMMIT (group commit), and answered only after COMMIT returns.
typedef struct { int fd; int kind; int close_; long long uid, pid; char *text; int tl; char *uname; int unl; int status; char *resp; int rl; } pend_t;
static pend_t pend[MAXPEND]; static int npend;

static int exec_write(pend_t *p) {
  body.len = 0;
  if (p->kind == 1) {
    sqlite3_bind_int64(st_ins_post, 1, p->uid); sqlite3_bind_text(st_ins_post, 2, p->text, p->tl, SQLITE_STATIC);
    int rc = sqlite3_step(st_ins_post);
    if (rc != SQLITE_ROW) { sqlite3_reset(st_ins_post); err("internal server error"); return 500; }
    bputs(&body, "{\"post\":{\"id\":"); bint(&body, sqlite3_column_int64(st_ins_post, 0));
    bputs(&body, ",\"body\":"); bjstr(&body, (const unsigned char *)p->text, p->tl);
    bputs(&body, ",\"created_at\":"); bjstr(&body, sqlite3_column_text(st_ins_post, 1), sqlite3_column_bytes(st_ins_post, 1));
    bputs(&body, ",\"author\":"); bjstr(&body, (const unsigned char *)p->uname, p->unl); bputs(&body, ",\"like_count\":0}}");
    rc = sqlite3_step(st_ins_post); sqlite3_reset(st_ins_post);
    if (rc != SQLITE_DONE) { err("internal server error"); return 500; }
    return 201;
  }
  sqlite3_bind_int64(st_exists, 1, p->pid); int rc = sqlite3_step(st_exists); sqlite3_reset(st_exists);
  if (rc == SQLITE_DONE) { err("post not found"); return 404; }
  if (rc != SQLITE_ROW) { err("internal server error"); return 500; }
  sqlite3_bind_int64(st_ins_like, 1, p->uid); sqlite3_bind_int64(st_ins_like, 2, p->pid);
  rc = sqlite3_step(st_ins_like); sqlite3_reset(st_ins_like);
  if (rc != SQLITE_DONE) { err("internal server error"); return 500; }
  int ch = sqlite3_changes(db);
  bputs(&body, "{\"liked\":true,\"already_liked\":"); bputs(&body, ch ? "false" : "true"); bputs(&body, ",\"post_id\":"); bint(&body, p->pid); bputs(&body, "}");
  return ch ? 201 : 200;
}

// returns status (>0) with body filled, or 0 when deferred into pend[]
static int handle(int fd, const char *m, int ml, const char *path, int pl, const char *authh, int al, const char *rb, int rbl, int close_) {
  if (ml == 3 && !memcmp(m, "GET", 3)) {
    if (pl == 5 && !memcmp(path, "/feed", 5)) { do_feed(); return body.p[2] == 'e' ? 500 : 200; }
    if (pl > 7 && !memcmp(path, "/posts/", 7)) { long long id; if (!parse_id(path + 7, pl - 7, &id)) { err("invalid post id"); return 400; } return do_post(id); }
    if (pl == 7 && !memcmp(path, "/health", 7)) {
      int rc = sqlite3_step(st_one); sqlite3_reset(st_one); body.len = 0;
      if (rc == SQLITE_ROW) { bputs(&body, "{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":"); bint(&body, (long long)(time(0) - start_time)); bputs(&body, "}"); return 200; }
      bputs(&body, "{\"status\":\"degraded\",\"db\":\"unreachable\",\"error\":"); const char *e = sqlite3_errmsg(db); bjstr(&body, (const unsigned char *)e, strlen(e)); bputs(&body, "}"); return 503;
    }
    err("not found"); return 404;
  }
  if (ml == 4 && !memcmp(m, "POST", 4)) {
    int kind = 0; const char *idp = 0; int idl = 0;
    if (pl == 6 && !memcmp(path, "/posts", 6)) kind = 1;
    else if (pl > 12 && !memcmp(path, "/posts/", 7) && !memcmp(path + pl - 5, "/like", 5)) { kind = 2; idp = path + 7; idl = pl - 12; }
    if (!kind) { err("not found"); return 404; }
    long long uid; char uname[1024]; int unl;
    int a = auth(authh, al, &uid, uname, &unl);
    if (a == 1) { err("missing bearer token"); return 401; }
    if (a == 2) { err("invalid or expired token"); return 401; }
    if (a == 3) { err("invalid token payload"); return 401; }
    pend_t p = {.fd = fd, .kind = kind, .uid = uid, .close_ = close_};
    if (kind == 2) { if (!parse_id(idp, idl, &p.pid)) { err("invalid post id"); return 400; } }
    else {
      const char *vs, *ve; int r = jget(rb, rb + rbl, "body", &vs, &ve);
      if (r < 0) { const char *q = jval(rb, rb + rbl, 0); if (!q || jws(q, rb + rbl) != rb + rbl) { err("malformed JSON body"); return 400; } r = 0; }
      if (r == 0 || *vs != '"') { err("body is required"); return 400; }
      char *text = malloc(ve - vs + 4); int tl = junescape(vs, ve, text);
      if (tl < 0) { free(text); err("malformed JSON body"); return 400; }
      char *s = text, *e = text + tl;
      while (s < e && (*s == ' ' || *s == '\t' || *s == '\n' || *s == '\r' || *s == '\f' || *s == '\v')) s++;
      while (e > s && (e[-1] == ' ' || e[-1] == '\t' || e[-1] == '\n' || e[-1] == '\r' || e[-1] == '\f' || e[-1] == '\v')) e--;
      if (s == e) { free(text); err("body is required"); return 400; }
      if (utf8_len(s, e - s) > 500) { free(text); err("body must be at most 500 characters"); return 400; }
      memmove(text, s, e - s); p.text = text; p.tl = e - s;
      p.uname = malloc(unl + 1); memcpy(p.uname, uname, unl); p.unl = unl;
    }
    pend[npend++] = p;
    return 0;
  }
  err("not found"); return 404;
}

static int ep;
static void conn_close(int fd) { conn_t *c = &conns[fd]; free(c->in); free(c->out); memset(c, 0, sizeof *c); close(fd); }

static void flush_out(int fd, const char *p, size_t n) {
  conn_t *c = &conns[fd];
  if (c->closing == 2 || !n) return;
  if (c->outlen) { c->out = realloc(c->out, c->outlen + n); memcpy(c->out + c->outlen, p, n); c->outlen += n; return; }
  ssize_t w = send(fd, p, n, MSG_NOSIGNAL);
  if (w < 0) { if (errno != EAGAIN) { c->closing = 2; return; } w = 0; }
  if ((size_t)w < n) { c->out = malloc(n - w); memcpy(c->out, p + w, n - w); c->outlen = n - w; c->outoff = 0;
    struct epoll_event ev = {.events = EPOLLIN | EPOLLOUT | EPOLLRDHUP, .data.fd = fd}; epoll_ctl(ep, EPOLL_CTL_MOD, fd, &ev); }
}
static int ci_eq(const char *a, const char *b, int n) { for (int i = 0; i < n; i++) if (tolower((unsigned char)a[i]) != b[i]) return 0; return 1; }

// Parse and answer complete requests in [buf,len) into `out`. Stops after a deferred write (so later
// pipelined requests on this connection observe it). Returns bytes consumed or -1 (protocol error).
static int process(int fd, char *buf, int len, int *deferred) {
  int off = 0; *deferred = 0;
  while (off < len) {
    char *s = buf + off; int rem = len - off;
    char *he = memmem(s, rem, "\r\n\r\n", 4);
    if (!he) { if (rem > MAXREQ) return -1; break; }
    int hlen = he - s + 4;
    char *le = memchr(s, '\r', hlen);
    char *sp1 = memchr(s, ' ', le - s); if (!sp1) return -1;
    char *sp2 = memchr(sp1 + 1, ' ', le - sp1 - 1); if (!sp2) return -1;
    const char *path = sp1 + 1; int pl = sp2 - path;
    const char *qm = memchr(path, '?', pl); if (qm) pl = qm - path;
    int close_ = (le - sp2 - 1 == 8 && !memcmp(sp2 + 1, "HTTP/1.0", 8));
    long clen = 0; const char *authh = 0; int al = 0;
    for (char *h = le + 2; h < he; ) {
      char *e = memmem(h, he + 2 - h, "\r\n", 2); if (!e) break;
      char *col = memchr(h, ':', e - h);
      if (col) { int kl = col - h; char *v = col + 1; while (v < e && (*v == ' ' || *v == '\t')) v++; int vl = e - v; while (vl > 0 && (v[vl-1]==' '||v[vl-1]=='\t')) vl--;
        if (kl == 14 && ci_eq(h, "content-length", 14)) clen = strtol(v, 0, 10);
        else if (kl == 13 && ci_eq(h, "authorization", 13)) { authh = v; al = vl; }
        else if (kl == 10 && ci_eq(h, "connection", 10)) { if (vl == 5 && ci_eq(v, "close", 5)) close_ = 1; else if (vl == 10 && ci_eq(v, "keep-alive", 10)) close_ = 0; } }
      h = e + 2; }
    if (clen < 0 || clen > MAXREQ) return -1;
    if (rem < hlen + clen) { if (hlen + clen > MAXREQ) return -1; break; }
    int st = handle(fd, s, sp1 - s, path, pl, authh, al, he + 4, clen, close_);
    off += hlen + clen;
    if (!st) { *deferred = 1; break; }
    frame(&out, st, body.p, body.len, close_);
    if (close_) { conns[fd].closing = 1; break; }
  }
  return off;
}

// Output of this iteration, per connection, in order: seg = [reads answered now] + optional deferred write.
typedef struct { int fd; size_t start, end; int pidx; } seg_t;
static seg_t segs[MAXEV * 2]; static int nsegs;
static int redo[MAXEV * 2]; static int nredo;

static void consume(int fd, char *buf, int have, int fromrbuf) {
  conn_t *c = &conns[fd];
  size_t st = out.len; int p0 = npend, deferred;
  int used = process(fd, buf, have, &deferred);
  if (used < 0) { out.len = st; c->closing = 2; return; }
  if (out.len > st || npend > p0) segs[nsegs++] = (seg_t){fd, st, out.len, npend > p0 ? p0 : -1};
  int left = have - used;
  if (left) { if (fromrbuf || !c->in) { char *n = malloc(MAXREQ + 4096); memmove(n, buf + used, left); if (c->in) free(c->in); c->in = n; } else memmove(c->in, buf + used, left); c->inlen = left; }
  else if (c->in) { free(c->in); c->in = 0; c->inlen = 0; }
  if (deferred && left) redo[nredo++] = fd;
}

static void on_readable(int fd) {
  conn_t *c = &conns[fd];
  static char rbuf[RBUF];
  for (int loops = 0; loops < 4; loops++) {
    char *buf = c->in ? c->in : rbuf; int have = c->in ? (int)c->inlen : 0;
    int room = (c->in ? MAXREQ + 4096 : RBUF) - have;
    ssize_t r = recv(fd, buf + have, room, 0);
    if (r == 0) { c->closing = 2; return; }
    if (r < 0) { if (errno != EAGAIN && errno != EINTR) c->closing = 2; return; }
    consume(fd, buf, have + r, !c->in);
    if (c->closing || r < room) return;
    if (nsegs >= MAXEV) return;
  }
}

static int busy_cb(void *a, int n) { (void)a; if (n > 200000) return 0; if (n < 1000) sched_yield(); else usleep(100); return 1; }

static void finish_iteration(void) {
  for (;;) {
    if (npend) {
      int ok = sqlite3_exec(db, "BEGIN IMMEDIATE", 0, 0, 0) == SQLITE_OK;
      for (int i = 0; i < npend; i++) { pend_t *p = &pend[i];
        if (ok) p->status = exec_write(p); else { err("internal server error"); p->status = 500; }
        p->resp = malloc(body.len); memcpy(p->resp, body.p, body.len); p->rl = body.len; }
      if (ok && sqlite3_exec(db, "COMMIT", 0, 0, 0) != SQLITE_OK) {
        sqlite3_exec(db, "ROLLBACK", 0, 0, 0);
        for (int i = 0; i < npend; i++) { pend_t *p = &pend[i]; free(p->resp); p->resp = strdup("{\"error\":\"internal server error\"}"); p->rl = strlen(p->resp); p->status = 500; } }
      feed_valid = 0;
    }
    static buf_t tmp;
    for (int i = 0; i < nsegs; i++) {
      seg_t *g = &segs[i];
      if (g->pidx < 0) { flush_out(g->fd, out.p + g->start, g->end - g->start); continue; }
      pend_t *p = &pend[g->pidx]; tmp.len = 0;
      bput(&tmp, out.p + g->start, g->end - g->start);
      frame(&tmp, p->status, p->resp, p->rl, p->close_);
      if (p->close_) conns[g->fd].closing = 1;
      flush_out(g->fd, tmp.p, tmp.len);
    }
    for (int i = 0; i < npend; i++) { free(pend[i].text); free(pend[i].uname); free(pend[i].resp); }
    for (int i = 0; i < nsegs; i++) { int fd = segs[i].fd; if (conns[fd].closing && !conns[fd].outlen && conns[fd].closing != 3) { conn_close(fd); } }
    nsegs = 0; npend = 0; out.len = 0;
    if (!nredo) break;
    int n = nredo; int r2[MAXEV * 2]; memcpy(r2, redo, n * sizeof(int)); nredo = 0;
    for (int i = 0; i < n; i++) { conn_t *c = &conns[r2[i]]; if (c->in && !c->closing) consume(r2[i], c->in, c->inlen, 0); }
  }
  feed_valid = 0;
}

static void worker(int id, int nworkers) {
  struct rlimit rl; getrlimit(RLIMIT_NOFILE, &rl); rl.rlim_cur = rl.rlim_max; setrlimit(RLIMIT_NOFILE, &rl);
  db_open(id == 0);
  sqlite3_busy_handler(db, busy_cb, 0);
  nconns = rl.rlim_cur > (1 << 20) ? (1 << 20) : (int)rl.rlim_cur; conns = calloc(nconns, sizeof(conn_t));
  const char *host = getenv("HOST"); if (!host) host = "127.0.0.1";
  int port = env_int("PORT", 3000);
  int ls = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0); int one = 1;
  setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  if (nworkers > 1) setsockopt(ls, SOL_SOCKET, SO_REUSEPORT, &one, sizeof one);
  struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(port)}; inet_pton(AF_INET, host, &a.sin_addr);
  if (bind(ls, (void *)&a, sizeof a) || listen(ls, 65535)) { perror("bind/listen"); exit(1); }
  ep = epoll_create1(0);
  struct epoll_event ev = {.events = EPOLLIN | EPOLLEXCLUSIVE, .data.fd = ls}; epoll_ctl(ep, EPOLL_CTL_ADD, ls, &ev);
  struct epoll_event evs[MAXEV];
  if (id == 0) fprintf(stderr, "listening on %s:%d with %d worker(s), fd limit %d\n", host, port, nworkers, nconns);
  for (;;) {
    int n = epoll_wait(ep, evs, MAXEV, -1);
    for (int i = 0; i < n; i++) {
      int fd = evs[i].data.fd;
      if (fd == ls) {
        for (;;) { int c = accept4(ls, 0, 0, SOCK_NONBLOCK); if (c < 0) break;
          if (c >= nconns) { close(c); continue; }
          setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
          struct epoll_event e2 = {.events = EPOLLIN | EPOLLRDHUP, .data.fd = c}; epoll_ctl(ep, EPOLL_CTL_ADD, c, &e2); }
        continue;
      }
      conn_t *c = &conns[fd];
      if (evs[i].events & EPOLLOUT) {
        while (c->outlen) { ssize_t w = send(fd, c->out + c->outoff, c->outlen - c->outoff, MSG_NOSIGNAL);
          if (w < 0) { if (errno == EAGAIN) break; c->closing = 2; break; }
          c->outoff += w; if (c->outoff == c->outlen) { free(c->out); c->out = 0; c->outlen = c->outoff = 0;
            struct epoll_event e2 = {.events = EPOLLIN | EPOLLRDHUP, .data.fd = fd}; epoll_ctl(ep, EPOLL_CTL_MOD, fd, &e2); } }
        if (c->closing && !c->outlen) { c->closing = 3; }
      }
      if (c->closing != 3 && (evs[i].events & (EPOLLIN | EPOLLERR | EPOLLHUP | EPOLLRDHUP))) {
        if (nsegs >= MAXEV || npend >= MAXPEND - 64) finish_iteration();
        int had = nsegs;
        on_readable(fd);
        if (c->closing == 2) { for (int k = had; k < nsegs; k++) if (segs[k].fd == fd) segs[k].end = segs[k].start; }
        if (c->closing && nsegs == had && !c->outlen) c->closing = 3;
      }
      if (c->closing == 3) { // close now unless a segment in this iteration still refers to it
        int ref = 0; for (int k = 0; k < nsegs; k++) if (segs[k].fd == fd) { ref = 1; break; }
        if (ref) c->closing = 2; else conn_close(fd);
      }
    }
    finish_iteration();
  }
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  start_time = time(0);
  feed_by_id = env_int("FEED_BY_ID", 0);
  coalesce = env_int("COALESCE_FEED", 0);
  const char *secret = getenv("JWT_SECRET"); if (!secret) secret = "";
  hmac_base = HMAC_CTX_new(); HMAC_Init_ex(hmac_base, secret, strlen(secret), EVP_sha256(), 0);
  int nw = env_int("WORKERS", 8); if (nw < 1) nw = 1;
  if (nw == 1) { worker(0, 1); return 0; }
  pid_t *pids = calloc(nw, sizeof(pid_t));
  for (int i = 0; i < nw; i++) { pid_t p = fork(); if (p == 0) { prctl(PR_SET_PDEATHSIG, SIGTERM); worker(i, nw); _exit(0); } pids[i] = p; }
  for (;;) { int st; pid_t p = wait(&st); if (p < 0) { if (errno == EINTR) continue; return 1; }
    for (int i = 0; i < nw; i++) if (pids[i] == p) { fprintf(stderr, "worker %d exited (%d), restarting\n", i, st);
        pid_t q = fork(); if (q == 0) { prctl(PR_SET_PDEATHSIG, SIGTERM); worker(i, nw); _exit(0); } pids[i] = q; } }
}
