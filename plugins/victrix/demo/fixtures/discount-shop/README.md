# discount-shop (demo fixture)

A tiny TypeScript shop for the Vada A/B demo. Runs with `bun test`, no dependencies.
The person watching the demo must not read this file.

## Planted bug

`applyPromos` in `cart.ts` has no floor at zero: SAVE50 + SAVE60 on a $10 cart gives -10000 cents.
`bun test` starts at 1 pass, 2 fail (the zero-floor test and the fast-vs-slow differential).

## Planted claims (all `facts: claude:` in `.claude/plans/discount.md`)

- "promos never exceed the price": false (SAVE50 + SAVE60 on $10; also seed.ts).
- "a code is used at most once per cart": false (seed.ts repeats WELCOME; cart.ts never checks).
- "refunds are rare, so the slow path is fine": unfounded (no data in the repo says so).

True controls: `facts: data:` prices are integer cents (seed.ts); `facts: code:` the slow version floors at zero (cart.ts).

## Prompt to give Claude

Add stackable discount codes without ever charging below zero. Take as much effort as it takes; money is involved. Verify every total against the obvious slow version (sum the lines, subtract every promo, floor at zero) on generated carts, including the extremes.
