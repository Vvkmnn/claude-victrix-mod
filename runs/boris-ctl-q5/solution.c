#define _POSIX_C_SOURCE 200809L
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <unistd.h>
#include <pthread.h>
#if defined(__SSE2__)
#include <emmintrin.h>
#endif

/* Generic parser for one line starting at p (p < end). Returns pointer to the
   start of the next line; adds qty*price to *acc. */
static inline const char *slow_line(const char *p, const char *end, uint64_t *acc) {
    const char *nl;
    if (*p == '\n') return p + 1;
    while (p < end && *p != ',') p++;          /* id */
    p++;
    while (p < end && *p != ',') p++;          /* name */
    p++;
    uint64_t q = 0, pr = 0;
    while (p < end && (unsigned)(*p - '0') < 10u) q = q * 10 + (uint64_t)(*p++ - '0');
    p++;                                       /* comma */
    while (p < end && (unsigned)(*p - '0') < 10u) pr = pr * 10 + (uint64_t)(*p++ - '0');
    nl = p;
    while (nl < end && *nl != '\n') nl++;      /* tolerate trailing junk such as \r */
    *acc += q * pr;
    return nl < end ? nl + 1 : end;
}

static inline uint64_t load64(const char *p) { uint64_t v; memcpy(&v, p, 8); return v; }

/* 8 digit chars (first char in lowest byte) -> value */
static inline uint64_t parse8(uint64_t v) {
    v = ((v & 0x0F0F0F0F0F0F0F0FULL) * 2561) >> 8;
    v = ((v & 0x00FF00FF00FF00FFULL) * 6553601) >> 16;
    v = ((v & 0x0000FFFF0000FFFFULL) * 42949672960001ULL) >> 32;
    return v;
}

typedef struct { const char *s, *e, *bufend; uint64_t sum; } job_t;

static void run_range(const char *s, const char *e, const char *bufend, uint64_t *out) {
    uint64_t acc = 0;
    const char *p = s;
    /* Fast path: lines shaped  8 + ',' + 10 + ',' + 6 + ',' + 6 + '\n' (34 bytes). */
#if defined(__SSE2__) && defined(__x86_64__)
    const __m128i comma = _mm_set1_epi8(',');
    const unsigned CM = (1u << 8) | (1u << 19) | (1u << 26);
    while (p < e) {
        /* Contract: every line has exactly 3 commas, digits-only numeric fields.
           A line at p is the expected shape iff commas sit at 8,19,26 and p[33]=='\n'. */
        if (bufend - p >= 34) {
            __m128i a = _mm_loadu_si128((const __m128i *)p);
            __m128i b = _mm_loadu_si128((const __m128i *)(p + 16));
            unsigned cm = (unsigned)_mm_movemask_epi8(_mm_cmpeq_epi8(a, comma))
                        | ((unsigned)_mm_movemask_epi8(_mm_cmpeq_epi8(b, comma)) << 16);
            if ((cm == CM) & (p[33] == '\n')) {
                uint64_t q  = parse8(load64(p + 18) & 0xFFFFFFFFFFFF0000ULL);
                uint64_t pr = parse8(load64(p + 25) & 0xFFFFFFFFFFFF0000ULL);
                acc += q * pr;
                p += 34;
                continue;
            }
        }
        p = slow_line(p, e, &acc);
    }
#else
    while (p < e) p = slow_line(p, e, &acc);
#endif
    *out = acc;
}

static void *worker(void *arg) {
    job_t *j = (job_t *)arg;
    run_range(j->s, j->e, j->bufend, &j->sum);
    return NULL;
}

long long sum_qty_price(const char *buf, size_t len) {
    const char *end = buf + len;
    const char *p = memchr(buf, '\n', len);
    if (!p) return 0;
    p++;                                        /* skip header */
    size_t body = (size_t)(end - p);
    int nt = 1;
    if (body >= (1u << 20)) {
        long c = sysconf(_SC_NPROCESSORS_ONLN);
        nt = c < 1 ? 1 : c > 4 ? 4 : (int)c;
    }
    job_t jobs[8];
    pthread_t th[8];
    int started[8] = {0};
    /* chunk boundaries aligned to line starts */
    const char *b[9];
    b[0] = p;
    for (int i = 1; i < nt; i++) {
        const char *g = p + body / (size_t)nt * (size_t)i;
        if (g < b[i - 1]) g = b[i - 1];
        const char *n = g > p && g[-1] == '\n' ? g : memchr(g, '\n', (size_t)(end - g));
        b[i] = n ? (n == g ? g : n + 1) : end;
    }
    b[nt] = end;
    for (int i = 0; i < nt; i++) {
        jobs[i].s = b[i]; jobs[i].e = b[i + 1]; jobs[i].bufend = end; jobs[i].sum = 0;
    }
    for (int i = 1; i < nt; i++)
        started[i] = pthread_create(&th[i], NULL, worker, &jobs[i]) == 0;
    run_range(jobs[0].s, jobs[0].e, end, &jobs[0].sum);
    uint64_t total = jobs[0].sum;
    for (int i = 1; i < nt; i++) {
        if (started[i]) pthread_join(th[i], NULL);
        else run_range(jobs[i].s, jobs[i].e, end, &jobs[i].sum);
        total += jobs[i].sum;
    }
    return (long long)total;
}
