// Began as the plan parser of github.com/Vvkmnn/claude-emporium (plugins/emporium/hooks/plan.ts,
// Oct 2026, same author); carried on here with tags, assumptions and the summary.
import type { ClaimSource, PlanFact, PlanItem, PlanTree } from '../types'

type Row = { readonly depth: number; readonly item: Omit<PlanItem, 'children'> }

const CHECKBOX = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/
const SECTION = /^##\s+(.+?)\s*$/
const TITLE = /^#\s+(.+?)\s*$/
const PROGRESS = /^\*\*Progress:\s*(.+?)\*\*/
const TAG = /^(why|because|trade|judge|verify|assume[sd]?|facts?|guard|options?|slow):\s*(.*)$/i
// A fact line may name where it came from: `data: ids are dense`, `you: prices are in cents`.
const SOURCE = /^(data|code|you|claude):\s*(.*)$/i
// Wording that leans on something unchecked; the lens shows these lines under their step as △.
const ASSUMES = /\b(assum\w*|should|probably|likely|presumably|supposedly|expect\w*|guess\w*)\b/i

type Tags = Pick<PlanItem, 'note' | 'why' | 'trade' | 'judge' | 'assumptions' | 'facts' | 'guard' | 'options' | 'slow'>

/**
 * Splits a note into its tags. Notes read `plain words · why: … · trade: … · judge: …`; a part
 * without a tag is the plain note, and any part whose wording assumes something is an assumption.
 */
const factOf = (text: string, fallback: ClaimSource): PlanFact => {
  const named = SOURCE.exec(text)
  return named ? { text: (named[2] ?? '').trim(), source: (named[1] ?? '').toLowerCase() as ClaimSource } : { text, source: fallback }
}

const readTags = (note: string): Tags => {
  const parts = note.split(/\s+·\s+/).map(part => part.trim()).filter(Boolean)
  const tagged = parts.map(part => ({ part, tag: TAG.exec(part) }))
  const named = (...names: readonly string[]) => tagged.filter(({ tag }) => tag !== null && names.includes((tag[1] ?? '').toLowerCase()))
  const first = (...names: readonly string[]) => named(...names)[0]?.tag?.[2]?.trim() ?? ''
  const all = (...names: readonly string[]) => named(...names).map(({ tag }) => tag?.[2]?.trim() ?? '').filter(Boolean)
  const plain = tagged.filter(({ tag }) => tag === null).map(({ part }) => part)
  // `facts:`/`assume:` lines are facts with a named source; a plain part whose wording assumes something is one from the wording.
  const explicit = all('facts', 'fact', 'assume', 'assumes', 'assumed').map(text => factOf(text, 'claude'))
  const implied = plain.filter(part => ASSUMES.test(part)).map(text => factOf(text, 'wording'))
  const facts = [...explicit, ...implied].filter(fact => fact.text !== '')

  return {
    note: plain.join(' · '),
    why: first('why', 'because'),
    trade: first('trade'),
    judge: first('judge', 'verify'),
    assumptions: facts.map(fact => fact.text),
    facts,
    guard: first('guard'),
    options: all('options', 'option'),
    slow: first('slow'),
  }
}

// "**Name** — note" or "~~**Name**~~ — note": the bold part names the item, the rest is its note.
const splitItem = (raw: string): { name: string; isAbandoned: boolean } & Tags => {
  const isAbandoned = raw.startsWith('~~')
  const plain = raw.replace(/~~/g, '')
  const bold = /^\*\*(.+?)\*\*\s*(?:[—-]+\s*)?(.*)$/.exec(plain)

  return bold
    ? { name: (bold[1] ?? '').trim().replace(/:$/, ''), isAbandoned, ...readTags((bold[2] ?? '').trim()) }
    : { name: plain.trim(), isAbandoned, ...readTags('') }
}

// Two spaces (or one tab) per nesting level, as markdown lists indent.
const depthOf = (indent: string) => indent.replace(/\t/g, '  ').length >> 1

const toRow = (text: string, line: number): Row | undefined => {
  const match = CHECKBOX.exec(text)
  if (!match) return undefined
  const { name, isAbandoned, ...tags } = splitItem(match[3] ?? '')

  return { depth: depthOf(match[1] ?? ''), item: { name, ...tags, isDone: match[2] !== ' ', isAbandoned, line } }
}

// Rows arrive in document order; each row owns the deeper rows that follow it.
const nest = (rows: readonly Row[]): PlanItem[] => {
  const build = (start: number, depth: number): { items: PlanItem[]; next: number } => {
    const items: PlanItem[] = []
    let at = start
    for (let row = rows[at]; row !== undefined && row.depth >= depth; row = rows[at]) {
      const inner = build(at + 1, row.depth + 1)
      items.push({ ...row.item, children: inner.items })
      at = inner.next
    }
    return { items, next: at }
  }

  return build(0, Math.min(...rows.map(row => row.depth))).items
}

type Draft = { readonly title: string; readonly rows: readonly Row[]; readonly prose: readonly string[] }

const isProse = (text: string) => text.trim() !== '' && !text.startsWith('#') && !text.startsWith('```') && !CHECKBOX.test(text)

// The first paragraph of the first Summary (else Context) section: the plan's own one-line purpose.
const summaryOf = (drafts: readonly Draft[]): string | undefined => {
  const pick = (pattern: RegExp) => drafts.find(draft => pattern.test(draft.title))?.prose[0]
  return pick(/summary/i) ?? pick(/context/i)
}

/** Parses a plan file into its title, progress line, summary and per-section checkbox tree; tolerates any missing part. */
export const parsePlan = (markdown: string): PlanTree => {
  const lines = markdown.split(/\r?\n/)
  const title = lines.map(text => TITLE.exec(text)?.[1]).find(Boolean)
  const progress = lines.map(text => PROGRESS.exec(text)?.[1]?.trim()).find(Boolean)

  const drafts = lines.reduce<Draft[]>((acc, text, index) => {
    const heading = SECTION.exec(text)?.[1]
    if (heading !== undefined) return [...acc, { title: heading, rows: [], prose: [] }]
    const last = acc[acc.length - 1]
    if (!last) return acc
    const row = toRow(text, index + 1)
    if (row) return [...acc.slice(0, -1), { ...last, rows: [...last.rows, row] }]
    if (isProse(text) && last.rows.length === 0) return [...acc.slice(0, -1), { ...last, prose: [...last.prose, text.trim()] }]
    return acc
  }, [])

  return {
    title,
    progress,
    summary: summaryOf(drafts),
    sections: drafts
      .filter(draft => draft.rows.length > 0)
      .map(draft => ({ title: draft.title, items: nest(draft.rows) })),
  }
}

const isOpenItem = (item: PlanItem) => !item.isDone && !item.isAbandoned

const allItems = (tree: PlanTree): PlanItem[] => {
  const walk = (item: PlanItem): PlanItem[] => [item, ...item.children.flatMap(walk)]
  return tree.sections.flatMap(section => section.items.flatMap(walk))
}

/** The item being worked: the first open item under "In Progress", else the first open item anywhere. */
export const nowItem = (tree: PlanTree): PlanItem | undefined => {
  const inProgress = tree.sections.find(section => /in progress/i.test(section.title))

  return inProgress?.items.find(isOpenItem) ?? tree.sections.flatMap(section => section.items).find(isOpenItem)
}

export type Tally = { readonly done: number; readonly open: number; readonly abandoned: number; readonly assumed: number }

/** Counts over every item at every depth: what is done, open, abandoned, and how many lines assume something. */
export const tally = (tree: PlanTree): Tally =>
  allItems(tree).reduce<Tally>(
    (acc, item) => ({
      done: acc.done + (item.isDone && !item.isAbandoned ? 1 : 0),
      open: acc.open + (isOpenItem(item) ? 1 : 0),
      abandoned: acc.abandoned + (item.isAbandoned ? 1 : 0),
      assumed: acc.assumed + (isOpenItem(item) ? item.assumptions.length : 0),
    }),
    { done: 0, open: 0, abandoned: 0, assumed: 0 },
  )

export type OutlineRow = {
  readonly key: string
  readonly kind: 'section' | 'item' | 'assumption'
  readonly depth: number
  readonly label: string
  readonly mark: 'done' | 'abandoned' | 'open' | 'now' | 'assumed' | 'section'
  readonly count: number
  readonly isFoldable: boolean
  readonly isOpen: boolean
  readonly isNow: boolean
  /** The step this row belongs to: the item's own name, or the item an assumption sits under. */
  readonly step: string
}

/**
 * The order the lens draws rows in: open sections and their items first, then every folded
 * section head together on one tray line, so folded parts cost one row, not one each.
 */
export const arrange = (rows: readonly OutlineRow[]): { body: OutlineRow[]; tray: OutlineRow[] } => {
  const isFoldedHead = (row: OutlineRow) => row.kind === 'section' && !row.isOpen
  return { body: rows.filter(row => !isFoldedHead(row)), tray: rows.filter(isFoldedHead) }
}

// `fit` lives in draw.ts with the rest of the kit; kept exported here for the callers that import it from plan.
export { fit } from './draw'

export const sectionKey = (title: string) => `s:${title}`
export const itemKey = (item: PlanItem) => `i:${item.name}`
export const assumptionKey = (item: PlanItem, index: number) => `a:${item.name}:${index}`

const markOf = (item: PlanItem, isNow: boolean): OutlineRow['mark'] =>
  item.isAbandoned ? 'abandoned' : item.isDone ? 'done' : isNow ? 'now' : 'open'

/** Finds the item a row stands for, by its step name, so a press can read its why, trade and judge. */
export const itemNamed = (tree: PlanTree, name: string): PlanItem | undefined =>
  allItems(tree).find(item => item.name === name)

/**
 * The rows the lens draws, in order. Open by default: the In Progress section and the item being
 * worked, whose assumptions show under it; everything else folded to one line. A key in
 * `toggled` flips its default.
 */
export const outline = (tree: PlanTree, toggled: readonly string[]): OutlineRow[] => {
  const now = nowItem(tree)
  const flips = new Set(toggled)
  const isOpen = (key: string, byDefault: boolean) => byDefault !== flips.has(key)

  const assumptionRows = (item: PlanItem, depth: number): OutlineRow[] =>
    item.assumptions.map((text, index) => ({
      key: assumptionKey(item, index),
      kind: 'assumption',
      depth,
      label: text,
      mark: 'assumed',
      count: 0,
      isFoldable: false,
      isOpen: false,
      isNow: false,
      step: item.name,
    }))

  const itemRows = (item: PlanItem, depth: number): OutlineRow[] => {
    const key = itemKey(item)
    const isNow = item === now
    const hasInside = item.children.length > 0 || (isNow && item.assumptions.length > 0)
    const open = isOpen(key, isNow)
    const row: OutlineRow = {
      key,
      kind: 'item',
      depth,
      label: item.name,
      mark: markOf(item, isNow),
      count: item.children.length,
      isFoldable: hasInside,
      isOpen: open && hasInside,
      isNow,
      step: item.name,
    }
    if (!open) return [row]
    const inside = isNow ? assumptionRows(item, depth + 1) : []
    return [row, ...inside, ...item.children.flatMap(child => itemRows(child, depth + 1))]
  }

  return tree.sections.flatMap(section => {
    const key = sectionKey(section.title)
    const open = isOpen(key, /in progress/i.test(section.title))
    const head: OutlineRow = {
      key,
      kind: 'section',
      depth: 0,
      label: section.title,
      mark: 'section',
      count: section.items.length,
      isFoldable: true,
      isOpen: open,
      isNow: false,
      step: section.title,
    }
    return open ? [head, ...section.items.flatMap(item => itemRows(item, 1))] : [head]
  })
}
