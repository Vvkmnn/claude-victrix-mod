# Plan: maxArea in O(n)

Questions I would have asked (assumptions made): Is input always a plain Array of non-negative numbers? (assumed yes per spec; guarded). Ties/duplicates? (handled).

## Mined facts
1. All heights >= 0 (spec). 2. Max product 1e4*1e6 = 1e10, exact in doubles. 3. Moving the pointer at the shorter side never loses the optimum. 4. Any remaining pair has area <= (r-l)*maxH.

## Plan
Two pointers from both ends, skipping bars not taller than the one just used; early exit when best >= (r-l)*maxH. One pass first computes maxH and validates.

## Cards
Card 1 - Says: moving the shorter pointer inward never discards the best pair.
Assumes: heights non-negative. Breaks when: negative/NaN heights. Checked: Proved (shorter side limits any pair with the farther partner, and width only shrinks); fuzz vs brute force 20000 cases.

Card 2 - Says: skipping bars <= the one just used is safe.
Assumes: same. Breaks when: never for non-negative; such bars give area <= already counted. Checked: Proved + fuzz.

Card 3 - Says: early exit when best >= (r-l)*maxH is safe.
Assumes: maxH is true maximum. Breaks when: maxH computed wrong. Checked: Proved (upper bound) + fuzz.

Card 4 - Says: guard falls back to O(n^2) brute force if any value is not >= 0.
Checked: Checked (code review); spec says unreachable.

## Measured
n=1e6 random: ~10-25 ms (node 22). Visible tests pass.
