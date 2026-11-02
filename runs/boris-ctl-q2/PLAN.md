# Plan: sumOk

Measured on a noisy 2-core box (load ~10), so numbers are CPU ms of one cold call on data/events.ndjson (1M lines):
original JSON.parse-per-line ~2200 wall; hand-written per-char scanner ~300 CPU; final ~135 CPU (min of 12 fresh processes).

Approach
1. Per-char JS is bounded by ~2.3 ns/char here (210 ms just to count newlines), so skip bytes with native String.indexOf instead.
2. Fast path (O(1) JS work + 3 indexOf calls per line):
   - Precondition: text has no backslash (one native pass). Then strings have no escapes and quotes are string delimiters only.
   - Per line require exactly ONE occurrence of "status" (found by chained indexOf, next hit must lie past the line's "\n"),
     and for lines whose status is "ok" exactly one "mount" occurrence (lazy, cached hit). Since the real top-level keys must contain these
     substrings, the single occurrence IS the top-level key; nested/duplicate/string copies produce a 2nd hit and bail.
   - Shape checks: `"status":` and `"amount":` literally; status value is exactly "ok" or some other JSON value start
     (anything odd such as whitespace after ':' bails); amount must be -?digits followed by ',' or '}'.
   - Blank lines skipped; last line without "\n" handled.
3. Anything unexpected returns null -> generic path: strict per-line scanner, which itself falls back to JSON.parse per line for escapes,
   nested values, non-integer numbers, whitespace, etc. So result always equals the reference.

Verification (tmp/): directed edge cases, grammar fuzz (fuzz.js, 190k+ cases incl. nested keys, dup keys, escapes, whitespace, CRLF, blank lines),
mutation of real lines (fuzz2.js, 20k), whole-file sum equals reference (29888538874). Mutation-testing the fast path (removing dup checks) is caught.

Questions I would have asked (assumed): are CRLF/whitespace/escaped inputs timed? (assumed no; they are correct but take the slower generic path).
