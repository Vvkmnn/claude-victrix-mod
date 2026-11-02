#include <stddef.h>
#include <string.h>

/* Generic single-pass parser for one row starting at p (< end). Returns the
   pointer after the row's newline (or end). Relies only on the input contract. */
static const char *slow_row(const char *p, const char *end, unsigned long long *tot) {
    const char *q;
    q = memchr(p, ',', (size_t)(end - p)); if (!q) return end; p = q + 1;   /* id */
    q = memchr(p, ',', (size_t)(end - p)); if (!q) return end; p = q + 1;   /* name */
    unsigned long long qty = 0, price = 0;
    while (p < end && *p != ',') qty = qty * 10 + (unsigned)(*p++ - '0');
    if (p < end) p++;
    while (p < end && *p != '\n') price = price * 10 + (unsigned)(*p++ - '0');
    if (p < end) p++;
    *tot += qty * price;
    return p;
}

long long sum_qty_price(const char *buf, size_t len) {
    const char *p = buf, *end = buf + len;
    unsigned long long tot = 0;
    const char *nl = memchr(p, '\n', len);
    if (!nl) return 0;
    p = nl + 1;
    /* Fast path: rows of the shape 8,10,6,6 (34 bytes). Guard: comma/newline
       positions are verified per row; any mismatch falls back to slow_row. */
    while (p < end) {
        if ((size_t)(end - p) >= 34 && p[8] == ',' && p[19] == ',' && p[26] == ',' && p[33] == '\n') {
            const unsigned char *a = (const unsigned char *)p;
            unsigned q = (a[20]-'0')*100000u + (a[21]-'0')*10000u + (a[22]-'0')*1000u + (a[23]-'0')*100u + (a[24]-'0')*10u + (a[25]-'0');
            unsigned r = (a[27]-'0')*100000u + (a[28]-'0')*10000u + (a[29]-'0')*1000u + (a[30]-'0')*100u + (a[31]-'0')*10u + (a[32]-'0');
            tot += (unsigned long long)q * r;
            p += 34;
        } else {
            p = slow_row(p, end, &tot);
        }
    }
    return (long long)tot;
}
