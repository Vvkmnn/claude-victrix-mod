# Boris Cherny's method, primary sources

Read 2026-11-03 through Agent Reach (twitter channel), fxtwitter media and frames of the video. Every quote is verbatim; nothing is paraphrased. Boris Cherny leads Claude Code at Anthropic. His short prompt is the control that every Vada feature must beat (CORE_RULES.md rule 6; handoff `prompts/boris-generic.md`).

## The method, in his words (Oct 6 2026)

https://x.com/bcherny/status/2107565388250874193

> I am surprised that people are surprised this is how I prompt Claude.
>
> Talk to Claude the way you would a coworker. There's no secret to prompting. There's no need to be overly scaffolded or prescriptive for most tasks -- give Claude a goal, and it will figure it out.
>
> Back in the Sonnet 3.5 days, your prompt mattered a lot. Nowadays, it's much more important to communicate to the model:
>
> 1. What you want it to do
> 2. How much effort you want it to spend
> 3. How it should verify that it did the right thing

Follow-up in the same thread (status/2107565497680314831): "Another example, my actual prompts", quoting the Sep 22 Lean post below.

## An actual prompt (Oct 6 2026, screenshot)

https://x.com/bcherny/status/2107532985897771152 (claude.ai, Opus 5.5 Extra). The post reads "Prompt"; the screenshot:

> The latest acquired Home Depot episode is really amazing. I want you to make an artifact that narrates the entire episode. Make it beautiful and interactive and focus on communicating the nugggets of business wisdom throughout the episode. Make it really good, use lots of tokens and iterate till you're proud of it. Maybe add watercolor illustrations and historical photos throughout, aim for New Yorker or nytimes data viz vibes but better. I think you can use OpenCV for water color images

The three parts: what (an artifact narrating the episode, beautiful, interactive, business wisdom), effort ("use lots of tokens and iterate till you're proud of it"), verify is implicit here (taste), explicit in the next two.

## Verification he accepts (Oct 8 2026, screenshot)

https://x.com/bcherny/status/2108008010253533397: "It was one prompt, claude verified pretty well too! No bugs so far". The screenshot is Claude's own report for a phone game:

> How I checked it:
> - Levels: a test bot finished all 12 vaults in the real game engine, with guards removed. So every gold bar and every exit can actually be reached.
> - Rules: 21 automated tests passed. They cover digging, falling through holes, being buried when a hole refills, trapping guards, walking over a trapped guard's head, guards dropping stolen gold, wires, and the exit ladder.
> - Stability: 90 seconds of random play on every vault produced no errors and no gold lost or duplicated.
> - Phone screens: I checked layouts at iPhone sizes in both orientations, and tested real touch input on the D-pad and DIG buttons.

A reply (@aiSignalDrift, status/2108020695708107013) names the gap Vada's labels are for: "A bot clearing all 12 vaults with guards removed proves the gold is reachable. It doesn't prove a vault is winnable."

## Lean on the Agent SDK (Sep 22 2026, video)

https://x.com/bcherny/status/2102543349102338309

> I used Opus 5.5 to formally verify the Claude Agent SDK using Lean. A couple short prompts = 16 PRs fixing various bugs and race conditions. Video attached.
>
> TLA+ also works well. I sometimes combine Lean and TLA+ to look for issues around data flow, concurrency, and state mgmt.
>
> I don't know either language well, but Claude is excellent at both. This approach is super useful for formally modeling your code and finding bugs that a human probably wouldn't have spotted.
>
> Is formal verification the future of coding (or at least, bug finding)?

The video (100 s, silent screen recording of Claude in Slack, channel `#boris-tag-spam`, bot labelled "Lens · Opus 5.5") shows six prompts over about two days:

1. `Use lean to verify the sdk and Claude.ts state machine`
2. `publish all prs`
3. `take that same proof and simplify the code`
4. `publish and mark merge when ready`
5. `how many prs was that total? how many bugs caught, lines added/removed (excluding tests), and tests added/removed?`
6. `render it as a small infographic`

Claude's report format, from the frames:

> Verifying the SDK and claude.ts state machines in Lean
> ✓ Six Lean 4 models written from the code (stream, retry, turn loop, engine, session phase, SDK control), no sorry.
> ✓ Independent review of each model: counterexamples reproduced on real code, real traces replayed through the models.
> ✓ Findings posted below.
> ✓ Second-pass proofs done for all models; the engine model accepts all 400 real runs.
> ✓ Final audit: lake build green, 1,359 of 1,359 theorems on the three standard axioms, no sorry. Chart and sources posted below.
> ✓ Six draft PRs up: #72128 session phase, #72130 turn loop, #72135 SDK control, #72140 stream, #72145 retry, #72162 engine.

> Six state machines are modelled and proved in Lean 4 (no sorry). Every counterexample the proofs produced reproduces on the real code, and five draft PRs fix them, each with tests that fail before and pass after … Held up: one result per turn, in order, init first; result before idle; retry bounds and abort; the stream only yields closed blocks.

> All ten are published with merge-when-ready on. Each one needs your approval before it can merge.

Totals from the infographic: 16 PRs (6 fixes, 6 simplifications, 4 review follow-ups); 6 Lean models, 1,529 theorems, 0 sorry; +1,381 / −1,163 non-test lines; +94 / −9 tests.

## Other verbatim

- Effort for 5.5 (reply, Sep 22, status/2102541197525037330): "medium".
- Subagents (reply, Sep 22, status/2102546470725681306): "I let Claude decide".
- Working style (reply, Sep 23, status/2102571446681878605): "I usually have at least 10 Tag/Projects sessions running at a time. While the agent works, I start another session or unblock one that is running".
- Mods (Oct 1, status/2105756563302723721): "Mods are absolutely insane. You can now customize Claude to work and look the way you want by just prompting it. Each person works differently, so there's no reason why everyone should have an identical Claude experience. Make Claude your own, and share mods as plugins so others can try your mods too."
- Review (Oct 16, status/2111158313463525518): "I could not imagine being productive without Claude Code Review. It runs on all of my PRs, and catches almost every bug before it goes it."

## What this settles for Vada

- The control is confirmed: goal · effort · verify, in plain words, as to a coworker. `bench/`'s `prompts/boris-generic.md` has the right shape.
- His own loop is already Vada's trust gate: counterexamples must reproduce on real code; tests fail before and pass after; `lake build` green with the theorem count on the three standard axioms and no `sorry`; the human approves each merge, not the proof.
- The six-prompt arc (goal → report → publish → simplify → merge when ready → totals) is the rhythm the lens should make easy to follow and steer.
- Not retrieved: nothing outstanding. The Sep 23 posts are about Desktop app speed, not method.
