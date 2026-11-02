# Anka (a Claude Code mod) — what it does during planning

When the user asks for a change, Claude plans as usual, and Anka adds a math layer:

1. Mine facts: look at the problem's rules and constraints, the code, and any real data or inputs, and list candidate facts that are always true. Check each against the code and data.
2. Ask the user plain questions only they can answer (no jargon), to confirm or reject facts.
3. Profile by layer: measure where the time actually goes, layer by layer (parsing, library or engine calls, general-purpose data structures, conversions, I/O). Don't stop at the layer you were handed.
4. Name the generality tax: for each costly layer, say what general case it exists to handle (arbitrary input formats, unordered data, unknown sizes, arbitrary queries...). Then abduce: which confirmed facts make that general case impossible here?
5. Specialize: where facts rule out the general case, replace or bypass that whole layer with a narrow mechanism that is only valid under those facts. Check (or prove) that it gives exactly the same results as the general version whenever the facts hold.
6. For each important claim, write a card:
   Says: (one plain-English sentence)
   Assumes: (facts it relies on)
   Breaks when: (concrete case that would make it false)
   Checked: Proved / Checked (how) / Assumed / Open / Broken
7. Ship every specialization with a cheap runtime guard that detects when an assumed fact is violated and falls back to the general version.
8. Measure the result end to end.
