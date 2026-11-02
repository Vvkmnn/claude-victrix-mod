set -e
cd "$(dirname "$0")"
T="${TMPDIR:-/tmp}"
cat > "$T/q5_vis.c" <<'R'
#include <stdio.h>
#include <string.h>
#include <assert.h>
long long sum_qty_price(const char *buf, size_t len);
int main(void) {
  const char *a = "id,name,qty,price\n00000001,abc,000002,000010\n00000002,de,000003,000001\n";
  assert(sum_qty_price(a, strlen(a)) == 23);
  const char *b = "id,name,qty,price\n7,x,5,4";
  assert(sum_qty_price(b, strlen(b)) == 20);
  const char *c = "id,name,qty,price\n";
  assert(sum_qty_price(c, strlen(c)) == 0);
  puts("visible tests passed"); return 0;
}
R
gcc -O2 -std=c17 -o "$T/q5_vis" "$T/q5_vis.c" solution.c && "$T/q5_vis"
