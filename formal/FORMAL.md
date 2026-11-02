# Anka — formal model (v0)

Machine-checked core: `Anka.lean` (Lean 4.35.0, no dependencies). Every theorem below type-checks with no `sorry`; axioms used are only Lean's standard `propext` and `Quot.sound`, and the two guard theorems use none.

## 0. Reading (Curry–Howard)

- A **spec** S is a proposition/type. A **program with its proof** is a term of S.
- **Facts** Φ are propositions about inputs or the environment (data shape, writers, order).
- **Architecture moves** — specialising, bypassing a layer, adding a guard — are theorems about programs, not opinions.
- Turing's limit applies: program equivalence is undecidable in general (Rice). So every claim carries an honest **status**, and only checkers raise it.

## 1. Objects

| Symbol | Meaning | Who supplies it |
|---|---|---|
| S | spec: goals, never-rules | human (plain words), formalised by AI |
| R : α → β | reference ("obvious") program meeting S | AI |
| Φ, Γ, ψ : α → Prop | facts: known (Γ), abduced (ψ) | mined from code/data, confirmed by human |
| F : α → β | fast/specialised program | AI (discovery loop) |
| g : α → Bool | runtime guard | AI |
| s ∈ {broken < open < checked < proved} | evidence status | checkers only |
| c(P) | measured cost; L = speed-of-light floor | profiler; estimate |

## 2. Theorems (all in `Anka.lean`)

**T1 — No laundering** (`combine_le_own`, `combine_le_premise`). A conclusion's status is the meet of its own check and all its premises: it can never be stronger than its weakest premise. *An assumed premise can't produce a proved conclusion.*

**T2 — Guarded specialisation** (`guarded_correct`). If (a) the guard is sound, `g x = true → Φ x`, and (b) the fast path agrees under the facts, `Φ x → F x = R x`, then the shipped program `if g x then F x else R x` equals R **on every input, whether or not the facts hold**. *Facts change speed, never answers.* A counterexample in the file shows that dropping (a) breaks it.

**T3 — Abduction** (`Abduced`, `abduced_guarded_correct`). ψ is abductive for a shortcut if Γ ∧ ψ ⇒ F = R and Γ ∧ ψ is satisfiable. With a guard that soundly tests Γ ∧ ψ, the shipped program equals R. *"What must be true for this shortcut to be correct?" becomes a precise obligation.*

**T4 — Ratchet** (`ratchet`). If each accepted step requires the new version to equal R and to beat the old cost by more than the noise band, then along any chain of accepted steps every version is correct and cost never rises. *Anka can't make things worse.*

**T5 — Instance: hargup's shortcut, 1-row case** (`newest_eq_last`). If time never decreases along id order, scanning all rows for the newest equals reading the last row. The k-row feed follows the same induction.

## 3. The obligations Anka shows as cards

Every shipped shortcut produces exactly these cards, matching T2/T3's hypotheses:

1. **Agreement under facts** (Says: "fast = obvious whenever ψ") — Proved (Lean/SMT) or Checked (differential fuzzing), never just asserted.
2. **Guard soundness** (Says: "the guard only says yes when ψ holds") — usually small enough to prove.
3. **Each fact ψ** — status from data/code checks; source tag (data/code/rule/math/user/claude).
4. **Gain** (Says: "faster than floor-gap × noise") — Checked by benchmark; feeds T4.

## 4. Discovery, stated precisely

Objective (human sets the weights w by choosing among concrete options):

  minimise  w₁·|P| + w₂·E_D[c(P,x)] + w₃·(change cost)   subject to   P ≡ R (or guarded ≡ R)

- Search space: programs at every layer the descent reached (substrate ≠ interface).
- Trigger: c / L > ~3 on a hot path ⇒ descend one layer.
- Evaluator: T2's two obligations (correctness) + benchmark (cost). A candidate failing either is rejected and logged as a refuted conjecture.

## 5. Limits (stated, not hidden)

- Equivalence is undecidable in general: some claims stay **Checked** or **Open** forever.
- A proof is only as good as its spec: the human-readable **Says** line is the defence (back-translation checks).
- Floors L are estimates; they decide where to look, never what to ship.
- Mined data is untrusted evidence: it can change a status, never trigger an action.
