import { expect, test } from 'bun:test'
import { applyPromos, applyPromosSlow } from './cart'
import { carts, promoSets } from './seed'

test('a single promo comes off the total', () => {
  expect(applyPromos({ lines: [{ priceCents: 2000, qty: 1 }] }, [{ code: 'SAVE10', offCents: 1000 }])).toBe(1000)
})

test('SAVE50 + SAVE60 on a $10 cart must not go below $0', () => {
  const total = applyPromos({ lines: [{ priceCents: 1000, qty: 1 }] }, [
    { code: 'SAVE50', offCents: 5000 },
    { code: 'SAVE60', offCents: 6000 },
  ])
  expect(total).toBeGreaterThanOrEqual(0)
})

test('fast matches slow on every seed cart and promo set', () => {
  for (const cart of carts)
    for (const promos of promoSets) expect(applyPromos(cart, promos)).toBe(applyPromosSlow(cart, promos))
})
