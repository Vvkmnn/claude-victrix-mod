# Discount codes for the shop

**Progress: 2/7 done** | Active: Apply promos

Goal: add stackable discount codes without ever charging below zero. Effort: as much as it takes; money is involved. Verify: every total checked against the obvious slow version (sum the lines, subtract each promo) on generated carts including the extremes.

## Summary

Add discount codes to the shop. The scary part is a total that goes negative when two codes stack; the slow version is the spec.

## Done

- [x] **Schema** — promos table with code, amount, kind · verify: migration applies on an empty db
- [x] ~~**Coupons v1**~~ — abandoned: replaced by promos, which stack

## In Progress

- [ ] **Apply promos** — subtract each promo from the cart total · because: one rule in one place, chosen over capping each promo at the line it applies to · facts: data: prices in the seed are integers in cents · facts: claude: promos never exceed the price · facts: you: two codes never share a prefix · guard: if total < 0 then clamp to 0 and log the cart, 1 compare per cart · options: cache promo lookups per request (2× on the hot path) · verify: bun test · slow: sum every line, then subtract every promo in order
- [ ] **Show the total** — in the cart view, with the promos listed · verify: snapshot test of the cart view

## Up Next

- [ ] **Stacking rules** — which codes may stack · facts: claude: a code is used at most once per cart · verify: property test over random code lists
- [ ] **Receipts** — the promos on the receipt line by line
- [ ] **Refunds** — refund the promo share proportionally · facts: claude: refunds are rare, so the slow path is fine · slow: recompute the whole cart
- [ ] **Admin screen** — create and expire codes
- [ ] **Ship** — behind a flag, 10% of carts first

---

## Detail: Apply promos

Prose only, no checkboxes. The clamp is the guard; the differential against the slow version is the check.
