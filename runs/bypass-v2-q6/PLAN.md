# Plan (Anka)
Facts mined from data/ids.txt (5M lines): every ID has length 10; ~2.2% invalid, almost all by a single corrupted char. Regex is the general layer (pattern compile/match engine per call, Matcher allocation).
Questions I would have asked (assumed answers): are non-ASCII/odd strings possible? -> yes per contract, so no input-shape assumption is made.
Profile: String.matches ~7-9 s (cold-ish); layer cost is regex engine. Parallel streams tried: 166 ms vs 148 ms sequential (2 cores, memory-bound) -> rejected.
Specialize: length==10 gate, then unsigned-range char checks; digits OR-accumulated, one sign test.

Cards
- Says: length != 10 means invalid. Assumes: pattern matches exactly 10 chars. Breaks when: never (pattern fixed). Checked: Proved.
- Says: (c-'A')<=25 and >=0 iff c in A-Z; digits likewise via d|(9-d)>=0. Assumes: chars are 16-bit (no overflow). Breaks when: never. Checked: Proved + 2M-case differential fuzz vs regex (non-ASCII, \n, Arabic-Indic digits, fullwidth letters, wrong lengths).
- Says: no data-shape assumption beyond the pattern, so no runtime guard/fallback needed. Checked: Proved.
- Says: result equals regex count on the real batch. Checked: 4,890,486 both.
Result: ~148 ms best of 20 warmed calls vs seconds for the regex baseline.
