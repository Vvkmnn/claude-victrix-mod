// The fit ladder: the whole plan always on screen, folded from the least important part first and never a
// blank row. Given a row budget it returns the rows of the richest level that fits (L0 richest, L4 leanest;
// past L4 the engine scrolls). Pure; no `$`.
import type { Claim, PlanItem, PlanTree, Status } from '../types'
import { GLYPH, stepStatus, weakest } from './lattice'
import { nowItem } from './plan'
import type { TrunkKind } from './draw'

export type RowKind = 'title' | 'chips' | 'step' | 'because' | 'fact' | 'guard' | 'option' | 'verify' | 'more'
export type RowMark = 'done' | 'now' | 'open' | 'abandoned' | 'claim' | 'none'

export type MapRow = {
  readonly key: string
  readonly kind: RowKind
  readonly trunk: TrunkKind
  readonly glyph: string
  readonly text: string
  readonly right: string
  readonly mark: RowMark
  readonly status?: Status
  /** The step the row belongs to: the item's own name, or the item a detail sits under. */
  readonly step: string
  readonly isNow: boolean
}

export type Fitted = { readonly level: 0 | 1 | 2 | 3 | 4; readonly rows: readonly MapRow[]; readonly isOverflowing: boolean }

export type FitInput = {
  readonly rows: number
  readonly tree: PlanTree
  readonly claims: readonly Claim[]
  /** The row key the cursor is on; the ladder never folds it away. */
  readonly cursorKey?: string
  /** What branches under a step: its facts (default; because, guard, option and verify live in the map's `now` zone) or everything. */
  readonly details?: 'facts' | 'all'
}

const DONE_GLYPH = '✓'
const NOW_GLYPH = '◉'
const OPEN_GLYPH = '○'
const ABANDONED_GLYPH = '~'

export const stepKey = (item: PlanItem) => `s:${item.name}`
export const factKey = (step: string, index: number) => `f:${step}:${index}`
const detailKey = (step: string, kind: RowKind) => `${kind}:${step}`

const isSettled = (item: PlanItem) => item.isDone || item.isAbandoned

/** Every item at every depth, in document order. */
const walk = (items: readonly PlanItem[]): PlanItem[] => items.flatMap(item => [item, ...walk(item.children)])

const claimsOf = (claims: readonly Claim[], step: string) => claims.filter(claim => claim.step === step)

/** The claims drawn under a step: the plan's facts, each replaced by a checked or answered claim of the same words when one exists. */
/** A step's premises: every plan fact as a claim (the ledger's status where it was checked, else open), plus claims the ledger holds beyond the plan. */
export const factsOf = (item: PlanItem, claims: readonly Claim[]): Claim[] => {
  const known = claimsOf(claims, item.name)
  const fromPlan = item.facts.map(fact => known.find(claim => claim.says === fact.text) ?? { step: item.name, says: fact.text, status: 'open' as Status, source: fact.source, at: 0 })
  const extra = known.filter(claim => !item.facts.some(fact => fact.text === claim.says))
  return [...fromPlan, ...extra]
}

const counts = (facts: readonly Claim[]) => {
  const open = facts.filter(claim => claim.status === 'open').length
  const broken = facts.filter(claim => claim.status === 'broken').length
  const checked = facts.filter(claim => claim.status === 'checked' || claim.status === 'proved').length
  return [open > 0 ? `△${open}` : '', checked > 0 ? `■${checked}` : '', broken > 0 ? `✗${broken}` : ''].filter(Boolean).join(' ')
}

const stepRow = (item: PlanItem, isNow: boolean, isLast: boolean, facts: readonly Claim[], right: string): MapRow => ({
  key: stepKey(item),
  kind: 'step',
  trunk: isLast ? 'last' : 'step',
  glyph: item.isAbandoned ? ABANDONED_GLYPH : item.isDone ? DONE_GLYPH : isNow ? NOW_GLYPH : OPEN_GLYPH,
  text: item.name,
  right,
  mark: item.isAbandoned ? 'abandoned' : item.isDone ? 'done' : isNow ? 'now' : 'open',
  status: isNow ? stepStatus(facts) : undefined,
  step: item.name,
  isNow,
})

/** The detail rows under a step: because, each fact as a claim, guard, each option, verify. */
const detailRows = (item: PlanItem, facts: readonly Claim[], withFacts: boolean, details: 'facts' | 'all'): MapRow[] => {
  const low = weakest(facts)
  const rows: MapRow[] = []
  const push = (kind: RowKind, glyph: string, text: string, right = '', status?: Status) =>
    rows.push({ key: detailKey(item.name, kind) + (kind === 'option' || kind === 'fact' ? `:${rows.length}` : ''), kind, trunk: 'detail', glyph, text, right, mark: kind === 'fact' ? 'claim' : 'none', status, step: item.name, isNow: true })
  if (details === 'all' && item.why) push('because', '', item.why)
  if (withFacts) {
    facts.forEach((claim, index) => {
      rows.push({
        key: factKey(item.name, index),
        kind: 'fact',
        trunk: 'detail',
        glyph: GLYPH[claim.status],
        text: claim.says,
        right: low !== undefined && claim === low && facts.length > 1 ? 'weakest' : '',
        mark: 'claim',
        status: claim.status,
        step: item.name,
        isNow: true,
      })
    })
  } else if (facts.length > 0) {
    push('fact', '', `${facts.length} facts · ${counts(facts)}`)
  }
  if (details === 'all') {
    if (item.guard) push('guard', '', item.guard)
    item.options.forEach(option => push('option', '', option, 'not built'))
    if (item.judge) push('verify', '', item.judge, 'not yet')
  }
  // The last detail closes the branch.
  const last = rows[rows.length - 1]
  if (last) rows[rows.length - 1] = { ...last, trunk: 'detailLast' }
  return rows
}

/** The chips row of settled steps: every done or abandoned item on one line. */
const chipsRow = (settled: readonly PlanItem[]): MapRow => ({
  key: 'chips',
  kind: 'chips',
  trunk: 'step',
  glyph: '',
  text: settled.map(item => `${item.isAbandoned ? ABANDONED_GLYPH : DONE_GLYPH} ${item.name}`).join(' · '),
  right: `done ${settled.filter(item => !item.isAbandoned).length}`,
  mark: 'done',
  step: '',
  isNow: false,
})

type Level = 0 | 1 | 2 | 3 | 4

const build = (input: FitInput, level: Level, keepNext: number): MapRow[] => {
  const { tree, claims } = input
  const now = nowItem(tree)
  const rows: MapRow[] = []
  if (tree.title) rows.push({ key: 'title', kind: 'title', trunk: 'gap', glyph: '', text: tree.summary ?? tree.title, right: '', mark: 'none', step: '', isNow: false })

  const all = tree.sections.flatMap(section => walk(section.items))
  const settled = all.filter(isSettled)
  const open = all.filter(item => !isSettled(item))

  if (settled.length > 0) {
    if (level >= 2) rows.push(chipsRow(settled))
    else settled.forEach(item => rows.push(stepRow(item, false, false, [], '')))
  }

  const nowIndex = open.findIndex(item => item === now)
  const after = nowIndex === -1 ? open : open.slice(nowIndex + 1)
  const before = nowIndex === -1 ? [] : open.slice(0, nowIndex)
  const kept = level >= 3 ? after.slice(0, Math.max(0, keepNext)) : after
  const hidden = after.length - kept.length

  const emit = (item: PlanItem, isLast: boolean, sectionLabel: string) => {
    const isNow = item === now
    const facts = factsOf(item, claims)
    const right = isNow ? 'now' : counts(facts)
    rows.push(stepRow(item, isNow, isLast, facts, right))
    const showDetail = level === 0 || isNow
    if (showDetail && !isSettled(item)) rows.push(...detailRows(item, facts, level < 4, input.details ?? 'facts'))
  }

  const sectionOf = (item: PlanItem) => tree.sections.find(section => walk(section.items).includes(item))
  let lastSection: string | undefined
  const labelFor = (item: PlanItem) => {
    const section = sectionOf(item)
    const title = section?.title ?? ''
    if (title === lastSection || /in progress/i.test(title)) return ''
    lastSection = title
    const count = section ? walk(section.items).filter(one => !isSettled(one)).length : 0
    return `${title.toLowerCase()} ${count}`
  }

  const ordered = [...before, ...(now ? [now] : []), ...kept]
  ordered.forEach((item, index) => emit(item, index === ordered.length - 1 && hidden === 0, labelFor(item)))
  if (hidden > 0) rows.push({ key: 'more', kind: 'more', trunk: 'last', glyph: '', text: `… ${hidden} more`, right: '', mark: 'none', step: '', isNow: false })

  // The cursor row is never folded away: when it is among the hidden next steps, keep up to it.
  const cursor = input.cursorKey
  if (cursor !== undefined && level >= 3 && !rows.some(row => row.key === cursor)) {
    const need = after.findIndex(item => stepKey(item) === cursor)
    if (need >= 0 && need + 1 > keepNext) return build(input, level, need + 1)
  }
  return rows
}

/** The richest level whose rows fit the budget; past L4 the rows overflow and the engine scrolls. */
export const fitRows = (input: FitInput): Fitted => {
  const budget = Math.max(0, Math.floor(input.rows))
  const levels: Level[] = [0, 1, 2, 3, 4]
  for (const level of levels) {
    if (level < 3) {
      const rows = build(input, level, Number.MAX_SAFE_INTEGER)
      if (rows.length <= budget) return { level, rows, isOverflowing: false }
      continue
    }
    // L3 and L4: keep as many next steps as the budget allows, at least one.
    const full = build(input, level, Number.MAX_SAFE_INTEGER)
    if (full.length <= budget) return { level, rows: full, isOverflowing: false }
    const base = build(input, level, 0).length
    const room = Math.max(1, budget - base)
    const rows = build(input, level, room)
    if (rows.length <= budget) return { level, rows, isOverflowing: false }
  }
  return { level: 4, rows: build(input, 4, 1), isOverflowing: true }
}
