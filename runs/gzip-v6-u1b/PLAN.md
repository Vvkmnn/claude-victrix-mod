# Plan (Anka)

## 0. Prior art
- zlib/libdeflate: inflate runs ~400 MB/s of output; floor for any sequential decode.
- pigz/zran/BGZF/rapidgzip: parallel or random-access gzip needs sync-flush points, an index, or speculative block
  starts with a marker window. Early termination (stop decoding once past the range) is the standard cheap win.
- Built on: native inflate + early stop + byte-level scan (no string conversion).

## 2. Substrate vs interface
- Rule names: "valid gzip file (RFC 1952)", "UTF-8 text, \n separated", "non-decreasing timestamps", fixed line format.
- Interface I happened to use: zlib.gunzipSync (whole output, 166 MB string, split). Not named by any rule.
- Lower interface used: zlib binding handle writeSync (resumable inflate; Node's public sync API is one-shot).

## 3/4. Floor vs measured
- Output 166 MB; pure native inflate of everything = ~380-430 ms (measured, OUT buffer size insensitive).
- Original solution: ~4.9 s (12:00 window). Window at 47h now ~490 ms, i.e. at the inflate floor; at hour 0, 30 ms.
- Scan of the window itself (~64k lines) is negligible; chunk-level skip means pre-window data is never parsed.

## Facts / cards
- Card: sorted input => stop at first ts >= end, and skip whole chunks whose last full line has ts < start.
  Assumes: contract sortedness. Breaks when: unsorted input (contract forbids). Checked: differential fuzz 1800 cases.
- Card: fixed-width ts, so byte compare == string compare (done generally via length-tiebreak compare, ASCII only).
  Guard: start/end non-printable-ASCII or not gzip magic or any exception => reference implementation.
- Card: status = 4th space token, exactly "500" (same as reference split(" ")).
  Checked: fuzz includes 5000, 50, CR, blank lines, no trailing newline, multi-member gzip, reversed window.

## Rejected: speculative mid-stream start (rapidgzip style)
- No sync-flush markers in the file (0 occurrences of 00 00 FF FF). Dynamic block starts findable by header
  validation (~27 KB compressed apart, ~30 ms per find in JS), and zlib can start there with a dictionary.
- Measured: with a fill dictionary the decoded text is ~all tainted even 200 KB in (date prefix, path prefix
  are copied from the unknown window forever). Cannot recover exact timestamps => cannot be exact. Rejected.
- Revisit if: caller can supply an index / file has sync points / lines are fully literal.

## Questions I could not ask (user unavailable)
- Is an approximate/heuristic skip acceptable? Prototyped, measured as unrecoverable; default stays exact.

## Ratchet
- v1 gunzipSync+split: ~4.9 s. v2 handle-based streaming + early stop: 30-490 ms. Kept.
