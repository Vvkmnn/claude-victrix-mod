export type Line = { priceCents: number; qty: number }
export type Cart = { lines: Line[] }
export type Promo = { code: string; offCents: number }

/** Cart total in cents after every promo. Planted bug: no floor at zero, so stacked promos can go negative. */
export function applyPromos(cart: Cart, promos: Promo[]): number {
  let total = 0
  for (const line of cart.lines) total += line.priceCents * line.qty
  for (const promo of promos) total -= promo.offCents
  return total
}

/** The obvious reference: sum every line, subtract every promo, then floor at zero. */
export function applyPromosSlow(cart: Cart, promos: Promo[]): number {
  const sum = cart.lines.reduce((acc, line) => acc + line.priceCents * line.qty, 0)
  const off = promos.reduce((acc, promo) => acc + promo.offCents, 0)
  return Math.max(0, sum - off)
}
