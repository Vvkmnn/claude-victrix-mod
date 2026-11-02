/* Strict JSON (RFC 8259, same grammar as JavaScript's JSON.parse) validator that also
 * extracts selected top-level members of an object. */
#ifndef JSON_H
#define JSON_H
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

enum { JT_ABSENT = 0, JT_STRING, JT_NUMBER, JT_OTHER };

typedef struct {
  const char *key;        /* member name to capture (ASCII) */
  int type;               /* out: JT_* of the LAST occurrence (JSON.parse semantics) */
  char *str; size_t cap;  /* in: buffer for decoded UTF-8 string; out: len */
  size_t len;
  int truncated;          /* decoded string did not fit in cap */
  double num;
} jfield;

static const char *jws(const char *p, const char *e) {
  while (p < e && (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) p++;
  return p;
}

static int hexv(int c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

static size_t utf8_put(char *o, uint32_t cp) {
  if (cp < 0x80) { o[0] = (char)cp; return 1; }
  if (cp < 0x800) { o[0] = (char)(0xC0 | cp >> 6); o[1] = (char)(0x80 | (cp & 0x3F)); return 2; }
  if (cp < 0x10000) { o[0] = (char)(0xE0 | cp >> 12); o[1] = (char)(0x80 | ((cp >> 6) & 0x3F)); o[2] = (char)(0x80 | (cp & 0x3F)); return 3; }
  o[0] = (char)(0xF0 | cp >> 18); o[1] = (char)(0x80 | ((cp >> 12) & 0x3F)); o[2] = (char)(0x80 | ((cp >> 6) & 0x3F)); o[3] = (char)(0x80 | (cp & 0x3F)); return 4;
}

/* Decode one UTF-8 sequence at p; invalid bytes decode as U+FFFD consuming 1 byte (like a TextDecoder). */
static uint32_t utf8_get(const unsigned char *p, const unsigned char *e, int *adv) {
  unsigned c = p[0];
  if (c < 0x80) { *adv = 1; return c; }
  int n; uint32_t cp, min;
  if ((c & 0xE0) == 0xC0) { n = 2; cp = c & 0x1F; min = 0x80; }
  else if ((c & 0xF0) == 0xE0) { n = 3; cp = c & 0x0F; min = 0x800; }
  else if ((c & 0xF8) == 0xF0) { n = 4; cp = c & 0x07; min = 0x10000; }
  else { *adv = 1; return 0xFFFD; }
  if (e - p < n) { *adv = 1; return 0xFFFD; }
  for (int i = 1; i < n; i++) { if ((p[i] & 0xC0) != 0x80) { *adv = 1; return 0xFFFD; } cp = cp << 6 | (p[i] & 0x3F); }
  if (cp < min || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) { *adv = 1; return 0xFFFD; }
  *adv = n; return cp;
}

/* Parse a string starting at the opening quote. If out != NULL, decode into it (up to cap bytes). */
static const char *jstring(const char *p, const char *e, char *out, size_t cap, size_t *olen, int *trunc) {
  size_t n = 0; char tmp[4]; int tr = 0;
  p++; /* opening quote */
  while (p < e) {
    unsigned char c = (unsigned char)*p;
    if (c == '"') { if (olen) *olen = n; if (trunc) *trunc = tr; return p + 1; }
    if (c < 0x20) return NULL;
    if (c == '\\') {
      if (++p >= e) return NULL;
      uint32_t cp;
      switch (*p) {
        case '"': cp = '"'; break; case '\\': cp = '\\'; break; case '/': cp = '/'; break;
        case 'b': cp = 8; break; case 'f': cp = 12; break; case 'n': cp = 10; break;
        case 'r': cp = 13; break; case 't': cp = 9; break;
        case 'u': {
          if (e - p < 5) return NULL;
          int a = hexv(p[1]), b = hexv(p[2]), cc = hexv(p[3]), d = hexv(p[4]);
          if ((a | b | cc | d) < 0) return NULL;
          cp = (uint32_t)(a << 12 | b << 8 | cc << 4 | d); p += 4;
          if (cp >= 0xD800 && cp <= 0xDBFF && e - p >= 7 && p[1] == '\\' && p[2] == 'u') {
            int a2 = hexv(p[3]), b2 = hexv(p[4]), c2 = hexv(p[5]), d2 = hexv(p[6]);
            if ((a2 | b2 | c2 | d2) >= 0) {
              uint32_t lo = (uint32_t)(a2 << 12 | b2 << 8 | c2 << 4 | d2);
              if (lo >= 0xDC00 && lo <= 0xDFFF) { cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00); p += 6; }
            }
          }
          if (cp >= 0xD800 && cp <= 0xDFFF) cp = 0xFFFD; /* lone surrogate: not representable in UTF-8 */
          break;
        }
        default: return NULL;
      }
      p++;
      if (out) { size_t k = utf8_put(tmp, cp); if (n + k <= cap) { memcpy(out + n, tmp, k); n += k; } else tr = 1; }
      continue;
    }
    if (c < 0x80) { if (out) { if (n < cap) out[n++] = (char)c; else tr = 1; } p++; continue; }
    int adv; uint32_t cp = utf8_get((const unsigned char *)p, (const unsigned char *)e, &adv);
    if (out) {
      if (adv > 1) { if (n + adv <= cap) { memcpy(out + n, p, adv); n += adv; } else tr = 1; }
      else { size_t k = utf8_put(tmp, cp); if (n + k <= cap) { memcpy(out + n, tmp, k); n += k; } else tr = 1; }
    }
    p += adv;
  }
  return NULL;
}

static const char *jnumber(const char *p, const char *e, double *v) {
  const char *s = p;
  if (p < e && *p == '-') p++;
  if (p >= e) return NULL;
  if (*p == '0') p++;
  else if (*p >= '1' && *p <= '9') { while (p < e && *p >= '0' && *p <= '9') p++; }
  else return NULL;
  if (p < e && *p == '.') { p++; if (p >= e || *p < '0' || *p > '9') return NULL; while (p < e && *p >= '0' && *p <= '9') p++; }
  if (p < e && (*p == 'e' || *p == 'E')) {
    p++; if (p < e && (*p == '+' || *p == '-')) p++;
    if (p >= e || *p < '0' || *p > '9') return NULL;
    while (p < e && *p >= '0' && *p <= '9') p++;
  }
  if (v) { char buf[64]; size_t L = (size_t)(p - s); if (L >= sizeof buf) L = sizeof buf - 1; memcpy(buf, s, L); buf[L] = 0; *v = strtod(buf, NULL); }
  return p;
}

static const char *jvalue(const char *p, const char *e, int depth) {
  p = jws(p, e);
  if (p >= e || depth > 1000) return NULL;
  switch (*p) {
    case '"': return jstring(p, e, NULL, 0, NULL, NULL);
    case '{':
      p = jws(p + 1, e);
      if (p < e && *p == '}') return p + 1;
      for (;;) {
        if (p >= e || *p != '"') return NULL;
        p = jstring(p, e, NULL, 0, NULL, NULL); if (!p) return NULL;
        p = jws(p, e); if (p >= e || *p != ':') return NULL;
        p = jvalue(p + 1, e, depth + 1); if (!p) return NULL;
        p = jws(p, e); if (p >= e) return NULL;
        if (*p == '}') return p + 1;
        if (*p != ',') return NULL;
        p = jws(p + 1, e);
      }
    case '[':
      p = jws(p + 1, e);
      if (p < e && *p == ']') return p + 1;
      for (;;) {
        p = jvalue(p, e, depth + 1); if (!p) return NULL;
        p = jws(p, e); if (p >= e) return NULL;
        if (*p == ']') return p + 1;
        if (*p != ',') return NULL;
        p++;
      }
    case 't': return (e - p >= 4 && !memcmp(p, "true", 4)) ? p + 4 : NULL;
    case 'f': return (e - p >= 5 && !memcmp(p, "false", 5)) ? p + 5 : NULL;
    case 'n': return (e - p >= 4 && !memcmp(p, "null", 4)) ? p + 4 : NULL;
    default: return jnumber(p, e, NULL);
  }
}

/* Returns -1 if s is not valid JSON; else 1 if top-level value is an object, 0 otherwise.
 * Captures listed fields of a top-level object. */
static int json_top(const char *s, size_t n, jfield *f, int nf) {
  const char *p = s, *e = s + n;
  for (int i = 0; i < nf; i++) { f[i].type = JT_ABSENT; f[i].len = 0; f[i].truncated = 0; }
  p = jws(p, e);
  if (p < e && *p == '{') {
    p = jws(p + 1, e);
    if (p < e && *p == '}') { p++; goto done; }
    for (;;) {
      if (p >= e || *p != '"') return -1;
      char key[64]; size_t klen; int ktr;
      p = jstring(p, e, key, sizeof key, &klen, &ktr); if (!p) return -1;
      p = jws(p, e); if (p >= e || *p != ':') return -1;
      p = jws(p + 1, e); if (p >= e) return -1;
      jfield *hit = NULL;
      if (!ktr) for (int i = 0; i < nf; i++) if (strlen(f[i].key) == klen && !memcmp(f[i].key, key, klen)) { hit = &f[i]; break; }
      if (hit && *p == '"') {
        p = jstring(p, e, hit->str, hit->cap, &hit->len, &hit->truncated); if (!p) return -1;
        hit->type = JT_STRING;
      } else if (hit && (*p == '-' || (*p >= '0' && *p <= '9'))) {
        p = jnumber(p, e, &hit->num); if (!p) return -1;
        hit->type = JT_NUMBER;
      } else {
        p = jvalue(p, e, 1); if (!p) return -1;
        if (hit) hit->type = JT_OTHER;
      }
      p = jws(p, e); if (p >= e) return -1;
      if (*p == '}') { p++; break; }
      if (*p != ',') return -1;
      p = jws(p + 1, e);
    }
  done:
    p = jws(p, e);
    return p == e ? 1 : -1;
  }
  p = jvalue(p, e, 0);
  if (!p) return -1;
  p = jws(p, e);
  return p == e ? 0 : -1;
}
#endif
