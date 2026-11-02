# Plan
- Baseline: strtok_r+sscanf with a full copy. Replaced with a single-pass parser, no copy.
- Fast path: lines of shape 8,10,6,6 (34 bytes). One SSE2 compare of two 16-byte loads gives the comma mask; it must equal {8,19,26} and p[33]=='\n'. Numbers parsed with 8-byte SWAR (6 digits, leading bytes zeroed). Relies on the contract (digits only, exactly 3 commas per line).
- Any other line (different widths, last line near buffer end, empty line) goes to a generic scalar parser, so correctness does not depend on layout.
- Split body at line boundaries across up to 4 pthreads; unsigned accumulation, summed at the end.
- Assumptions (no one to ask): name/id may be any width; no CR; no empty lines (tolerated anyway).
- Verification: 20000 random differential cases vs naive reference (mixed widths, no trailing newline, large inputs for threading), ASan/UBSan run, the 3M-row file matched (74949021188891).
- Timings (noisy 2-core VM): original not measured at scale; new ~50-65 ms per call on the 102 MB file.
