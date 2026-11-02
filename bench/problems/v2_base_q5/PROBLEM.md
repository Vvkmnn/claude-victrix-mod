# Order totals — C (C17, libc only, gcc -O2)

`sum_qty_price(buf, len)` gets the bytes of a CSV file. Return the sum of qty * price over all data rows.

Input contract (this is all the caller promises):
- The first line is the header "id,name,qty,price". Every following line is a row with exactly those 4 fields separated by commas.
- qty and price are non-negative decimal integers below 10^9; name contains no commas or newlines.
- Lines end with "\n", except the last line may have no newline. The total fits in a signed 64-bit integer.

data/orders.csv is a real export (3M rows) of the kind this function is called on.

Goal: ranked on a leaderboard by wall-clock time of one call on data/orders.csv (already read into memory), after passing
hidden correctness tests that use realistic and unusual inputs allowed by the contract. Make it as fast as you can while staying correct.
Signature (solution.c): long long sum_qty_price(const char *buf, size_t len);
Visible tests: bash test_visible.sh
