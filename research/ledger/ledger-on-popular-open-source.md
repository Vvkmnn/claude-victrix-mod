# Justified decisions would have landed most fixes sooner

**Verdict: yes, mostly, and for a specific reason. Ledger would have helped 13 of the 20 recently merged fixes studied here land meaningfully earlier, and it fits most of the 18 open issues reviewed. The reason is not that the bugs were hard. Every one of them breaks a one-sentence rule ("a finite number written to JSON never comes back infinite", "an optimizer rule never changes a result"), and in most cases the project already had a free reference to compare against: its own parser, sync mode, the cache turned off, the previous compiler, or exact arithmetic. Confidence: 7/10.** Three things hold it below 10. First, every rating is hindsight: each property was read off a fix that already explained the bug, and nobody has yet tested whether Ledger's questions produce the same property *before* the fix. Second, nothing was executed. "Fails on the first input" is reasoning from published repros, not a run. Third, coverage has holes: React was not accessible, issue comment threads could not be read, and Rust std/serde produced no usable case. Two facts shape the pitch. Bugs that cheap checks would catch survived for years in the most-used software: **~8 years in NumPy and pandas, 7.8+ years in Luxon, ~12 years in Valkey**. And at least **7 of the 20 fixes disclose AI help** (Claude Code, OpenAI Codex, an AI CI agent). Agents are already finding these bugs, so Ledger's edge is not finding them. Its edge is the recorded justification plus a check that fails before the fix and passes after it, which shortens the maintainer's review.

## The spine: a justified decision, re-checked on every change

hargup's lean-derive submission is the template. The transcript of the video about it states the key point plainly: *"you could write these exact optimizations in C yourself without ever touching Lean. Lean just lets you prove that these optimizations are safe for your specific workload."* (user-supplied transcript). His code proves `feedPlan = feed` under an invariant, emits C, and guards the invariant at runtime with a SQL fallback; "the C emitted for them is tested, not proved" ([submission](https://github.com/arjaythedev/twelve-dollar-server-challenge/tree/main/submissions/lean-derive-hargup)). Generalised, every engineering choice Ledger records has four parts:

| Part | Plain English | Example (pandas #71325) |
|---|---|---|
| **1. The choice** | What we decided to do | "Add digits one at a time until the JSON number parses as finite" |
| **2. Why it's safe** | Facts about *this* workload that make it safe | "17 significant digits always round-trip a float64, so the loop ends" |
| **3. The check** | Evidence that the choice equals the obvious or reference version under those facts. It can be proved, model-checked, solver-checked or property-tested | Round-trip property: `isfinite(x) ⇒ isfinite(read_json(to_json(x)))` for every precision 0–15 |
| **4. The guard** | A runtime check plus a fallback for when the facts stop holding | Loop capped at 17 digits, then fall back to full `repr` |

That is an architecture decision record whose "because" gets re-verified on every change. Each card carries a label taken from TheoricLabs' evidence classes, **Proved / Checked / Assumed / Open** ([leanapi](https://github.com/theoriclabs/leanapi)), and one plain-English "why it's safe" sentence. That sentence is Tao's "Math 2.0" point applied to code: the goal is understanding and exposition, not just answers ([Tao](https://teorth.github.io/tao-web/ai-views.html)). The math stays collapsed. The sentence is the product.

Ledger gets parts 2 and 3 out of a developer by asking plain-English questions. The original five are: *What must never happen? What are the hard limits? What should be as big or small as possible? What's uncertain? Does order or timing matter?* This research adds two more, because the cases below kept demanding them:

| New question | Why it was needed | Cases it would have caught |
|---|---|---|
| **Q6. What should agree with this?** | Comparison oracles were the check in **11 of 20** merged fixes | Own parser (Luxon, Go, pandas), optimizer on/off (DuckDB), cache on/off (zod #6707), sync vs async (zod #6702), old vs new version (TS6 vs TS7), UTC vs local (CPython), exact math (ClickHouse) |
| **Q7. Which settings, platforms or flags change this?** | The original five never point at configuration or environment | Rails `partial_inserts=false`, Django on Windows + Python 3.15, TS7 `--checkers`, date-fns system TZ |

## Twenty merged fixes: most were one question away

The cases come from PRs merged between July and November 2026 in CPython, Node.js, Go, NumPy, pandas, tokio, Valkey, PostgreSQL, DuckDB, ClickHouse, etcd, Luxon, temporal-polyfill, Rails, zod, TypeScript and Django. "Lived" means the time from the first report, or from when the code was introduced, to the merge; the cell says which. "Earlier?" is a judgement made in hindsight.

### Language runtimes and core libraries

| Project / link | What broke | Lived | The decision and why it's safe | Ledger question | The check | Earlier? |
|---|---|---|---|---|---|---|
| NumPy [#32467](https://github.com/numpy/numpy/pull/32467) | `digitize` checked bin order after casting int64 to float64, so distinct large ints looked equal and gave wrong bins | **~8y 4m** (issue [#11022](https://github.com/numpy/numpy/issues/11022), 2018) | Compare adjacent edges in their own dtype. Safe because integer comparison is exact at any width | Uncertain: "do huge integer bins behave like small ones?" | Hypothesis: `digitize == searchsorted` oracle over int64/uint64 biased to ≥2^53 | **High.** The 2018 issue already stated both the property and the oracle |
| pandas [#71325](https://github.com/pandas-dev/pandas/pull/71325) | `to_json` rounded floats near float64 max to a literal every parser reads as `inf` | **~8y 5m** ([#21454](https://github.com/pandas-dev/pandas/issues/21454)) | Add digits until the output is finite; 17 always suffice | Never: "a finite number never comes back non-finite" | Round-trip through `read_json`; Hypothesis tries `float_info.max` early | **High** |
| CPython [#160564](https://github.com/python/cpython/pull/160564) | `TimedRotatingFileHandler` misnamed backups around DST and merged intervals | 1 day as a report; the DST class was reported in 2020 ([gh-86410](https://github.com/python/cpython/issues/86410)) | Name backups from the unshifted interval start. Safe because fixed intervals don't move with DST | Timing + uncertain: "local time, DST, late records" | Stateful test with a mocked clock; **UTC run as the oracle**, which is what the PR itself did | **Medium.** Simple property, heavy harness |
| Go `net/mail` ([#80592](https://github.com/golang/go/issues/80592)) | `Address.String` output that `ParseAddress` rejects (backslash in display name) | 6 days as a report; latent age unknown | Use B-encoding when the name has a backslash | Never: "what we print, we can parse back" | `go test -fuzz` round-trip over RFC 5322 specials | **High.** The failing input is two characters |
| Node.js [#66325](https://github.com/nodejs/node/pull/66325) | `Buffer.indexOf` returned a negative index past 2 GiB (int32 narrowing) | 3 days as a report; the int32 limit dates to 2016 ([#67009](https://github.com/nodejs/node/pull/67009)) | Return a 64-bit index. Safe because `MAX_LENGTH < 2^53` | Hard limits: "buffers larger than 2^31" | `r === -1 ∨ off ≤ r < len`, plus a bounded check on the narrowing | **Medium.** Needs ~4.5 GB RAM, or a symbolic check. **Partial fix:** the offset clamp is still open |
| tokio [#8645](https://github.com/tokio-rs/tokio/pull/8645) | `Barrier` became a pass-through after a panicking waker, because state was updated after `send` | Not stated; found by analogy with #8560 | Reset state before calling foreign code | Timing: "can callbacks panic?" | loom model with a panicking waker | **Medium-low.** The fault model is unusual to volunteer. **Limits case** |

### Databases and infrastructure

| Project / link | What broke | Lived | The decision and why it's safe | Ledger question | The check | Earlier? |
|---|---|---|---|---|---|---|
| Valkey [#4880](https://github.com/valkey-io/valkey/pull/4880) | `now + relative TTL` overflowed to a negative expire and crashed the server, including on restart | **Every release 7.2.0–9.1.2**; the code predates the fork | Check `value > LLONG_MAX − basetime` before adding | Never: "a stored expire is never negative" | Z3 bit-vector query on the guard plus the add; existing tests used an input the earlier guard rejected, "so the addition was never reached" | **High** |
| Valkey [#5163](https://github.com/valkey-io/valkey/pull/5163) | 32-bit wrap in the quicklist merge size estimate allowed a merge that then asserted | **~12 years** (2014) | Use `size_t`; the sibling `AllowInsert` already did | Hard limits: "listpack < 4 GiB; the estimate must agree with the real merge" | Estimate ≡ real size, via CBMC/Kani or a solver | **Medium-high** |
| PostgreSQL [85f5553](https://github.com/postgres/postgres/commit/85f55534e80b633bdb7bfc91eaa5793021d6bf66) | `MERGE … NOT MATCHED BY SOURCE` ran the wrong action after a concurrent delete | Since the v17 feature (~2 years) | On retry, only flip `matched` for WHEN MATCHED actions | Timing: "a concurrent DELETE between match and action" | Model-check the retry loop (TLA+/P) or enumerate isolation permutations; the fix added an isolation spec | **Medium.** The tester existed; the spec didn't |
| DuckDB [#24368](https://github.com/duckdb/duckdb/pull/24368) | Two optimizer rewrites changed results (NaN ordering; NULL folded to FALSE) | Not stated | Each rule must preserve three-valued logic with IEEE specials | Never + **Q6** (optimizer off) | **Found by** diffing ~1,000 predicates against runs with each of 43 optimizers disabled | **High.** Ledger's value is making this routine for every new rule |
| ClickHouse [#124680](https://github.com/ClickHouse/ClickHouse/pull/124680) | Decimal rescale used a multiply that "wraps and reports success" for Int128/256 | Class open since 2022 ([#38223](https://github.com/ClickHouse/ClickHouse/issues/38223)) | Checked multiply on comparisons and casts | Hard limits: "exact result or DECIMAL_OVERFLOW, never wrapped" | Differential against exact rationals; Z3 proof of the helper | **High.** **Partial fix:** arithmetic and `greatest`/`least` left unchanged |
| etcd [#22609](https://github.com/etcd-io/etcd/pull/22609) | `store.hash` read the backend and revision without locks during `Restore` | Several release lines | Take `s.mu` and `revMu` | Timing: "what runs concurrently with Restore?" | Race detector plus a targeted test (failed 40/40 before, passed 200/200 after) | **Medium.** The deeper consistency TODO stays **Open** |
| Valkey [#4823](https://github.com/valkey-io/valkey/pull/4823) | `LSET` index narrowed `long → int`, so `4294967296` modified element 0 | Not stated | Keep the 64-bit index | Never: "out of range ⇒ error, list unchanged" | Boundary PBT / narrowing lint | **High** |

### Web frameworks and developer tools

| Project / link | What broke | Lived | The decision and why it's safe | Ledger question | The check | Earlier? |
|---|---|---|---|---|---|---|
| Luxon [#1784](https://github.com/moment/luxon/pull/1784) | `Duration#toISO` printed `2.77e-7H`, which its own parser rejects | **7.8+ years** latent ([repo](https://github.com/moment/luxon)) | Expand exponent notation; ≥1e21 left out of scope | Never + Q6: "own parser" | fast-check `fromISO(toISO(d))` round-trip | **High.** A card also records the ≥1e21 gap as Open |
| temporal-polyfill [#104](https://github.com/fullcalendar/temporal-polyfill/pull/104) | `diffDays(x, x)` threw; one caller skipped the `sign ≠ 0` guard | ~2–3 months | Guard `if (!sign) return 0` at the last call site | Hard limits: precondition `sign ≠ 0` | `diff(x, x) = 0`, plus "every caller establishes the precondition" | **High** |
| Rails [#59435](https://github.com/rails/rails/pull/59435) | Counter cache double-incremented with `partial_inserts = false` | **3y 8m** from report ([#47555](https://github.com/rails/rails/issues/47555)) | Leave unchanged counter columns out of INSERT | Never: "counter = row count" + **Q7** | Stateful PBT across operations × `partial_inserts ∈ {true, false}` | **Medium.** Only with the flag question |
| zod [#6707](https://github.com/colinhacks/zod/pull/6707) | Encode skipped nested checks; memo cache shared between passes | ≤2.5 months (inferred) | Separate caches per pass | Q6: "memo on vs off" | Differential using the existing `z.config()` toggle | **Medium-high** |
| zod [#6702](https://github.com/colinhacks/zod/pull/6702) | Async tuple rest elements all written to the last index | Not stated | Per-iteration index capture | Q6: "sync vs async" | `parseAsync ≡ parse` for rest length ≥ 2 | **High** |
| TypeScript 7 [#65060](https://github.com/microsoft/TypeScript/pull/65060) | Emit dropped parentheses: `new (f() as T).C()` became `new f().C()` | ~4 months (TS 7.0 to fix) | Preserve required parens | Never + Q6: "TS6 output" | Precedence fuzzing with TS6 as oracle | **Medium-high** |
| Django [#22186](https://github.com/django/django/pull/22186) | `makemessages` broke on non-ASCII names on Windows (Python 3.15 UTF-8 vs ANSI code page) | Short | Write the file list in the encoding xgettext reads | Only Q7 reaches it | A Windows + 3.15 CI matrix, not math | **No/low. Limits case** |

**Tally (hindsight):** High 10, Medium-high 3, Medium 5, Medium-low 1, No/low 1. Counting High and Medium-high as "earlier" gives **13 of 20**; all 20 ratings carry the same hindsight caveat.

## Six patterns, and what each says about Ledger

| Pattern | Evidence | What it means for Ledger |
|---|---|---|
| **Comparison oracles dominate** | 11/20 checks compare against something the project already had: own parser, `searchsorted`, UTC, optimizer off, memo off, sync, TS6, exact math, or the real merge size | Q6 ("what should agree with this?") is worth more than asking for an absolute spec. Most developers can't write a spec, but they can name a twin |
| **Boundary arithmetic behind untested guards** | Valkey #4880's tests used an input the earlier guard rejected, so the vulnerable add never ran; same family: Valkey #5163/#4823, Node, ClickHouse, NumPy (2^53), pandas (float max), PostgreSQL [903ce58](https://github.com/postgres/postgres/commit/903ce587e665af18ef1af24b4632e5ed4bf78edc) | Q2 → a solver or boundary generator on *guard plus arithmetic*. Minutes of compute; Z3 finds these counterexamples immediately |
| **Partial fixes repeat at neighbouring sites** | Node #66325 → open [#67008](https://github.com/nodejs/node/issues/67008); tokio #8560 → #8645; ClickHouse leaves #38223; pandas [#71389](https://github.com/pandas-dev/pandas/pull/71389) leaves `length`; temporal's one unguarded caller; Valkey's `AllowInsert` already correct | **State the property for the whole API** (every offset and return value; every foreign-code call site), not the symptom. Highest-leverage design rule found |
| **Distributed and timing bugs need model checking and honest labels** | PostgreSQL MERGE, etcd hash/restore, tokio Barrier; open etcd [#22028](https://github.com/etcd-io/etcd/issues/22028) was found by Antithesis | Route Q5 answers to TLA+/P, loom or isolation enumeration. Never label **Checked** from unit tests. Fixing a data race leaves the semantic claim **Open** |
| **Settings and platform blind spot** | Rails flag, Django Windows/3.15, TS `--checkers`, date-fns system TZ, ClickHouse `decimal_check_overflow` | Q7 makes the generator range over config and platform, and turns untested environments into **Assumed** cards |
| **AI agents already find many of these** | Codex (NumPy), Claude Code (pandas ×2, etcd, Django), "AI generated details" (Valkey), AI CI agent `groeneai` (ClickHouse [#122134](https://github.com/ClickHouse/ClickHouse/issues/122134)); Django [#22102](https://github.com/django/django/pull/22102): "Claude discovered this issue" | Ledger's edge is a **recorded justification** plus a **fail-before / pass-after check** a maintainer can trust in one read. Several PRs already did this by hand (Luxon and Go round-trip tests; CPython's "seven local-time subcases fail… seven UTC controls pass"; etcd's 40/40 vs 200/200) |

## Open-issues playbook: agree on the contract first, then the small fix

In the open issues the code change is usually small. The hard part is agreeing what "correct" means. Status is as of 2026-11-01.

| Issue | The spec / invariant | Questions to ask maintainers | Confirming check | Label | Risk |
|---|---|---|---|---|---|
| **anthropics/claude-code [#92542](https://github.com/anthropics/claude-code/issues/92542)**: Bash deny rules bypassed by any wrapper outside an 8-item unwrap list (103 unintended files committed) | Wrapping never weakens a denial: `denied(c) ⇒ denied(w c)`. **Fail closed**: unknown program + argv tail matching a deny rule ⇒ ask/deny, never allow | Is deny a security boundary or best-effort? (Docs call it client-side filtering.) Which positions forward exec? Are `sh -c`, `xargs` and `sudo` in scope? | fast-check: denied commands × random wrapper chains (known, unknown, nested); assert no `allow` | **Checked** for the known list; **Open** for arbitrary scripts (undecidable) | False prompts on harmless commands like `echo git add -A`. It's a policy decision, not just a fix. Version 2.1.258 list not re-verified |
| **anthropics/claude-code [#91271](https://github.com/anthropics/claude-code/issues/91271)**: second `marketplace add` silently drops `autoUpdate` | Idempotence `add(add(S,m),m) = add(S,m)`; frame condition: keys `add` doesn't own are untouched | Which fields does `add` own (e.g. a changed `source`)? | Property over random settings JSON; fails on the first input with `autoUpdate` | **Assumed** until ownership is agreed, then **Proved** (tiny pure merge function) | Low |
| **POSIX TZ showcase**: CPython [#159712](https://github.com/python/cpython/issues/159712) (zero-based `n` one day early), [#159715](https://github.com/python/cpython/issues/159715) (local→UTC round-trip shifts an hour at a year boundary), Go [#70633](https://github.com/golang/go/issues/70633) (`ZoneBounds` returns year ends, not transitions, open since 2024) | One card: *"converting to local and back never changes the instant, and transitions match glibc for any valid TZ string."* Go: `start ≤ t < end`, zone constant on `[start,end)`, and the bounds are real transitions | Is glibc or the POSIX text the reference when they disagree? Are year-wrapping (southern-hemisphere) footers supported? Is "real transitions" Go's contract, given a comment that says year ends suffice "for the only caller that cares"? What performance budget applies? | **One shared generator** of valid footer strings (`Jn`, `n`, `Mm.w.d`, negative and >24 h times), instants biased to year ends and leap years; **four oracles**: CPython C, CPython pure-Python, Go, glibc via `tzset`. Optional Z3 for the `n` vs `Jn` day arithmetic | **Checked** across runtimes; **Assumed** on the glibc-is-reference answer | glibc, musl and macOS may disagree; behaviour changes for real TZif files (probably rare); Go's is arguably a contract change. Go fixed a leap-year bug in the same code in Sept 2026 ([#81583](https://github.com/golang/go/issues/81583)) |
| Node [#67008](https://github.com/nodejs/node/issues/67008) / PR [#67009](https://github.com/nodejs/node/pull/67009): `byteOffset` clamped to 2^31−1 | Whole-API: `r === −1 ∨ (norm(off) ≤ r < len ∧ match)`, first such index; `includes ⟺ indexOf ≠ −1`; metamorphic `indexOf(n, off) = off + buf.subarray(off).indexOf(n)` | Follow `TypedArray` offset semantics exactly? Is a large-RAM CI job allowed? Do `fill`/`copy`/`compare` belong on the same card? | Metamorphic fast-check on small buffers; bounded check of offset normalisation over ±2^53; one gated >2 GiB test | Checked (small) + Proved (normalisation) | Flaky high-RAM CI; LTS backports |
| pandas [#25499](https://github.com/pandas-dev/pandas/issues/25499): `IntervalIndex.length` still wraps | `left ≤ mid ≤ right` (done); `length ≥ 0 ∧ left + length = right`, or flagged | Wrap (like Series subtraction), upcast or raise? Should datetime `mid` match scalar `Interval`? | Hypothesis per int dtype + datetime extremes; index vs scalar differential | **Assumed** ("wraps like Series") until decided | User-visible semantics; precision vs overflow trade-off |
| CPython [#153729](https://github.com/python/cpython/issues/153729): `iterdump()` unrestorable with virtual tables | `restore(iterdump(db))` succeeds and is content-equal; matches the sqlite3 CLI `.dump` | Is CLI `.dump` the reference? What does "equivalent" mean if the module is missing at restore? | Stateful generator of schemas incl. FTS5/R*Tree + rows; restore and compare per table | Checked | Compile options differ on CI |
| Valkey [#4934](https://github.com/valkey-io/valkey/issues/4934): empty-delivery consumers not replicated / not in AOF | **Replay equivalence**: `state(primary) = state(replay(stream))`, consumers included | Does consumer creation count as state? | Model-based PBT: random stream commands; replay AOF into a fresh instance; deep-compare `XINFO` | **Checked** (deterministic) | Low; covers the whole "side effect not propagated" class |
| DuckDB [#28123](https://github.com/duckdb/duckdb/issues/28123): rowids change mid-transaction after another connection's checkpoint | **Snapshot stability**, as documented: "rowid values are stable within a transaction" | Block vacuum while older snapshots exist, or remap? | Concurrent stateful PBT with deterministic schedules; small TLA+ model to pick the design | Checked (interleavings) | Interleaving-dependent |
| ClickHouse [#38223](https://github.com/ClickHouse/ClickHouse/issues/38223) / [#69304](https://github.com/ClickHouse/ClickHouse/issues/69304): unchecked decimal arithmetic | Exact result (per rounding rule) or DECIMAL_OVERFLOW, for `+ − × ÷ greatest least` | Is the documented 1.5–2.4× slowdown acceptable? Do `decimal_check_overflow=0` users accept wrapping? | Exact-rational differential + **one proved checked-multiply helper**, reused everywhere | **Proved** (helper) + Checked | The performance trade-off matters more than the proof |
| Next.js [#100345](https://github.com/vercel/next.js/issues/100345): read after `updateTag` joins a stale in-flight fill | Read-your-writes; a fill may be joined only if `startEpoch ≥ invalidationEpoch` | Single instance or shared cache handler? Is losing dedup under write load acceptable? | TLA+/PlusCal 3-actor model, or fake-timer interleaving test | Checked (model); implementation **Assumed** | Thundering herd |
| TypeScript [#64998](https://github.com/microsoft/TypeScript/issues/64998): `.d.ts` depends on `--checkers`, alias becomes `any` | Determinism: `emit(P, k) = emit(P, 1)` for all k; no silent `any` | Is a deterministic resolution order acceptable for performance? | Baseline corpus + generated circular aliases under `--checkers 1..8`, random partition seeds | Checked (corpus) | Rare partitions slip through |
| date-fns [#4029](https://github.com/date-fns/date-fns/issues/4029), [#4346](https://github.com/date-fns/date-fns/issues/4346): DST infinite loop; fractional months | Output strictly increasing and bounded; `addMonths(d,n) = addMonths(d,trunc(n))` | Accept truncate-toward-zero as policy? | fast-check near tz transitions × a `TZ` matrix (Q7) | Assumed → Checked | ICU/tzdata version drift |
| etcd [#22028](https://github.com/etcd-io/etcd/issues/22028), Valkey [#2724](https://github.com/valkey-io/valkey/issues/2724): apply index ahead of WAL commit; slot migration vs failover | `ConsistentIndex ≤ HardState.commit` across crashes; exactly one slot owner per highest epoch | Transient or persistent after restart? Which of the two proposed migration designs? | TLA+/P with crash injection; re-run Antithesis; compare designs before coding | Model **Checked**, implementation **Assumed** | Unit PBT cannot reproduce these; labelling discipline is the deliverable |

## How Ledger reaches the latest pure and AI-assisted math

Ledger should look things up before it tries to invent them. DeepMind's Aletheia found that **9 of 13 meaningful results were known or rediscovered** ([arXiv 2601.22401](https://arxiv.org/html/2601.22401)).

| Step | Sources and tools | Rule |
|---|---|---|
| **1. Library first** | Mathlib through Loogle/LeanSearch (exposed to agents by [lean-lsp-mcp](https://github.com/oOo0oOo/lean-lsp-mcp)); [CSLib](https://github.com/leanprover/cslib) for CS theory; OpenAI's [github.com/openai/math](https://github.com/openai/math), checked locally: **Apache-2.0, Lean `v4.34.1` + Mathlib, ~419 Comparator challenge configs** in `lean/ComparatorChallenges`, with ~300 of 719 top-line results formalized ([Wikipedia](https://en.wikipedia.org/wiki/OpenAI_bulk_release_of_mathematical_papers)); then arXiv, zbMATH Open, the Erdős problems database and OEIS | Cite the exact lemma or entry; never re-prove a library fact |
| **2. Refute first** | Hypothesis/fast-check, Z3, small model checks | Try to break a claim before proving it, as OpenAI's fixed prompt required "rigorous solution… or rigorous refutation" ([repo](https://github.com/openai/math)) |
| **3. Blueprint graph** | Card dependency graph with an English line per node | Anthropic's FLT effort failed with "plain agent coordination" until a statement DAG took over ([Anthropic](https://www.anthropic.com/news/formalizing-fermats-last-theorem)). When a card goes red, its dependents drop to Open |
| **4. Statement checks** | Comparator configs (statement vs trusted reference); Midspiral/metareflection [claimcheck](https://github.com/metareflection/claimcheck/blob/main/README.md) blind back-translation (**96.3% vs 69.4%** for Claude-Code-as-judge on 36 pairs) | Weakened theorems pass Lean, so "Proved" needs the kernel, standard axioms only, **and** a confirmed English reading |
| **5. Search with an evaluator** | AlphaEvolve-style evolutionary search via open OpenEvolve / ShinkaEvolve, for "does a faster/better X exist?" (AlphaEvolve improved an autocorrelation bound from 1.50992 to 1.5032 — [alphaXiv](https://www.alphaxiv.org/abs/2511.02864v1)) | The evaluator is the comparison oracle from Q6; every winner goes back through steps 2–4 |
| **6. Optional prover connectors** | Open: DeepSeek-Prover, Kimina-Prover, Goedel-Prover. Paid: Harmonic [Aristotle](https://github.com/harmonic-ai/aristotle), which now targets C/Verilog/Rust, "does not verify pure mathematics or Lean-only projects", and runs for tens of minutes on credits | Opt-in, with the cost shown first; the generator and checker run in separate contexts |
| **7. Weekly digest + provenance** | New Mathlib lemmas, Comparator challenges, and arXiv/AI preprints touching the user's cards | Every citation is tagged **Verified in Mathlib/Lean**, **Peer-reviewed**, or **AI preprint, unverified**. OpenAI withdrew three manuscripts after one sign error ([Wikipedia](https://en.wikipedia.org/wiki/OpenAI_bulk_release_of_mathematical_papers)) |

The open-prover, OpenEvolve/ShinkaEvolve, zbMATH, Erdős DB and OEIS entries are design choices. Their current APIs and licenses were not re-checked in this research.

## What this means for Ledger's design

### Question set v2

| # | Question | Routes to | Hit rate in this sample |
|---|---|---|---|
| Q1 | What must never happen? | Invariant → PBT → proof | Nearly every case |
| Q2 | What are the hard limits? | Z3 bit-vectors, Kani/CBMC, boundary generators | 8 overflow/width cases |
| Q3 | What to maximise or minimise? | Optimizer/evaluator; performance-vs-safety trade-off | ClickHouse (2.2× cost), Next.js dedup |
| Q4 | What's uncertain? | Fault models, generator ranges | CPython DST, tokio panics, Valkey RESTORE payloads |
| Q5 | Does order or timing matter? | TLA+/P, loom, isolation enumeration | PostgreSQL, etcd, tokio, Next.js, DuckDB |
| **Q6** | **What should agree with this?** | Differential/metamorphic oracle | **11/20** merged fixes |
| **Q7** | **Which settings, platforms or flags change this?** | Config/platform matrix; Assumed cards | Rails, Django, TS7, date-fns |

Two rules come out of the patterns. **Scope rule:** a card's property covers the whole API surface (every offset, every call site that runs foreign code, every operator that shares a helper), never just the reported symptom. **Label rule:** a fixed data race or a passing unit test never upgrades a distributed or crash-consistency claim beyond **Assumed**/**Open**.

### Cards written as justified decisions

```
┌─ ClickHouse · decimal compare/cast ───────────────────────────── [PROVED helper · CHECKED callers] ┐
│ CHOICE     Keep the fast unchecked multiply only where it provably can't overflow; else checked.  │
│ WHY SAFE   When both scales and precisions fit the bound, the product fits in 256 bits.            │
│ CHECK      Z3: checkedMul reports "no overflow" ⇒ product equals the exact product (UNSAT, 0.3 s) │
│            Differential vs exact rationals, 10k triples biased to 10^scale (fails on old code)  │
│ GUARD      Overflow ⇒ DECIMAL_OVERFLOW, never a wrapped value                                    │
│ SCOPE      compare, cast ✓ · arithmetic, greatest/least ✗ OPEN (#38223)                          │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
┌─ Node · Buffer.indexOf / includes / lastIndexOf ───────────────────────────────────── [CHECKED] ┐
│ CHOICE     Offsets and results use 64-bit integers end to end.                                    │
│ WHY SAFE   MAX_LENGTH < 2^53, so every valid index is exact in a double and an int64.             │
│ CHECK      fast-check metamorphic: indexOf(n,off) = off + subarray(off).indexOf(n); bounded check│
│            of offset normalisation over ±2^53; one gated >2 GiB run                              │
│ GUARD      Debug assert: result is −1 or in [off, len)                                           │
│ SCOPE      Whole API: indexOf, includes, lastIndexOf (+ fill/copy/compare? ASK maintainers)      │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
┌─ claude-code · Bash deny matching ──────────────────────────── [CHECKED known · OPEN arbitrary] ┐
│ CHOICE     Fail closed: an unknown program whose argv tail matches a deny rule asks first.       │
│ WHY SAFE   We can't know what an arbitrary binary execs, so "unknown" must not mean "allow".      │
│ CHECK      fast-check: denied cmds × wrapper chains (known/unknown/nested) → never allow         │
│ GUARD      Ask on unknown wrappers; log the decision                                             │
│ ASSUMED    Deny rules are treated as a boundary, not best-effort (product decision pending)       │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The checks shown in these cards are designs. None has been run.

## Limits, risks and the case against

**Limits and gaps.** facebook/react returned "access not enabled for this session", so React is absent. Per-repo GitHub endpoints were blocked, so PR and issue bodies came from search payloads and **no comment thread was read**. Maintainer positions on every open issue are unknown, and some may already be decided in comments. **Nothing was executed**: the 2.1.258 unwrap list, the linked fix PRs and every "fails immediately" claim are unverified. Rust std and serde yielded no usable case, so Rust rests on tokio alone. Introduction dates are unverified for DuckDB, Valkey #4823, etcd, zod #6702 and Go net/mail. Django Trac, pgsql-bugs and Jepsen reports were not read. Kubernetes, Prometheus, OpenTofu and VS Code contributed nothing clean.

| Risk | Why it matters | Mitigation |
|---|---|---|
| Expensive environments | Node needs ~4.5 GB RAM; CPython needs a mocked clock, `tzset` and a filesystem | Prefer symbolic or bounded checks on the narrowing; gate heavy tests |
| Contract changes disguised as fixes | Go `ZoneBounds`, pandas wrap-vs-raise and claude-code deny semantics are product decisions | Cards stay **Assumed** until a maintainer signs off; questions go to maintainers first |
| Oracle disagreement | glibc vs musl vs macOS; ICU/tzdata drift | Name the reference on the card; pin versions |
| Overclaiming on distributed systems | A unit PBT "pass" on etcd #22028 would be false comfort | The label rule above; route to TLA+/Antithesis |
| Noise | Maintainers already get a flood of AI PRs | Lead each PR with one card and a fail-before/pass-after line, nothing else |

**Strongest objection.** "Agents already find and fix these bugs. Codex fixed NumPy's, Claude Code fixed pandas' and etcd's, and an AI CI bot fixed ClickHouse's. Ledger is ceremony on top." **Reply:** the agents fixed symptoms, and the record shows it. Node, ClickHouse, pandas #71389 and tokio each needed or still need a second fix at a neighbouring site. The fixes that reviewed fastest were the ones that already carried a Ledger-shaped artifact: Go's round-trip test, CPython's seven-fail/seven-pass UTC controls, etcd's 40/40 vs 200/200. Ledger makes that artifact the default, scopes it to the whole API, and keeps the "because" on file so the next change re-checks it. Both claude-code issues carry a "stale" label. Triage capacity, not bug-finding, is the bottleneck.

**One non-obvious way this could be wrong.** The bottleneck may be the generator, not the property. Every property here is easy to state *after the fact*. Going forward, a developer answering "what must never happen?" for `to_json` says "round-trips correctly", and the test passes, because the default float generator stays well clear of `float64.max` at precision 15. Or the developer writes the Rails invariant without the flag. If the questions produce the right sentence but the wrong input distribution, Ledger adds confidence without adding coverage, which is worse than nothing. The Q2/Q4/Q7 answers have to flow into the generator's ranges, and the only way to know whether they do is a blind test.

## Next step: reproduce five fixes, blind and sighted

Take five cases that span the check types: **pandas #71325** (round-trip), **NumPy #32467** (oracle), **Go #80592** (fuzz), **zod #6702** (sync vs async) and **Valkey #4880** (Z3). For each, check out the pre-fix commit and run Ledger in two modes:

| Mode | Input given | Pass condition |
|---|---|---|
| **Sighted** | The issue text | The property is written, **fails on the pre-fix commit, passes on the fix commit** |
| **Blind** | Only the function and its docs, no issue | The Q1–Q7 answers produce a property *and generator* that fails on the pre-fix commit |

**Metrics per case:** minutes of wall-clock time, tokens, number of questions asked, and whether the card's scope covers the neighbouring sites the real fix missed. **Targets:** sighted ≥ 5/5 within 30 minutes each; blind ≥ 3/5. Count a catch mechanically, as a fail followed by a pass, rather than by the agent's own tally ([LemmaScript run log](https://github.com/midspiral/LemmaScript/blob/main/DESIGN_RUN_LOG.md)). Then open one real PR, the POSIX TZ cross-runtime generator for CPython #159712/#159715, and measure time to first maintainer response against the issue's current zero comments.

## Conclusion

The most popular software is not short of verification tools: Go ships a fuzzer, tokio runs loom, PostgreSQL has an isolation tester, and Hypothesis would have tried `float64.max` almost immediately. What was missing in nearly every case was a written-down sentence saying what must agree with what, scoped to the whole API, and kept on file. That reframes Ledger. It is less a math engine than a habit that makes engineers name a twin (Q6) and a configuration space (Q7), with math as the enforcement. hargup's "prove it's safe for your workload" turns out to apply less to clever optimisations than to ordinary encoders, offsets and caches.

The second shift is strategic. With agents already closing eight-year-old issues, the scarce resource is maintainer trust. A justified decision that states the choice, why it's safe, the check that failed before and passes after, and the guard is a format a maintainer can approve in one read. If the blind test shows that Ledger's questions also produce the right generators, Ledger becomes the way AI-written fixes earn review. If it doesn't, Ledger is still the best way to write them up honestly.
