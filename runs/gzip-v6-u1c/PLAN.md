# Plan (Anka)

User unavailable: no questions asked; every shortcut is guarded and falls back automatically (8c: safe path is default on any surprise).

## 0. Prior art
Indexed/seekable gzip (bgzip, zran, pigz -i): independent members or access points let a reader inflate only the needed block. Binary search on sorted logs. memchr-speed substring search instead of per-line parsing. Early termination of a sequential stream.

## 1-2. Facts / substrate vs interface
- Rule names: "valid gzip file (RFC 1952)", lines sorted by timestamp, fixed line format. Interface I assumed by habit: "one gzip stream, must inflate everything, then split lines". RFC 1952 allows concatenated members.
- Fact (checked in data): file is 48 gzip members, one per hour, ~548 KB each, plain 10-byte headers (FLG=0). The magic 1f8b0800 occurs exactly 48 times; every member's first inflated bytes are a log line.
- Fact: ~60k lines/member, 3.4 MB out per member.

## 3-4. Floor vs measured
- Floor for a 1 h window: inflate the 2 members that overlap it (~7 MB out, ~15 ms) + one memchr over 26 MB (~5 ms) = ~20 ms.
- Baseline: gunzip all 166 MB = ~960 ms, whole original ~1.5-3 s (noisy machine). Ratio ~50-100x.
- Measured now: ~34 ms warm, ~55-65 ms cold single call. Residual gap ~2x/3x: 48 small sample-inflates (~12 ms), magic scan (~5 ms), cold zlib/JIT start.

## 5-7. Generality tax
Single stream => sequential inflate. Impossible here only if the file is one member; so: detect members by magic, validate each by inflating a 6 KB prefix and requiring a well-formed timestamp line (false magics are dropped; dropping is always safe because a dropped candidate just stays inside the previous segment, which is decompressed with the multi-member-aware gunzipSync). Per member S_k = ts of first line STARTING inside it. Member k needed iff S_k < end and S_{k+1} >= start. Straddling line at the right edge is completed from the next member's sample head. Left edge partial line has ts <= S_kmin < start, so skipping it is exact. Within the inflated bytes: byte-level binary search for window bounds (sorted), then indexOf(" 500 ") counting, each hit verified to be the 4th token (exactly 2 spaces before it on its line).

## Cards
1. Multi-member skipping. Says: only members overlapping window matter. Assumes sorted ts, header FLG=0, ts format. Breaks when: single member / odd headers / unsorted S / odd line. Checked: fuzz 1440 synthetic multi-member cases (mid-line splits, stored+fast+default levels, duplicate timestamps, no trailing newline) all equal to the obvious version AND fast path actually used in all; real file random + hour-edge windows (+-1ms) equal oracle. Guard: any anomaly returns -1/throws -> streaming path.
2. Binary search + indexOf count. Says: equals line-by-line filter. Assumes sorted lines, 24-char ts, duration token present after status. Breaks when line shorter than 24 / bad ts (throws -> fallback). Paths with spaces: hit rejected, same as split(" ")[3].
3. Streaming fallback (single-member files). Says: inflate growing prefix (Z_SYNC_FLUSH on truncated gzip), extrapolated size, stop when a line with ts >= end seen. Checked: 1600 fuzz cases incl. blank lines, big files, equals obvious. Rejected first attempt: Gunzip._processChunk (handle closes after each call). Open: costs ~1.25-2.5x the needed prefix.
4. Last resort: original split-based code (throws in the same way if gzip invalid).

## Rejected / revisit
- Lazy binary search over byte offsets for members (skips 48 samples + full magic scan, ~15 ms): not done; revisit if leaderboard is tight.
- Scale sweep: memory = 2-3 members (<=~11 MB) for hourly members; if one member were huge the fast path degrades to streaming. Revisit when window spans > ~50 members.
