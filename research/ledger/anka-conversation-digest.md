# Anka: conversation digest (what is NOT in ledger-claude-code-prompt.md)

Companion to `ledger-claude-code-prompt.md` and the four reports. **"Ledger" in all earlier files = "Anka"** (renamed by the user, 2026-11-02). Repo: `claude-anka`. Product and plugin name: **Anka**.

Conversation dates: 2026-11-01 to 2026-11-02 (UTC). All work ran in a cloud sandbox: Linux, 2 vCPU, 7 GB RAM, Node 22.23.4, npm 10.9.9, no `zstd`, no .NET. Outbound HTTP went through an allowlisting proxy, so github.com web pages and some hosts were blocked; `git clone` and the GitHub search API mostly worked.

---

## 1. Decisions and preferences the user stated (verbatim where short, in order)

### Direction and scope
1. Origin: shared the YouTube Short *"Lean vs $12 server?!"* by @arjay_the_dev (`https://youtube.com/shorts/Cr69N5pG258`) and asked to explore the video and comments.
2. "I would like to make this mathmarical process available."
3. "What i liked is math and lean. All one thing no different parts." Wants to "stumble on amazing math algorithms by accident almost by defining plans with proofs in plain English."
4. "Not even surface. More like we leverage your ability to use pure math to improve average Claude users plans and code somehow. With real math"
5. "Surface is good too. Must be visual and beautiful still but the underlying mechanism lets an average human access math proofs and related algorithms somehow. Ideally cheaply and quickly for any kind of project in parallel with plan mode."
6. "I need more than just shortcuts. I need the ability to discover unique and novel proofs that help whatever I'm planning somehow and custom where necessary. Something worth more than the tokens I spend while being generally helpful and mathematically rigorous in a way no human can be while being easy for anyone to use"
7. "Don't need new mathematics. The very best of current mathematics at the frontier available to regular users in Claude is my goal"
8. "Recognizing with keywords seem silly. There must be a software or mathematically pure way to do this better and generally?"

### UI and interaction
9. "I want a ui on the side while Claude works that shows the English proof simply, then pure math, and steps to verify what it's doing and that it understands what I'm proving so I can quickly make Claude change the plan and associated proofs. Investigate mods later"
10. "I like the idea of Claude asking questions to help guide us both to the right math."
11. "Ideally it's always on when I'm in Claude and useful"

### Openness, credit and positioning
12. "Build on them not against them. I am just an open source mod maker in this example. And aspiring developer with a hope to use pure math in my daily flow"
13. "Recycle and use as much of them as you can. Our focus is daily proactive token optimized collaboration while planning. We will reference theory labs and them directly so not stealing."
14. "Not just them. Anything we can use out there. Best tools for this quick job."

### Goals
15. "The goal above is all is to bring the power of ai sssisted math to any Claude user"
16. "The goal is to find a way to help any plan any project any field. But obviously let's discuss"
17. Creative domains are in scope: "Even creative writing and script writing and world building in dungeons and dragons. Possible?"
18. "I also want it to let me access the latest in pure math and ai assisted math like OpenAI."
19. The method, not the problem: "Hargrup example opened my eyes to the power of lean as a way to justify software choices and engineering. His specific solution and problem isn't important. It's his method and how we can generalize it with math 2.0." The user supplied the video transcript, including: *"Technically, you could write these exact optimizations in C yourself without ever touching Lean. Lean just lets you prove that these optimizations are safe for your specific workload."*

### Paid service
20. "I also want to publish a paid service to run these tools and hold proofs maybe. Worth it or no? Let users do it? Optional upsell?" **Undecided by the user.** Claude recommended: free, local-first; waitlist; paid tier only if ≥50 users or ≥5 teams sign up within 2 months.

### Division of labour and housekeeping
21. "Claude code will know how to build it. You focus on the research we've done together". Claude therefore stopped two build-detail research agents (exact mod API extraction; skill/sandbox/connector facts). They did not finish.
22. Confirmed GitHub `Vvkmnn/claude-historian-mcp` is the user's own project: "yes thats mine".
23. Handoff instruction (this turn): "Plain Markdown, no summaries of summaries, keep every link, number and version as you found it."
24. Explanation style asked for along the way: "Explain plainly like I don't know code or math", "build up to the true math and tools", "simply at an expert level", "two views, one as the developer creating one as the user using".

---

## 2. Answers to §16 open questions (from the brief)

| §16 question | Status | User's words / basis |
|---|---|---|
| 1. Name and licence | **Name answered: Anka.** Licence **not answered** | "Name: Anka" |
| 2. First language focus | **Answered indirectly** | "Stack: whatever ships with Claude Code first so users are up and running easily; optional add-ons for power users that Claude sets up only when needed; greedy, lazy, modular design others can build on." Which language comes first is still open |
| 3. Plan-exit: non-blocking or blocking gate | **Not answered** | — |
| 4. Default proof backend: Dafny or Lean | **Not answered directly.** The stack answer implies neither is installed by default: both are optional power-user add-ons that Claude sets up lazily | Stack answer above; user's stated affinity for Lean (items 3, 19) |
| 5. claude.ai reach (skill standalone first?) | **Partly answered** | "always on when I'm in Claude" (item 11) and "any Claude user" (item 15) imply the skill ships for claude.ai too. Ordering not stated |
| 6. Telemetry | **Not answered** | — |
| 7. Creative mode in v1 or later | **Implied in scope** | Scope answer "everything combined" plus item 17. Timing not stated |
| Scope (added by user) | **Answered** | "Scope: everything combined, reviewed into one better plan, prototyped and rigorously tested on ourselves; simplicity, clarity and beauty first, now with AI-based and true pure-maths rigour" |
| Stack (added by user) | **Answered** | As quoted in row 2 |

---

## 3. Hands-on trials: exact commands, versions, timings, failures, gotchas

### 3.1 hargup's `lean-derive-hargup` rebuild (run by Claude in the sandbox)
- **Clone:**
  - `git clone -q --depth 1 --filter=blob:none --sparse https://github.com/arjaythedev/twelve-dollar-server-challenge.git t12`
  - then `git sparse-checkout set submissions/lean-derive-hargup submissions/lean-c-iouring-loafecho`
- **File sizes (`wc -l`):**
  - `spec/Feed.lean` 6, `spec/Main.lean` 9
  - `Feed/Model.lean` 98, `Feed/Plan.lean` 221, `Feed/Schema.lean` 52, `Feed/Emit.lean` 249, `Feed/Invariant.lean` 148, `Feed/Contract.lean` 171
  - Total **954** (939 inside `spec/Feed/`)
  - `gen/app_gen.c` 512
  - `runtime/*.c`: db 328, http 131, json 230, jwt 166, out 147, server 34, uring 561 = 1,597
- **Toolchain** (`spec/lean-toolchain`): `leanprover/lean4:v4.35.0`.
- **Failure 1:** `elan-init.sh -y --default-toolchain none` installed elan, but elan's toolchain download crashed inside `elan_utils::utils::fetch_url` (proxy).
- **Workaround:**
  - `curl -sSfL -o lean.tar.zst https://github.com/leanprover/lean4/releases/download/v4.35.0/lean-4.35.0-linux.tar.zst` (594,481,375 bytes).
  - **Failure 2:** `tar --use-compress-program=unzstd` → `unzstd: Cannot exec` (no zstd).
  - **Workaround:** `pip install --break-system-packages zstandard`, then Python `zstandard` streaming extract to `/tmp/lean-4.35.0-linux/`.
- **Build:** `lake build` → `Build completed successfully (18 jobs)`, `real 0m4.269s`.
- **Regenerate:** `lake exe derive /tmp/gen` → `wrote /tmp/gen/app_gen.c`; `cmp /tmp/gen/app_gen.c ../gen/app_gen.c` → identical ("GENERATED C MATCHES CHECKED-IN COPY").
- **Axioms:** `#print axioms` for `Feed.Db.feedPlan_eq`, `Feed.Db.postPlan_eq`, `Feed.Db.inv_addPost`, `Feed.Db.checkInv_sound` → each `[propext, Classical.choice, Quot.sound]`.
- `grep -rn sorry spec/Feed` → none.

### 3.2 OpenAI `openai/math` repo (read by Claude in the sandbox)
- **Clone:** `git clone -q --depth 1 --filter=blob:limit=200k https://github.com/openai/math.git`.
- **Licence and toolchain:**
  - `LICENSE`: Apache License 2.0.
  - `lean/lean-toolchain`: `leanprover/lean4:v4.34.1`.
  - `lean/lakefile.lean`: mathlib pinned at `d13f23b723b8a846827a245b89c10fc7d3f11612`.
- **README:**
  - "721 manuscripts organized into 373 families"; "~42% top-line results formalized"; "three hours of ChatGPT Pro thinking compute"; "approximately 4,000 problems".
  - Outputs "best understood as a form of raw research data, rather than polished academic papers".
  - Exceptions: the zeta zero-free region and Hodge for CM abelian varieties; the Re(s) > 11/12 write-up was human-edited.
- **`history.md`:**
  - Oct 7: 3 withdrawals after a sign error; 14 revised; 300/719 ≈ 42% formalized.
  - Oct 26: added "Local smoothing for the Euclidean wave equation" and "The Exponential Time Hypothesis is False" (reviewed by a group led by Impagliazzo, Paturi, Williams).
  - Oct 29: Hodge CM Comparator namespace fix.
- **Comparator:**
  - `lean/ComparatorChallenges/README.md` needs `comparator`, `landrun`, `lean4export` on PATH.
  - Then `lake update`, `lake exe cache get`, `lake env comparator ComparatorChallenges/QuasiRiemannHypothesis.json`.
- **Build note:** a full build may fail on a low `vm.max_map_count`; workaround `-DMMAP=OFF` / `GLIBC_TUNABLES=glibc.malloc.mmap_max=0:glibc.malloc.arena_max=1`.
- **Reasoning summaries:** 10 in `reasoning_traces/`. The Mézard–Parisi one opens with the fixed prompt "Please give a complete rigorous solution … Even if the problem is 'open' … rigorous refutation. Brute-force enumerations and computer-assisted proofs are strongly discouraged".

### 3.3 LemmaScript, lemmafit, agentic-pbt (run by a subagent in the sandbox; full notes in `research_notes/.../hands_on.md`)
- **Repos as cloned:**
  - LemmaScript `f245e98` (2026-10-30), npm `lemmascript@0.6.5` (pulls `lemmascript-claimcheck@0.2.1`, `ts-morph`).
  - lemmafit `4b795ea` (2026-06-02), `lemmafit@0.3.5`.
  - agentic-pbt `7ac6a15` (2025-11-03).
- **Dafny:**
  - `curl -L https://github.com/dafny-lang/dafny/releases/download/v4.11.0/dafny-4.11.0-x64-ubuntu-22.04.zip`: 65 MB, 1.1 s, self-contained (no .NET), 148 MB unzipped.
  - `dafny --version` → `4.11.0+fcb2042…` in 0.28 s.
  - `gh api` was refused by the sandbox; direct curl worked.
- **LemmaScript install:**
  - From source: `npm install --ignore-scripts` 5.8 s; `npm run build` 11.4 s → `tools/dist/lsc.js`.
  - Fresh `npm install --ignore-scripts lemmascript`: 13.5 s.
  - `lsc --help` is not recognised. Bare `lsc` prints `lsc <gen|check|regen|extract|info> [--backend=lean|dafny] …`, plus `lsc claimcheck` and `lsc runs`.
- **LemmaScript Lean backend** (pinned Lean **4.34.0** + `namin/velvet` branch **`lemma2`**, sibling dir `../velvet`; Velvet 2 needs no Loom and no external Z3/cvc5; `mathlib @ "v4.34.0"`):
  - `lean-4.34.0-linux.tar.zst` (580 MB, 3.7 s) could not be extracted (no zstd). `lean-4.34.0-linux.zip` (904 MB, 38 s) worked; 3.2 GB extracted.
  - `lake update -R` killed at 540 s (mathlib clone 753 MB).
  - `lake exe cache get` killed at 500 s: `curl https://cache.mathlib.org/...ltar` → `CONNECT tunnel failed, response 403` (proxy).
  - `lake build «clamp.proof»` from source: 722 jobs in the first 560 s window, then 302 more in 405 s → `Build completed successfully (1041 jobs)`. `.lake` 1.8 GB; about 5 GB total footprint.
  - LemmaScript imports only `Mathlib.Tactic.SplitIfs`, `Mathlib.Tactic.NormNum`, `Mathlib.Algebra.Ring.Int.Defs`, `Mathlib.Algebra.BigOperators.Intervals`.
  - Warm rebuilds: clamp 1 s, arraySum 7 s, binarySearch 9 s. One deprecation warning (`Array.contains_iff`).
- **`lsc check --backend=dafny` timings:** clamp 4.5 s (1 VC), binarySearch 4.4 s (9), arraySum 4.4 s (3), toposort 8.2 s (12), auction 3.8 s (4).
- **Hand proof in bundled examples:**
  - Dafny: 72 `.ts`, 71 `.dfy`, **63 with zero additions**. Others: countBadPairs +459, preorder +210, toposort +88, binarySearch +28, perm +17, maxSpread +7, arraySum +6, counter +3.
  - Lean: 25 `.proof.lean`, 765 lines total (toposort 274, spec 172). `clamp.proof.lean` = `prove_correct clamp by velvet_vcgen [clamp] with finish`.
- **Worked example** (`/home/claude/eval/worked/feed.ts`, 2.5 KB; `append`, `newestN`, `cartTotal`, `applyDiscount`):
  - Dafny run 1: `gen` 0.95 s, `check` 3.2 s → `8 verified, 1 error` on the "older posts bounded" postcondition.
  - Dafny run 2: +18 lines (`lemma SortedTrans` plus one call) → **`11 verified, 0 errors`**, 3.2 s, exit 0.
  - Lean: `feed.proof.lean` 38 lines, ~5 s.
    - `applyDiscount` needed `finish [Pure.applyDiscount]`.
    - `cartTotal` needed a 3-line `Int.mul_nonneg` + `omega` step.
    - newestN ensures_4 needed an 11-line `sorted_mono` plus 6 lines of glue.
    - **ensures_1 (exact length) left `sorry`** after ~4 attempts: `omega` treated `↑out.size` as two atoms.
- **Gotchas:**
  - `.every((p, i) => …)` generates `i: Unknown`. `lsc gen` stays silent, then Dafny reports 5 resolution errors.
  - Run `lsc regen`, not `lsc check`, after editing TS, or you get `FAILED: feed.dfy has modifications to generated lines`.
  - The additions-only gate rejects deleting a `requires`.
  - With `assume false;`, Dafny prints "11 verified" but `lsc check` exits 1 ("warnings were found and --allow-warnings is false"). **Trust the exit code.**
  - The Lean backend needs `//@ type i nat` on loop counters.
  - TS `number` → unbounded `int`/`Int`, so floats, NaN and overflow are outside the proof. Use integer cents.
- **lemmafit:**
  - `postinstall` = `node ./cli/sync.js && node ./cli/download-dafny2js.js && node ./lib/download-dafny.js && node ./cli/check-claimcheck.js`. It fetches Dafny `4.11.0` and `metareflection/dafny2js` `v0.10.0` into `~/.lemmafit/`. `dafny2js-linux-x64.tar.gz` is 37 MB (84 MB binary).
  - **Hooks** written to `.claude/settings.json` (full overwrite via `fs.writeFileSync`): `PostToolUse` matcher `Write|Edit` → `lemmafit-verify-hook`; `UserPromptSubmit` → `lemmafit-context-hook`; `SessionStart` → `lemmafit-session-hook`. All exit 0 (advisory). Nothing on PreToolUse, ExitPlanMode or Stop.
  - Also copies 7 skills into `.claude/skills/` and appends a "LEMMAFIT SYSTEM PROMPT - DO NOT EDIT" block to `.claude/CLAUDE.md`, on every install or update.
  - **Daemon** (`lib/daemon.js`, 997 lines): `dafny verify … --verification-time-limit=300`, `dafny translate js --no-verify --include-runtime`, `dafny2js --file … --app-core AppCore`. Optional **WebSocket relay** accepting `spawnClaude` (`claude -p … --tools '' --max-turns ≤10`) and `readFile`.
  - Observed: a 60-line cart domain verified and compiled in 11.2 s (`Domain.cjs` 40.6 KB, `app.ts` 7.1 KB). A simulated broken edit returned `✗ Verification failed (1 error): lemmafit/dafny/Domain.dfy:38: a postcondition could not be proved on this return path` in 5.0 s.
- **agentic-pbt:**
  - `hypo.md` is 290 lines. Rule: "**Only test properties that the code is explicitly claiming to have**". "90% is good enough".
  - `run.py`: `claude --output-format json -p "/hypo <module>" --allowedTools … --permission-mode acceptEdits --model opus`, 3600 s timeout.
  - `scoring.py` (default `claude-opus-4-1`): Obviousness, Input Reasonableness, Maintainer Defensibility, each 0–5, total /15. The regex expects `/25`, so it falls back to summing the three; rankings are still correct.
  - Paper CSV: 984 scored reports; 21 manually labelled (18 valid, 3 not; 17 reportable).
- **Not run:** `lsc claimcheck`, the long-lived lemmafit daemon, the `/guarantees` skill, `/hypo`, `scoring.py` (each needs a Claude session or API key).

### 3.4 Access failures during research (useful for Anka's own fetch logic)
- WebFetch of the YouTube Short returned only the footer. `youtube.com/oembed` was not on the allowlist. The Claude in Chrome extension was "not connected". The built-in browser was unavailable. **Comments were never read**: only the one comment visible in a screenshot (see §5).
- GitHub web pages and per-repo API calls were often blocked or returned 403. The GitHub search API and `git clone` worked. facebook/react returned "access not enabled for this session".
- Also blocked: theoric.com (the "Why Lean 4 for agentic coding" post was never read), terrytao.wordpress.com, agmai.org, midspiral.com, lemmafit.com, lemmascript.org, `cache.mathlib.org`.

---

## 4. Corrections and retractions made later in the chat

| Earlier statement | Correction |
|---|---|
| hargup's entry "officially #1 on the leaderboard" | The benchmark homepage listed **three entries tied at 280,000** (lean-derive-hargup, mojo-iouring-oh-meh, objc-uring-delneg) as "1". A later research note read it as **tied #2**. Unresolved; use "280,000 users, tied at the top when scored (2026-10-28)" |
| lemmafit "intercepts Claude's plan" (launch newsletter; SDLC report) | Its plan steering is **instructions + `SPEC.yaml` + daemon**, not a hook. No ExitPlanMode/PreToolUse/Stop hooks. Dormant since 2026-06-02 |
| Midspiral is "new projects only" | Only lemmafit is greenfield. **LemmaScript verifies existing code** (hono CVEs, node-casbin, rallly, etc.) |
| LemmaScript Lean needs Lean 4.35.0 + Loom | **Lean 4.34.0 + Velvet 2 (`lemma2`)**; Loom no longer required |
| claimcheck belongs to Midspiral | Published under **metareflection** (Nada Amin's org), used by Midspiral. Credit both |
| "Paste the share link into Claude Code" works (from a GitHub comment) | Usually **fails: claude.ai/share returns 403 (Cloudflare bot challenge)** to Claude Code WebFetch; issues #33985, #35321, #37146, #24462, #29009, #7162. Workaround found: ChatPeek's snapshot JSON (§6) |
| A share link lets the recipient download files | **No.** Viewers can't download files; sent file cards are probably not in the snapshot |
| Mod hooks have a hard 10 s limit | The 10 s counts **the hook's own running time only**; awaiting `$.process.run`, `$.model.complete` and `$.ui.ask` doesn't count (`$.clock.sleep` excepted). `prompt.edit` hooks get 50 ms. Settings command hooks default to 600 s |
| The "Midspiral and TheoricLabs reuse plan" report says the hands-on trial didn't complete | **It completed later** (§3.3) |
| lean-egg presented as "the right Lean tool" (algorithms report) | lean-egg exists (POPL 2026) but **has had no commits since May 2026** |
| Aristotle API listed as a prover option | Paid (credits), **now C/Verilog/Rust only**, rejects pure-maths/Lean-only projects, runs tens of minutes |
| "Lean is expensive" (early wording) | **Lean is free, local, fast to check.** Cost = Claude tokens + user review time |
| Skill "always on" | Skills **load when relevant**, not literally always; a preference line improves triggering |
| Claude Code and claude.ai share memory | **No.** Chat and Cowork have shared one memory since 2026-08-25; Claude Code keeps CLAUDE.md + auto memory |
| hargup's win credited to Lean | The proved feed plan gave ~3.1× on that query (16.7 → 5.4 µs). Much of the #1 score comes from the **unproved ~1,600-line hand-written runtime** |
| "Anthropic's agentic-pbt false alarms 30–58%" vs "56% valid" | Both from the same paper: 56% valid overall; 86% of the 21 top-ranked; raw false alarms 30–58% depending on how counted |

---

## 5. Uploaded screenshots: what each showed and why it mattered

The six images arrived as `2bdb8076-image.png`, `d5082bec-image.png`, `59583660-image.png`, `71479b12-image.png`, `26f53c07-image.png`, `8e78726b-image.png`. **Claude never saw the original names** (`IMG_1623.png`, `IMG_1626.png`, …), so the list below follows **upload order**, not filenames.

1. **Leaderboard frame** (YouTube Shorts, 2:28):
   - Shown: `benchmarks.arjaythedev.com`, "$12 Server", "How many users can a $12 server hold? 1 vCPU Synteq VPS". Ranked list: 1 `lean-derive-hargup`, 2 `c-iouring-public`, 3 `crystal-epoll-faustinoaq`, 4 `rust-epoll-scooter1337`, 5 `c-iouring-unorig-username`. Video caption "insane". 8.3K likes, 161 comments, @arjay_the_dev.
   - Visible comment: *"As a math person who became a SWE, this is one of the most beautiful things I've ever s…"*.
   - Why it mattered: identified the entry and the site, which led to the PR and the source.
2. **io_uring architecture frame** (2:27):
   - Shown: "app → kernel" with SQ/CQ rings; "multishot accept + recv", "10 rings SO_REUSEPORT", "1 SQLite txn per batch"; C / Rust / Crystal / asm all on `io_uring`. Caption "did".
   - Why it mattered: the top entries share the same I/O tricks, so Lean's contribution is the proved plan, not the I/O.
3. **"same code" frame** (2:27):
   - Shown: `feed.c` by hand = `app_gen.c` from `Plan.lean`: `feed_tail(db) { BtreeLast(c); Prev(c) ×19; }`. Caption "touching lean".
   - Why it mattered: this is the core insight. The C could be written by hand; Lean justifies it.
4. **"@hargup LEAN proved" frame** (2:27):
   - Shown: `Db.Inv`: "post ids are 1…n, no gaps", "created_at only goes up", "every author exists"; a table row `1 | 09:00:01 | u7`. Caption "those posts are already".
   - Why it mattered: the three invariants, the facts that make the shortcut safe.
5. **Pipeline frame** (2:27):
   - Shown: `Model.lean` (feed · getPost · newPost · like), `Contract.lean` (routes · statuses · JSON), `Invariant.lean` (theorem `checkInv_sound`, `inv_addPost`, `inv_like`), then `Emit.lean` generator → `app_gen.c` 512 lines `gcc -O2` → 1 binary + SQLite. Caption "optimized c code".
   - Why it mattered: the whole method on one screen. It became the "justified decision" template.
6. **Vercel receipt/invoice** (10:35, unrelated to the video):
   - Shown: receipt #2250-9291-0109 and invoice 6HLXQ2DR-0020 dated November 1, 2026. Payment Processing Fee $3.06 plus AI credit (per Credits) qty 95 × $1.00 = $95.00; total and amount paid $98.06.
   - It also shows a billing name, postal address and email, **deliberately not reproduced here**.
   - Why it mattered: it didn't, for Anka. It was flagged later as a reason to **avoid public share links of this chat**.

---

## 6. Findings from late in the chat that are not in the brief

### Sharing between claude.ai and Claude Code (as of 2026-11-02)
- **No native chat → Code bridge.** Requests are still open: #13843, #23017, #52641, #92884, #106548 (opened 2026-11-01, "convert a Chat conversation into a Code session").
- **Official Cowork → Claude Code handoff** (support.claude.com article 15520349): "Open the task and select 'Download task data.' Unzip the download and open the folder in Claude Code. Run /port-task-data to pick up with your context."
- **Connectors added in claude.ai are available in Claude Code** (terminal and cloud sessions) when signed in with the same Claude account (claude.com/docs/connectors/overview; code.claude.com/docs/en/mcp). A shared Drive or Notion file is therefore a two-way pipe today.
- **Claude Desktop:** servers in `claude_desktop_config.json` load in both the Desktop chat surface and local Code tab sessions (code.claude.com/docs/en/desktop).
- **Share links:**
  - Claude Code WebFetch gets 403 (Cloudflare).
  - **ChatPeek PR #15** (github.com/vl3c/ChatPeek/pull/15) exports a share link via the public JSON the share page loads: `claude.ai/api/chat_snapshots/ID?rendering_mode=messages&render_all_tools=true`. Undocumented; the fixture was fetched from a home connection; Cloudflare may challenge servers.
- **Share-link facts** (support.claude.com 10593882, 16762437, 16762496):
  - It's a snapshot at share time.
  - You can share publicly (not on Team/Enterprise) or with specific people by email.
  - Viewers "can't continue the chat, copy it to their account, or download files from it".
  - Attached files and raw MCP/tool data are excluded.
- **Teleport / Remote Control:**
  - `claude --teleport` / `/teleport` pulls cloud → local only.
  - `claude --cloud` starts cloud sessions.
  - Desktop "Open in" can send a local Code session to the cloud.
  - Remote Control exposes a local session to a browser or phone.
  - `/desktop` and `claude --desktop` hand terminal → Desktop.
- **Exporters:**
  - `claude-chat-ferry` (nrzz): `claude-chat-ferry import conversations.json --pick "…"` makes a session `claude --resume <id>` can open.
  - Browser extensions: socketteer/agoramachina Claude Exporter (open source), and others.
  - `conversation-handoff-mcp` (trust-delta): local, verbatim saves; needs remote hosting for claude.ai web.
- **Opportunity for the user's `claude-historian-mcp`:** add a share-link ingester (snapshot JSON, run locally) and a claude.ai/Cowork export importer, plus an optional remote mode so one connector serves both surfaces.

### Popular-OSS research details now in the reports (pointer only)
- See `ledger-on-popular-open-source.md` for 20 merged fixes, 18 open issues and question set v2 (Q6/Q7).
- See `midspiral-theoriclabs-reuse-plan.md` for 19 industry cases.

---

## 7. Confidence per major claim

**Legend:** **Ran** = verified by running it in the sandbox. **Source** = read in cloned source or official docs. **Search** = from search snippets or secondary pages only (not executed).

| Claim | Basis |
|---|---|
| hargup's proofs compile, standard axioms only, generated C byte-identical | **Ran** |
| hargup leaderboard numbers (280,000 users, 26,683 req/s, p95 141 ms, p99 316 ms, 31 µs/request, 836 MB, scored 2026-10-28) | **Search** (leaderboard page fetched via WebFetch) |
| PR #153 merged 2026-10-30 with "this is epic, allowed"; commits co-authored by Claude Opus 5.5 | **Search** (WebFetch of PR page) |
| openai/math licence, toolchain, README counts, history, Comparator steps | **Ran** (cloned and read) |
| LemmaScript/Dafny/Lean install, timings, gotchas; lemmafit hooks and daemon; agentic-pbt contents | **Ran** (subagent) / **Source** |
| Mod API names (`$.ui.open`, `$.ui.ask`, `$.process.run`, `$.model.complete`, `tool.call` on `ExitPlanMode`, `e.plan`) | **Source** (cloned Plannotator, playground, built-in mods; official docs pages) — **not executed** |
| `$.process.spawn` signature; `$.process` on Desktop; full `marketplace.json` schema; issue #15755 behaviour | **Unverified** |
| Claude Code hook timeouts, `async`/`asyncRewake`, `PermissionRequest` on `ExitPlanMode` | **Source** (official hooks docs) |
| Claimcheck 96.3% vs 69.4% (36 pairs) | **Source** (repo README), not run |
| 20 merged-fix and 19 industry case studies (PR numbers, what broke, lifetimes) | **Search** (GitHub search API bodies + `git log`); comment threads unread; **no check executed**; ratings are hindsight |
| cFE #2707 unguarded sum still on `main` at `3673163b` (`cfe_tbl_load.c:249-250`) | **Source** (cloned repo) per subagent |
| Coverage estimates (25–45% / 5–12% / 35–55%) | **Reasoned estimate** from search data; unmeasured |
| Autoformalization/proof benchmark numbers (VERINA, CLEVER, Vericoding, Verus-SpecGym, ProofNet audit, Seed-Prover, LGuess) | **Search** |
| Anthropic Fermat's Last Theorem formalization (Sep 2026; ~13M lines, 11 days, ~6B output tokens) | **Search** (subagent fetched anthropic.com news page) |
| OpenAI release reactions, Tao "Math 2.0", IAS advisory group | **Search** (Wikipedia, news, Tao summary page; Tao blog and agmai.org blocked) |
| AlphaEvolve/AlphaDev/AlphaTensor/FunSearch/Souper/LPO numbers | **Search** (some primary pages blocked; some secondary) |
| Kiro pricing backlash | **Search** (The Register; press only) |
| Google Tricorder <10%, Meta diff-time >70% | **Search** (book chapter / slides; CACM blocked) |
| Memory: chat + Cowork shared since 2026-08-25; Claude Code separate | **Search** (third-party blogs + daily.dev) |
| Share-link 403 and ChatPeek snapshot endpoint | **Search** (GitHub issues/PR text); not executed |
| Mathlib ≈232k theorems | **Search** (single secondary source) |
| Licences: leanapi BSL 1.1; leanllm none and impersonates the Claude CLI; most TheoricLabs MIT; LemmaScript/lemmafit/claimcheck MIT | **Source** (cloned repos) |
| History of Lean/proof assistants; definition of proof; Rice's theorem; IMO format | Model knowledge (stable); not looked up |

---

## 8. Open questions still unresolved

1. **Licence** (MIT vs Apache-2.0). Apache-2.0 matches openai/math and gives a patent grant.
2. **First language** within "ships with Claude Code first": TypeScript (LemmaScript-ready) or Python (best PBT evidence)?
3. **Plan-exit behaviour:** non-blocking cards (Plannotator mod mode) or optional blocking gate?
4. **Proof add-on order:** Dafny (65 MB zip, ~4 s checks, low hand-proof burden) vs Lean (Mathlib, frontier access; ~5 GB, needs the Mathlib cache).
5. **Telemetry** for the 10% "not useful" rule: none, or opt-in local-only?
6. **claude.ai skill:** ship standalone in v1 or with the plugin?
7. **Creative mode timing** (in scope; when?).
8. **Paid tier:** user hasn't decided; recommendation is waitlist-gated.
9. **Leaderboard rank** wording for hargup (tied #1 vs tied #2).
10. **Unrun checks:** claimcheck end-to-end (needs API key), `/hypo` and `scoring.py`, the lemmafit long-running daemon. The ExitPlanMode plan field is read in source only; verify with `claude --debug`.
11. **Mod platform unknowns:** `$.process.spawn`; `$.process` on Desktop; `marketplace.json` schema; Anthropic directory submission; `PermissionRequest` allow not exiting plan mode (#15755).
12. **Lean in the claude.ai code-execution sandbox** (untested; likely too heavy); whether `z3-solver`/`ortools` pip-install there (unverified; the research agent was stopped).
13. **Whether uploaded images appear in a claude.ai share snapshot** (unconfirmed).
14. **Unread sources:** TheoricLabs "Why Lean 4 for agentic coding"; the YouTube comments; React repo; issue comment threads; Tao's blog post.
15. **Unmeasured product claims:**
    - Does the question engine reach the right structure in ≤3–4 questions?
    - Can non-experts judge plain-English readings of formal claims?
    - False-positive rate in real use.
    - Blind (no issue text) replay success.
16. **Anka-specific:** greedy/lazy/modular add-on mechanism. Which add-ons, how Claude detects the need, how others extend it. Not designed yet.
