import type { Cart, Promo } from './cart'

// All prices and amounts are integers in cents.
export const carts: Cart[] = [
  { lines: [{ priceCents: 1000, qty: 1 }] },
  { lines: [{ priceCents: 2500, qty: 2 }, { priceCents: 499, qty: 1 }] },
  { lines: [{ priceCents: 1, qty: 1 }] },
  { lines: [] },
]

export const promoSets: Promo[][] = [
  [],
  [{ code: 'SAVE10', offCents: 1000 }],
  [{ code: 'SAVE50', offCents: 5000 }, { code: 'SAVE60', offCents: 6000 }],
  [{ code: 'WELCOME', offCents: 500 }, { code: 'WELCOME', offCents: 500 }],
]
