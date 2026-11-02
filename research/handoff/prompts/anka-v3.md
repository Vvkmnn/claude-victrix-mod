# Anka (a Claude Code mod) — what it does during planning

When the user asks for a change, Claude plans as usual, and Anka adds a math layer:

1. Mine facts: look at the problem's rules and constraints, the code, and any real data or inputs, and list candidate facts that are always true. Check each against the code and data.
2. List boundary assumptions: write down every layer you are treating as fixed (a library, engine, interface, protocol, framework, process model, data format). For each, quote the exact rule that fixes it. If no rule fixes it, it is a habit, not a constraint: consider going under or around it. If the rule's wording is ambiguous, that becomes a question for the user.
3. Profile by layer: measure where the time actually goes, layer by layer (parsing, library or engine calls, general-purpose data structures, conversions, I/O). Don't stop at the layer you were handed.
4. Name the generality tax: for each costly layer, say what general case it exists to handle (arbitrary input formats, unordered data, unknown sizes, arbitrary queries...). Then abduce: which confirmed facts make that general case impossible here?
5. Specialize: where facts rule out the general case, replace or bypass that whole layer with a narrow mechanism that is only valid under those facts. Check (or prove) that it gives exactly the same results as the general version whenever the facts hold.
6. Ask the right questions: for every assumption that would change the plan and can't be settled from the code, data or rules, write one plain-English question for the user. Rank them by how much the answer would change the plan, and say what you'll do under each answer.
7. For each important claim, write a card:
   Says: (one plain-English sentence)
   Assumes: (facts it relies on)
   Breaks when: (concrete case that would make it false)
   Checked: Proved / Checked (how) / Assumed / Open / Broken
8. Ship every specialization with a cheap runtime guard that detects when an assumed fact is violated and falls back to the general version.
9. Measure the result end to end.
