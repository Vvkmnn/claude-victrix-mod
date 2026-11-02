# Plan
- Baseline: String.matches per element (regex compile each call), ~seconds.
- Fix: length==10 check, then branch-free char range checks (sign-bit OR trick), hyphen at index 3.
  charAt on non-Latin1 chars yields >255 so they fail range checks; ASCII-only classes preserved.
- Split array across min(cores,4) threads (2 here), plain Threads, per-thread result slots, join.
  Small inputs (<100k) run single-threaded.
- Verify: differential vs regex on real data (4890486 valid) + 40 fuzz rounds up to 300k strings
  with boundary chars (@ [ ` / : non-ASCII, trailing newline, surrogates) + edge cases.
- Assumptions: no questions needed; ids elements non-null per contract.
