# Brownfield candidates (no data download)

Every claim about these projects is a LEAD: written from memory, source not read this session. Read the code before relying on any of it.

## 1. CPython DST-aware log rotation (logging.handlers.TimedRotatingFileHandler)
- Invariant: for any sequence of timestamps across a DST change, `computeRollover` returns a strictly later instant and no rotation is skipped or doubled. LEAD
- Why hard: local-time arithmetic around the 23- and 25-hour days; the code adjusts by the DST offset. LEAD
- Slow version: walk the clock minute by minute in UTC, convert each to local time, and rotate whenever the local calendar day (or hour) changes.

## 2. hargup's feed server
- Invariant: a feed page never repeats or drops an item across pagination while new items arrive. LEAD
- Why hard: cursor versus offset paging under concurrent inserts. LEAD (repo layout and storage unknown)
- Slow version: take a full snapshot, sort it, and slice the pages.

## 3. A small LKML fix
- Invariant: pick one patch whose behaviour a userspace or model-level check can state (a bounds, overflow or ordering rule). LEAD (no patch chosen yet)
- Why hard: kernel context is big and the check must run without booting a kernel; a pure helper function is the likely target.
- Slow version: the naive loop or wider-integer arithmetic that the helper replaced.

## Failures worth learning from
- Rubber stamp: Claude accepts a wrong `facts: claude:` line and builds on it. The discount-shop fixture plants three; run it first.
- Vacuous check: a differential test where fast and slow share a helper, or where seed carts never hit the extreme, passes while the bug stays (cf. the Boris reply "a bot clearing all 12 vaults with guards removed proves the gold is reachable", research/boris.md).

## Next step
Read the source of one candidate, restate each LEAD as verified or drop it, then write its plan in the fixture-plan shape.
