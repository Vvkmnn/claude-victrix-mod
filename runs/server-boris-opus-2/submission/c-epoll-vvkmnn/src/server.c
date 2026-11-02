/* $12 server challenge: single-threaded epoll HTTP/1.1 server in C on SQLite.
 *
 * - One event-loop thread owns the only read/write SQLite connection (prepared statements, mmap).
 * - Writes from one loop iteration are group-committed in one transaction; each 201/200 is sent
 *   only after COMMIT returns (WAL, synchronous=NORMAL).
 * - A background thread with its own connection runs WAL checkpoints so fsyncs never block the loop.
 * - Direct mode: holds up to RLIMIT_NOFILE connections; when full, closes least-recently-used idle ones.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <pthread.h>
#include <signal.h>
#include <sqlite3.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <sched.h>
#include <time.h>
#include <unistd.h>
#include "sha256.h"
#include "json.h"

#define likely(x) __builtin_expect(!!(x), 1)
#define unlikely(x) __builtin_expect(!!(x), 0)

/* ------------------------------------------------------------------ globals */
static sqlite3 *db;
static sqlite3_stmt *st_feed_rows, *st_cnt_range, *st_cnt_one, *st_rbegin, *st_rcommit, *st_post, *st_health, *st_ins_post, *st_ins_like, *st_exists, *st_begin, *st_commit, *st_rollback;
static hmac_key jwt_key;
static time_t start_time;
static const char *db_path;
static int epfd, lfd;
static long max_conns;

#define IBUF_SZ (256 * 1024)
#define OBUF_SZ (1024 * 1024)
#define MAX_HDR (16 * 1024)
#define MAX_BODY (1024 * 1024)
static char ibuf[IBUF_SZ];
static char obuf[OBUF_SZ];
static size_t olen;

/* ------------------------------------------------------------------ connections */
enum { W_NONE = 0, W_POST, W_LIKE };
typedef struct wreq {
  int kind;
  int64_t uid, post_id;
  char *uname; size_t ulen;
  char *body; size_t blen;
  /* results */
  int status; int already;
  int64_t new_id; char created[40]; size_t clen;
} wreq;

typedef struct conn {
  int fd;
  struct conn *prev, *next;      /* LRU list (head = least recently active) */
  struct conn *wnext;            /* pending-write queue */
  char *rbuf; size_t rlen, rcap; /* unparsed input carried between reads */
  char *wbuf; size_t wlen, woff; /* unsent output */
  wreq *w;                       /* in-flight write request awaiting group commit */
  unsigned close_after : 1, dead : 1, epollout : 1, queued : 1;
  struct conn *gnext;            /* graveyard link: freed at the end of the loop iteration */
} conn;

static conn **conns;
static conn *lru_head, *lru_tail;
static long nconns;
static conn *wq_head, *wq_tail;

static void lru_remove(conn *c) {
  if (c->prev) c->prev->next = c->next; else lru_head = c->next;
  if (c->next) c->next->prev = c->prev; else lru_tail = c->prev;
  c->prev = c->next = NULL;
}
static void lru_push(conn *c) {
  c->prev = lru_tail; c->next = NULL;
  if (lru_tail) lru_tail->next = c; else lru_head = c;
  lru_tail = c;
}
static void lru_touch(conn *c) { if (lru_tail != c) { lru_remove(c); lru_push(c); } }

static conn *grave;
/* Close now, free the struct later: epoll may still hold events for it in this iteration. */
static void conn_free(conn *c) {
  if (c->dead) return;
  c->dead = 1;
  lru_remove(c);
  conns[c->fd] = NULL;
  close(c->fd);
  free(c->rbuf); free(c->wbuf); c->rbuf = c->wbuf = NULL; c->rlen = c->wlen = c->woff = 0;
  c->gnext = grave; grave = c;
  nconns--;
}
static void bury(void) {
  while (grave) { conn *c = grave; grave = c->gnext; if (c->w) { free(c->w->uname); free(c->w->body); free(c->w); } free(c); }
}

/* ------------------------------------------------------------------ output helpers */
static inline void out(const void *p, size_t n) {
  if (unlikely(olen + n > OBUF_SZ)) return; /* cannot happen with bounded responses */
  memcpy(obuf + olen, p, n); olen += n;
}
#define OUTS(s) out(s, sizeof(s) - 1)
static inline void out_int(int64_t v) {
  char b[24]; int i = 24; uint64_t u = v < 0 ? (uint64_t)(-v) : (uint64_t)v;
  do { b[--i] = (char)('0' + u % 10); u /= 10; } while (u);
  if (v < 0) b[--i] = '-';
  out(b + i, 24 - i);
}
/* JSON string escaping as JSON.stringify does it (no escaping of / or non-ASCII).
 * SWAR fast path: copy 8 bytes at a time while none of them is '"', '\\' or < 0x20. */
static inline uint64_t swar_special(uint64_t v) {
  const uint64_t ones = 0x0101010101010101ULL, high = 0x8080808080808080ULL;
  uint64_t lt = (v - ones * 0x20) & ~v;
  uint64_t q = v ^ (ones * 0x22); q = (q - ones) & ~q;
  uint64_t b = v ^ (ones * 0x5C); b = (b - ones) & ~b;
  return (lt | q | b) & high;
}
static void out_jstr(const unsigned char *s, size_t n) {
  static const char hex[] = "0123456789abcdef";
  if (unlikely(olen + n * 6 + 2 > OBUF_SZ)) return;
  char *o = obuf + olen; *o++ = '"';
  size_t i = 0;
  for (;;) {
    while (i + 8 <= n) {
      uint64_t v; memcpy(&v, s + i, 8);
      if (swar_special(v)) break;
      memcpy(o, &v, 8); o += 8; i += 8;
    }
    if (i >= n) break;
    unsigned char c = s[i++];
    if (likely(c >= 0x20 && c != '"' && c != '\\')) { *o++ = (char)c; continue; }
    *o++ = '\\';
    switch (c) {
      case '"': *o++ = '"'; break; case '\\': *o++ = '\\'; break;
      case '\b': *o++ = 'b'; break; case '\f': *o++ = 'f'; break;
      case '\n': *o++ = 'n'; break; case '\r': *o++ = 'r'; break; case '\t': *o++ = 't'; break;
      default: *o++ = 'u'; *o++ = '0'; *o++ = '0'; *o++ = hex[c >> 4]; *o++ = hex[c & 15];
    }
  }
  *o++ = '"';
  olen = (size_t)(o - obuf);
}

/* Reserve room for headers, write body, then fill headers in front (right-aligned). */
#define HDR_RESERVE 128
static size_t resp_begin(void) { size_t at = olen; olen += HDR_RESERVE; return at; }
static void resp_end(size_t at, int status, int close_conn) {
  const char *st;
  switch (status) {
    case 200: st = "200 OK"; break; case 201: st = "201 Created"; break;
    case 400: st = "400 Bad Request"; break; case 401: st = "401 Unauthorized"; break;
    case 404: st = "404 Not Found"; break; case 413: st = "413 Payload Too Large"; break;
    case 503: st = "503 Service Unavailable"; break; default: st = "500 Internal Server Error"; break;
  }
  size_t blen = olen - at - HDR_RESERVE;
  char h[HDR_RESERVE];
  int hl = snprintf(h, sizeof h, "HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n%s\r\n",
                    st, blen, close_conn ? "Connection: close\r\n" : "");
  /* move header to sit right before the body, then close the gap */
  memcpy(obuf + at + HDR_RESERVE - hl, h, (size_t)hl);
  memmove(obuf + at, obuf + at + HDR_RESERVE - hl, (size_t)hl + blen);
  olen = at + (size_t)hl + blen;
}
static void resp_simple(int status, const char *json, int close_conn) {
  size_t at = resp_begin(); out(json, strlen(json)); resp_end(at, status, close_conn);
}
static void resp_error(int status, const char *msg, int close_conn) {
  size_t at = resp_begin(); OUTS("{\"error\":"); out_jstr((const unsigned char *)msg, strlen(msg)); OUTS("}");
  resp_end(at, status, close_conn);
}

/* post object from a row: id, body, created_at, username, like_count */
static void out_post_row(sqlite3_stmt *s) {
  OUTS("{\"id\":"); out_int(sqlite3_column_int64(s, 0));
  OUTS(",\"body\":"); out_jstr(sqlite3_column_text(s, 1), (size_t)sqlite3_column_bytes(s, 1));
  OUTS(",\"created_at\":"); out_jstr(sqlite3_column_text(s, 2), (size_t)sqlite3_column_bytes(s, 2));
  OUTS(",\"author\":"); out_jstr(sqlite3_column_text(s, 3), (size_t)sqlite3_column_bytes(s, 3));
  OUTS(",\"like_count\":"); out_int(sqlite3_column_int64(s, 4));
  OUTS("}");
}

/* ------------------------------------------------------------------ handlers */
static void h_health(int cl) {
  int rc = sqlite3_step(st_health);
  int ok = (rc == SQLITE_ROW && sqlite3_column_int(st_health, 0) == 1);
  const char *err = ok ? NULL : sqlite3_errmsg(db);
  size_t at = resp_begin();
  if (ok) { OUTS("{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":"); out_int((int64_t)(time(NULL) - start_time)); OUTS("}"); }
  else { OUTS("{\"status\":\"degraded\",\"db\":\"unreachable\",\"error\":"); out_jstr((const unsigned char *)err, strlen(err)); OUTS("}"); }
  sqlite3_reset(st_health);
  resp_end(at, ok ? 200 : 503, cl);
}

/* Feed: one read transaction; posts+authors from the (created_at,id) index, then like counts for
 * the 20 ids in one range scan of likes_post_id_idx (ids of the newest posts are nearly contiguous;
 * falls back to per-id counts when they are not). */
static char fscratch[64 * 1024];
static void h_feed(int cl) {
  int64_t ids[20], cnt[20]; size_t seg[21]; int n = 0, rc;
  int64_t mn = INT64_MAX, mx = 0;
  if (sqlite3_step(st_rbegin) != SQLITE_DONE) { sqlite3_reset(st_rbegin); resp_error(500, "internal server error", cl); return; }
  sqlite3_reset(st_rbegin);
  size_t save = olen;
  /* build each post prefix in obuf temporarily, then move to fscratch */
  while (n < 20 && (rc = sqlite3_step(st_feed_rows)) == SQLITE_ROW) {
    int64_t id = sqlite3_column_int64(st_feed_rows, 0);
    seg[n] = olen - save;
    OUTS("{\"id\":"); out_int(id);
    OUTS(",\"body\":"); out_jstr(sqlite3_column_text(st_feed_rows, 1), (size_t)sqlite3_column_bytes(st_feed_rows, 1));
    OUTS(",\"created_at\":"); out_jstr(sqlite3_column_text(st_feed_rows, 2), (size_t)sqlite3_column_bytes(st_feed_rows, 2));
    OUTS(",\"author\":"); out_jstr(sqlite3_column_text(st_feed_rows, 3), (size_t)sqlite3_column_bytes(st_feed_rows, 3));
    OUTS(",\"like_count\":");
    ids[n] = id; cnt[n] = 0; if (id < mn) mn = id; if (id > mx) mx = id; n++;
  }
  seg[n] = olen - save;
  int ok = (n == 20 || rc == SQLITE_DONE);
  sqlite3_reset(st_feed_rows);
  size_t plen = olen - save; if (plen > sizeof fscratch) plen = sizeof fscratch;
  memcpy(fscratch, obuf + save, plen);
  olen = save;
  if (ok && n) {
    if (mx - mn <= 200) {
      sqlite3_bind_int64(st_cnt_range, 1, mn); sqlite3_bind_int64(st_cnt_range, 2, mx);
      while ((rc = sqlite3_step(st_cnt_range)) == SQLITE_ROW) {
        int64_t pid = sqlite3_column_int64(st_cnt_range, 0), c = sqlite3_column_int64(st_cnt_range, 1);
        for (int k = 0; k < n; k++) if (ids[k] == pid) cnt[k] = c;
      }
      if (rc != SQLITE_DONE) ok = 0;
      sqlite3_reset(st_cnt_range);
    } else {
      for (int k = 0; k < n && ok; k++) {
        sqlite3_bind_int64(st_cnt_one, 1, ids[k]);
        if (sqlite3_step(st_cnt_one) == SQLITE_ROW) cnt[k] = sqlite3_column_int64(st_cnt_one, 0); else ok = 0;
        sqlite3_reset(st_cnt_one);
      }
    }
  }
  sqlite3_step(st_rcommit); sqlite3_reset(st_rcommit);
  if (!ok) { resp_error(500, "internal server error", cl); return; }
  size_t at = resp_begin();
  OUTS("{\"posts\":[");
  for (int k = 0; k < n; k++) {
    if (k) OUTS(",");
    out(fscratch + seg[k], seg[k + 1] - seg[k]); out_int(cnt[k]); OUTS("}");
  }
  OUTS("]}");
  resp_end(at, 200, cl);
}

static void h_post(int64_t id, int cl) {
  sqlite3_bind_int64(st_post, 1, id);
  int rc = sqlite3_step(st_post);
  if (rc == SQLITE_ROW) {
    size_t at = resp_begin(); OUTS("{\"post\":"); out_post_row(st_post); OUTS("}");
    sqlite3_reset(st_post); resp_end(at, 200, cl);
  } else {
    sqlite3_reset(st_post);
    if (rc == SQLITE_DONE) resp_error(404, "post not found", cl); else resp_error(500, "internal server error", cl);
  }
}

/* "positive integer" path id: ASCII digits only, 1 .. 2^53-1 */
static int64_t parse_id(const char *p, size_t n) {
  if (n == 0 || n > 16) return -1;
  int64_t v = 0;
  for (size_t i = 0; i < n; i++) { if (p[i] < '0' || p[i] > '9') return -1; v = v * 10 + (p[i] - '0'); }
  if (v <= 0 || v > 9007199254740991LL) return -1;
  return v;
}

/* ------------------------------------------------------------------ JWT */
static int b64url_val(unsigned char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '-') return 62;
  if (c == '_') return 63;
  return -1;
}
static long b64url_dec(const char *s, size_t n, unsigned char *o, size_t cap) {
  if (n % 4 == 1) return -1;
  size_t olen2 = n / 4 * 3 + (n % 4 ? n % 4 - 1 : 0);
  if (olen2 > cap) return -1;
  uint32_t acc = 0; int bits = 0; size_t k = 0;
  for (size_t i = 0; i < n; i++) {
    int v = b64url_val((unsigned char)s[i]); if (v < 0) return -1;
    acc = acc << 6 | (uint32_t)v; bits += 6;
    if (bits >= 8) { bits -= 8; o[k++] = (unsigned char)(acc >> bits); }
  }
  return (long)k;
}
static void b64url_enc(const unsigned char *in, size_t n, char *o) {
  static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  size_t i = 0, k = 0;
  for (; i + 2 < n; i += 3) {
    uint32_t v = (uint32_t)in[i] << 16 | (uint32_t)in[i + 1] << 8 | in[i + 2];
    o[k++] = T[v >> 18]; o[k++] = T[(v >> 12) & 63]; o[k++] = T[(v >> 6) & 63]; o[k++] = T[v & 63];
  }
  if (n - i == 1) { uint32_t v = (uint32_t)in[i] << 16; o[k++] = T[v >> 18]; o[k++] = T[(v >> 12) & 63]; }
  else if (n - i == 2) { uint32_t v = (uint32_t)in[i] << 16 | (uint32_t)in[i + 1] << 8; o[k++] = T[v >> 18]; o[k++] = T[(v >> 12) & 63]; o[k++] = T[(v >> 6) & 63]; }
  o[k] = 0;
}

enum { AUTH_OK = 0, AUTH_MISSING, AUTH_INVALID, AUTH_PAYLOAD };
#define UNAME_CAP 4096
/* Verifies HS256 signature, alg, exp/nbf on every call (no caching). */
static int verify_jwt(const char *auth, size_t alen, int64_t *uid, char *uname, size_t *ulen) {
  if (!auth || alen < 7 || memcmp(auth, "Bearer ", 7) != 0) return AUTH_MISSING;
  const char *t = auth + 7; size_t n = alen - 7;
  const char *d1 = memchr(t, '.', n); if (!d1) return AUTH_INVALID;
  const char *d2 = memchr(d1 + 1, '.', (size_t)(t + n - d1 - 1)); if (!d2) return AUTH_INVALID;
  if (memchr(d2 + 1, '.', (size_t)(t + n - d2 - 1))) return AUTH_INVALID;
  size_t hl = (size_t)(d1 - t), pl = (size_t)(d2 - d1 - 1), sl = (size_t)(t + n - d2 - 1);
  if (hl == 0 || pl == 0 || hl > 2048 || pl > 8192) return AUTH_INVALID;
  /* signature */
  unsigned char mac[32]; char macs[48];
  hmac_sha256(&jwt_key, t, (size_t)(d2 - t), mac);
  b64url_enc(mac, 32, macs);
  if (sl != 43) return AUTH_INVALID;
  unsigned diff = 0; for (int i = 0; i < 43; i++) diff |= (unsigned)(macs[i] ^ d2[1 + i]);
  if (diff) return AUTH_INVALID;
  /* header: {"alg":"HS256",...} */
  unsigned char hj[2048], pj[8192];
  long hjl = b64url_dec(t, hl, hj, sizeof hj); if (hjl < 0) return AUTH_INVALID;
  char algbuf[16];
  jfield hf[1] = {{.key = "alg", .str = algbuf, .cap = sizeof algbuf}};
  if (json_top((const char *)hj, (size_t)hjl, hf, 1) != 1) return AUTH_INVALID;
  if (hf[0].type != JT_STRING || hf[0].truncated || hf[0].len != 5 || memcmp(algbuf, "HS256", 5)) return AUTH_INVALID;
  long pjl = b64url_dec(d1 + 1, pl, pj, sizeof pj); if (pjl < 0) return AUTH_INVALID;
  char subbuf[32];
  jfield pf[4] = {{.key = "sub", .str = subbuf, .cap = sizeof subbuf},
                  {.key = "username", .str = uname, .cap = UNAME_CAP},
                  {.key = "exp"}, {.key = "nbf"}};
  if (json_top((const char *)pj, (size_t)pjl, pf, 4) != 1) return AUTH_INVALID;
  double now = (double)time(NULL);
  if (pf[2].type != JT_ABSENT) { if (pf[2].type != JT_NUMBER || now >= pf[2].num) return AUTH_INVALID; }
  if (pf[3].type != JT_ABSENT) { if (pf[3].type != JT_NUMBER || pf[3].num > now) return AUTH_INVALID; }
  if (pf[0].type != JT_STRING || pf[0].truncated) return AUTH_PAYLOAD;
  int64_t id = parse_id(subbuf, pf[0].len); if (id <= 0) return AUTH_PAYLOAD;
  if (pf[1].type != JT_STRING || pf[1].truncated) return AUTH_PAYLOAD;
  *uid = id; *ulen = pf[1].len;
  return AUTH_OK;
}

/* JavaScript String.prototype.trim() whitespace */
static int js_space(uint32_t c) {
  return c == 9 || c == 10 || c == 11 || c == 12 || c == 13 || c == 32 || c == 0xA0 || c == 0x1680 ||
         (c >= 0x2000 && c <= 0x200A) || c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F ||
         c == 0x3000 || c == 0xFEFF;
}

/* ------------------------------------------------------------------ write queue */
static void enqueue_write(conn *c, wreq *w) {
  c->w = w; c->queued = 1; c->wnext = NULL;
  if (wq_tail) wq_tail->wnext = c; else wq_head = c;
  wq_tail = c;
}

static void h_create(conn *c, const char *auth, size_t alen, const char *body, size_t blen) {
  int64_t uid; static char uname[UNAME_CAP]; size_t ulen;
  int a = verify_jwt(auth, alen, &uid, uname, &ulen);
  if (a == AUTH_MISSING) { resp_error(401, "missing bearer token", c->close_after); return; }
  if (a == AUTH_INVALID) { resp_error(401, "invalid or expired token", c->close_after); return; }
  if (a == AUTH_PAYLOAD) { resp_error(401, "invalid token payload", c->close_after); return; }
  static char text[3 * MAX_BODY + 16];
  jfield f[1] = {{.key = "body", .str = text, .cap = sizeof text}};
  int r = json_top(body, blen, f, 1);
  if (r < 0) { resp_error(400, "malformed JSON body", c->close_after); return; }
  if (r == 0 || f[0].type != JT_STRING) { resp_error(400, "body is required", c->close_after); return; }
  if (f[0].truncated) { resp_error(400, "body must be at most 500 characters", c->close_after); return; }
  /* trim JS whitespace from both ends, count code points */
  const unsigned char *s = (const unsigned char *)text, *e = s + f[0].len;
  int adv;
  while (s < e && js_space(utf8_get(s, e, &adv))) s += adv;
  const unsigned char *q = s, *last_end = s; size_t cps = 0, cps_at_last = 0;
  while (q < e) { uint32_t cp = utf8_get(q, e, &adv); q += adv; cps++; if (!js_space(cp)) { last_end = q; cps_at_last = cps; } }
  if (last_end == s) { resp_error(400, "body is required", c->close_after); return; }
  if (cps_at_last > 500) { resp_error(400, "body must be at most 500 characters", c->close_after); return; }
  wreq *w = calloc(1, sizeof *w);
  w->kind = W_POST; w->uid = uid;
  w->uname = malloc(ulen + 1); memcpy(w->uname, uname, ulen); w->ulen = ulen;
  w->blen = (size_t)(last_end - s); w->body = malloc(w->blen + 1); memcpy(w->body, s, w->blen);
  enqueue_write(c, w);
}

static void h_like(conn *c, const char *auth, size_t alen, const char *idp, size_t idn) {
  int64_t uid; static char uname[UNAME_CAP]; size_t ulen;
  int a = verify_jwt(auth, alen, &uid, uname, &ulen);
  if (a == AUTH_MISSING) { resp_error(401, "missing bearer token", c->close_after); return; }
  if (a == AUTH_INVALID) { resp_error(401, "invalid or expired token", c->close_after); return; }
  if (a == AUTH_PAYLOAD) { resp_error(401, "invalid token payload", c->close_after); return; }
  int64_t id = parse_id(idp, idn);
  if (id < 0) { resp_error(400, "invalid post id", c->close_after); return; }
  wreq *w = calloc(1, sizeof *w);
  w->kind = W_LIKE; w->uid = uid; w->post_id = id;
  enqueue_write(c, w);
}

static void exec_write(wreq *w) {
  int rc;
  if (w->kind == W_POST) {
    sqlite3_bind_int64(st_ins_post, 1, w->uid);
    sqlite3_bind_text(st_ins_post, 2, w->body, (int)w->blen, SQLITE_STATIC);
    rc = sqlite3_step(st_ins_post);
    if (rc == SQLITE_ROW) {
      w->new_id = sqlite3_column_int64(st_ins_post, 0);
      int cl = sqlite3_column_bytes(st_ins_post, 1); if (cl > 39) cl = 39;
      memcpy(w->created, sqlite3_column_text(st_ins_post, 1), (size_t)cl); w->clen = (size_t)cl;
      rc = sqlite3_step(st_ins_post);
      w->status = (rc == SQLITE_DONE) ? 201 : 500;
    } else w->status = 500;
    sqlite3_reset(st_ins_post); sqlite3_clear_bindings(st_ins_post);
  } else {
    sqlite3_bind_int64(st_exists, 1, w->post_id);
    rc = sqlite3_step(st_exists);
    sqlite3_reset(st_exists);
    if (rc == SQLITE_DONE) { w->status = 404; return; }
    if (rc != SQLITE_ROW) { w->status = 500; return; }
    sqlite3_bind_int64(st_ins_like, 1, w->uid);
    sqlite3_bind_int64(st_ins_like, 2, w->post_id);
    rc = sqlite3_step(st_ins_like);
    sqlite3_reset(st_ins_like);
    if (rc != SQLITE_DONE) { w->status = 500; return; }
    w->already = sqlite3_changes(db) == 0;
    w->status = w->already ? 200 : 201;
  }
}

static void write_response(conn *c, wreq *w, int committed) {
  int cl = c->close_after;
  if (!committed && (w->status == 200 || w->status == 201)) w->status = 500;
  if (w->status == 500) { resp_error(500, "internal server error", cl); return; }
  if (w->kind == W_POST) {
    size_t at = resp_begin();
    OUTS("{\"post\":{\"id\":"); out_int(w->new_id);
    OUTS(",\"body\":"); out_jstr((unsigned char *)w->body, w->blen);
    OUTS(",\"created_at\":"); out_jstr((unsigned char *)w->created, w->clen);
    OUTS(",\"author\":"); out_jstr((unsigned char *)w->uname, w->ulen);
    OUTS(",\"like_count\":0}}");
    resp_end(at, 201, cl);
  } else {
    if (w->status == 404) { resp_error(404, "post not found", cl); return; }
    size_t at = resp_begin();
    OUTS("{\"liked\":true,\"already_liked\":"); if (w->already) OUTS("true"); else OUTS("false");
    OUTS(",\"post_id\":"); out_int(w->post_id); OUTS("}");
    resp_end(at, w->status, cl);
  }
}

/* ------------------------------------------------------------------ HTTP */
static inline int ieq(const char *a, size_t n, const char *lit) {
  size_t m = strlen(lit); if (n != m) return 0;
  for (size_t i = 0; i < n; i++) { char x = a[i]; if (x >= 'A' && x <= 'Z') x += 32; if (x != lit[i]) return 0; }
  return 1;
}

/* Parse and handle one request from p[0..n). Returns bytes consumed, 0 if incomplete, -1 on fatal error. */
static long handle_one(conn *c, const char *p, size_t n) {
  const char *he = NULL;
  if (n >= 4) he = memmem(p, n, "\r\n\r\n", 4);
  if (!he) { if (n > MAX_HDR) { resp_error(400, "bad request", 1); c->close_after = 1; return -1; } return 0; }
  const char *hend = he + 4;
  /* request line */
  const char *le = memchr(p, '\r', (size_t)(he - p) + 1);
  const char *sp1 = memchr(p, ' ', (size_t)(le - p));
  if (!sp1) { resp_error(400, "bad request", 1); c->close_after = 1; return -1; }
  const char *tgt = sp1 + 1;
  const char *sp2 = memchr(tgt, ' ', (size_t)(le - tgt));
  if (!sp2) { resp_error(400, "bad request", 1); c->close_after = 1; return -1; }
  const char *meth = p; size_t mlen = (size_t)(sp1 - p);
  size_t tlen = (size_t)(sp2 - tgt);
  const char *ver = sp2 + 1; size_t vlen = (size_t)(le - ver);
  int http10 = (vlen == 8 && !memcmp(ver, "HTTP/1.0", 8));
  /* headers */
  const char *auth = NULL; size_t alen = 0; long clen = 0; int conn_close = 0, conn_ka = 0, chunked = 0;
  const char *h = le + 2;
  while (h < he + 2) {
    const char *e = memchr(h, '\r', (size_t)(he + 2 - h)); if (!e) e = he;
    const char *colon = memchr(h, ':', (size_t)(e - h));
    if (colon) {
      size_t nl = (size_t)(colon - h);
      const char *v = colon + 1; while (v < e && (*v == ' ' || *v == '\t')) v++;
      const char *ve = e; while (ve > v && (ve[-1] == ' ' || ve[-1] == '\t')) ve--;
      size_t vl = (size_t)(ve - v);
      switch (nl) {
        case 13: if (ieq(h, nl, "authorization")) { auth = v; alen = vl; } break;
        case 14: if (ieq(h, nl, "content-length")) {
                   clen = 0; if (vl == 0 || vl > 9) clen = -1;
                   for (size_t i = 0; i < vl && clen >= 0; i++) { if (v[i] < '0' || v[i] > '9') clen = -1; else clen = clen * 10 + (v[i] - '0'); }
                 } break;
        case 10: if (ieq(h, nl, "connection")) { if (ieq(v, vl, "close")) conn_close = 1; else if (ieq(v, vl, "keep-alive")) conn_ka = 1; } break;
        case 17: if (ieq(h, nl, "transfer-encoding")) chunked = 1; break;
      }
    }
    h = e + 2;
  }
  if (clen < 0 || chunked) { resp_error(400, "malformed JSON body", 1); c->close_after = 1; return -1; }
  if (clen > MAX_BODY) { resp_error(413, "body too large", 1); c->close_after = 1; return -1; }
  if ((size_t)(n - (size_t)(hend - p)) < (size_t)clen) return 0; /* body incomplete */
  const char *body = hend; long total = (long)(hend - p) + clen;
  c->close_after = conn_close || (http10 && !conn_ka);
  int cl = c->close_after;

  /* strip query string */
  const char *q = memchr(tgt, '?', tlen); if (q) tlen = (size_t)(q - tgt);
  int get = (mlen == 3 && !memcmp(meth, "GET", 3)), post = (mlen == 4 && !memcmp(meth, "POST", 4));

  if (tlen >= 7 && !memcmp(tgt, "/posts/", 7)) {
    const char *idp = tgt + 7; size_t rest = tlen - 7;
    const char *slash = memchr(idp, '/', rest);
    if (!slash) {
      if (get && rest > 0) { int64_t id = parse_id(idp, rest); if (id < 0) resp_error(400, "invalid post id", cl); else h_post(id, cl); return total; }
    } else if (post && (size_t)(tgt + tlen - slash) == 5 && !memcmp(slash, "/like", 5) && slash > idp) {
      h_like(c, auth, alen, idp, (size_t)(slash - idp)); return total;
    }
  } else if (tlen == 5 && !memcmp(tgt, "/feed", 5)) {
    if (get) { h_feed(cl); return total; }
  } else if (tlen == 6 && !memcmp(tgt, "/posts", 6)) {
    if (post) { h_create(c, auth, alen, body, (size_t)clen); return total; }
  } else if (tlen == 7 && !memcmp(tgt, "/health", 7)) {
    if (get) { h_health(cl); return total; }
  }
  resp_error(404, "not found", cl);
  return total;
}

static void set_epollout(conn *c, int on) {
  if (c->epollout == on) return;
  struct epoll_event ev = {.events = EPOLLIN | (on ? EPOLLOUT : 0), .data.ptr = c};
  epoll_ctl(epfd, EPOLL_CTL_MOD, c->fd, &ev);
  c->epollout = on;
}

/* Send obuf (plus any backlog). Returns -1 if the connection was closed. */
static int flush_out(conn *c) {
  if (c->wlen > c->woff) { /* backlog exists: append */
    size_t need = c->wlen + olen;
    c->wbuf = realloc(c->wbuf, need); memcpy(c->wbuf + c->wlen, obuf, olen); c->wlen = need; olen = 0;
  } else if (olen) {
    ssize_t w = send(c->fd, obuf, olen, MSG_NOSIGNAL);
    if (w < 0) { if (errno != EAGAIN && errno != EINTR) { olen = 0; conn_free(c); return -1; } w = 0; }
    if ((size_t)w < olen) {
      free(c->wbuf); c->wlen = olen - (size_t)w; c->woff = 0;
      c->wbuf = malloc(c->wlen); memcpy(c->wbuf, obuf + w, c->wlen);
    }
    olen = 0;
  }
  if (c->wlen > c->woff) {
    ssize_t w = send(c->fd, c->wbuf + c->woff, c->wlen - c->woff, MSG_NOSIGNAL);
    if (w < 0 && errno != EAGAIN && errno != EINTR) { conn_free(c); return -1; }
    if (w > 0) c->woff += (size_t)w;
    if (c->woff == c->wlen) { free(c->wbuf); c->wbuf = NULL; c->wlen = c->woff = 0; }
  }
  if (c->wlen) { set_epollout(c, 1); return 0; }
  set_epollout(c, 0);
  if (c->close_after && !c->queued) { conn_free(c); return -1; }
  return 0;
}

/* Process as many complete requests as possible from data; save the remainder. */
static int process(conn *c, char *data, size_t len, int data_is_rbuf) {
  size_t off = 0;
  while (off < len && !c->queued && !c->close_after) {
    long r = handle_one(c, data + off, len - off);
    if (r == 0) break;
    if (r < 0) { off = len; break; }
    off += (size_t)r;
  }
  size_t rem = len - off;
  if (data_is_rbuf) {
    if (rem && off) memmove(c->rbuf, c->rbuf + off, rem);
    c->rlen = rem;
    if (!rem) { free(c->rbuf); c->rbuf = NULL; c->rcap = 0; }
  } else if (rem) {
    if (c->rcap < rem) { c->rcap = rem < 4096 ? 4096 : rem; c->rbuf = realloc(c->rbuf, c->rcap); }
    memcpy(c->rbuf, data + off, rem); c->rlen = rem;
  }
  return flush_out(c);
}

static void on_readable(conn *c) {
  lru_touch(c);
  if (c->queued) return; /* wait until its write commits; data stays in the kernel buffer */
  for (;;) {
    ssize_t n;
    if (c->rlen) {
      if (c->rcap - c->rlen < 16384) { c->rcap = c->rcap * 2 + 16384; c->rbuf = realloc(c->rbuf, c->rcap); }
      n = recv(c->fd, c->rbuf + c->rlen, c->rcap - c->rlen, 0);
    } else n = recv(c->fd, ibuf, IBUF_SZ, 0);
    if (n == 0) { conn_free(c); return; }
    if (n < 0) { if (errno == EAGAIN || errno == EINTR) return; conn_free(c); return; }
    int full;
    if (c->rlen) {
      c->rlen += (size_t)n; full = c->rlen == c->rcap;
      if (c->rlen > MAX_HDR + MAX_BODY + 4096) { conn_free(c); return; }
      if (process(c, c->rbuf, c->rlen, 1) < 0) return;
    } else {
      full = (size_t)n == IBUF_SZ;
      if (process(c, ibuf, (size_t)n, 0) < 0) return;
    }
    if (!full || c->queued || c->close_after) return;
  }
}

static void commit_writes(void) {
  if (!wq_head) return;
  int committed = 0;
  if (sqlite3_step(st_begin) == SQLITE_DONE) {
    sqlite3_reset(st_begin);
    for (conn *c = wq_head; c; c = c->wnext) exec_write(c->w);
    int rc = sqlite3_step(st_commit); sqlite3_reset(st_commit);
    if (rc == SQLITE_DONE) committed = 1;
    else { sqlite3_step(st_rollback); sqlite3_reset(st_rollback); }
  } else sqlite3_reset(st_begin);
  conn *c = wq_head; wq_head = wq_tail = NULL;
  while (c) {
    conn *nx = c->wnext; wreq *w = c->w;
    if (!w->status) w->status = 500;
    write_response(c, w, committed);
    if (c->dead) { olen = 0; c = nx; continue; } /* client vanished: write committed, nobody to tell; bury() frees w */
    free(w->uname); free(w->body); free(w); c->w = NULL; c->queued = 0; c->wnext = NULL;
    if (flush_out(c) == 0 && c->rlen && !c->close_after) process(c, c->rbuf, c->rlen, 1);
    c = nx;
  }
  /* writes queued by pipelined requests processed above run in the next iteration */
}

/* Close least-recently-used idle connections until below the limit. */
static void evict(long target) {
  conn *c = lru_head;
  while (nconns > target && c) {
    conn *nx = c->next;
    if (!c->queued && !c->wlen && !c->rlen) conn_free(c);
    c = nx;
  }
}

static void on_accept(void) {
  for (;;) {
    if (nconns >= max_conns) evict(max_conns - max_conns / 64 - 1);
    int fd = accept4(lfd, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
    if (fd < 0) {
      if (errno == EMFILE || errno == ENFILE) { evict(nconns - 1024); continue; }
      return;
    }
    if (fd >= max_conns + 64) { close(fd); continue; }
    int one = 1; setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    conn *c = calloc(1, sizeof *c); c->fd = fd;
    conns[fd] = c; nconns++; lru_push(c);
    struct epoll_event ev = {.events = EPOLLIN, .data.ptr = c};
    epoll_ctl(epfd, EPOLL_CTL_ADD, fd, &ev);
    on_readable(c); /* with TCP_DEFER_ACCEPT data is usually already there */
  }
}

/* ------------------------------------------------------------------ checkpoint thread */
static void *checkpointer(void *arg) {
  (void)arg;
  sqlite3 *cdb;
  if (sqlite3_open_v2(db_path, &cdb, SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX, NULL) != SQLITE_OK) return NULL;
  sqlite3_busy_timeout(cdb, 100);
  sqlite3_exec(cdb, "PRAGMA synchronous=NORMAL", 0, 0, 0);
  for (;;) {
    usleep(500000);
    int logf = 0, ckpt = 0;
    sqlite3_wal_checkpoint_v2(cdb, NULL, SQLITE_CHECKPOINT_PASSIVE, &logf, &ckpt);
  }
  return NULL;
}

/* ------------------------------------------------------------------ main */
static void prep(sqlite3_stmt **s, const char *sql) {
  if (sqlite3_prepare_v3(db, sql, -1, SQLITE_PREPARE_PERSISTENT, s, NULL) != SQLITE_OK) {
    fprintf(stderr, "prepare failed: %s: %s\n", sql, sqlite3_errmsg(db)); exit(1);
  }
}

static long meminfo_kb(const char *key) {
  FILE *f = fopen("/proc/meminfo", "r"); if (!f) return -1;
  char line[256]; long v = -1; size_t kl = strlen(key);
  while (fgets(line, sizeof line, f)) if (!strncmp(line, key, kl) && line[kl] == ':') { v = atol(line + kl + 1); break; }
  fclose(f); return v;
}

static int busy_cb(void *arg, int n) { (void)arg; if (n < 2000) { sched_yield(); return 1; } if (n < 4000) { usleep(200); return 1; } return 0; }

static void open_db(void) {
  if (sqlite3_open_v2(db_path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX, NULL) != SQLITE_OK) {
    fprintf(stderr, "open %s: %s\n", db_path, sqlite3_errmsg(db)); exit(1);
  }
  sqlite3_busy_handler(db, busy_cb, NULL);
  sqlite3_exec(db,
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA mmap_size=1073741824;"
    "PRAGMA cache_size=-32768; PRAGMA temp_store=MEMORY; PRAGMA wal_autocheckpoint=0;", 0, 0, 0);
  prep(&st_feed_rows, "SELECT p.id, p.body, p.created_at, u.username "
                      "FROM posts p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC, p.id DESC LIMIT 20");
  prep(&st_cnt_range, "SELECT post_id, count(*) FROM likes WHERE post_id BETWEEN ?1 AND ?2 GROUP BY post_id");
  prep(&st_cnt_one, "SELECT count(*) FROM likes WHERE post_id = ?");
  prep(&st_rbegin, "BEGIN"); prep(&st_rcommit, "COMMIT");
  prep(&st_post, "SELECT p.id, p.body, p.created_at, u.username, (SELECT count(*) FROM likes l WHERE l.post_id = p.id) "
                 "FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?");
  prep(&st_health, "SELECT 1");
  prep(&st_ins_post, "INSERT INTO posts (user_id, body) VALUES (?, ?) RETURNING id, created_at");
  prep(&st_ins_like, "INSERT INTO likes (user_id, post_id) VALUES (?, ?) ON CONFLICT (user_id, post_id) DO NOTHING");
  prep(&st_exists, "SELECT 1 FROM posts WHERE id = ?");
  prep(&st_begin, "BEGIN IMMEDIATE"); prep(&st_commit, "COMMIT"); prep(&st_rollback, "ROLLBACK");
}

static const char *g_host; static int g_port;

static void worker(int idx) {
  open_db();
  if (idx == 0) /* warm the OS page cache once so the first requests are not cold */
    sqlite3_exec(db, "SELECT count(*) FROM posts; SELECT count(*) FROM users; SELECT count(*) FROM likes INDEXED BY likes_post_id_idx;", 0, 0, 0);
  conns = calloc((size_t)max_conns + 256, sizeof *conns);
  lfd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
  int one = 1; setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  setsockopt(lfd, SOL_SOCKET, SO_REUSEPORT, &one, sizeof one);
  int defer = 1; setsockopt(lfd, IPPROTO_TCP, TCP_DEFER_ACCEPT, &defer, sizeof defer);
  struct sockaddr_in sa = {.sin_family = AF_INET, .sin_port = htons((uint16_t)g_port)};
  if (inet_pton(AF_INET, g_host, &sa.sin_addr) != 1) sa.sin_addr.s_addr = htonl(INADDR_ANY);
  if (bind(lfd, (struct sockaddr *)&sa, sizeof sa) < 0) { perror("bind"); exit(1); }
  if (listen(lfd, 65535) < 0) { perror("listen"); exit(1); }
  epfd = epoll_create1(EPOLL_CLOEXEC);
  struct epoll_event lev = {.events = EPOLLIN, .data.ptr = NULL};
  epoll_ctl(epfd, EPOLL_CTL_ADD, lfd, &lev);
  fprintf(stderr, "worker %d listening on %s:%d, max_conns=%ld\n", idx, g_host, g_port, max_conns);

  static struct epoll_event evs[1024];
  time_t last_check = time(NULL);
  for (;;) {
    int n = epoll_wait(epfd, evs, 1024, 1000);
    for (int i = 0; i < n; i++) {
      conn *c = evs[i].data.ptr;
      if (!c) { on_accept(); continue; }
      if (c->dead) continue;
      if (evs[i].events & EPOLLOUT) { if (flush_out(c) < 0) continue; if (!c->wlen && c->rlen && !c->queued) { if (process(c, c->rbuf, c->rlen, 1) < 0) continue; } }
      if (!c->dead && (evs[i].events & (EPOLLIN | EPOLLHUP | EPOLLERR))) on_readable(c);
    }
    commit_writes();
    bury();
    time_t now = time(NULL);
    if (now != last_check) { /* memory guard: shed idle connections if the box runs low on RAM */
      last_check = now;
      long avail = meminfo_kb("MemAvailable");
      if (avail >= 0 && avail < 400 * 1024 && nconns > 1024) { max_conns = nconns - nconns / 8; evict(max_conns); }
    }
  }
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  db_path = getenv("SQLITE_PATH"); if (!db_path) db_path = "feed.db";
  const char *secret = getenv("JWT_SECRET"); if (!secret) secret = "twelve-dollar-challenge";
  g_host = getenv("HOST"); if (!g_host) g_host = "127.0.0.1";
  g_port = getenv("PORT") ? atoi(getenv("PORT")) : 3000;
  hmac_setkey(&jwt_key, (const uint8_t *)secret, strlen(secret));
  start_time = time(NULL);

  struct rlimit rl; getrlimit(RLIMIT_NOFILE, &rl); rl.rlim_cur = rl.rlim_max; setrlimit(RLIMIT_NOFILE, &rl);
  getrlimit(RLIMIT_NOFILE, &rl);
  long per_proc = (long)rl.rlim_cur - 128; if (per_proc < 64) per_proc = 64;
  /* Connection budget across all workers: ~5 KB of kernel memory per idle TCP socket, keeping
   * ~800 MB for the OS, the database page cache and our own heaps. */
  long memtotal = meminfo_kb("MemTotal");
  long budget = memtotal > 0 ? (memtotal - 800L * 1024) / 5 : per_proc;
  if (budget < 4096) budget = 4096;
  int workers = (int)((budget + per_proc - 1) / per_proc);
  if (workers < 1) workers = 1;
  if (workers > 8) workers = 8;
  if (getenv("WORKERS")) workers = atoi(getenv("WORKERS"));
  max_conns = budget / workers; if (max_conns > per_proc) max_conns = per_proc;
  if (getenv("MAX_CONNS")) max_conns = atol(getenv("MAX_CONNS"));
  fprintf(stderr, "nofile=%ld memtotal=%ldkB budget=%ld conns -> %d workers x %ld\n", (long)rl.rlim_cur, memtotal, budget, workers, max_conns);

  if (workers == 1) {
    pthread_t th; pthread_create(&th, NULL, checkpointer, NULL);
    worker(0);
  }
  pid_t *pids = calloc((size_t)workers, sizeof *pids);
  pid_t parent = getpid();
  for (;;) {
    for (int i = 0; i < workers; i++) {
      if (pids[i] > 0) continue;
      pid_t p = fork();
      if (p == 0) { prctl(PR_SET_PDEATHSIG, SIGTERM); if (getppid() != parent) _exit(1); worker(i); _exit(0); }
      pids[i] = p;
    }
    /* parent: WAL checkpoints (fsync happens here, never in a worker's event loop) + respawn */
    static sqlite3 *cdb;
    if (!cdb) {
      if (sqlite3_open_v2(db_path, &cdb, SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX, NULL) == SQLITE_OK) {
        sqlite3_busy_timeout(cdb, 100); sqlite3_exec(cdb, "PRAGMA synchronous=NORMAL", 0, 0, 0);
      }
    }
    usleep(500000);
    if (cdb) { int logf, ck; sqlite3_wal_checkpoint_v2(cdb, NULL, SQLITE_CHECKPOINT_PASSIVE, &logf, &ck); }
    int st; pid_t d;
    while ((d = waitpid(-1, &st, WNOHANG)) > 0)
      for (int i = 0; i < workers; i++) if (pids[i] == d) { fprintf(stderr, "worker %d exited (%d), restarting\n", i, st); pids[i] = 0; }
  }
}
