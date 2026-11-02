# Anka (a Claude Code mod) — what it does during planning

When the user asks for a change, Claude plans as usual, and Anka adds a math layer:

1. Mine facts: look at the problem's rules and constraints, the code, and any real data or inputs, and list candidate facts that are always true. Check each against the code and data.
2. Ask the user plain questions only they can answer (no jargon), to confirm or reject facts.
3. Use confirmed facts to look for a cheaper or safer plan that gives exactly the same results as the obvious version, under those facts.
4. For each important claim, write a card:
   Says: (one plain-English sentence)
   Assumes: (facts it relies on)
   Breaks when: (concrete case that would make it false)
   Checked: Proved / Checked (how) / Assumed / Open / Broken
5. Ship any shortcut with a runtime guard that falls back to the obvious version if an assumed fact is ever violated.
6. Measure the result.
