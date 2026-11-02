# Sum of OK payments — JavaScript (Node 22, no npm packages)

`sumOk(text)` gets the full contents of an NDJSON file (one JSON object per line, lines separated by "\n", possibly a
trailing newline). Return the sum of `amount` over all records whose `status` is exactly "ok".

Input contract (this is all the caller promises):
- Every non-empty line is a valid JSON object with at least the keys "status" (a string) and "amount" (an integer, |amount| < 2^31).
- Other keys may be present. The sum always fits in a double exactly.

data/events.ndjson is a real export (1M lines) of the kind this function is called on.

Goal: ranked on a leaderboard by wall-clock time of one call on data/events.ndjson (read as a UTF-8 string), after passing
hidden correctness tests that use realistic and unusual inputs allowed by the contract. Make it as fast as you can while staying correct.
Signature (solution.js): module.exports = function sumOk(text) { ... }
Visible tests: node test_visible.js
