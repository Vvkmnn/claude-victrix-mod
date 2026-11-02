# Plan: count_by_hour

Questions I would ask (assumed answers): are inputs always zero-padded and sorted? Real log is; contract
only promises strptime-valid, so I do not assume it, I check it at runtime. Should invalid lines raise? Assumed no (contract-valid input only).

## Mined facts (checked on data/app.log)
- F1 All lines begin with canonical "YYYY-MM-DD HH:MM:SS " (fixed 19 chars + space): Checked (shape test on all 1.5M lines).
- F2 Lines are non-decreasing by timestamp (ties exist): Checked (ks == sorted(ks)).
- F3 Under F1, string order == time order: Proved (zero-padded fixed-width, most significant field first).

## Plan
Slice 20-char keys once (C-speed itemgetter), verify shape with one join+translate+equality, verify sorted via
sorted() compare, then bisect start/end and jump hour-by-hour with bisect. Replaces 1.5M strptime calls.

## Cards
Card 1. Says: string comparison of prefixes equals datetime comparison. Assumes: F1 and canonical start/end.
Breaks when: non-padded ("2026-3-5 7:8:9") or other width. Checked: Proved given guard; guard falls back to original code.
Card 2. Says: bisect range [bisect_left(start), bisect_left(end)) is exactly lines with start<=t<end. Assumes: F2.
Breaks when: unsorted input. Checked: guard (sorted compare) -> fallback. key vs start: t==start gives key>start (included), t==end gives key>end (excluded).
Card 3. Says: jumping with bisect(h+"\x7f") counts each hour's lines. Assumes: keys in hour h are h+":..." < h+"\x7f" and > previous hours. Checked: random tests vs original (2000 sorted, 300 odd/unsorted), real data equal.
Card 4. Says: the fallback equals original. Proved (it is the original code). Triggers: bad shape, unsorted, non-str, non-canonical start/end.
Open: invalid calendar values (month 13) raise in original, not in fast path; outside contract.

## Measured (noisy machine)
Original ~20-43 s; new ~0.7-1.3 s on middle half of data/app.log; output identical.
