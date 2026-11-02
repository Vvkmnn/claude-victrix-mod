// $12 Server Challenge: single-threaded epoll HTTP/1.1 server in C on SQLite.
// See README.md for the design. Config from env: SQLITE_PATH, JWT_SECRET, HOST, PORT.
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
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
#include <sys/time.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/resource.h>
#include <time.h>
#include <unistd.h>

#define likely(x) __builtin_expect(!!(x), 1)
#define unlikely(x) __builtin_expect(!!(x), 0)

/* ------------------------------------------------------------------ SHA-256 / HMAC */
typedef struct { uint32_t h[8]; uint8_t buf[64]; uint64_t len; uint32_t blen; } sha256_ctx;
static const uint32_t K256[64] = {
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
#define ROR(x,n) (((x)>>(n))|((x)<<(32-(n))))
static void sha256_block(uint32_t *h, const uint8_t *p) {
  uint32_t w[64], a,b,c,d,e,f,g,hh;
  for (int i = 0; i < 16; i++) w[i] = (uint32_t)p[4*i]<<24 | (uint32_t)p[4*i+1]<<16 | (uint32_t)p[4*i+2]<<8 | p[4*i+3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = ROR(w[i-15],7) ^ ROR(w[i-15],18) ^ (w[i-15]>>3);
    uint32_t s1 = ROR(w[i-2],17) ^ ROR(w[i-2],19) ^ (w[i-2]>>10);
    w[i] = w[i-16] + s0 + w[i-7] + s1;
  }
  a=h[0];b=h[1];c=h[2];d=h[3];e=h[4];f=h[5];g=h[6];hh=h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t t1 = hh + (ROR(e,6)^ROR(e,11)^ROR(e,25)) + ((e&f)^(~e&g)) + K256[i] + w[i];
    uint32_t t2 = (ROR(a,2)^ROR(a,13)^ROR(a,22)) + ((a&b)^(a&c)^(b&c));
    hh=g; g=f; f=e; e=d+t1; d=c; c=b; b=a; a=t1+t2;
  }
  h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;h[5]+=f;h[6]+=g;h[7]+=hh;
}
static void sha256_init(sha256_ctx *c) {
  static const uint32_t iv[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
  memcpy(c->h, iv, 32); c->len = 0; c->blen = 0;
}
static void sha256_update(sha256_ctx *c, const uint8_t *p, size_t n) {
  c->len += n;
  if (c->blen) {
    size_t t = 64 - c->blen; if (t > n) t = n;
    memcpy(c->buf + c->blen, p, t); c->blen += t; p += t; n -= t;
    if (c->blen == 64) { sha256_block(c->h, c->buf); c->blen = 0; }
  }
  while (n >= 64) { sha256_block(c->h, p); p += 64; n -= 64; }
  if (n) { memcpy(c->buf, p, n); c->blen = n; }
}
static void sha256_final(sha256_ctx *c, uint8_t out[32]) {
  uint64_t bits = c->len * 8;
  uint8_t pad = 0x80; sha256_update(c, &pad, 1);
  uint8_t z = 0; while (c->blen != 56) sha256_update(c, &z, 1);
  uint8_t lb[8]; for (int i = 0; i < 8; i++) lb[i] = bits >> (56 - 8*i);
  sha256_update(c, lb, 8);
  for (int i = 0; i < 8; i++) { out[4*i]=c->h[i]>>24; out[4*i+1]=c->h[i]>>16; out[4*i+2]=c->h[i]>>8; out[4*i+3]=c->h[i]; }
}
static sha256_ctx hmac_inner, hmac_outer; // key-derived states, computed once at startup from JWT_SECRET
static void hmac_setup(const char *key, size_t klen) {
  uint8_t k[64] = {0}, pad[64];
  if (klen > 64) { sha256_ctx t; sha256_init(&t); sha256_update(&t,(const uint8_t*)key,klen); sha256_final(&t,k); }
  else memcpy(k, key, klen);
  for (int i = 0; i < 64; i++) pad[i] = k[i] ^ 0x36;
  sha256_init(&hmac_inner); sha256_update(&hmac_inner, pad, 64);
  for (int i = 0; i < 64; i++) pad[i] = k[i] ^ 0x5c;
  sha256_init(&hmac_outer); sha256_update(&hmac_outer, pad, 64);
}
static void hmac_sha256(const uint8_t *m, size_t n, uint8_t out[32]) {
  sha256_ctx c = hmac_inner; uint8_t ih[32];
  sha256_update(&c, m, n); sha256_final(&c, ih);
  c = hmac_outer; sha256_update(&c, ih, 32); sha256_final(&c, out);
}

/* ------------------------------------------------------------------ base64url */
static int8_t b64t[256];
static void b64_setup(void) {
  memset(b64t, -1, sizeof b64t);
  const char *a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (int i = 0; i < 64; i++) b64t[(uint8_t)a[i]] = i;
}
// decodes unpadded base64url; returns length or -1
static long b64url_dec(const char *s, size_t n, uint8_t *out) {
  if (n % 4 == 1) return -1;
  size_t o = 0; uint32_t acc = 0; int bits = 0;
  for (size_t i = 0; i < n; i++) {
    int v = b64t[(uint8_t)s[i]]; if (v < 0) return -1;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return (long)o;
}

/* ------------------------------------------------------------------ JSON (strict, RFC 8259) */
typedef struct { const char *p, *e; int depth; } jp;
static inline void jws(jp *j) { while (j->p < j->e && (*j->p==' '||*j->p=='\t'||*j->p=='\n'||*j->p=='\r')) j->p++; }
static int hexv(int c) { if (c>='0'&&c<='9') return c-'0'; c|=32; if (c>='a'&&c<='f') return c-'a'+10; return -1; }
static char *utf8_put(char *o, uint32_t cp) {
  if (cp < 0x80) *o++ = cp;
  else if (cp < 0x800) { *o++ = 0xc0|(cp>>6); *o++ = 0x80|(cp&63); }
  else if (cp < 0x10000) { *o++ = 0xe0|(cp>>12); *o++ = 0x80|((cp>>6)&63); *o++ = 0x80|(cp&63); }
  else { *o++ = 0xf0|(cp>>18); *o++ = 0x80|((cp>>12)&63); *o++ = 0x80|((cp>>6)&63); *o++ = 0x80|(cp&63); }
  return o;
}
// j->p at '"'. Decodes into out (capacity >= raw length is always enough) if out != NULL. Returns decoded length or -1.
static long jstring(jp *j, char *out) {
  if (j->p >= j->e || *j->p != '"') return -1;
  j->p++;
  char *o = out; long n = 0;
  while (j->p < j->e) {
    unsigned char c = *j->p++;
    if (c == '"') return out ? (long)(o - out) : n;
    if (c < 0x20) return -1;
    if (c != '\\') { if (out) *o++ = c; else n++; continue; }
    if (j->p >= j->e) return -1;
    c = *j->p++;
    char r;
    switch (c) {
      case '"': r='"'; break; case '\\': r='\\'; break; case '/': r='/'; break;
      case 'b': r='\b'; break; case 'f': r='\f'; break; case 'n': r='\n'; break;
      case 'r': r='\r'; break; case 't': r='\t'; break;
      case 'u': {
        if (j->e - j->p < 4) return -1;
        int a=hexv(j->p[0]),b=hexv(j->p[1]),cc=hexv(j->p[2]),d=hexv(j->p[3]);
        if ((a|b|cc|d) < 0) return -1;
        uint32_t cp = a<<12|b<<8|cc<<4|d; j->p += 4;
        if (cp >= 0xD800 && cp <= 0xDBFF && j->e - j->p >= 6 && j->p[0]=='\\' && j->p[1]=='u') {
          int a2=hexv(j->p[2]),b2=hexv(j->p[3]),c2=hexv(j->p[4]),d2=hexv(j->p[5]);
          if ((a2|b2|c2|d2) >= 0) {
            uint32_t lo = a2<<12|b2<<8|c2<<4|d2;
            if (lo >= 0xDC00 && lo <= 0xDFFF) { cp = 0x10000 + ((cp-0xD800)<<10) + (lo-0xDC00); j->p += 6; }
          }
        }
        if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD;  // lone surrogate: store valid UTF-8 (U+FFFD), like JS->UTF-8 encoders
        if (out) o = utf8_put(o, cp); else n += 4;
        continue;
      }
      default: return -1;
    }
    if (out) *o++ = r; else n++;
  }
  return -1;
}
static int jnumber(jp *j, double *val) {
  const char *s = j->p;
  if (j->p < j->e && *j->p == '-') j->p++;
  if (j->p >= j->e) return -1;
  if (*j->p == '0') j->p++;
  else if (*j->p >= '1' && *j->p <= '9') while (j->p < j->e && *j->p >= '0' && *j->p <= '9') j->p++;
  else return -1;
  if (j->p < j->e && *j->p == '.') { j->p++; if (j->p >= j->e || *j->p<'0'||*j->p>'9') return -1; while (j->p<j->e && *j->p>='0'&&*j->p<='9') j->p++; }
  if (j->p < j->e && (*j->p == 'e' || *j->p == 'E')) {
    j->p++; if (j->p < j->e && (*j->p=='+'||*j->p=='-')) j->p++;
    if (j->p >= j->e || *j->p<'0'||*j->p>'9') return -1; while (j->p<j->e && *j->p>='0'&&*j->p<='9') j->p++;
  }
  if (val) { char tmp[64]; size_t l = j->p - s; if (l >= sizeof tmp) l = sizeof tmp - 1; memcpy(tmp, s, l); tmp[l]=0; *val = strtod(tmp, NULL); }
  return 0;
}
static int jskip(jp *j);
static int jlit(jp *j, const char *w, size_t n) { if ((size_t)(j->e - j->p) < n || memcmp(j->p, w, n)) return -1; j->p += n; return 0; }
static int jskip(jp *j) {
  jws(j); if (j->p >= j->e) return -1;
  switch (*j->p) {
    case '"': return jstring(j, NULL) < 0 ? -1 : 0;
    case 't': return jlit(j, "true", 4);
    case 'f': return jlit(j, "false", 5);
    case 'n': return jlit(j, "null", 4);
    case '{': case '[': {
      char close = *j->p == '{' ? '}' : ']'; int obj = close == '}';
      if (++j->depth > 100000) return -1;
      j->p++; jws(j);
      if (j->p < j->e && *j->p == close) { j->p++; j->depth--; return 0; }
      for (;;) {
        if (obj) { jws(j); if (jstring(j, NULL) < 0) return -1; jws(j); if (j->p >= j->e || *j->p != ':') return -1; j->p++; }
        if (jskip(j)) return -1;
        jws(j); if (j->p >= j->e) return -1;
        if (*j->p == ',') { j->p++; continue; }
        if (*j->p == close) { j->p++; j->depth--; return 0; }
        return -1;
      }
    }
    default: return jnumber(j, NULL);
  }
}
// Iterates a top-level JSON document. If it is an object, cb(key,klen,j,ud) is called for each member with j->p at
// the value; cb must consume the value (return 0) or return 1 to have it skipped; <0 = malformed.
// Returns 0 = valid JSON object, 1 = valid JSON but not an object, -1 = malformed.
typedef int (*jcb)(const char *k, long kl, jp *j, void *ud);
static int jdoc(const char *s, size_t n, jcb cb, void *ud) {
  jp j = { s, s + n, 0 }; char kb[64];
  jws(&j); if (j.p >= j.e) return -1;
  if (*j.p != '{') { if (jskip(&j)) return -1; jws(&j); return j.p == j.e ? 1 : -1; }
  j.p++; jws(&j);
  if (j.p < j.e && *j.p == '}') { j.p++; goto end; }
  for (;;) {
    jws(&j);
    const char *ks = j.p; jp probe = j; long rl = jstring(&probe, NULL); if (rl < 0) return -1;
    long kl = -1;
    if (probe.p - ks <= (long)sizeof kb) { kl = jstring(&j, kb); } else j = probe; // long keys are never ours
    jws(&j); if (j.p >= j.e || *j.p != ':') return -1; j.p++; jws(&j);
    int r = kl >= 0 ? cb(kb, kl, &j, ud) : 1;
    if (r < 0) return -1;
    if (r == 1 && jskip(&j)) return -1;
    jws(&j); if (j.p >= j.e) return -1;
    if (*j.p == ',') { j.p++; continue; }
    if (*j.p == '}') { j.p++; break; }
    return -1;
  }
end:
  jws(&j); return j.p == j.e ? 0 : -1;
}

/* ------------------------------------------------------------------ globals */
static sqlite3 *db;
static sqlite3_stmt *st_feed, *st_post, *st_ins_post, *st_exists, *st_ins_like, *st_one, *st_begin, *st_commit, *st_rollback;
static int epfd, lfd;
static struct timespec t_start;
static time_t now_s;            // wall clock, refreshed every loop iteration
static char date_hdr[64];       // "Date: ...\r\n", refreshed when the second changes
static size_t date_len;
static long max_conns, open_conns;

/* ------------------------------------------------------------------ connections */
typedef struct conn {
  int fd; uint32_t gen;
  struct conn *prev, *next;     // LRU list of all open connections (head = least recently active)
  char *rbuf; uint32_t rlen, rcap;
  char *wbuf; uint32_t wlen, woff, wcap;
  uint8_t open, want_out, close_after, waiting; // waiting: a write request is queued for the group commit
} conn;
static conn *conns;  // indexed by fd
static conn lru = { .prev = &lru, .next = &lru };
static inline void lru_unlink(conn *c) { c->prev->next = c->next; c->next->prev = c->prev; }
static inline void lru_push(conn *c) { c->prev = lru.prev; c->next = &lru; lru.prev->next = c; lru.prev = c; }

static void conn_close(conn *c) {
  if (!c->open) return;
  lru_unlink(c);
  close(c->fd);   // close() also removes it from epoll
  c->open = 0; c->gen++;
  free(c->rbuf); c->rbuf = NULL; c->rlen = c->rcap = 0;
  free(c->wbuf); c->wbuf = NULL; c->wlen = c->woff = c->wcap = 0;
  open_conns--;
}

// Out-buffer: responses are built into a per-iteration scratch area then written; leftovers go to c->wbuf.
static char *ob; static size_t ob_len, ob_cap;
static inline void ob_need(size_t n) { if (ob_len + n > ob_cap) { while (ob_len + n > ob_cap) ob_cap *= 2; ob = realloc(ob, ob_cap); } }
static inline void ob_put(const void *s, size_t n) { ob_need(n); memcpy(ob + ob_len, s, n); ob_len += n; }
#define OB_LIT(s) ob_put(s, sizeof(s) - 1)
static inline void ob_int(int64_t v) {
  char t[24]; int i = 24; uint64_t u = v < 0 ? -(uint64_t)v : (uint64_t)v;
  do { t[--i] = '0' + u % 10; u /= 10; } while (u);
  if (v < 0) t[--i] = '-';
  ob_put(t + i, 24 - i);
}
static void ob_jstr(const unsigned char *s, int n) {   // JSON string with quotes, JSON.stringify-style escaping
  ob_need(2 + (size_t)n * 6);
  char *o = ob + ob_len; *o++ = '"';
  static const char hx[] = "0123456789abcdef";
  for (int i = 0; i < n; i++) {
    unsigned char c = s[i];
    if (likely(c >= 0x20 && c != '"' && c != '\\')) { *o++ = c; continue; }
    *o++ = '\\';
    switch (c) {
      case '"': *o++ = '"'; break; case '\\': *o++ = '\\'; break;
      case '\n': *o++ = 'n'; break; case '\r': *o++ = 'r'; break; case '\t': *o++ = 't'; break;
      case '\b': *o++ = 'b'; break; case '\f': *o++ = 'f'; break;
      default: *o++ = 'u'; *o++ = '0'; *o++ = '0'; *o++ = hx[c >> 4]; *o++ = hx[c & 15];
    }
  }
  *o++ = '"'; ob_len = o - ob;
}

// Response framing: we reserve space for the header, write the body, then fill the header in.
#define HDR_RESERVE 160
static size_t resp_start;
static void resp_begin(void) { resp_start = ob_len; ob_need(HDR_RESERVE); ob_len += HDR_RESERVE; }
static void resp_end(int status, int keep) {
  const char *st;
  switch (status) {
    case 200: st = "200 OK"; break; case 201: st = "201 Created"; break; case 400: st = "400 Bad Request"; break;
    case 401: st = "401 Unauthorized"; break; case 404: st = "404 Not Found"; break;
    case 503: st = "503 Service Unavailable"; break; default: st = "500 Internal Server Error";
  }
  size_t blen = ob_len - resp_start - HDR_RESERVE;
  char h[HDR_RESERVE];
  int hl = snprintf(h, sizeof h, "HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n%.*s%s\r\n",
                    st, blen, (int)date_len, date_hdr, keep ? "" : "Connection: close\r\n");
  char *dst = ob + resp_start + HDR_RESERVE - hl;
  memcpy(dst, h, hl);
  // slide header+body down to resp_start to keep the buffer contiguous
  memmove(ob + resp_start, dst, hl + blen);
  ob_len = resp_start + hl + blen;
}
static void resp_error(int status, const char *msg, int keep) {
  resp_begin(); OB_LIT("{\"error\":\""); ob_put(msg, strlen(msg)); OB_LIT("\"}"); resp_end(status, keep);
}

/* ------------------------------------------------------------------ handlers */
static void put_post_row(sqlite3_stmt *s) {
  OB_LIT("{\"id\":"); ob_int(sqlite3_column_int64(s, 0));
  OB_LIT(",\"body\":"); ob_jstr(sqlite3_column_text(s, 1), sqlite3_column_bytes(s, 1));
  OB_LIT(",\"created_at\":\""); ob_put(sqlite3_column_text(s, 2), sqlite3_column_bytes(s, 2));
  OB_LIT("\",\"author\":"); ob_jstr(sqlite3_column_text(s, 3), sqlite3_column_bytes(s, 3));
  OB_LIT(",\"like_count\":"); ob_int(sqlite3_column_int64(s, 4)); OB_LIT("}");
}
static void h_feed(int keep) {
  size_t mark = ob_len;
  resp_begin(); OB_LIT("{\"posts\":[");
  int rc, n = 0;
  while ((rc = sqlite3_step(st_feed)) == SQLITE_ROW) { if (n++) OB_LIT(","); put_post_row(st_feed); }
  sqlite3_reset(st_feed);
  if (rc != SQLITE_DONE) { ob_len = mark; resp_error(500, "internal server error", keep); return; }
  OB_LIT("]}"); resp_end(200, keep);
}
static void h_post(int64_t id, int keep) {
  sqlite3_bind_int64(st_post, 1, id);
  int rc = sqlite3_step(st_post);
  if (rc == SQLITE_ROW) { resp_begin(); OB_LIT("{\"post\":"); put_post_row(st_post); OB_LIT("}"); resp_end(200, keep); }
  else if (rc == SQLITE_DONE) resp_error(404, "post not found", keep);
  else resp_error(500, "internal server error", keep);
  sqlite3_reset(st_post);
}
static void h_health(int keep) {
  int rc = sqlite3_step(st_one); sqlite3_reset(st_one);
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  if (rc == SQLITE_ROW) {
    resp_begin(); OB_LIT("{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":"); ob_int(t.tv_sec - t_start.tv_sec); OB_LIT("}"); resp_end(200, keep);
  } else {
    const char *m = sqlite3_errmsg(db);
    resp_begin(); OB_LIT("{\"status\":\"degraded\",\"db\":\"unreachable\",\"error\":"); ob_jstr((const unsigned char*)m, strlen(m)); OB_LIT("}"); resp_end(503, keep);
  }
}

/* --- JWT */
typedef struct { int alg_ok; int64_t sub; int sub_ok; char *uname; long ulen; int uname_ok; int exp_bad; int nbf_bad; } jwtc;
static int cb_hdr(const char *k, long kl, jp *j, void *ud) {
  jwtc *c = ud;
  if (kl == 3 && !memcmp(k, "alg", 3)) {
    c->alg_ok = 0;
    if (j->p < j->e && *j->p == '"') { char b[16]; jp pr = *j; long l = jstring(&pr, NULL); if (l < 0) return -1;
      if (pr.p - j->p <= 16) { l = jstring(j, b); c->alg_ok = (l == 5 && !memcmp(b, "HS256", 5)); return 0; } }
    return 1;
  }
  return 1;
}
static int cb_pay(const char *k, long kl, jp *j, void *ud) {
  jwtc *c = ud;
  if (kl == 3 && !memcmp(k, "sub", 3)) {
    c->sub_ok = 0;
    if (*j->p != '"') return 1;
    char b[32]; jp pr = *j; if (jstring(&pr, NULL) < 0) return -1;
    if (pr.p - j->p > 22) { *j = pr; return 0; }
    long l = jstring(j, b);
    if (l < 1 || l > 18 || b[0] < '1' || b[0] > '9') return 0;
    int64_t v = 0; for (long i = 0; i < l; i++) { if (b[i] < '0' || b[i] > '9') return 0; v = v * 10 + (b[i] - '0'); }
    c->sub = v; c->sub_ok = 1; return 0;
  }
  if (kl == 8 && !memcmp(k, "username", 8)) {
    c->uname_ok = 0;
    if (*j->p != '"') return 1;
    long l = jstring(j, c->uname); if (l < 0) return -1;
    c->ulen = l; c->uname_ok = 1; return 0;
  }
  if ((kl == 3 && !memcmp(k, "exp", 3)) || (kl == 3 && !memcmp(k, "nbf", 3))) {
    int is_exp = k[0] == 'e';
    if (*j->p == '-' || (*j->p >= '0' && *j->p <= '9')) {
      double v; if (jnumber(j, &v)) return -1;
      if (is_exp) c->exp_bad = !((double)now_s < v); else c->nbf_bad = (double)now_s < v;
      return 0;
    }
    if (is_exp) c->exp_bad = 1; else c->nbf_bad = 1;   // non-numeric exp/nbf is invalid (jsonwebtoken semantics)
    return 1;
  }
  return 1;
}
// returns 0 ok, else HTTP 401 with *msg set. uname buffer must hold >= token length bytes.
static int auth(const char *h, size_t hl, int64_t *uid, char *uname, long *ulen, const char **msg) {
  if (!h || hl < 7 || memcmp(h, "Bearer ", 7)) { *msg = "missing bearer token"; return 401; }
  const char *t = h + 7; size_t tl = hl - 7;
  *msg = "invalid or expired token";
  const char *d1 = memchr(t, '.', tl); if (!d1) return 401;
  const char *d2 = memchr(d1 + 1, '.', t + tl - d1 - 1); if (!d2) return 401;
  if (memchr(d2 + 1, '.', t + tl - d2 - 1)) return 401;
  size_t sl = t + tl - d2 - 1;
  uint8_t sig[64], mac[32];
  if (sl != 43 || b64url_dec(d2 + 1, sl, sig) != 32) return 401;
  hmac_sha256((const uint8_t*)t, d2 - t, mac);
  uint8_t diff = 0; for (int i = 0; i < 32; i++) diff |= sig[i] ^ mac[i];
  if (diff) return 401;
  uint8_t *buf = (uint8_t*)uname;  // scratch: decoded header, then decoded payload
  long n = b64url_dec(t, d1 - t, buf); if (n < 0) return 401;
  jwtc c = {0};
  if (jdoc((char*)buf, n, cb_hdr, &c) != 0 || !c.alg_ok) return 401;
  uint8_t *pay = malloc(d2 - d1 + 4);
  n = b64url_dec(d1 + 1, d2 - d1 - 1, pay); if (n < 0) { free(pay); return 401; }
  c.uname = uname;
  int r = jdoc((char*)pay, n, cb_pay, &c);
  free(pay);
  if (r != 0 || c.exp_bad || c.nbf_bad) return 401;
  if (!c.sub_ok || !c.uname_ok) { *msg = "invalid token payload"; return 401; }
  *uid = c.sub; *ulen = c.ulen; return 0;
}

/* --- create-post body */
typedef struct { int state; char *out; long len; } bodyc; // state 0 absent, 1 string, 2 other
static int cb_body(const char *k, long kl, jp *j, void *ud) {
  bodyc *b = ud;
  if (kl == 4 && !memcmp(k, "body", 4)) {
    if (*j->p == '"') { long l = jstring(j, b->out); if (l < 0) return -1; b->len = l; b->state = 1; return 0; }
    b->state = 2; return 1;
  }
  return 1;
}
static int is_space_cp(uint32_t c) {
  return c==9||c==10||c==11||c==12||c==13||c==32||c==0xA0||c==0x1680||(c>=0x2000&&c<=0x200A)||c==0x2028||c==0x2029||c==0x202F||c==0x205F||c==0x3000||c==0xFEFF;
}
static uint32_t dec_cp(const unsigned char *s, long n, long i, int *len) { // lenient UTF-8 decode
  unsigned char c = s[i];
  if (c < 0x80) { *len = 1; return c; }
  int l = c >= 0xF0 ? 4 : c >= 0xE0 ? 3 : c >= 0xC0 ? 2 : 1;
  if (i + l > n) l = 1;
  uint32_t cp = l == 1 ? c : l == 2 ? c & 0x1f : l == 3 ? c & 0x0f : c & 0x07;
  for (int k = 1; k < l; k++) cp = cp << 6 | (s[i+k] & 0x3f);
  *len = l; return cp;
}
static void trim(char **s, long *n) {
  const unsigned char *p = (const unsigned char*)*s; long a = 0, b = *n; int l;
  while (a < b) { uint32_t c = dec_cp(p, b, a, &l); if (!is_space_cp(c)) break; a += l; }
  while (b > a) { long st = b - 1; while (st > a && (p[st] & 0xC0) == 0x80 && b - st < 4) st--;
    uint32_t c = dec_cp(p, b, st, &l); if (st + l != b || !is_space_cp(c)) break; b = st; }
  *s += a; *n = b - a;
}
static long cp_count(const char *s, long n) { long c = 0; for (long i = 0; i < n; i++) c += ((unsigned char)s[i] & 0xC0) != 0x80; return c; }

/* --- group-commit queue */
enum { J_POST = 1, J_LIKE = 2 };
typedef struct { int fd; uint32_t gen; int type; int keep; int64_t uid, pid; char *body; long blen; char *uname; long ulen;
                 int status; int64_t new_id; char created[40]; int already; } job;
static job *jobs; static int njobs, jobs_cap;
static job *job_new(void) { if (njobs == jobs_cap) { jobs_cap = jobs_cap ? jobs_cap * 2 : 256; jobs = realloc(jobs, jobs_cap * sizeof(job)); }
  job *j = &jobs[njobs++]; memset(j, 0, sizeof *j); return j; }

/* ------------------------------------------------------------------ HTTP request dispatch */
static int parse_id(const char *s, size_t n, int64_t *out) { // 1 ok, 0 invalid, -1 too large (cannot exist)
  if (n == 0) return 0;
  int64_t v = 0;
  for (size_t i = 0; i < n; i++) { if (s[i] < '0' || s[i] > '9') return 0; if (v > 100000000000000000LL) return -1; v = v * 10 + (s[i] - '0'); }
  if (v <= 0) return 0;
  *out = v; return 1;
}

// handles one complete request. returns 1 if the request was queued for group commit
static int dispatch(conn *c, const char *m, size_t ml, const char *path, size_t pl, const char *authh, size_t al,
                    const char *body, size_t bl, int keep) {
  const char *q = memchr(path, '?', pl); if (q) pl = q - path;
  int get = ml == 3 && !memcmp(m, "GET", 3), post = ml == 4 && !memcmp(m, "POST", 4);
  if (get && pl == 5 && !memcmp(path, "/feed", 5)) { h_feed(keep); return 0; }
  if (pl > 7 && !memcmp(path, "/posts/", 7)) {
    const char *idp = path + 7; size_t il = pl - 7;
    const char *sl = memchr(idp, '/', il);
    if (sl == idp) { resp_error(404, "not found", keep); return 0; }   // empty :id segment does not match the route
    if (!sl && get) {
      int64_t id; int r = parse_id(idp, il, &id);
      if (r == 0) resp_error(400, "invalid post id", keep); else if (r < 0) resp_error(404, "post not found", keep); else h_post(id, keep);
      return 0;
    }
    if (sl && post && (size_t)(idp + il - sl) == 5 && !memcmp(sl, "/like", 5)) {
      int64_t uid; long ulen; const char *msg; char *un = malloc(al + 8);
      if (auth(authh, al, &uid, un, &ulen, &msg)) { free(un); resp_error(401, msg, keep); return 0; }
      free(un);
      int64_t id; int r = parse_id(idp, sl - idp, &id);
      if (r == 0) { resp_error(400, "invalid post id", keep); return 0; }
      if (r < 0) { resp_error(404, "post not found", keep); return 0; }
      job *j = job_new(); j->fd = c->fd; j->gen = c->gen; j->type = J_LIKE; j->keep = keep; j->uid = uid; j->pid = id;
      return 1;
    }
  }
  if (post && pl == 6 && !memcmp(path, "/posts", 6)) {
    int64_t uid; long ulen; const char *msg; char *un = malloc(al + 8);
    if (auth(authh, al, &uid, un, &ulen, &msg)) { free(un); resp_error(401, msg, keep); return 0; }
    char *bbuf = malloc(bl + 8);
    bodyc b = { 0, bbuf, 0 };
    int r = jdoc(body, bl, cb_body, &b);
    if (r < 0) { free(un); free(bbuf); resp_error(400, "malformed JSON body", keep); return 0; }
    char *s = bbuf; long n = b.len;
    if (b.state == 1) trim(&s, &n);
    if (b.state != 1 || n == 0) { free(un); free(bbuf); resp_error(400, "body is required", keep); return 0; }
    if (cp_count(s, n) > 500) { free(un); free(bbuf); resp_error(400, "body must be at most 500 characters", keep); return 0; }
    job *j = job_new(); j->fd = c->fd; j->gen = c->gen; j->type = J_POST; j->keep = keep; j->uid = uid;
    memmove(bbuf, s, n); j->body = bbuf; j->blen = n; j->uname = un; j->ulen = ulen;
    return 1;
  }
  if (get && pl == 7 && !memcmp(path, "/health", 7)) { h_health(keep); return 0; }
  resp_error(404, "not found", keep);
  return 0;
}

static inline int hdr_is(const char *s, size_t n, const char *name, size_t nl) {
  if (n != nl) return 0;
  for (size_t i = 0; i < n; i++) if ((s[i] | 32) != name[i]) return 0;
  return 1;
}

// Parse and handle as many complete requests in buf as possible (stops after a queued write, to keep order).
// Returns bytes consumed, or -1 on a protocol error (connection should close).
static long process(conn *c, const char *buf, size_t n) {
  size_t off = 0;
  while (off < n && !c->waiting && !c->close_after) {
    const char *s = buf + off; size_t avail = n - off;
    const char *he = memmem(s, avail, "\r\n\r\n", 4);
    if (!he) { if (avail > 65536) return -1; break; }
    const char *le = memchr(s, '\r', he + 2 - s);
    // request line
    const char *sp1 = memchr(s, ' ', le - s); if (!sp1) return -1;
    const char *sp2 = memchr(sp1 + 1, ' ', le - sp1 - 1); if (!sp2) return -1;
    int http10 = (le - sp2 - 1) == 8 && !memcmp(sp2 + 1, "HTTP/1.0", 8);
    int keep = !http10; size_t clen = 0; const char *authh = NULL; size_t al = 0;
    const char *h = le + 2;
    while (h < he + 2) {
      const char *e = memchr(h, '\r', he + 2 - h); if (!e) break;
      const char *col = memchr(h, ':', e - h);
      if (col) {
        size_t nl = col - h; const char *v = col + 1; while (v < e && (*v == ' ' || *v == '\t')) v++;
        const char *ve = e; while (ve > v && (ve[-1] == ' ' || ve[-1] == '\t')) ve--;
        if (hdr_is(h, nl, "content-length", 14)) { clen = 0; for (const char *p = v; p < ve; p++) { if (*p < '0' || *p > '9') return -1; clen = clen * 10 + (*p - '0'); if (clen > 1 << 20) return -1; } }
        else if (hdr_is(h, nl, "authorization", 13)) { authh = v; al = ve - v; }
        else if (hdr_is(h, nl, "connection", 10)) { if (ve - v == 5 && !strncasecmp(v, "close", 5)) keep = 0; else if (ve - v == 10 && !strncasecmp(v, "keep-alive", 10)) keep = 1; }
        else if (hdr_is(h, nl, "transfer-encoding", 17)) return -1;  // chunked uploads are not supported
      }
      h = e + 2;
    }
    size_t hlen = he + 4 - s;
    if (avail < hlen + clen) break;
    int queued = dispatch(c, s, sp1 - s, sp1 + 1, sp2 - sp1 - 1, authh, al, he + 4, clen, keep);
    if (queued) c->waiting = 1;
    if (!keep) c->close_after = 1;
    off += hlen + clen;
  }
  return (long)off;
}

static void flush_conn(conn *c, const char *data, size_t n) {
  // write pending wbuf first, then data
  if (c->wlen > c->woff) {
    if (n) { if (c->wlen + n > c->wcap) { c->wcap = c->wlen + n + 1024; c->wbuf = realloc(c->wbuf, c->wcap); } memcpy(c->wbuf + c->wlen, data, n); c->wlen += n; }
    data = c->wbuf + c->woff; n = c->wlen - c->woff;
  }
  while (n) {
    ssize_t w = send(c->fd, data, n, MSG_NOSIGNAL);
    if (w > 0) { data += w; n -= w; continue; }
    if (w < 0 && errno == EINTR) continue;
    if (w < 0 && errno == EAGAIN) break;
    conn_close(c); return;
  }
  if (n) {
    if (data < c->wbuf || data >= c->wbuf + c->wcap) { // data is from the scratch buffer
      if (n > c->wcap) { c->wcap = n + 1024; free(c->wbuf); c->wbuf = malloc(c->wcap); }
      memcpy(c->wbuf, data, n); c->woff = 0; c->wlen = n;
    } else { c->woff = data - c->wbuf; }
    if (!c->want_out) { struct epoll_event ev = { .events = EPOLLIN | EPOLLOUT | EPOLLRDHUP, .data.fd = c->fd }; epoll_ctl(epfd, EPOLL_CTL_MOD, c->fd, &ev); c->want_out = 1; }
  } else {
    c->woff = c->wlen = 0;
    if (c->want_out) { struct epoll_event ev = { .events = EPOLLIN | EPOLLRDHUP, .data.fd = c->fd }; epoll_ctl(epfd, EPOLL_CTL_MOD, c->fd, &ev); c->want_out = 0; }
    if (c->close_after && !c->waiting) conn_close(c);
  }
}

static char rbuf_global[65536];
static void on_readable(conn *c) {
  if (c->waiting) return;  // level-triggered: will be revisited after the commit
  ssize_t r;
  char *buf; size_t n;
  if (c->rlen == 0) {
    r = recv(c->fd, rbuf_global, sizeof rbuf_global, 0);
    if (r <= 0) { if (r < 0 && (errno == EAGAIN || errno == EINTR)) return; conn_close(c); return; }
    buf = rbuf_global; n = r;
  } else {
    if (c->rcap - c->rlen < 16384) { c->rcap = c->rcap * 2 + 16384; c->rbuf = realloc(c->rbuf, c->rcap); }
    r = recv(c->fd, c->rbuf + c->rlen, c->rcap - c->rlen, 0);
    if (r <= 0) { if (r < 0 && (errno == EAGAIN || errno == EINTR)) return; conn_close(c); return; }
    c->rlen += r; buf = c->rbuf; n = c->rlen;
  }
  lru_unlink(c); lru_push(c);
  size_t mark = ob_len;
  long used = process(c, buf, n);
  if (used < 0) { conn_close(c); return; }
  size_t left = n - used;
  if (buf == rbuf_global) {
    if (left) { if (c->rcap < left + 16384) { c->rcap = left + 16384; c->rbuf = realloc(c->rbuf, c->rcap); } memcpy(c->rbuf, buf + used, left); c->rlen = left; }
  } else {
    if (left && used) memmove(c->rbuf, c->rbuf + used, left);
    c->rlen = left;
    if (!left && c->rcap > 65536) { free(c->rbuf); c->rbuf = NULL; c->rcap = 0; }
  }
  if (ob_len > mark) { flush_conn(c, ob + mark, ob_len - mark); }
  else if (c->close_after && !c->waiting && c->wlen == c->woff) conn_close(c);
  ob_len = mark;
}

/* ------------------------------------------------------------------ group commit */
static void run_jobs(void) {
  if (!njobs) return;
  int ok = sqlite3_step(st_begin) == SQLITE_DONE; sqlite3_reset(st_begin);
  if (ok) {
    for (int i = 0; i < njobs; i++) {
      job *j = &jobs[i];
      if (j->type == J_POST) {
        sqlite3_bind_int64(st_ins_post, 1, j->uid);
        sqlite3_bind_text(st_ins_post, 2, j->body, j->blen, SQLITE_STATIC);
        if (sqlite3_step(st_ins_post) == SQLITE_ROW) {
          j->new_id = sqlite3_column_int64(st_ins_post, 0);
          int cl = sqlite3_column_bytes(st_ins_post, 1); if (cl > 39) cl = 39;
          memcpy(j->created, sqlite3_column_text(st_ins_post, 1), cl); j->created[cl] = 0;
          j->status = 201;
          while (sqlite3_step(st_ins_post) == SQLITE_ROW) {}
        } else j->status = 500;
        sqlite3_reset(st_ins_post);
      } else {
        sqlite3_bind_int64(st_exists, 1, j->pid);
        int rc = sqlite3_step(st_exists); sqlite3_reset(st_exists);
        if (rc == SQLITE_DONE) { j->status = 404; continue; }
        if (rc != SQLITE_ROW) { j->status = 500; continue; }
        sqlite3_bind_int64(st_ins_like, 1, j->uid); sqlite3_bind_int64(st_ins_like, 2, j->pid);
        rc = sqlite3_step(st_ins_like); sqlite3_reset(st_ins_like);
        if (rc != SQLITE_DONE) { j->status = 500; continue; }
        j->already = sqlite3_changes(db) == 0;
        j->status = j->already ? 200 : 201;
      }
    }
    ok = sqlite3_step(st_commit) == SQLITE_DONE; sqlite3_reset(st_commit);
    if (!ok) { sqlite3_step(st_rollback); sqlite3_reset(st_rollback); }
  }
  int cnt = njobs;
  for (int i = 0; i < cnt; i++) {
    job *j = &jobs[i];
    conn *c = &conns[j->fd];
    int live = c->open && c->gen == j->gen;
    size_t mark = ob_len;
    if (live) {
      if (!ok || j->status == 500) resp_error(500, "internal server error", j->keep);
      else if (j->status == 404) resp_error(404, "post not found", j->keep);
      else if (j->type == J_POST) {
        resp_begin(); OB_LIT("{\"post\":{\"id\":"); ob_int(j->new_id);
        OB_LIT(",\"body\":"); ob_jstr((unsigned char*)j->body, j->blen);
        OB_LIT(",\"created_at\":\""); ob_put(j->created, strlen(j->created));
        OB_LIT("\",\"author\":"); ob_jstr((unsigned char*)j->uname, j->ulen);
        OB_LIT(",\"like_count\":0}}"); resp_end(201, j->keep);
      } else {
        resp_begin(); OB_LIT("{\"liked\":true,\"already_liked\":"); if (j->already) OB_LIT("true"); else OB_LIT("false");
        OB_LIT(",\"post_id\":"); ob_int(j->pid); OB_LIT("}"); resp_end(j->status, j->keep);
      }
    }
    free(j->body); free(j->uname); j->body = j->uname = NULL;
    if (!live) continue;
    c->waiting = 0;
    // pipelined requests that arrived behind the write (may queue new jobs -> realloc; j is not used after this)
    if (c->rlen && !c->close_after) {
      long used = process(c, c->rbuf, c->rlen);
      if (used < 0) c->close_after = 1;
      else { memmove(c->rbuf, c->rbuf + used, c->rlen - used); c->rlen -= used; }
    }
    flush_conn(c, ob + mark, ob_len - mark);
    ob_len = mark;
  }
}

/* ------------------------------------------------------------------ checkpoint thread */
static const char *db_path;
static void *ckpt_thread(void *arg) {
  (void)arg;
  setpriority(PRIO_PROCESS, 0, 10);  // per-thread nice: the request loop wins the CPU
  sqlite3 *cdb;
  if (sqlite3_open_v2(db_path, &cdb, SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX, NULL) != SQLITE_OK) return NULL;
  sqlite3_busy_timeout(cdb, 1000);
  sqlite3_exec(cdb, "PRAGMA synchronous=NORMAL", NULL, NULL, NULL);
  for (;;) {
    usleep(200 * 1000);
    int logf = 0, ck = 0;
    sqlite3_wal_checkpoint_v2(cdb, NULL, SQLITE_CHECKPOINT_PASSIVE, &logf, &ck);
  }
  return NULL;
}

/* ------------------------------------------------------------------ main */
static void prep(sqlite3_stmt **s, const char *sql) {
  if (sqlite3_prepare_v3(db, sql, -1, SQLITE_PREPARE_PERSISTENT, s, NULL) != SQLITE_OK) { fprintf(stderr, "prepare: %s: %s\n", sql, sqlite3_errmsg(db)); exit(1); }
}
static void update_clock(void) {
  time_t t = time(NULL);
  if (t != now_s) {
    now_s = t; struct tm tm; gmtime_r(&t, &tm);
    date_len = strftime(date_hdr, sizeof date_hdr, "Date: %a, %d %b %Y %H:%M:%S GMT\r\n", &tm);
  }
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  clock_gettime(CLOCK_MONOTONIC, &t_start);
  db_path = getenv("SQLITE_PATH"); if (!db_path) db_path = "feed.db";
  const char *secret = getenv("JWT_SECRET"); if (!secret) secret = "twelve-dollar-challenge";
  const char *host = getenv("HOST"); if (!host) host = "0.0.0.0";
  int port = getenv("PORT") ? atoi(getenv("PORT")) : 3000;
  hmac_setup(secret, strlen(secret)); b64_setup();

  struct rlimit rl; getrlimit(RLIMIT_NOFILE, &rl); rl.rlim_cur = rl.rlim_max; setrlimit(RLIMIT_NOFILE, &rl);
  long fdmax = (long)rl.rlim_cur; if (fdmax > 1 << 20) fdmax = 1 << 20;
  max_conns = fdmax - 64;  // above this, the least recently active idle connections are closed
  if (getenv("MAX_CONNS")) max_conns = atol(getenv("MAX_CONNS"));
  conns = calloc(fdmax, sizeof(conn));

  // hint the OS to pull the database into its page cache (this is the kernel's cache, not ours)
  { int f = open(db_path, O_RDONLY); if (f >= 0) { posix_fadvise(f, 0, 0, POSIX_FADV_WILLNEED); close(f); } }

  if (sqlite3_open_v2(db_path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX, NULL) != SQLITE_OK) { fprintf(stderr, "open failed\n"); return 1; }
  sqlite3_busy_timeout(db, 5000);
  sqlite3_exec(db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0;"
                   "PRAGMA mmap_size=1073741824; PRAGMA cache_size=-65536; PRAGMA temp_store=MEMORY;", NULL, NULL, NULL);
  prep(&st_feed, "SELECT p.id, p.body, p.created_at, u.username, (SELECT count(*) FROM likes l WHERE l.post_id = p.id) "
                 "FROM posts p JOIN users u ON u.id = p.user_id ORDER BY p.created_at DESC, p.id DESC LIMIT 20");
  prep(&st_post, "SELECT p.id, p.body, p.created_at, u.username, (SELECT count(*) FROM likes l WHERE l.post_id = p.id) "
                 "FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?");
  prep(&st_ins_post, "INSERT INTO posts (user_id, body) VALUES (?, ?) RETURNING id, created_at");
  prep(&st_exists, "SELECT 1 FROM posts WHERE id = ?");
  prep(&st_ins_like, "INSERT INTO likes (user_id, post_id) VALUES (?, ?) ON CONFLICT (user_id, post_id) DO NOTHING");
  prep(&st_one, "SELECT 1");
  prep(&st_begin, "BEGIN IMMEDIATE"); prep(&st_commit, "COMMIT"); prep(&st_rollback, "ROLLBACK");
  pthread_t th; pthread_create(&th, NULL, ckpt_thread, NULL);

  lfd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0);
  int one = 1; setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  struct sockaddr_in sa = { .sin_family = AF_INET, .sin_port = htons(port) };
  inet_pton(AF_INET, host, &sa.sin_addr);
  if (bind(lfd, (struct sockaddr*)&sa, sizeof sa) || listen(lfd, 65535)) { perror("bind/listen"); return 1; }
  epfd = epoll_create1(0);
  struct epoll_event ev = { .events = EPOLLIN, .data.fd = lfd }; epoll_ctl(epfd, EPOLL_CTL_ADD, lfd, &ev);
  ob_cap = 1 << 20; ob = malloc(ob_cap);
  fprintf(stderr, "listening on %s:%d, max_conns=%ld\n", host, port, max_conns);

  enum { MAXEV = 1024 }; struct epoll_event evs[MAXEV];
  for (;;) {
    int n = epoll_wait(epfd, evs, MAXEV, njobs ? 0 : 1000);
    update_clock();
    for (int i = 0; i < n; i++) {
      int fd = evs[i].data.fd;
      if (fd == lfd) {
        for (int k = 0; k < 512; k++) {
          int cfd = accept4(lfd, NULL, NULL, SOCK_NONBLOCK);
          if (cfd < 0) {
            if (errno == EMFILE || errno == ENFILE) { // shed the least recently active idle connections
              int shed = 0; for (conn *c = lru.next; c != &lru && shed < 64; ) { conn *nx = c->next; if (!c->waiting && c->wlen == c->woff) { conn_close(c); shed++; } c = nx; }
              if (shed) continue;
            }
            break;
          }
          if (cfd >= fdmax) { close(cfd); continue; }
          setsockopt(cfd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
          conn *c = &conns[cfd]; c->fd = cfd; c->open = 1; c->want_out = 0; c->close_after = 0; c->waiting = 0;
          lru_push(c); open_conns++;
          struct epoll_event ce = { .events = EPOLLIN | EPOLLRDHUP, .data.fd = cfd }; epoll_ctl(epfd, EPOLL_CTL_ADD, cfd, &ce);
          while (open_conns > max_conns) { // evict the least recently active idle connection
            conn *v = lru.next; while (v != &lru && (v->waiting || v->wlen != v->woff || v->rlen)) v = v->next;
            if (v == &lru || v == c) break; conn_close(v);
          }
        }
        continue;
      }
      conn *c = &conns[fd];
      if (!c->open) continue;
      uint32_t e = evs[i].events;
      if (e & EPOLLOUT) { flush_conn(c, NULL, 0); if (!c->open) continue; }
      if (e & (EPOLLIN | EPOLLRDHUP | EPOLLHUP | EPOLLERR)) on_readable(c);
    }
    if (njobs) {
      int cnt = njobs;
      run_jobs();
      // run_jobs may have queued more jobs (pipelined requests) after index cnt
      if (njobs > cnt) { memmove(jobs, jobs + cnt, (njobs - cnt) * sizeof(job)); njobs -= cnt; } else njobs = 0;
    }
  }
}
