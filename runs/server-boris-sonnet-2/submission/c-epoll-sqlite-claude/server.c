// $12 server: single-threaded epoll HTTP/1.1 server + SQLite (libsqlite3), direct on the port.
// One vCPU => one thread, no locks.  Writes are group-committed once per event-loop batch and
// every write response is sent only after COMMIT.  No data is cached across requests.
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
#include <strings.h>
#include <sys/epoll.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

/* ---------------------------------------------------------------- SHA256 / HMAC */
typedef struct { uint32_t h[8]; uint8_t buf[64]; uint64_t len; size_t n; } sha_t;
static const uint32_t K[64] = {
0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
#define ROR(x,n) (((x)>>(n))|((x)<<(32-(n))))
static void sha_block(sha_t *s, const uint8_t *p) {
  uint32_t w[64], a,b,c,d,e,f,g,h;
  for (int i = 0; i < 16; i++) w[i] = (uint32_t)p[4*i]<<24|(uint32_t)p[4*i+1]<<16|(uint32_t)p[4*i+2]<<8|p[4*i+3];
  for (int i = 16; i < 64; i++) {
    uint32_t s0 = ROR(w[i-15],7)^ROR(w[i-15],18)^(w[i-15]>>3), s1 = ROR(w[i-2],17)^ROR(w[i-2],19)^(w[i-2]>>10);
    w[i] = w[i-16]+s0+w[i-7]+s1;
  }
  a=s->h[0];b=s->h[1];c=s->h[2];d=s->h[3];e=s->h[4];f=s->h[5];g=s->h[6];h=s->h[7];
  for (int i = 0; i < 64; i++) {
    uint32_t t1 = h+(ROR(e,6)^ROR(e,11)^ROR(e,25))+((e&f)^(~e&g))+K[i]+w[i];
    uint32_t t2 = (ROR(a,2)^ROR(a,13)^ROR(a,22))+((a&b)^(a&c)^(b&c));
    h=g;g=f;f=e;e=d+t1;d=c;c=b;b=a;a=t1+t2;
  }
  s->h[0]+=a;s->h[1]+=b;s->h[2]+=c;s->h[3]+=d;s->h[4]+=e;s->h[5]+=f;s->h[6]+=g;s->h[7]+=h;
}
static void sha_init(sha_t *s) {
  static const uint32_t i[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
  memcpy(s->h, i, 32); s->len = 0; s->n = 0;
}
static void sha_upd(sha_t *s, const uint8_t *p, size_t n) {
  s->len += n;
  while (n) {
    size_t k = 64 - s->n; if (k > n) k = n;
    if (s->n == 0 && n >= 64) { sha_block(s, p); p += 64; n -= 64; continue; }
    memcpy(s->buf + s->n, p, k); s->n += k; p += k; n -= k;
    if (s->n == 64) { sha_block(s, s->buf); s->n = 0; }
  }
}
static void sha_fin(sha_t *s, uint8_t out[32]) {
  uint64_t bits = s->len * 8; uint8_t pad = 0x80;
  sha_upd(s, &pad, 1); pad = 0;
  while (s->n != 56) sha_upd(s, &pad, 1);
  uint8_t l[8]; for (int i = 0; i < 8; i++) l[i] = bits >> (56 - 8*i);
  sha_upd(s, l, 8);
  for (int i = 0; i < 8; i++) { out[4*i]=s->h[i]>>24; out[4*i+1]=s->h[i]>>16; out[4*i+2]=s->h[i]>>8; out[4*i+3]=s->h[i]; }
}
static sha_t ipad_ctx, opad_ctx; /* precomputed HMAC key states (key is config, not data) */
static void hmac_setup(const char *key, size_t kl) {
  uint8_t k[64] = {0}, ip[64], op[64];
  if (kl > 64) { sha_t s; sha_init(&s); sha_upd(&s, (const uint8_t*)key, kl); sha_fin(&s, k); }
  else memcpy(k, key, kl);
  for (int i = 0; i < 64; i++) { ip[i] = k[i]^0x36; op[i] = k[i]^0x5c; }
  sha_init(&ipad_ctx); sha_upd(&ipad_ctx, ip, 64);
  sha_init(&opad_ctx); sha_upd(&opad_ctx, op, 64);
}
static void hmac(const uint8_t *m, size_t n, uint8_t out[32]) {
  sha_t s = ipad_ctx; uint8_t in[32];
  sha_upd(&s, m, n); sha_fin(&s, in);
  s = opad_ctx; sha_upd(&s, in, 32); sha_fin(&s, out);
}

/* ---------------------------------------------------------------- base64url */
static int8_t B64[256];
static void b64_init(void) {
  memset(B64, -1, sizeof B64);
  const char *a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (int i = 0; i < 64; i++) B64[(uint8_t)a[i]] = i;
}
/* decode unpadded base64url; returns length or -1 */
static int b64_dec(const char *s, size_t n, uint8_t *out) {
  if (n % 4 == 1) return -1;
  size_t o = 0; uint32_t acc = 0; int bits = 0;
  for (size_t i = 0; i < n; i++) {
    int v = B64[(uint8_t)s[i]]; if (v < 0) return -1;
    acc = acc << 6 | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = acc >> bits; acc &= (1u << bits) - 1; }
  }
  return (int)o;
}
static void b64_enc32(const uint8_t *in, char *out) { /* 32 bytes -> 43 chars */
  const char *a = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  int o = 0;
  for (int i = 0; i < 30; i += 3) {
    uint32_t v = in[i]<<16|in[i+1]<<8|in[i+2];
    out[o++]=a[v>>18]; out[o++]=a[(v>>12)&63]; out[o++]=a[(v>>6)&63]; out[o++]=a[v&63];
  }
  uint32_t v = in[30]<<16|in[31]<<8;
  out[o++]=a[v>>18]; out[o++]=a[(v>>12)&63]; out[o++]=a[(v>>6)&63];
}

/* ---------------------------------------------------------------- minimal strict JSON */
typedef struct { const char *p, *end; } jp_t;
static void jws(jp_t *j) { while (j->p < j->end && (*j->p==' '||*j->p=='\t'||*j->p=='\n'||*j->p=='\r')) j->p++; }
static int hex4(const char *p) {
  int v = 0;
  for (int i = 0; i < 4; i++) {
    char c = p[i]; v <<= 4;
    if (c>='0'&&c<='9') v |= c-'0'; else if (c>='a'&&c<='f') v |= c-'a'+10; else if (c>='A'&&c<='F') v |= c-'A'+10; else return -1;
  }
  return v;
}
static int put_utf8(uint32_t c, char *o) {
  if (c < 0x80) { o[0]=c; return 1; }
  if (c < 0x800) { o[0]=0xC0|c>>6; o[1]=0x80|(c&63); return 2; }
  if (c < 0x10000) { o[0]=0xE0|c>>12; o[1]=0x80|((c>>6)&63); o[2]=0x80|(c&63); return 3; }
  o[0]=0xF0|c>>18; o[1]=0x80|((c>>12)&63); o[2]=0x80|((c>>6)&63); o[3]=0x80|(c&63); return 4;
}
/* Parse string at j->p (the opening quote). If out != NULL decode into it (caller guarantees
   capacity >= raw length + 8, decoded text is never longer than the raw text). 0 ok, -1 malformed. */
static int jstr(jp_t *j, char *out, size_t *olen) {
  const char *p = j->p + 1; size_t o = 0;
  for (;;) {
    if (p >= j->end) return -1;
    uint8_t c = *p;
    if (c == '"') { p++; break; }
    if (c < 0x20) return -1;
    if (c == '\\') {
      if (++p >= j->end) return -1;
      char e = *p++; uint32_t cp;
      switch (e) {
        case '"': cp='"'; break; case '\\': cp='\\'; break; case '/': cp='/'; break;
        case 'b': cp='\b'; break; case 'f': cp='\f'; break; case 'n': cp='\n'; break;
        case 'r': cp='\r'; break; case 't': cp='\t'; break;
        case 'u': {
          if (j->end - p < 4) return -1;
          int h = hex4(p); if (h < 0) return -1;
          p += 4; cp = h;
          if (cp >= 0xD800 && cp < 0xDC00 && j->end - p >= 6 && p[0]=='\\' && p[1]=='u') {
            int l = hex4(p+2);
            if (l >= 0xDC00 && l < 0xE000) { cp = 0x10000 + ((cp-0xD800)<<10) + (l-0xDC00); p += 6; }
          }
          if (cp >= 0xD800 && cp < 0xE000) cp = 0xFFFD;
          break; }
        default: return -1;
      }
      if (out) o += put_utf8(cp, out + o);
    } else {
      if (out) out[o++] = c;
      p++;
    }
  }
  if (out) out[o] = 0;
  if (olen) *olen = o;
  j->p = p; return 0;
}
static int jnum(jp_t *j) {
  const char *p = j->p;
  if (p < j->end && *p == '-') p++;
  if (p >= j->end) return -1;
  if (*p == '0') p++;
  else if (*p >= '1' && *p <= '9') { while (p < j->end && *p >= '0' && *p <= '9') p++; }
  else return -1;
  if (p < j->end && *p == '.') { p++; if (p >= j->end || *p < '0' || *p > '9') return -1; while (p < j->end && *p >= '0' && *p <= '9') p++; }
  if (p < j->end && (*p == 'e' || *p == 'E')) {
    p++; if (p < j->end && (*p == '+' || *p == '-')) p++;
    if (p >= j->end || *p < '0' || *p > '9') return -1;
    while (p < j->end && *p >= '0' && *p <= '9') p++;
  }
  j->p = p; return 0;
}
static int jlit(jp_t *j, const char *s) {
  size_t n = strlen(s);
  if ((size_t)(j->end - j->p) < n || memcmp(j->p, s, n)) return -1;
  j->p += n; return 0;
}
static int jskip(jp_t *j, int depth) {
  if (depth > 64) return -1;
  jws(j);
  if (j->p >= j->end) return -1;
  switch (*j->p) {
    case '"': return jstr(j, NULL, NULL);
    case 't': return jlit(j, "true");
    case 'f': return jlit(j, "false");
    case 'n': return jlit(j, "null");
    case '[':
      j->p++; jws(j);
      if (j->p < j->end && *j->p == ']') { j->p++; return 0; }
      for (;;) {
        if (jskip(j, depth+1)) return -1;
        jws(j); if (j->p >= j->end) return -1;
        if (*j->p == ',') { j->p++; continue; }
        if (*j->p == ']') { j->p++; return 0; }
        return -1;
      }
    case '{':
      j->p++; jws(j);
      if (j->p < j->end && *j->p == '}') { j->p++; return 0; }
      for (;;) {
        jws(j); if (j->p >= j->end || *j->p != '"' || jstr(j, NULL, NULL)) return -1;
        jws(j); if (j->p >= j->end || *j->p != ':') return -1;
        j->p++;
        if (jskip(j, depth+1)) return -1;
        jws(j); if (j->p >= j->end) return -1;
        if (*j->p == ',') { j->p++; continue; }
        if (*j->p == '}') { j->p++; return 0; }
        return -1;
      }
    default: return jnum(j);
  }
}
/* Top-level scan: validates the whole document; for wanted top-level keys records the last value. */
enum { T_ABSENT = 0, T_STR, T_NUM, T_OTHER };
typedef struct { int type; char *s; size_t slen; double num; } jfield_t;
/* returns 0 ok (document valid), -1 malformed. *is_obj set if the top level is an object. */
static int jscan(const char *data, size_t n, const char *const *keys, jfield_t *f, int nk, char *sbuf, int *is_obj) {
  jp_t j = { data, data + n };
  *is_obj = 0;
  jws(&j);
  if (j.p >= j.end) return -1;
  if (*j.p != '{') { if (jskip(&j, 0)) return -1; jws(&j); return j.p == j.end ? 0 : -1; }
  *is_obj = 1;
  j.p++; jws(&j);
  size_t soff = 0;
  if (j.p < j.end && *j.p == '}') { j.p++; goto done; }
  for (;;) {
    jws(&j); if (j.p >= j.end || *j.p != '"') return -1;
    char key[24]; size_t kl = 0; int match = -1;
    {
      jp_t kj = j;
      if (jstr(&kj, NULL, NULL)) return -1;
      size_t raw = (size_t)(kj.p - j.p);
      if (raw <= 18) {
        char tmp[32];
        if (jstr(&j, tmp, &kl)) return -1;
        memcpy(key, tmp, kl < 23 ? kl : 23);
        for (int i = 0; i < nk; i++) if (strlen(keys[i]) == kl && !memcmp(keys[i], tmp, kl)) match = i;
      } else j = kj;
    }
    jws(&j); if (j.p >= j.end || *j.p != ':') return -1;
    j.p++; jws(&j); if (j.p >= j.end) return -1;
    if (match >= 0) {
      jfield_t *x = &f[match];
      if (*j.p == '"') {
        char *dst = sbuf + soff; size_t l;
        const char *st = j.p;
        if (jstr(&j, dst, &l)) return -1;
        soff += l + 8 + (size_t)(j.p - st); /* keep buffers disjoint (decoded <= raw) */
        x->type = T_STR; x->s = dst; x->slen = l;
      } else if (*j.p == '-' || (*j.p >= '0' && *j.p <= '9')) {
        const char *st = j.p;
        if (jnum(&j)) return -1;
        char t[64]; size_t l = (size_t)(j.p - st); if (l > 63) l = 63;
        memcpy(t, st, l); t[l] = 0;
        x->type = T_NUM; x->num = strtod(t, NULL);
      } else { if (jskip(&j, 1)) return -1; x->type = T_OTHER; }
    } else if (jskip(&j, 1)) return -1;
    jws(&j); if (j.p >= j.end) return -1;
    if (*j.p == ',') { j.p++; continue; }
    if (*j.p == '}') { j.p++; break; }
    return -1;
  }
done:
  jws(&j);
  return j.p == j.end ? 0 : -1;
}

/* ---------------------------------------------------------------- globals */
static sqlite3 *db;
static sqlite3_stmt *st_ids, *st_range, *st_likes, *st_begin_r, *st_feed, *st_post, *st_ins_post, *st_exists, *st_like, *st_health, *st_begin, *st_commit, *st_rollback;
static time_t start_time, now_s;
static int in_txn;   /* a write is pending in the open transaction */
static int txn_open; /* any transaction (read or write) is open */
static int batch_n;  /* events in the current epoll batch */
static volatile sig_atomic_t stop_flag;

#define OBUF_SZ (512 * 1024)
#define HDR_RES 160
static char obuf[OBUF_SZ];      /* response: header written right-aligned before body at HDR_RES */
static char tokbuf[80000];      /* decoded JWT parts / JSON strings */

/* ---------------------------------------------------------------- response building */
static char *bp;                /* write cursor of body */
static inline void put(const char *s, size_t n) { memcpy(bp, s, n); bp += n; }
#define PUTL(lit) put(lit, sizeof(lit) - 1)
static void put_u64(uint64_t v) {
  char t[24]; int n = 0;
  do { t[n++] = '0' + v % 10; v /= 10; } while (v);
  while (n) *bp++ = t[--n];
}
static const uint8_t NEEDESC[256] = { [0 ... 31] = 1, ['"'] = 1, ['\\'] = 1 };
static void put_esc(const char *s, size_t n) {
  size_t i = 0, run = 0;
  while (i < n) {
    uint8_t c = s[i];
    if (!NEEDESC[c]) { i++; continue; }
    put(s + run, i - run);
    switch (c) {
      case '"': PUTL("\\\""); break; case '\\': PUTL("\\\\"); break;
      case '\n': PUTL("\\n"); break; case '\r': PUTL("\\r"); break; case '\t': PUTL("\\t"); break;
      case '\b': PUTL("\\b"); break; case '\f': PUTL("\\f"); break;
      default: { static const char hx[] = "0123456789abcdef"; PUTL("\\u00"); *bp++ = hx[c >> 4]; *bp++ = hx[c & 15]; }
    }
    i++; run = i;
  }
  put(s + run, n - run);
}
static void put_str(const char *lit) { put(lit, strlen(lit)); }
static void put_post_row(sqlite3_stmt *s) {
  PUTL("{\"id\":"); put_u64((uint64_t)sqlite3_column_int64(s, 0));
  PUTL(",\"body\":\""); put_esc((const char *)sqlite3_column_text(s, 1), (size_t)sqlite3_column_bytes(s, 1));
  PUTL("\",\"created_at\":\""); put_esc((const char *)sqlite3_column_text(s, 2), (size_t)sqlite3_column_bytes(s, 2));
  PUTL("\",\"author\":\""); put_esc((const char *)sqlite3_column_text(s, 3), (size_t)sqlite3_column_bytes(s, 3));
  PUTL("\",\"like_count\":"); put_u64((uint64_t)sqlite3_column_int64(s, 4));
  *bp++ = '}';
}
static int status_code;
static void err(int code, const char *msg) {
  status_code = code; bp = obuf + HDR_RES;
  PUTL("{\"error\":\""); put_str(msg); PUTL("\"}");
}
static const char *status_text(int c) {
  switch (c) {
    case 200: return "OK"; case 201: return "Created"; case 400: return "Bad Request"; case 401: return "Unauthorized";
    case 404: return "Not Found"; case 413: return "Payload Too Large"; case 503: return "Service Unavailable";
    default: return "Internal Server Error";
  }
}
/* finalize: returns pointer/len of the full HTTP message inside obuf */
static char *finish(size_t *total) {
  size_t blen = (size_t)(bp - (obuf + HDR_RES));
  char h[160];
  int hl = snprintf(h, sizeof h, "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %zu\r\n\r\n",
                    status_code, status_text(status_code), blen);
  char *start = obuf + HDR_RES - hl;
  memcpy(start, h, hl);
  *total = blen + hl;
  return start;
}

/* ---------------------------------------------------------------- application logic */
static int parse_id(const char *s, size_t n, int64_t *out) {
  if (n == 0 || n > 18) return 0;
  int64_t v = 0;
  for (size_t i = 0; i < n; i++) { if (s[i] < '0' || s[i] > '9') return 0; v = v * 10 + (s[i] - '0'); }
  if (v <= 0) return 0;
  *out = v; return 1;
}
/* 0 ok (uid/uname set), else error already written via err() */
static const char *g_uname; static size_t g_unamelen; static int64_t g_uid;
static int check_auth(const char *a, size_t al) {
  if (!a || al < 7 || memcmp(a, "Bearer ", 7)) { err(401, "missing bearer token"); return -1; }
  const char *t = a + 7; size_t tl = al - 7;
  while (tl && (t[tl-1] == ' ' || t[tl-1] == '\t')) tl--;
  const char *d1 = memchr(t, '.', tl);
  if (!d1) goto bad;
  const char *d2 = memchr(d1 + 1, '.', tl - (size_t)(d1 + 1 - t));
  if (!d2 || memchr(d2 + 1, '.', tl - (size_t)(d2 + 1 - t))) goto bad;
  size_t hl = (size_t)(d1 - t), pl = (size_t)(d2 - d1 - 1), sl = tl - (size_t)(d2 + 1 - t);
  if (sl != 43 || hl == 0 || pl == 0 || tl > 8000) goto bad;
  uint8_t mac[32]; char enc[43];
  hmac((const uint8_t *)t, (size_t)(d2 - t), mac);
  b64_enc32(mac, enc);
  { unsigned diff = 0; for (int i = 0; i < 43; i++) diff |= (unsigned char)enc[i] ^ (unsigned char)d2[1 + i]; if (diff) goto bad; }
  /* header */
  uint8_t *hb = (uint8_t *)tokbuf; int hn = b64_dec(t, hl, hb);
  if (hn < 0) goto bad;
  static const char *hk[] = { "alg" };
  jfield_t hf[1] = {{0}}; int isobj;
  if (jscan((char *)hb, (size_t)hn, hk, hf, 1, tokbuf + 32768, &isobj) || !isobj) goto bad;
  if (hf[0].type != T_STR || hf[0].slen != 5 || memcmp(hf[0].s, "HS256", 5)) goto bad;
  /* payload */
  char *pb = tokbuf + 16384; int pn = b64_dec(d1 + 1, pl, (uint8_t *)pb);
  if (pn < 0) goto bad;
  static const char *pk[] = { "sub", "username", "exp", "nbf" };
  jfield_t pf[4] = {{0}, {0}, {0}, {0}};
  if (jscan(pb, (size_t)pn, pk, pf, 4, tokbuf + 49152, &isobj) || !isobj) goto bad;
  if (pf[2].type == T_NUM && !(pf[2].num > (double)now_s)) goto bad;
  if (pf[2].type != T_ABSENT && pf[2].type != T_NUM) goto bad;
  if (pf[3].type == T_NUM && pf[3].num > (double)now_s) goto bad;
  if (pf[0].type != T_STR || !parse_id(pf[0].s, pf[0].slen, &g_uid) || pf[1].type != T_STR) { err(401, "invalid token payload"); return -1; }
  g_uname = pf[1].s; g_unamelen = pf[1].slen;
  return 0;
bad:
  err(401, "invalid or expired token"); return -1;
}

typedef struct conn conn_t;
static void defer_response(conn_t *c);   /* queue current obuf message for after-commit send */

static int step_simple(sqlite3_stmt *st) {
  sqlite3_reset(st);
  int rc = sqlite3_step(st); sqlite3_reset(st);
  return rc == SQLITE_DONE ? 0 : -1;
}
/* One read snapshot per batch: statements inside share a single BEGIN (saves ~5us each). */
static void begin_read(void) {
  if (!txn_open && step_simple(st_begin_r) == 0) txn_open = 1;
}
static int ensure_txn(void) {
  if (in_txn) return 0;
  if (!txn_open) { if (step_simple(st_begin)) return -1; txn_open = 1; }
  in_txn = 1; return 0;
}
static void db_error(void) { err(500, "internal server error"); }

static void h_health(void) {
  sqlite3_reset(st_health);
  int rc = sqlite3_step(st_health); sqlite3_reset(st_health);
  if (rc != SQLITE_ROW) {
    status_code = 503; bp = obuf + HDR_RES;
    PUTL("{\"status\":\"degraded\",\"db\":\"unreachable\",\"error\":\""); put_esc(sqlite3_errmsg(db), strlen(sqlite3_errmsg(db))); PUTL("\"}");
    return;
  }
  status_code = 200; bp = obuf + HDR_RES;
  PUTL("{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":"); put_u64((uint64_t)(now_s - start_time)); PUTL("}");
}
#define SPAN_MAX 40
static void h_feed_slow(void) {
  status_code = 200; bp = obuf + HDR_RES;
  PUTL("{\"posts\":[");
  int first = 1, rc;
  while ((rc = sqlite3_step(st_feed)) == SQLITE_ROW) {
    if (!first) *bp++ = ',';
    first = 0;
    put_post_row(st_feed);
  }
  sqlite3_reset(st_feed);
  if (rc != SQLITE_DONE) { db_error(); return; }
  PUTL("]}");
}
/* The 20 newest ids come from the covering index; their rows are contiguous in rowid space, so a
   single rowid-range scan (joined to users) and a single index range scan over likes replace
   ~60 independent B-tree descents.  Falls back to the plain query if the ids are spread out. */
static void h_feed(void) {
  begin_read();
  int64_t ids[20]; int n = 0, rc;
  while (n < 20 && (rc = sqlite3_step(st_ids)) == SQLITE_ROW) ids[n++] = sqlite3_column_int64(st_ids, 0);
  sqlite3_reset(st_ids);
  if (n == 0) { status_code = 200; bp = obuf + HDR_RES; PUTL("{\"posts\":[]}"); return; }
  int64_t lo = ids[0], hi = ids[0];
  for (int i = 1; i < n; i++) { if (ids[i] < lo) lo = ids[i]; if (ids[i] > hi) hi = ids[i]; }
  if (hi - lo >= SPAN_MAX) { h_feed_slow(); return; }
  struct { const char *body, *ts, *user; int bl, tl, ul; int64_t likes; } row[SPAN_MAX];
  static char scratch[SPAN_MAX * 640 + 4096]; size_t so = 0;
  char have[SPAN_MAX] = {0};
  sqlite3_bind_int64(st_range, 1, lo); sqlite3_bind_int64(st_range, 2, hi);
  while ((rc = sqlite3_step(st_range)) == SQLITE_ROW) {
    int k = (int)(sqlite3_column_int64(st_range, 0) - lo);
    int bl = sqlite3_column_bytes(st_range, 1), tl = sqlite3_column_bytes(st_range, 2), ul = sqlite3_column_bytes(st_range, 3);
    if (so + (size_t)bl + tl + ul + 8 > sizeof scratch) { sqlite3_reset(st_range); h_feed_slow(); return; }
    char *d = scratch + so;
    memcpy(d, sqlite3_column_text(st_range, 1), bl); row[k].body = d; row[k].bl = bl; d += bl;
    memcpy(d, sqlite3_column_text(st_range, 2), tl); row[k].ts = d; row[k].tl = tl; d += tl;
    memcpy(d, sqlite3_column_text(st_range, 3), ul); row[k].user = d; row[k].ul = ul; d += ul;
    so = (size_t)(d - scratch); row[k].likes = 0; have[k] = 1;
  }
  sqlite3_reset(st_range);
  if (rc != SQLITE_DONE) { db_error(); return; }
  sqlite3_bind_int64(st_likes, 1, lo); sqlite3_bind_int64(st_likes, 2, hi);
  while ((rc = sqlite3_step(st_likes)) == SQLITE_ROW) {
    int k = (int)(sqlite3_column_int64(st_likes, 0) - lo);
    if (k >= 0 && k < SPAN_MAX) row[k].likes = sqlite3_column_int64(st_likes, 1);
  }
  sqlite3_reset(st_likes);
  if (rc != SQLITE_DONE) { db_error(); return; }
  status_code = 200; bp = obuf + HDR_RES;
  PUTL("{\"posts\":[");
  for (int i = 0; i < n; i++) {
    int k = (int)(ids[i] - lo);
    if (!have[k]) { h_feed_slow(); return; }
    if (i) *bp++ = ',';
    PUTL("{\"id\":"); put_u64((uint64_t)ids[i]);
    PUTL(",\"body\":\""); put_esc(row[k].body, (size_t)row[k].bl);
    PUTL("\",\"created_at\":\""); put_esc(row[k].ts, (size_t)row[k].tl);
    PUTL("\",\"author\":\""); put_esc(row[k].user, (size_t)row[k].ul);
    PUTL("\",\"like_count\":"); put_u64((uint64_t)row[k].likes); *bp++ = '}';
  }
  PUTL("]}");
}
static void h_get_post(int64_t id) {
  if (batch_n > 1) begin_read(); /* a lone single-statement read is cheaper in autocommit */
  sqlite3_reset(st_post); sqlite3_bind_int64(st_post, 1, id);
  int rc = sqlite3_step(st_post);
  if (rc == SQLITE_ROW) {
    status_code = 200; bp = obuf + HDR_RES;
    PUTL("{\"post\":"); put_post_row(st_post); *bp++ = '}';
  } else if (rc == SQLITE_DONE) err(404, "post not found");
  else db_error();
  sqlite3_reset(st_post);
}
static inline int is_ws_cp(const uint8_t *p, size_t n, int *len) {
  /* whitespace as per JS String.prototype.trim */
  uint8_t c = p[0];
  if (c == ' ' || (c >= 9 && c <= 13)) { *len = 1; return 1; }
  if (c == 0xC2 && n >= 2 && p[1] == 0xA0) { *len = 2; return 1; }
  if (c == 0xE1 && n >= 3 && p[1] == 0x9A && p[2] == 0x80) { *len = 3; return 1; }
  if (c == 0xE2 && n >= 3) {
    if (p[1] == 0x80 && ((p[2] >= 0x80 && p[2] <= 0x8A) || p[2] == 0xA8 || p[2] == 0xA9 || p[2] == 0xAF)) { *len = 3; return 1; }
    if (p[1] == 0x81 && p[2] == 0x9F) { *len = 3; return 1; }
  }
  if (c == 0xE3 && n >= 3 && p[1] == 0x80 && p[2] == 0x80) { *len = 3; return 1; }
  if (c == 0xEF && n >= 3 && p[1] == 0xBB && p[2] == 0xBF) { *len = 3; return 1; }
  return 0;
}
static int is_ws_before(const uint8_t *base, size_t end, size_t *len) {
  /* whitespace code point ending at 'end' */
  for (int l = 1; l <= 3 && (size_t)l <= end; l++) {
    int dl;
    if (is_ws_cp(base + end - l, (size_t)l, &dl) && dl == l) { *len = (size_t)l; return 1; }
  }
  return 0;
}
static void h_create_post(conn_t *c, const char *body, size_t blen) {
  static const char *bk[] = { "body" };
  jfield_t bf[1] = {{0}}; int isobj;
  if (blen > 16384) { err(400, "malformed JSON body"); return; }
  if (jscan(body, blen, bk, bf, 1, tokbuf, &isobj)) { err(400, "malformed JSON body"); return; }
  if (bf[0].type != T_STR) { err(400, "body is required"); return; }
  const uint8_t *s = (const uint8_t *)bf[0].s; size_t n = bf[0].slen;
  size_t a = 0; int l;
  while (a < n && is_ws_cp(s + a, n - a, &l)) a += (size_t)l;
  size_t z = n; size_t wl;
  while (z > a && is_ws_before(s, z, &wl)) z -= wl;
  if (z == a) { err(400, "body is required"); return; }
  size_t chars = 0;
  for (size_t i = a; i < z; i++) chars += (s[i] & 0xC0) != 0x80;
  if (chars > 500) { err(400, "body must be at most 500 characters"); return; }
  if (ensure_txn()) { db_error(); return; }
  sqlite3_reset(st_ins_post);
  sqlite3_bind_int64(st_ins_post, 1, g_uid);
  sqlite3_bind_text(st_ins_post, 2, (const char *)s + a, (int)(z - a), SQLITE_STATIC);
  int rc = sqlite3_step(st_ins_post);
  if (rc != SQLITE_ROW) { sqlite3_reset(st_ins_post); db_error(); return; }
  status_code = 201; bp = obuf + HDR_RES;
  PUTL("{\"post\":{\"id\":"); put_u64((uint64_t)sqlite3_column_int64(st_ins_post, 0));
  PUTL(",\"body\":\""); put_esc((const char *)s + a, z - a);
  PUTL("\",\"created_at\":\""); put_esc((const char *)sqlite3_column_text(st_ins_post, 1), (size_t)sqlite3_column_bytes(st_ins_post, 1));
  PUTL("\",\"author\":\""); put_esc(g_uname, g_unamelen);
  PUTL("\",\"like_count\":0}}");
  sqlite3_reset(st_ins_post); /* completes the statement */
  defer_response(c);
}
static void h_like(conn_t *c, int64_t pid) {
  if (batch_n > 1) begin_read();
  sqlite3_reset(st_exists); sqlite3_bind_int64(st_exists, 1, pid);
  int rc = sqlite3_step(st_exists); sqlite3_reset(st_exists);
  if (rc == SQLITE_DONE) { err(404, "post not found"); return; }
  if (rc != SQLITE_ROW) { db_error(); return; }
  if (ensure_txn()) { db_error(); return; }
  sqlite3_reset(st_like);
  sqlite3_bind_int64(st_like, 1, g_uid); sqlite3_bind_int64(st_like, 2, pid);
  rc = sqlite3_step(st_like); sqlite3_reset(st_like);
  if (rc != SQLITE_DONE) { db_error(); return; }
  int fresh = sqlite3_changes(db) > 0;
  status_code = fresh ? 201 : 200; bp = obuf + HDR_RES;
  PUTL("{\"liked\":true,\"already_liked\":"); put_str(fresh ? "false" : "true");
  PUTL(",\"post_id\":"); put_u64((uint64_t)pid); *bp++ = '}';
  if (fresh || in_txn) defer_response(c);
}

/* returns nonzero if the response was deferred (sent after commit). Otherwise obuf holds it. */
static int deferred_flag;
static void route(conn_t *c, const char *m, size_t ml, const char *path, size_t pl,
                  const char *auth, size_t al, const char *body, size_t bl) {
  deferred_flag = 0;
  int64_t id;
  const char *q = memchr(path, '?', pl); if (q) pl = (size_t)(q - path);
  int get = ml == 3 && !memcmp(m, "GET", 3), post = ml == 4 && !memcmp(m, "POST", 4);
  if (get) {
    if (pl == 5 && !memcmp(path, "/feed", 5)) { h_feed(); return; }
    if (pl == 7 && !memcmp(path, "/health", 7)) { h_health(); return; }
    if (pl > 7 && !memcmp(path, "/posts/", 7) && !memchr(path + 7, '/', pl - 7)) {
      if (!parse_id(path + 7, pl - 7, &id)) { err(400, "invalid post id"); return; }
      h_get_post(id); return;
    }
  } else if (post) {
    if (pl == 6 && !memcmp(path, "/posts", 6)) {
      if (check_auth(auth, al)) return;
      h_create_post(c, body, bl); return;
    }
    if (pl > 12 && !memcmp(path, "/posts/", 7) && !memcmp(path + pl - 5, "/like", 5) && !memchr(path + 7, '/', pl - 12)) {
      if (check_auth(auth, al)) return;
      if (!parse_id(path + 7, pl - 12, &id)) { err(400, "invalid post id"); return; }
      h_like(c, id); return;
    }
  }
  err(404, "not found");
}

/* ---------------------------------------------------------------- connections */
struct conn {
  int fd;
  uint32_t len, cap;       /* buffered unparsed input */
  char *buf;
  uint32_t olen, ooff;     /* pending unsent output */
  char *out;
  uint8_t waiting, closing, wantout, sent100;
  struct conn *prev, *next; /* LRU list: head = idle longest */
};
static conn_t **conns; static int maxfd;
static int epfd;

static conn_t *lru_head, *lru_tail;
static void lru_unlink(conn_t *c) {
  if (c->prev) c->prev->next = c->next; else if (lru_head == c) lru_head = c->next;
  if (c->next) c->next->prev = c->prev; else if (lru_tail == c) lru_tail = c->prev;
  c->prev = c->next = NULL;
}
static void lru_touch(conn_t *c) {
  if (lru_tail == c) return;
  lru_unlink(c);
  c->prev = lru_tail; if (lru_tail) lru_tail->next = c; else lru_head = c;
  lru_tail = c;
}
static void conn_close(conn_t *c) {
  if (!c) return;
  lru_unlink(c);
  close(c->fd); conns[c->fd] = NULL;
  free(c->buf); free(c->out); free(c);
}
typedef struct { conn_t *c; char *msg; size_t len; } defer_t;
static defer_t *defers; static size_t ndefer, capdefer;
static void defer_response(conn_t *c) {
  size_t total; char *m = finish(&total);
  if (ndefer == capdefer) { capdefer = capdefer ? capdefer * 2 : 256; defers = realloc(defers, capdefer * sizeof *defers); }
  char *copy = malloc(total); memcpy(copy, m, total);
  defers[ndefer++] = (defer_t){ c, copy, total };
  c->waiting = 1; deferred_flag = 1;
}

/* send a message; on partial write stash the rest and switch to EPOLLOUT */
static void conn_send(conn_t *c, const char *m, size_t n) {
  if (c->olen) { /* output already queued: append */
    c->out = realloc(c->out, c->olen + n); memcpy(c->out + c->olen, m, n); c->olen += n; return;
  }
  ssize_t w = send(c->fd, m, n, MSG_NOSIGNAL);
  if (w == (ssize_t)n) return;
  if (w < 0) { if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) { c->closing = 2; return; } w = 0; }
  size_t rem = n - (size_t)w;
  c->out = realloc(c->out, rem); memcpy(c->out, m + w, rem); c->olen = (uint32_t)rem; c->ooff = 0;
  struct epoll_event ev = { .events = EPOLLOUT, .data.fd = c->fd };
  epoll_ctl(epfd, EPOLL_CTL_MOD, c->fd, &ev); c->wantout = 1;
}

static const char *find_hdr_end(const char *p, size_t n) {
  return n < 4 ? NULL : memmem(p, n, "\r\n\r\n", 4);
}
static int ieq(const char *a, size_t al, const char *lit) { size_t n = strlen(lit); return al == n && !strncasecmp(a, lit, n); }

/* Parse and answer as many complete requests as are in [p, p+n). Returns bytes consumed. */
static size_t process(conn_t *c, const char *p, size_t n) {
  size_t used = 0;
  while (used < n && !c->waiting && !c->closing && !c->olen) {
    const char *r = p + used; size_t rn = n - used;
    const char *he = find_hdr_end(r, rn);
    if (!he) {
      if (rn > 16384) { err(400, "bad request"); size_t t; char *m = finish(&t); conn_send(c, m, t); c->closing = 1; return n; }
      break;
    }
    size_t hlen = (size_t)(he - r) + 4;
    /* request line */
    const char *sp1 = memchr(r, ' ', hlen);
    if (!sp1) { err(400, "bad request"); size_t t; char *m = finish(&t); conn_send(c, m, t); c->closing = 1; return n; }
    const char *sp2 = memchr(sp1 + 1, ' ', (size_t)(r + hlen - sp1 - 1));
    const char *eol = memchr(r, '\r', hlen);
    if (!sp2 || sp2 > eol) { err(400, "bad request"); size_t t; char *m = finish(&t); conn_send(c, m, t); c->closing = 1; return n; }
    int http10 = (size_t)(eol - sp2 - 1) == 8 && !memcmp(sp2 + 1, "HTTP/1.0", 8);
    const char *auth = NULL; size_t al = 0; size_t clen = 0; int close_hdr = http10, expect = 0, chunked = 0;
    const char *h = eol + 2;
    while (h < he + 2 && h[0] != '\r') {
      const char *le = memchr(h, '\r', (size_t)(r + hlen - h));
      const char *colon = memchr(h, ':', (size_t)(le - h));
      if (colon) {
        size_t nl = (size_t)(colon - h);
        const char *v = colon + 1; while (v < le && (*v == ' ' || *v == '\t')) v++;
        const char *ve = le; while (ve > v && (ve[-1] == ' ' || ve[-1] == '\t')) ve--;
        size_t vl = (size_t)(ve - v);
        switch (nl) {
          case 13: if (ieq(h, nl, "authorization")) { auth = v; al = vl; } break;
          case 14: if (ieq(h, nl, "content-length")) { clen = 0; for (size_t i = 0; i < vl; i++) { if (v[i] < '0' || v[i] > '9') { clen = (size_t)-1; break; } clen = clen * 10 + (v[i] - '0'); if (clen > (1u << 24)) break; } } break;
          case 10: if (ieq(h, nl, "connection")) { if (vl == 5 && !strncasecmp(v, "close", 5)) close_hdr = 1; else if (vl == 10 && !strncasecmp(v, "keep-alive", 10)) close_hdr = 0; } break;
          case 6: if (ieq(h, nl, "expect")) expect = 1; break;
          case 17: if (ieq(h, nl, "transfer-encoding")) chunked = 1; break;
        }
      }
      h = le + 2;
    }
    if (chunked || clen == (size_t)-1 || clen > 65536) {
      err(clen > 65536 && clen != (size_t)-1 ? 413 : 400, clen > 65536 && clen != (size_t)-1 ? "payload too large" : "malformed JSON body");
      size_t t; char *m = finish(&t); conn_send(c, m, t); c->closing = 1; return n;
    }
    if (rn < hlen + clen) {
      if (expect && !c->sent100) { static const char cont[] = "HTTP/1.1 100 Continue\r\n\r\n"; conn_send(c, cont, sizeof cont - 1); c->sent100 = 1; }
      break;
    }
    c->sent100 = 0;
    route(c, r, (size_t)(sp1 - r), sp1 + 1, (size_t)(sp2 - sp1 - 1), auth, al, r + hlen, clen);
    used += hlen + clen;
    if (!deferred_flag) {
      size_t t; char *m = finish(&t);
      conn_send(c, m, t);
    }
    if (close_hdr) c->closing = 1; /* closes after pending responses flush */
  }
  return used;
}

static int evict_idle(void) {
  int tries = 0;
  for (conn_t *c = lru_head; c && tries < 16; c = c->next, tries++)
    if (!c->waiting && !c->olen) { conn_close(c); return 1; }
  return 0;
}
static char rbuf[65536 + 4096];
static void conn_input(conn_t *c, const char *data, size_t n, int from_cbuf) {
  size_t used = process(c, data, n);
  size_t left = n - used;
  if (from_cbuf) {
    if (left == 0) { free(c->buf); c->buf = NULL; c->len = c->cap = 0; }
    else { memmove(c->buf, c->buf + used, left); c->len = (uint32_t)left; }
  } else if (left) {
    if (left > c->cap) { c->buf = realloc(c->buf, left); c->cap = (uint32_t)left; }
    memcpy(c->buf, data + used, left); c->len = (uint32_t)left;
  }
}
static void conn_after(conn_t *c) { /* close if asked and nothing left to flush */
  if (c->closing && !c->waiting && !c->olen) conn_close(c);
}
static void on_readable(conn_t *c) {
  if (c->len) { /* partial request buffered: append */
    size_t room = sizeof rbuf;
    if (c->len + room > 200000) { conn_close(c); return; }
    c->buf = realloc(c->buf, c->len + room); c->cap = c->len + (uint32_t)room;
    ssize_t r = recv(c->fd, c->buf + c->len, room, 0);
    if (r <= 0) { if (r < 0 && (errno == EAGAIN || errno == EINTR)) return; conn_close(c); return; }
    c->len += (uint32_t)r;
    conn_input(c, c->buf, c->len, 1);
  } else {
    ssize_t r = recv(c->fd, rbuf, sizeof rbuf - 4096, 0);
    if (r <= 0) { if (r < 0 && (errno == EAGAIN || errno == EINTR)) return; conn_close(c); return; }
    conn_input(c, rbuf, (size_t)r, 0);
  }
  if (c->closing == 2 && !c->waiting) { conn_close(c); return; }
  conn_after(c);
}
static void on_writable(conn_t *c) {
  ssize_t w = send(c->fd, c->out + c->ooff, c->olen - c->ooff, MSG_NOSIGNAL);
  if (w < 0) { if (errno == EAGAIN || errno == EINTR) return; conn_close(c); return; }
  c->ooff += (uint32_t)w;
  if (c->ooff < c->olen) return;
  free(c->out); c->out = NULL; c->olen = c->ooff = 0; c->wantout = 0;
  struct epoll_event ev = { .events = EPOLLIN, .data.fd = c->fd };
  epoll_ctl(epfd, EPOLL_CTL_MOD, c->fd, &ev);
  if (c->closing) { conn_close(c); return; }
  if (c->len) { conn_input(c, c->buf, c->len, 1); conn_after(c); }
}

/* commit the batch, then release all deferred responses */
static void flush_batch(void) {
  while (ndefer || txn_open) {
    int ok = 1;
    if (txn_open) {
      sqlite3_reset(st_commit);
      int rc = sqlite3_step(st_commit); sqlite3_reset(st_commit);
      if (rc != SQLITE_DONE) {
        ok = 0; sqlite3_reset(st_rollback); sqlite3_step(st_rollback); sqlite3_reset(st_rollback);
      }
      txn_open = 0; in_txn = 0;
    }
    size_t cnt = ndefer; ndefer = 0;
    defer_t *d = defers; defers = NULL; capdefer = 0;
    static const char e500[] = "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: 34\r\n\r\n{\"error\":\"internal server error\"}\n";
    for (size_t i = 0; i < cnt; i++) {
      conn_t *c = d[i].c;
      c->waiting = 0;
      if (ok) conn_send(c, d[i].msg, d[i].len); else conn_send(c, e500, sizeof e500 - 1);
      free(d[i].msg);
      if (c->closing == 2 || (c->closing && !c->olen)) { conn_close(c); continue; }
      /* resume pipelined input that was held back (may defer again -> loop continues) */
      if (c->len && !c->olen) conn_input(c, c->buf, c->len, 1);
      if (c->closing == 2 || (c->closing && !c->waiting && !c->olen)) conn_close(c);
    }
    free(d);
  }
}

/* ---------------------------------------------------------------- setup */
static void sig_stop(int s) { (void)s; stop_flag = 1; }
static sqlite3_stmt *prep(const char *sql) {
  sqlite3_stmt *s;
  if (sqlite3_prepare_v3(db, sql, -1, SQLITE_PREPARE_PERSISTENT, &s, NULL) != SQLITE_OK) {
    fprintf(stderr, "prepare failed: %s\n  %s\n", sqlite3_errmsg(db), sql); exit(1);
  }
  return s;
}
static void exec(const char *sql) {
  char *e = NULL;
  if (sqlite3_exec(db, sql, NULL, NULL, &e) != SQLITE_OK) { fprintf(stderr, "exec failed: %s: %s\n", sql, e); exit(1); }
}
#define POST_SQL "SELECT p.id, p.body, p.created_at, u.username, " \
  "(SELECT count(*) FROM likes l WHERE l.post_id = p.id) AS like_count FROM posts p JOIN users u ON u.id = p.user_id "

int main(void) {
  const char *path = getenv("SQLITE_PATH"), *secret = getenv("JWT_SECRET");
  const char *host = getenv("HOST"), *port = getenv("PORT");
  if (!path || !secret) { fprintf(stderr, "SQLITE_PATH and JWT_SECRET required\n"); return 1; }
  if (!host) host = "0.0.0.0";
  if (!port) port = "3000";
  signal(SIGPIPE, SIG_IGN); signal(SIGTERM, sig_stop); signal(SIGINT, sig_stop);
  b64_init(); hmac_setup(secret, strlen(secret));
  start_time = now_s = time(NULL);

  struct rlimit rl;
  if (getrlimit(RLIMIT_NOFILE, &rl) == 0) { rl.rlim_cur = rl.rlim_max; setrlimit(RLIMIT_NOFILE, &rl); getrlimit(RLIMIT_NOFILE, &rl); }
  maxfd = rl.rlim_cur > 1048576 ? 1048576 : (int)rl.rlim_cur;
  conns = calloc((size_t)maxfd + 1, sizeof *conns);

  sqlite3_config(SQLITE_CONFIG_SINGLETHREAD);
  sqlite3_config(SQLITE_CONFIG_MEMSTATUS, 0);
  if (sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE, NULL) != SQLITE_OK) { fprintf(stderr, "open: %s\n", sqlite3_errmsg(db)); return 1; }
  sqlite3_busy_timeout(db, 5000);
  exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA temp_store=MEMORY;"
       "PRAGMA mmap_size=1073741824; PRAGMA cache_size=-32768; PRAGMA wal_autocheckpoint=4000;");
  if (getenv("EXCL")) exec("PRAGMA locking_mode=EXCLUSIVE;");
  st_feed = prep(POST_SQL "ORDER BY p.created_at DESC, p.id DESC LIMIT 20");
  st_post = prep(POST_SQL "WHERE p.id = ?1");
  st_ins_post = prep("INSERT INTO posts (user_id, body) VALUES (?1, ?2) RETURNING id, created_at");
  st_exists = prep("SELECT 1 FROM posts WHERE id = ?1");
  st_like = prep("INSERT INTO likes (user_id, post_id) VALUES (?1, ?2) ON CONFLICT (user_id, post_id) DO NOTHING");
  st_health = prep("SELECT 1");
  st_ids = prep("SELECT id FROM posts ORDER BY created_at DESC, id DESC LIMIT 20");
  st_range = prep("SELECT p.id, p.body, p.created_at, u.username FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id >= ?1 AND p.id <= ?2");
  st_likes = prep("SELECT post_id, count(*) FROM likes WHERE post_id >= ?1 AND post_id <= ?2 GROUP BY post_id");
  st_begin_r = prep("BEGIN"); st_begin = prep("BEGIN IMMEDIATE"); st_commit = prep("COMMIT"); st_rollback = prep("ROLLBACK");

  int lfd = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0), one = 1;
  setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  setsockopt(lfd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
  struct sockaddr_in sa = { .sin_family = AF_INET, .sin_port = htons((uint16_t)atoi(port)) };
  if (inet_pton(AF_INET, host, &sa.sin_addr) != 1) sa.sin_addr.s_addr = htonl(INADDR_ANY);
  if (bind(lfd, (struct sockaddr *)&sa, sizeof sa) || listen(lfd, 65535)) { perror("bind/listen"); return 1; }
  epfd = epoll_create1(0);
  struct epoll_event ev = { .events = EPOLLIN, .data.fd = lfd };
  epoll_ctl(epfd, EPOLL_CTL_ADD, lfd, &ev);

  int slowlog = getenv("SLOWLOG") != NULL;
  static struct epoll_event evs[1024];
  while (!stop_flag) {
    int n = epoll_wait(epfd, evs, 1024, -1);
    if (n < 0) { if (errno == EINTR) continue; perror("epoll_wait"); break; }
    now_s = time(NULL); batch_n = n;
    struct timespec t0; if (slowlog) clock_gettime(CLOCK_MONOTONIC, &t0);
    for (int i = 0; i < n; i++) {
      int fd = evs[i].data.fd;
      if (fd == lfd) {
        for (int k = 0; k < 256; k++) {
          int cfd = accept4(lfd, NULL, NULL, SOCK_NONBLOCK);
          if (cfd < 0) {
            if ((errno == EMFILE || errno == ENFILE) && evict_idle()) continue; /* fd table full: drop the longest-idle connection */
            break;
          }
          if (cfd > maxfd) { close(cfd); continue; }
          conn_t *c = calloc(1, sizeof *c); c->fd = cfd; conns[cfd] = c; lru_touch(c);
          struct epoll_event e2 = { .events = EPOLLIN, .data.fd = cfd };
          epoll_ctl(epfd, EPOLL_CTL_ADD, cfd, &e2);
        }
        continue;
      }
      conn_t *c = conns[fd]; if (!c) continue;
      lru_touch(c);
      if (c->wantout) { if (evs[i].events & (EPOLLOUT | EPOLLERR | EPOLLHUP)) on_writable(c); }
      else on_readable(c);
    }
    struct timespec t1, t2; if (slowlog) clock_gettime(CLOCK_MONOTONIC, &t1);
    flush_batch();
    if (slowlog) {
      clock_gettime(CLOCK_MONOTONIC, &t2);
      double w = (t1.tv_sec - t0.tv_sec) * 1e3 + (t1.tv_nsec - t0.tv_nsec) / 1e6, f = (t2.tv_sec - t1.tv_sec) * 1e3 + (t2.tv_nsec - t1.tv_nsec) / 1e6;
      if (w + f > 5) fprintf(stderr, "slow batch n=%d work=%.1fms flush=%.1fms\n", n, w, f);
    }
  }
  flush_batch();
  sqlite3_finalize(st_ids); sqlite3_finalize(st_range); sqlite3_finalize(st_likes); sqlite3_finalize(st_begin_r); sqlite3_finalize(st_feed); sqlite3_finalize(st_post); sqlite3_finalize(st_ins_post); sqlite3_finalize(st_exists);
  sqlite3_finalize(st_like); sqlite3_finalize(st_health); sqlite3_finalize(st_begin); sqlite3_finalize(st_commit); sqlite3_finalize(st_rollback);
  sqlite3_close(db);
  return 0;
}
