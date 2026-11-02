#define _POSIX_C_SOURCE 200809L
#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* General parser for one row starting at p (p < end). Returns pointer to the
   start of the next row. Adds qty*price to *tot. Contract-only assumptions. */
static const char *slow_row(const char *p, const char *end, unsigned long long *tot) {
    const char *e = memchr(p, '\n', (size_t)(end - p));
    const char *next = e ? e + 1 : end;
    if (!e) e = end;
    const char *c1 = memchr(p, ',', (size_t)(e - p));
    if (!c1) return next;
    const char *c2 = memchr(c1 + 1, ',', (size_t)(e - c1 - 1));
    if (!c2) return next;
    const char *q = c2 + 1;
    unsigned long long qty = 0, price = 0;
    while (q < e && (unsigned)(*q - '0') < 10) qty = qty * 10 + (unsigned)(*q++ - '0');
    if (q < e && *q == ',') q++;
    while (q < e && (unsigned)(*q - '0') < 10) price = price * 10 + (unsigned)(*q++ - '0');
    *tot += qty * price;
    return next;
}

static inline uint64_t ld64(const char *s) { uint64_t v; memcpy(&v, s, 8); return v; }

/* w holds 8 raw bytes with the 6 digits of interest in the TOP six bytes
   (little endian: bytes 2..7); the low two bytes are ignored. Returns 1 and
   sets *out iff all six are ASCII digits. */
static inline int six_digits(uint64_t w, unsigned *out) {
    uint64_t t = (w ^ 0x3030303030303030ULL) & ~0xFFFFULL;
    /* byte is a digit iff (b | (b+6)) has no bit in 0xF0; carries only arise from bytes already >=0xFA, which are flagged by themselves */
    uint64_t bad = (t | (t + 0x0606060606060606ULL)) & 0xF0F0F0F0F0F00000ULL;
    if (bad) return 0;
    t = (t * 10 + (t >> 8)) & 0x00FF00FF00FF00FFULL;
    t = (t * 100 + (t >> 16)) & 0x0000FFFF0000FFFFULL;
    t = (t * 10000 + (t >> 32)) & 0xFFFFFFFFULL;
    *out = (unsigned)t;
    return 1;
}

/* Sum the rows that START in [p, stop); a row straddling stop is finished.
   p must be at a row start; end is the end of the buffer. */
static unsigned long long run(const char *p, const char *stop, const char *end) {
    unsigned long long tot = 0;
    /* Fast path: fixed-width rows "iiiiiiii,nnnnnnnnnn,qqqqqq,pppppp\n" (8+1+10+1+6+1+6+1 = 34 bytes). Guarded per row; any
       mismatch falls back to the general parser for that row only. */
    while (p < stop && (size_t)(end - p) >= 34) {
        unsigned q, pr;
        if (p[8] == ',' && p[19] == ',' && p[26] == ',' && p[33] == '\n' &&
            six_digits(ld64(p + 20) << 16, &q) && six_digits(ld64(p + 25), &pr)) {
            tot += (unsigned long long)q * pr;
            p += 34;
        } else {
            p = slow_row(p, end, &tot);
        }
    }
    while (p < stop) p = slow_row(p, end, &tot);
    return tot;
}

long long sum_qty_price(const char *buf, size_t len) {
    const char *end = buf + len;
    const char *p = memchr(buf, '\n', len);   /* skip header */
    if (!p) return 0;
    return (long long)run(p + 1, end, end);
}
