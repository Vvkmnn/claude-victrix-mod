/-
  Anka: core formal model (Lean 4, no dependencies).

  Curry–Howard reading: a spec is a type/proposition, a program with its
  correctness proof is a term of that type. Anka's architecture moves are
  theorems about programs.
-/

namespace Anka

/-! ## 1. Evidence: the status of a claim, as a lattice -/

/-- How strongly a claim is established. Order: broken < open < checked < proved. -/
inductive Status where
  | broken | open_ | checked | proved
  deriving DecidableEq, Repr

def Status.rank : Status → Nat
  | .broken => 0 | .open_ => 1 | .checked => 2 | .proved => 3

instance : LE Status := ⟨fun a b => a.rank ≤ b.rank⟩
instance (a b : Status) : Decidable (a ≤ b) := inferInstanceAs (Decidable (a.rank ≤ b.rank))

/-- A claim built from premises is only as strong as its own check and its weakest premise. -/
def Status.meet (a b : Status) : Status := if a.rank ≤ b.rank then a else b

def combine (own : Status) (premises : List Status) : Status :=
  premises.foldl Status.meet own

theorem meet_le_left (a b : Status) : Status.meet a b ≤ a := by
  unfold Status.meet; split
  · exact Nat.le_refl _
  · show b.rank ≤ a.rank; omega

theorem meet_le_right (a b : Status) : Status.meet a b ≤ b := by
  unfold Status.meet; split
  · assumption
  · exact Nat.le_refl _

/-- Theorem (no laundering): a conclusion can never be stronger than its own check. -/
theorem combine_le_own (own : Status) (ps : List Status) : combine own ps ≤ own := by
  induction ps generalizing own with
  | nil => exact Nat.le_refl _
  | cons p ps ih =>
    show (combine (Status.meet own p) ps).rank ≤ own.rank
    exact Nat.le_trans (ih (Status.meet own p)) (meet_le_left own p)

/-- Theorem (no laundering): a conclusion can never be stronger than any premise. -/
theorem combine_le_premise (own : Status) (ps : List Status) :
    ∀ p ∈ ps, combine own ps ≤ p := by
  induction ps generalizing own with
  | nil => intro p h; cases h
  | cons q ps ih =>
    intro p hp
    cases hp with
    | head =>
      show (combine (Status.meet own q) ps).rank ≤ q.rank
      exact Nat.le_trans (combine_le_own _ ps) (meet_le_right own q)
    | tail _ hmem => exact ih (Status.meet own q) p hmem

/-! ## 2. Guarded specialization: facts change speed, never answers -/

variable {α β γ : Type}

/-- The shipped program: take the fast path only when the guard says so. -/
def guarded (g : α → Bool) (fast ref : α → β) : α → β :=
  fun x => if g x then fast x else ref x

/-- Theorem (guarded specialization). If the guard is sound for the facts Φ
    (whenever it says yes, Φ holds) and the fast path agrees with the reference
    wherever Φ holds, then the shipped program equals the reference on EVERY input,
    whether or not the facts hold. Assumed facts can cost speed, never correctness. -/
theorem guarded_correct (Φ : α → Prop) (g : α → Bool) (fast ref : α → β)
    (sound : ∀ x, g x = true → Φ x)
    (agree : ∀ x, Φ x → fast x = ref x) :
    ∀ x, guarded g fast ref x = ref x := by
  intro x
  unfold guarded
  cases h : g x
  · rfl
  · exact agree x (sound x h)

/-- The two obligations are exactly what Anka checks: each is a separate card.
    Dropping either one breaks the theorem; here is a counterexample for `sound`. -/
example : ¬ (∀ (g : Nat → Bool) (fast ref : Nat → Nat) (Φ : Nat → Prop),
    (∀ x, Φ x → fast x = ref x) → ∀ x, guarded g fast ref x = ref x) := by
  intro h
  have := h (fun _ => true) (fun _ => 1) (fun _ => 0) (fun _ => False) (fun _ hf => hf.elim) 0
  simp [guarded] at this

/-! ## 3. Abduction: the missing hypothesis a shortcut needs -/

/-- ψ is an abductive hypothesis for "fast = ref" given known facts Γ:
    together they imply agreement, and ψ is consistent with Γ on some input. -/
structure Abduced (Γ ψ : α → Prop) (fast ref : α → β) : Prop where
  enough     : ∀ x, Γ x → ψ x → fast x = ref x
  consistent : ∃ x, Γ x ∧ ψ x

/-- Theorem: an abduced hypothesis plus a guard that soundly tests Γ ∧ ψ
    yields a shipped program that is exactly the reference. -/
theorem abduced_guarded_correct (Γ ψ : α → Prop) (g : α → Bool) (fast ref : α → β)
    (hA : Abduced Γ ψ fast ref)
    (sound : ∀ x, g x = true → Γ x ∧ ψ x) :
    ∀ x, guarded g fast ref x = ref x :=
  guarded_correct (fun x => Γ x ∧ ψ x) g fast ref sound
    (fun x ⟨hg, hp⟩ => hA.enough x hg hp)

/-! ## 4. The ratchet: never make things worse -/

/-- A version: its program, whether it was shown equal to the reference, and its measured cost. -/
structure Version (α β : Type) where
  prog  : α → β
  cost  : Nat

/-- A step is accepted only if the new version agrees with the reference
    and its cost beats the old one by more than the noise band. -/
def accepts (ref : α → β) (noise : Nat) (old new : Version α β) : Prop :=
  (∀ x, new.prog x = ref x) ∧ new.cost + noise < old.cost

/-- A chain of steps v → v₁ → v₂ → … where each consecutive pair satisfies R. -/
inductive Chain (R : γ → γ → Prop) : γ → List γ → Prop
  | nil  (a : γ) : Chain R a []
  | cons {a b : γ} {l : List γ} : R a b → Chain R b l → Chain R a (b :: l)

/-- Theorem (ratchet): along any chain of accepted steps from a correct start,
    every version is correct and cost never goes up. -/
theorem ratchet (ref : α → β) (noise : Nat) :
    ∀ (v : Version α β) (vs : List (Version α β)),
      (∀ x, v.prog x = ref x) →
      Chain (accepts ref noise) v vs →
      ∀ w ∈ vs, (∀ x, w.prog x = ref x) ∧ w.cost ≤ v.cost := by
  intro v vs hv hc
  induction hc with
  | nil => intro w h; cases h
  | cons hstep _ ih =>
    intro w hw
    cases hw with
    | head => exact ⟨hstep.1, by have := hstep.2; omega⟩
    | tail _ hmem =>
      have ⟨hc, hle⟩ := ih hstep.1 w hmem
      exact ⟨hc, by have := hstep.2; omega⟩

/-! ## 5. A concrete instance: newest-by-time = last-by-id, under a monotone-time fact -/

/-- Rows stored in id order; each has a timestamp. -/
structure Row where
  id   : Nat
  time : Nat

/-- The fact hargup relied on: along id order, time never decreases. -/
def TimeMonotone : List Row → Prop
  | [] => True
  | [_] => True
  | a :: b :: rest => a.time ≤ b.time ∧ TimeMonotone (b :: rest)

/-- The general query's essential step: the row with the greatest time
    (scanning all rows, ties broken toward the later row). -/
def newestByTime : Row → List Row → Row
  | best, [] => best
  | best, r :: rs => newestByTime (if best.time ≤ r.time then r else best) rs

/-- The specialized plan: just read the last row. -/
def lastRow : Row → List Row → Row
  | best, [] => best
  | _, r :: rs => lastRow r rs

/-- Theorem: under the monotone-time fact, scanning for the newest row
    equals reading the last row. (The 1-row case of the feed; the k-row case
    follows the same induction.) -/
theorem newest_eq_last (a : Row) (rs : List Row) (h : TimeMonotone (a :: rs)) :
    newestByTime a rs = lastRow a rs := by
  induction rs generalizing a with
  | nil => rfl
  | cons r rs ih =>
    have ⟨hle, hrest⟩ := h
    simp only [newestByTime, lastRow, hle, ite_true]
    exact ih r hrest

end Anka
