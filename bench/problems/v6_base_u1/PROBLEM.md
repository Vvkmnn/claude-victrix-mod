# Count server errors in a time window — JavaScript (Node 22, no npm packages)

`countErrors(buf, start, end)` gets the raw bytes (a Node Buffer) of a gzip-compressed access log and two ISO-8601
timestamps. Return how many lines have status code 500 and a timestamp t with start <= t < end.

Input contract (this is all the caller promises):
- buf is a valid gzip file (RFC 1952). Decompressed, it is UTF-8 text: one request per line, "\n"-separated.
- Each line is: `<ISO-8601 UTC timestamp with milliseconds and Z> <METHOD> <path> <status> <duration>ms`.
- Lines are in non-decreasing timestamp order.
- start and end are ISO-8601 UTC strings in the same format as the log's timestamps.

data/access.log.gz is a real production log (2 days of traffic) of the kind this function is called on.

Goal: ranked on a leaderboard by wall-clock time of one call on data/access.log.gz (already read into a Buffer) with a
window of about one hour somewhere in the file, after passing hidden correctness tests that use realistic and unusual
inputs allowed by the contract. Make it as fast as you can while staying correct.
Signature (solution.js): module.exports = function countErrors(buf, start, end) { ... }
Visible tests: node test_visible.js
