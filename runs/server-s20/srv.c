// Prototype: single-threaded epoll + raw sqlite3 + own HTTP/JWT. Usage: env SQLITE_PATH JWT_SECRET HOST PORT
// build: gcc -O2 -o srv srv.c -lsqlite3 -lcrypto
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <openssl/sha.h>
#include <signal.h>
#include <sqlite3.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static sqlite3 *db;
static sqlite3_stmt *st_feed, *st_post, *st_ins, *st_exists, *st_like, *st_health;
static SHA256_CTX ictx, octx;
static time_t t_start;
static int WBATCH = 0; // 1 = group commit per epoll iteration

// ---------- tiny helpers
static int b64v(int c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '-') return 62;
  if (c == '_') return 63;
  return -1;
}
static int b64dec(const char *s, int n, unsigned char *out) { // url alphabet, no padding
  int o = 0; uint32_t acc = 0; int bits = 0;
  for (int i = 0; i < n; i++) {
    int v = b64v((unsigned char)s[i]); if (v < 0) return -1;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 255; }
  }
  return o;
}
static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
static void b64enc32(const unsigned char *in, char *out) { // 32 bytes -> 43 chars
  int o = 0, i = 0;
  for (; i + 2 < 32; i += 3) {
    uint32_t v = in[i] << 16 | in[i + 1] << 8 | in[i + 2];
    out[o++] = B64[v >> 18]; out[o++] = B64[(v >> 12) & 63]; out[o++] = B64[(v >> 6) & 63]; out[o++] = B64[v & 63];
  }
  uint32_t v = in[30] << 16 | in[31] << 8;
  out[o++] = B64[v >> 18]; out[o++] = B64[(v >> 12) & 63]; out[o++] = B64[(v >> 6) & 63];
}

// ---------- minimal JSON: scan top-level object
typedef struct { const char *p; int n; char type; } jv; // type: 's' string(raw, between quotes) 'n' number 'o' other 0 none
static const char *skipws(const char *p, const char *e) { while (p < e && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++; return p; }
static const char *skip_string(const char *p, const char *e) { // p at opening quote; returns after closing
  p++;
  while (p < e) { if (*p == '\\') p += 2; else if (*p == '"') return p + 1; else p++; }
  return NULL;
}
static const char *skip_value(const char *p, const char *e, jv *out) {
  p = skipws(p, e); if (p >= e) return NULL;
  if (*p == '"') { const char *q = skip_string(p, e); if (!q) return NULL; if (out) { out->p = p + 1; out->n = q - p - 2; out->type = 's'; } return q; }
  if (*p == '{' || *p == '[') {
    int depth = 0;
    while (p < e) {
      if (*p == '"') { p = skip_string(p, e); if (!p) return NULL; continue; }
      if (*p == '{' || *p == '[') depth++;
      else if (*p == '}' || *p == ']') { depth--; if (depth == 0) { p++; break; } }
      p++;
    }
    if (depth != 0) return NULL;
    if (out) out->type = 'o';
    return p;
  }
  const char *s = p;
  while (p < e && *p != ',' && *p != '}' && *p != ']' && *p != ' ' && *p != '\n' && *p != '\r' && *p != '\t') p++;
  if (p == s) return NULL;
  if (out) { out->p = s; out->n = p - s; out->type = ((*s >= '0' && *s <= '9') || *s == '-') ? 'n' : 'o'; }
  return p;
}
// parse whole text as object; fill up to nk keys (matches raw key text); return 0 ok, -1 malformed, -2 not an object
static int json_obj(const char *p, int n, const char **keys, jv *vals, int nk) {
  const char *e = p + n;
  for (int i = 0; i < nk; i++) vals[i].type = 0;
  p = skipws(p, e);
  if (p >= e) return -1;
  if (*p != '{') { jv t; const char *q = skip_value(p, e, &t); if (!q) return -1; q = skipws(q, e); return q == e ? -2 : -1; }
  p = skipws(p + 1, e);
  if (p < e && *p == '}') { p++; p = skipws(p, e); return p == e ? 0 : -1; }
  for (;;) {
    p = skipws(p, e); if (p >= e || *p != '"') return -1;
    const char *ks = p + 1; const char *q = skip_string(p, e); if (!q) return -1;
    int kn = q - ks - 1; p = skipws(q, e); if (p >= e || *p != ':') return -1;
    jv v; p = skip_value(p + 1, e, &v); if (!p) return -1;
    for (int i = 0; i < nk; i++) if ((int)strlen(keys[i]) == kn && !memcmp(keys[i], ks, kn)) vals[i] = v;
    p = skipws(p, e); if (p >= e) return -1;
    if (*p == ',') { p++; continue; }
    if (*p == '}') { p++; p = skipws(p, e); return p == e ? 0 : -1; }
    return -1;
  }
}
// unescape JSON string (raw between quotes) to utf8; returns length or -1
static int json_unescape(const char *s, int n, char *out) {
  int o = 0;
  for (int i = 0; i < n;) {
    unsigned char c = s[i];
    if (c != '\\') { out[o++] = c; i++; continue; }
    if (++i >= n) return -1;
    switch (s[i++]) {
      case '"': out[o++] = '"'; break; case '\\': out[o++] = '\\'; break; case '/': out[o++] = '/'; break;
      case 'b': out[o++] = 8; break; case 'f': out[o++] = 12; break; case 'n': out[o++] = 10; break;
      case 'r': out[o++] = 13; break; case 't': out[o++] = 9; break;
      case 'u': {
        unsigned cp = 0;
        for (int k = 0; k < 4; k++) { if (i >= n) return -1; int ch = s[i++]; cp <<= 4; if (ch >= '0' && ch <= '9') cp |= ch - '0'; else if (ch >= 'a' && ch <= 'f') cp |= ch - 'a' + 10; else if (ch >= 'A' && ch <= 'F') cp |= ch - 'A' + 10; else return -1; }
        if (cp >= 0xD800 && cp < 0xDC00 && i + 5 < n + 0 && s[i] == '\\' && s[i + 1] == 'u') {
          unsigned lo = 0; int ok = 1;
          for (int k = 0; k < 4; k++) { int ch = s[i + 2 + k]; lo <<= 4; if (ch >= '0' && ch <= '9') lo |= ch - '0'; else if (ch >= 'a' && ch <= 'f') lo |= ch - 'a' + 10; else if (ch >= 'A' && ch <= 'F') lo |= ch - 'A' + 10; else ok = 0; }
          if (ok && lo >= 0xDC00 && lo < 0xE000) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); i += 6; }
        }
        if (cp >= 0xD800 && cp < 0xE000) cp = 0xFFFD;
        if (cp < 0x80) out[o++] = cp; else if (cp < 0x800) { out[o++] = 0xC0 | cp >> 6; out[o++] = 0x80 | (cp & 63); }
        else if (cp < 0x10000) { out[o++] = 0xE0 | cp >> 12; out[o++] = 0x80 | ((cp >> 6) & 63); out[o++] = 0x80 | (cp & 63); }
        else { out[o++] = 0xF0 | cp >> 18; out[o++] = 0x80 | ((cp >> 12) & 63); out[o++] = 0x80 | ((cp >> 6) & 63); out[o++] = 0x80 | (cp & 63); }
        break; }
      default: return -1;
    }
  }
  return o;
}
// append JSON-escaped string
static char *esc_append(char *o, const char *s, int n) {
  for (int i = 0; i < n; i++) {
    unsigned char c = s[i];
    if (c == '"') { *o++ = '\\'; *o++ = '"'; }
    else if (c == '\\') { *o++ = '\\'; *o++ = '\\'; }
    else if (c < 0x20) { static const char H[] = "0123456789abcdef"; *o++ = '\\'; if (c == 10) *o++ = 'n'; else if (c == 13) *o++ = 'r'; else if (c == 9) *o++ = 't'; else if (c == 8) *o++ = 'b'; else if (c == 12) *o++ = 'f'; else { *o++ = 'u'; *o++ = '0'; *o++ = '0'; *o++ = H[c >> 4]; *o++ = H[c & 15]; } }
    else *o++ = c;
  }
  return o;
}

// ---------- JWT
// returns 0 ok (uid, uname raw json-escaped), 1 invalid or expired, 2 invalid payload
static int jwt_verify(const char *tok, int n, long *uid, const char **un, int *unn) {
  const char *d1 = memchr(tok, '.', n); if (!d1) return 1;
  const char *d2 = memchr(d1 + 1, '.', n - (d1 + 1 - tok)); if (!d2) return 1;
  if (memchr(d2 + 1, '.', n - (d2 + 1 - tok))) return 1;
  int hl = d1 - tok, pl = d2 - d1 - 1, sl = tok + n - d2 - 1;
  if (hl > 200 || pl > 600 || sl != 43 || hl == 0 || pl == 0) return 1;
  unsigned char hb[256], pb[512];
  int hn = b64dec(tok, hl, hb); if (hn < 0) return 1;
  const char *hk[] = {"alg"}; jv hv[1];
  if (json_obj((char *)hb, hn, hk, hv, 1) != 0 || hv[0].type != 's' || hv[0].n != 5 || memcmp(hv[0].p, "HS256", 5)) return 1;
  SHA256_CTX c = ictx; unsigned char in[32], mac[32];
  SHA256_Update(&c, tok, d2 - tok); SHA256_Final(in, &c);
  c = octx; SHA256_Update(&c, in, 32); SHA256_Final(mac, &c);
  char enc[43]; b64enc32(mac, enc);
  unsigned diff = 0; for (int i = 0; i < 43; i++) diff |= (unsigned char)(enc[i] ^ d2[1 + i]);
  if (diff) return 1;
  int pn = b64dec(d1 + 1, pl, pb); if (pn < 0) return 1;
  const char *pk[] = {"sub", "username", "exp"}; jv pv[3];
  if (json_obj((char *)pb, pn, pk, pv, 3) != 0) return 1;
  if (pv[2].type == 'n') { double ex = strtod(pv[2].p, NULL); if (ex <= (double)time(NULL)) return 1; }
  else if (pv[2].type) return 1;
  if (pv[0].type != 's' || pv[1].type != 's' || pv[0].n == 0 || pv[0].n > 15) return 2;
  long id = 0; for (int i = 0; i < pv[0].n; i++) { char ch = pv[0].p[i]; if (ch < '0' || ch > '9') return 2; id = id * 10 + (ch - '0'); }
  if (id <= 0) return 2;
  *uid = id;
  // username: copy raw (still escaped) out of the decoded payload buffer -> need stable storage
  static char ubuf[1024], ebuf[512]; int en = json_unescape(pv[1].p, pv[1].n, ebuf); if (en < 0) return 2;
  *unn = esc_append(ubuf, ebuf, en) - ubuf; *un = ubuf;
  return 0;
}

// ---------- connections
typedef struct { char *in; int inlen, incap; char *out; int outlen, outoff; } conn;
static conn **tab; static int tabn; static int ep;
static char *obuf; // big response buffer
#define OBUF (1 << 17)

static void close_conn(int fd) {
  conn *c = tab[fd];
  if (c) { free(c->in); free(c->out); free(c); tab[fd] = NULL; }
  epoll_ctl(ep, EPOLL_CTL_DEL, fd, NULL); close(fd);
}

static int status_text(char *o, int code, int blen) {
  const char *s = code == 200 ? "200 OK" : code == 201 ? "201 Created" : code == 400 ? "400 Bad Request" : code == 401 ? "401 Unauthorized" : code == 404 ? "404 Not Found" : code == 503 ? "503 Service Unavailable" : "500 Internal Server Error";
  return sprintf(o, "HTTP/1.1 %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n", s, blen);
}
// o = start of buffer, body begins at o+HDR (reserved 128 bytes); shifts header in front. returns total len and *start
#define HDR 128
static int finish(char *o, int code, int blen, char **start) {
  char h[128]; int hl = status_text(h, code, blen);
  *start = o + HDR - hl; memcpy(*start, h, hl); return hl + blen;
}
static int err_resp(char *o, int code, const char *msg, char **start) {
  int bl = sprintf(o + HDR, "{\"error\":\"%s\"}", msg); return finish(o, code, bl, start);
}
static char *emit_post(char *w, sqlite3_stmt *s) {
  w += sprintf(w, "{\"id\":%lld,\"body\":\"", sqlite3_column_int64(s, 0));
  w = esc_append(w, (const char *)sqlite3_column_text(s, 1), sqlite3_column_bytes(s, 1));
  w += sprintf(w, "\",\"created_at\":\"");
  memcpy(w, sqlite3_column_text(s, 2), sqlite3_column_bytes(s, 2)); w += sqlite3_column_bytes(s, 2);
  w += sprintf(w, "\",\"author\":\"");
  w = esc_append(w, (const char *)sqlite3_column_text(s, 3), sqlite3_column_bytes(s, 3));
  w += sprintf(w, "\",\"like_count\":%lld}", sqlite3_column_int64(s, 4));
  return w;
}
static int parse_id(const char *p, int n, long *id) { // -1 invalid
  if (n <= 0 || n > 18) return -1; long v = 0;
  for (int i = 0; i < n; i++) { if (p[i] < '0' || p[i] > '9') return -1; v = v * 10 + p[i] - '0'; }
  if (v <= 0) return -1; *id = v; return 0;
}

// handle one request; returns response length and sets *start. body points to request body.
static int handle(char *o, const char *m, int mn, const char *path, int pn, const char *auth, int authn, const char *body, int bn, char **start) {
  char *w = o + HDR;
  int isget = mn == 3 && !memcmp(m, "GET", 3), ispost = mn == 4 && !memcmp(m, "POST", 4);
  // strip query
  const char *q = memchr(path, '?', pn); if (q) pn = q - path;
  if (isget && pn == 5 && !memcmp(path, "/feed", 5)) {
    w += sprintf(w, "{\"posts\":[");
    int first = 1;
    while (sqlite3_step(st_feed) == SQLITE_ROW) { if (!first) *w++ = ','; first = 0; w = emit_post(w, st_feed); }
    sqlite3_reset(st_feed);
    w += sprintf(w, "]}");
    return finish(o, 200, w - (o + HDR), start);
  }
  if (isget && pn == 7 && !memcmp(path, "/health", 7)) {
    if (sqlite3_step(st_health) != SQLITE_ROW) { sqlite3_reset(st_health); int bl = sprintf(w, "{\"status\":\"degraded\",\"db\":\"unreachable\",\"error\":\"%s\"}", "select failed"); return finish(o, 503, bl, start); }
    sqlite3_reset(st_health);
    int bl = sprintf(w, "{\"status\":\"ok\",\"db\":\"ok\",\"uptime_s\":%ld}", (long)(time(NULL) - t_start));
    return finish(o, 200, bl, start);
  }
  if (pn >= 7 && !memcmp(path, "/posts/", 7) && (isget || ispost)) {
    const char *ip = path + 7; int in = pn - 7; int like = 0;
    if (in >= 5 && !memcmp(ip + in - 5, "/like", 5)) { like = 1; in -= 5; }
    if (isget && !like) {
      long id; if (parse_id(ip, in, &id) < 0) return err_resp(o, 400, "invalid post id", start);
      sqlite3_bind_int64(st_post, 1, id);
      if (sqlite3_step(st_post) != SQLITE_ROW) { sqlite3_reset(st_post); return err_resp(o, 404, "post not found", start); }
      w += sprintf(w, "{\"post\":"); w = emit_post(w, st_post); *w++ = '}';
      sqlite3_reset(st_post);
      return finish(o, 200, w - (o + HDR), start);
    }
    if (ispost && like) {
      long uid; const char *un; int unn;
      if (authn < 7 || memcmp(auth, "Bearer ", 7)) return err_resp(o, 401, "missing bearer token", start);
      int r = jwt_verify(auth + 7, authn - 7, &uid, &un, &unn);
      if (r == 1) return err_resp(o, 401, "invalid or expired token", start);
      if (r == 2) return err_resp(o, 401, "invalid token payload", start);
      long id; if (parse_id(ip, in, &id) < 0) return err_resp(o, 400, "invalid post id", start);
      sqlite3_bind_int64(st_exists, 1, id);
      int ex = sqlite3_step(st_exists) == SQLITE_ROW; sqlite3_reset(st_exists);
      if (!ex) return err_resp(o, 404, "post not found", start);
      sqlite3_bind_int64(st_like, 1, uid); sqlite3_bind_int64(st_like, 2, id);
      int rc = sqlite3_step(st_like); sqlite3_reset(st_like);
      if (rc != SQLITE_DONE) return err_resp(o, 500, "internal server error", start);
      int fresh = sqlite3_changes(db) > 0;
      int bl = sprintf(w, "{\"liked\":true,\"already_liked\":%s,\"post_id\":%ld}", fresh ? "false" : "true", id);
      return finish(o, fresh ? 201 : 200, bl, start);
    }
  }
  if (ispost && pn == 6 && !memcmp(path, "/posts", 6)) {
    long uid; const char *un; int unn;
    if (authn < 7 || memcmp(auth, "Bearer ", 7)) return err_resp(o, 401, "missing bearer token", start);
    int r = jwt_verify(auth + 7, authn - 7, &uid, &un, &unn);
    if (r == 1) return err_resp(o, 401, "invalid or expired token", start);
    if (r == 2) return err_resp(o, 401, "invalid token payload", start);
    const char *bk[] = {"body"}; jv bv[1];
    int jr = json_obj(body, bn, bk, bv, 1);
    if (jr == -1) return err_resp(o, 400, "malformed JSON body", start);
    if (jr == -2) return err_resp(o, 400, "body is required", start);
    if (bv[0].type != 's') return err_resp(o, 400, "body is required", start);
    static char tmp[8192];
    if (bv[0].n > (int)sizeof(tmp)) return err_resp(o, 400, "body must be at most 500 characters", start);
    int tn = json_unescape(bv[0].p, bv[0].n, tmp); if (tn < 0) return err_resp(o, 400, "malformed JSON body", start);
    // trim ASCII whitespace (+ NBSP U+00A0 as 0xC2 0xA0)
    int a = 0, b = tn;
    for (;;) { if (a < b && (tmp[a] == ' ' || (tmp[a] >= 9 && tmp[a] <= 13))) a++; else if (b - a >= 2 && (unsigned char)tmp[a] == 0xC2 && (unsigned char)tmp[a + 1] == 0xA0) a += 2; else break; }
    for (;;) { if (b > a && (tmp[b - 1] == ' ' || (tmp[b - 1] >= 9 && tmp[b - 1] <= 13))) b--; else if (b - a >= 2 && (unsigned char)tmp[b - 2] == 0xC2 && (unsigned char)tmp[b - 1] == 0xA0) b -= 2; else break; }
    if (a >= b) return err_resp(o, 400, "body is required", start);
    int cps = 0; for (int i = a; i < b; i++) if (((unsigned char)tmp[i] & 0xC0) != 0x80) cps++;
    if (cps > 500) return err_resp(o, 400, "body must be at most 500 characters", start);
    sqlite3_bind_int64(st_ins, 1, uid); sqlite3_bind_text(st_ins, 2, tmp + a, b - a, SQLITE_STATIC);
    if (sqlite3_step(st_ins) != SQLITE_ROW) { sqlite3_reset(st_ins); return err_resp(o, 500, "internal server error", start); }
    w += sprintf(w, "{\"post\":{\"id\":%lld,\"body\":\"", sqlite3_column_int64(st_ins, 0));
    w = esc_append(w, tmp + a, b - a);
    w += sprintf(w, "\",\"created_at\":\"%s\",\"author\":\"", sqlite3_column_text(st_ins, 1));
    memcpy(w, un, unn); w += unn;
    w += sprintf(w, "\",\"like_count\":0}}");
    sqlite3_reset(st_ins);
    return finish(o, 201, w - (o + HDR), start);
  }
  return err_resp(o, 404, "not found", start);
}

static void arm(int fd, int out) { struct epoll_event e = {.events = EPOLLIN | (out ? EPOLLOUT : 0), .data.fd = fd}; epoll_ctl(ep, EPOLL_CTL_MOD, fd, &e); }

static int flush_conn(int fd, conn *c) {
  while (c->outoff < c->outlen) {
    ssize_t k = send(fd, c->out + c->outoff, c->outlen - c->outoff, MSG_NOSIGNAL);
    if (k < 0) { if (errno == EAGAIN) { arm(fd, 1); return 0; } return -1; }
    c->outoff += k;
  }
  free(c->out); c->out = NULL; c->outlen = c->outoff = 0; arm(fd, 0); return 0;
}
static int send_resp(int fd, const char *p, int n) { // returns -1 on fatal error
  conn *c = tab[fd];
  if (c && c->out) { c->out = realloc(c->out, c->outlen + n); memcpy(c->out + c->outlen, p, n); c->outlen += n; return 0; }
  ssize_t k = send(fd, p, n, MSG_NOSIGNAL);
  if (k == n) return 0;
  if (k < 0) { if (errno != EAGAIN) return -1; k = 0; }
  if (!c) { c = tab[fd] = calloc(1, sizeof(conn)); }
  c->out = malloc(n - k); memcpy(c->out, p + k, n - k); c->outlen = n - k; c->outoff = 0; arm(fd, 1);
  return 0;
}

static const char *find_hdr_end(const char *p, int n) {
  const char *q = memmem(p, n, "\r\n\r\n", 4); return q ? q + 4 : NULL;
}
static int ieq(const char *a, int n, const char *lit) { int l = strlen(lit); if (n != l) return 0; for (int i = 0; i < n; i++) if ((a[i] | 32) != lit[i]) return 0; return 1; }

// process as many complete requests as in buf; returns bytes consumed, or -1 to close
static int process(int fd, const char *buf, int n, int *want_close) {
  int off = 0;
  while (off < n) {
    const char *base = buf + off; int rem = n - off;
    const char *he = find_hdr_end(base, rem);
    if (!he) { if (rem > 65536) return -1; break; }
    int hlen = he - base;
    const char *sp1 = memchr(base, ' ', hlen); if (!sp1) return -1;
    const char *sp2 = memchr(sp1 + 1, ' ', base + hlen - sp1 - 1); if (!sp2) return -1;
    const char *auth = NULL; int authn = 0; long clen = 0; int close_it = 0;
    const char *ln = memchr(base, '\n', hlen) + 1;
    while (ln < he - 2) {
      const char *le = memchr(ln, '\r', he - ln); if (!le) break;
      const char *colon = memchr(ln, ':', le - ln);
      if (colon) {
        int kn = colon - ln; const char *v = colon + 1; while (v < le && (*v == ' ' || *v == '\t')) v++;
        int vn = le - v;
        if (kn == 13 && ieq(ln, kn, "authorization")) { auth = v; authn = vn; }
        else if (kn == 14 && ieq(ln, kn, "content-length")) { clen = atol(v); }
        else if (kn == 10 && ieq(ln, kn, "connection") && vn == 5 && ieq(v, vn, "close")) close_it = 1;
        else if (kn == 17 && ieq(ln, kn, "transfer-encoding")) return -1;
      }
      ln = le + 2;
    }
    if (clen < 0 || clen > 65536) return -1;
    if (rem < hlen + clen) { if (rem > 70000) return -1; break; }
    char *start; int rl = handle(obuf, base, sp1 - base, sp1 + 1, sp2 - sp1 - 1, auth, authn, he, clen, &start);
    if (send_resp(fd, start, rl) < 0) return -1;
    off += hlen + clen;
    if (close_it) { *want_close = 1; return off; }
  }
  return off;
}

int main(void) {
  signal(SIGPIPE, SIG_IGN);
  const char *path = getenv("SQLITE_PATH"), *secret = getenv("JWT_SECRET"), *host = getenv("HOST"), *port = getenv("PORT");
  if (!path || !secret) { fprintf(stderr, "env\n"); return 1; }
  if (!host) host = "127.0.0.1"; if (!port) port = "3000";
  WBATCH = getenv("WBATCH") != NULL;
  int procs = getenv("PROCS") ? atoi(getenv("PROCS")) : 1;
  for (int i = 1; i < procs; i++) if (fork() == 0) break;
  struct rlimit rl; getrlimit(RLIMIT_NOFILE, &rl); rl.rlim_cur = rl.rlim_max; if (getenv("NOFILE_CAP")) rl.rlim_cur = atoi(getenv("NOFILE_CAP")); setrlimit(RLIMIT_NOFILE, &rl);
  tabn = rl.rlim_cur > 1 << 20 ? 1 << 20 : rl.rlim_cur; tab = calloc(tabn, sizeof(conn *));
  obuf = malloc(OBUF);
  // hmac midstates
  unsigned char k[64] = {0}; int kl = strlen(secret);
  if (kl > 64) { SHA256((const unsigned char *)secret, kl, k); } else memcpy(k, secret, kl);
  unsigned char ip[64], op[64]; for (int i = 0; i < 64; i++) { ip[i] = k[i] ^ 0x36; op[i] = k[i] ^ 0x5c; }
  SHA256_Init(&ictx); SHA256_Update(&ictx, ip, 64); SHA256_Init(&octx); SHA256_Update(&octx, op, 64);
  t_start = time(NULL);
  if (sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX, NULL)) { fprintf(stderr, "open: %s\n", sqlite3_errmsg(db)); return 1; }
  sqlite3_busy_timeout(db, 5000);
  sqlite3_exec(db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA mmap_size=1073741824; PRAGMA cache_size=-65536; PRAGMA temp_store=MEMORY;", 0, 0, 0);
  const char *postsel = "SELECT p.id,p.body,p.created_at,u.username,(SELECT count(*) FROM likes l WHERE l.post_id=p.id) FROM posts p JOIN users u ON u.id=p.user_id ";
  char sql[600];
  snprintf(sql, sizeof sql, "%sORDER BY p.created_at DESC, p.id DESC LIMIT 20", postsel);
  sqlite3_prepare_v3(db, sql, -1, SQLITE_PREPARE_PERSISTENT, &st_feed, 0);
  snprintf(sql, sizeof sql, "%sWHERE p.id=?", postsel);
  sqlite3_prepare_v3(db, sql, -1, SQLITE_PREPARE_PERSISTENT, &st_post, 0);
  sqlite3_prepare_v3(db, "INSERT INTO posts(user_id,body) VALUES(?,?) RETURNING id,created_at", -1, SQLITE_PREPARE_PERSISTENT, &st_ins, 0);
  sqlite3_prepare_v3(db, "SELECT 1 FROM posts WHERE id=?", -1, SQLITE_PREPARE_PERSISTENT, &st_exists, 0);
  sqlite3_prepare_v3(db, "INSERT INTO likes(user_id,post_id) VALUES(?,?) ON CONFLICT(user_id,post_id) DO NOTHING", -1, SQLITE_PREPARE_PERSISTENT, &st_like, 0);
  sqlite3_prepare_v3(db, "SELECT 1", -1, SQLITE_PREPARE_PERSISTENT, &st_health, 0);
  if (!st_feed || !st_post || !st_ins || !st_like) { fprintf(stderr, "prepare: %s\n", sqlite3_errmsg(db)); return 1; }

  int ls = socket(AF_INET, SOCK_STREAM | SOCK_NONBLOCK, 0); int one = 1;
  setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  if (procs > 1) setsockopt(ls, SOL_SOCKET, SO_REUSEPORT, &one, sizeof one);
  struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(atoi(port))}; inet_pton(AF_INET, host, &a.sin_addr);
  if (bind(ls, (void *)&a, sizeof a) || listen(ls, 65535)) { perror("bind/listen"); return 1; }
  ep = epoll_create1(0);
  struct epoll_event e = {.events = EPOLLIN, .data.fd = ls}; epoll_ctl(ep, EPOLL_CTL_ADD, ls, &e);
  static char rbuf[65536 + 4096];
  struct epoll_event evs[512];
  int spare = open("/dev/null", O_RDONLY);
  int stats = getenv("STATS") != NULL; double mx = 0, tl = 0; long nb = 0, ne = 0, nslow = 0; struct timespec ts0, ts1;
  for (;;) {
    int n = epoll_wait(ep, evs, 512, stats ? 1000 : -1);
    if (stats) { clock_gettime(CLOCK_MONOTONIC, &ts0); nb++; ne += n; }
    for (int i = 0; i < n; i++) {
      int fd = evs[i].data.fd;
      if (fd == ls) {
        for (;;) {
          int c = accept4(ls, NULL, NULL, SOCK_NONBLOCK);
          if (c < 0) {
            if (errno == EMFILE || errno == ENFILE) { close(spare); c = accept(ls, NULL, NULL); if (c >= 0) close(c); spare = open("/dev/null", O_RDONLY); continue; }
            break;
          }
          if (c >= tabn) { close(c); continue; }
          setsockopt(c, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
          struct epoll_event ce = {.events = EPOLLIN, .data.fd = c}; epoll_ctl(ep, EPOLL_CTL_ADD, c, &ce);
        }
        continue;
      }
      conn *c = tab[fd];
      if (evs[i].events & EPOLLOUT) { if (c && flush_conn(fd, c) < 0) { close_conn(fd); continue; } }
      if (!(evs[i].events & (EPOLLIN | EPOLLHUP | EPOLLERR))) continue;
      const char *data; int dn; int wc = 0;
      char *joined = NULL;
      ssize_t k = recv(fd, rbuf, 65536, 0);
      if (k == 0 || (k < 0 && errno != EAGAIN && errno != EINTR)) { close_conn(fd); continue; }
      if (k < 0) continue;
      if (c && c->inlen) { joined = malloc(c->inlen + k); memcpy(joined, c->in, c->inlen); memcpy(joined + c->inlen, rbuf, k); data = joined; dn = c->inlen + k; }
      else { data = rbuf; dn = k; }
      int used = process(fd, data, dn, &wc);
      c = tab[fd];
      if (used < 0) { free(joined); close_conn(fd); continue; }
      if (used < dn) { // keep remainder
        if (!c) c = tab[fd] = calloc(1, sizeof(conn));
        int rest = dn - used; char *nb = malloc(rest); memcpy(nb, data + used, rest); free(c->in); c->in = nb; c->inlen = rest;
      } else if (c) { free(c->in); c->in = NULL; c->inlen = 0; }
      free(joined);
      if (wc) { close_conn(fd); continue; }
      if (c && !c->in && !c->out) { free(c); tab[fd] = NULL; }
    }
    if (stats) { clock_gettime(CLOCK_MONOTONIC, &ts1); double d = (ts1.tv_sec - ts0.tv_sec) + (ts1.tv_nsec - ts0.tv_nsec) * 1e-9; if (d > mx) mx = d; if (d > 0.01) nslow++; tl += d;
      if (tl > 10) { fprintf(stderr, "batches=%ld events=%ld busy=%.2fs max_batch=%.1fms batches>10ms=%ld\n", nb, ne, tl, mx * 1e3, nslow); tl = 0; mx = 0; nb = ne = nslow = 0; } }
  }
}
