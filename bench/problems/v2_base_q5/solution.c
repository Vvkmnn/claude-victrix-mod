#define _POSIX_C_SOURCE 200809L
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

long long sum_qty_price(const char *buf, size_t len) {
    char *copy = malloc(len + 1);
    memcpy(copy, buf, len);
    copy[len] = '\0';
    long long total = 0;
    char *save = NULL;
    char *line = strtok_r(copy, "\n", &save);   /* header */
    while ((line = strtok_r(NULL, "\n", &save)) != NULL) {
        long long id, qty, price;
        char name[1024];
        if (sscanf(line, "%lld,%1023[^,],%lld,%lld", &id, name, &qty, &price) == 4)
            total += qty * price;
    }
    free(copy);
    return total;
}
