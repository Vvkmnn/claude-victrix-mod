# Plan (Anka)

Assumptions (questions I could not ask): rows in real data are always 8-digit id, 10-char name, 6-digit qty/price; hidden tests may vary widths, empty names, no trailing newline.

Facts mined: orders.csv has fixed 34-byte rows (commas at offsets 8,19,26, newline at 33). Contract guarantees qty/price are digit strings and name has no comma/newline.

Plan: no copy, no strtok/sscanf. Single pass; per row, a fixed-offset fast path with a runtime guard (check the 3 commas + newline, and >=34 bytes remain); any mismatch falls to a generic memchr-based parser relying only on the contract.

Cards
- Says: fast path computes qty*price for 34-byte rows. Assumes: row shape verified by guard; digits per contract. Breaks when: field widths differ -> guard fails -> slow path. Checked: tested mixed widths/empty name/no final newline (sum 999999998000000041 correct, exact int math).
- Says: unsigned 64-bit accumulation equals signed total. Assumes: total fits in int64 (contract). Checked: Proved (mod 2^64 arithmetic).
- Says: header skipped by first newline. Breaks when: no newline -> returns 0. Checked.
- Says: result matches reference on data. Checked: 74949021188891 equals awk sum.

Measured: ~67-105 ms per call on 102 MB (noisy 2-core box), vs. original sscanf/strtok version far slower (not timed).
