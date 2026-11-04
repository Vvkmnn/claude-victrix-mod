// Began as the plan lens of github.com/Vvkmnn/claude-emporium (plugins/emporium/hooks/lens.tsx,
// Oct 2026, same author); carried on here as the instrument: one trunk from the face through the plan.
import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register, RenderChildren } from 'claude-code'

import type { Activity, Claim, Note, NoteKind, PlanItem, PlanTree, PlanView, Question, RecentPlan, Status } from '../types'
import { EMPTY_ACTIVITY, describeCall, formatTokens, reduceActivity, timeOn } from './activity'
import type { ActivityEvent } from './activity'
import * as draw from './draw'
import { runVerify } from './check'
import { factKey, factsOf, fitRows, stepKey } from './fit'
import type { MapRow } from './fit'
import { DOCK_MIN_COLUMNS, chooseForm, choiceLabel, dockColumns, nextChoice } from './form'
import type { Form, FormChoice } from './form'
import { GLYPH, MEANING, label as claimLabel, proved, sameClaim, stepStatus, weakest } from './lattice'
import { VERBS, appendLog, deliveryText, describeNote, logLine } from './notes'
import { itemNamed, nowItem, parsePlan } from './plan'
import { drawTape } from './tape'

type On = Parameters<Register>[0]
type Dollar = Pick<CoreEngineInterface, 'state' | 'fs' | 'store' | 'ui' | 'env' | 'prompt' | 'clock' | 'session' | 'process' | 'model'>


export const PANE = 'victrix'
export const TITLE = '[-_-]'

// Atoms are declared in the file that reads them: the engine lists a module's state by scanning its own consts.
const plan = atom({ plugin: 'victrix', key: 'plan' } as const, null as PlanView | null)
// -1 means the cursor rests on the lit step until the person moves it.
const cursor = atom({ plugin: 'victrix', key: 'cursor' } as const, -1)
const cwd = atom({ plugin: 'victrix', key: 'cwd' } as const, '')
const recent = atom({ plugin: 'victrix', key: 'recent' } as const, [] as readonly RecentPlan[])
const activity = atom({ plugin: 'victrix', key: 'activity' } as const, EMPTY_ACTIVITY as Activity)
const notes = atom({ plugin: 'victrix', key: 'notes' } as const, [] as readonly Note[])
const pendingAdd = atom({ plugin: 'victrix', key: 'pendingAdd' } as const, null as string | null)
const isWorking = atom({ plugin: 'victrix', key: 'isWorking' } as const, false)
const claims = atom({ plugin: 'victrix', key: 'claims' } as const, [] as readonly Claim[])
const formChoice = atom({ plugin: 'victrix', key: 'formChoice' } as const, 'auto' as FormChoice)
const tick = atom({ plugin: 'victrix', key: 'tick' } as const, 0)
const asking = atom({ plugin: 'victrix', key: 'asking' } as const, [] as readonly string[])
const isDialogUp = atom({ plugin: 'victrix', key: 'isDialogUp' } as const, false)
const isPlanMode = atom({ plugin: 'victrix', key: 'isPlanMode' } as const, false)
const viewportColumns = atom({ plugin: 'victrix', key: 'viewportColumns' } as const, 0)
const isPlaced = atom({ plugin: 'victrix', key: 'isPlaced' } as const, false)
const questions = atom({ plugin: 'victrix', key: 'questions' } as const, [] as readonly Question[])
const changed = atom({ plugin: 'victrix', key: 'changed' } as const, [] as readonly string[])
const openedCard = atom({ plugin: 'victrix', key: 'openedCard' } as const, null as string | null)
const surface = atom({ plugin: 'victrix', key: 'surface' } as const, 'terminal' as string)
const contextPercent = atom({ plugin: 'victrix', key: 'contextPercent' } as const, 0)
const stepTokens = atom({ plugin: 'victrix', key: 'stepTokens' } as const, [] as readonly number[])
const ctxHistory = atom({ plugin: 'victrix', key: 'ctxHistory' } as const, [] as readonly number[])
const RECENT_KEPT = 3
const CHANGED_KEPT = 40
// The spinner's tick: the one declared exception to the ≤ 2 Hz motion rule, alive only while a call runs on the terminal.
const TICK_MS = 125

// Per repo, so two repos never overwrite each other's choice or ledger.
const planPathKey = (dir: string) => `victrix.planPath:${dir}`
const hiddenKey = (dir: string) => `victrix.hidden:${dir}`
const logKey = (dir: string) => `victrix.log:${dir}`
const askedKey = (dir: string) => `victrix.asked:${dir}`
const FORM_KEY = 'victrix.form'
/** The terminal's width as last reported by a drawing, kept per machine so a new session can ask for a quarter at once. */
const COLUMNS_KEY = 'victrix.columns'

// Plan files live as <anything>/.claude/plans/<name>.md; their archives are history, not the plan.
const isPlanFile = (path: string) => /\/\.claude\/plans\/[^/]+\.md$/.test(path) && !path.includes('.archive-')

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const clock = (at: number) => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** One ledger line per step whose state changed between two readings of the plan file: what Claude did, not what it said. */
export const diffPlans = (before: PlanTree | null, after: PlanTree | null): string[] => {
  const flat = (tree: PlanTree | null) => {
    const walk = (items: PlanTree['sections'][number]['items']): { name: string; state: string }[] =>
      items.flatMap(item => [{ name: item.name, state: item.isAbandoned ? 'abandoned' : item.isDone ? 'done' : 'open' }, ...walk(item.children)])
    return new Map((tree?.sections ?? []).flatMap(section => walk(section.items)).map(item => [item.name, item.state]))
  }
  const was = flat(before)
  const now = flat(after)
  const lines: string[] = []
  for (const [name, state] of now) {
    const old = was.get(name)
    if (old === undefined) lines.push(before === null ? `plan read ⋅ ${name}` : `step added ⋅ ${name}`)
    else if (old !== state) lines.push(`${name} ⋅ ${old} → ${state}`)
  }
  for (const name of was.keys()) if (!now.has(name)) lines.push(`step removed ⋅ ${name}`)
  return before === null ? lines.slice(0, 1) : lines
}

/** Steps open before and done now, top level and nested. */
const newlyDone = (before: PlanTree, after: PlanTree): PlanItem[] => {
  const walk = (items: readonly PlanItem[]): PlanItem[] => items.flatMap(item => [item, ...walk(item.children)])
  const wasOpen = new Set(walk(before.sections.flatMap(section => section.items)).filter(item => !item.isDone && !item.isAbandoned).map(item => item.name))
  return walk(after.sections.flatMap(section => section.items)).filter(item => item.isDone && !item.isAbandoned && wasOpen.has(item.name))
}

/** A verify line as an argv when it reads as one command (`bun test`, `npm test`, `make check`); prose stays undefined. */
export const argvOf = (judge: string): string[] | undefined => {
  const words = judge.trim().split(/\s+/)
  const head = words[0] ?? ''
  const isCommand = /^[\w./-]+$/.test(head) && words.length <= 8 && words.every(word => /^[\w./:=@,-]+$/.test(word))
  return isCommand && words.length > 0 ? words : undefined
}

/**
 * The review message for a step about to begin: Boris's three lines for it, its premises with the lattice's status,
 * and the ask: the questions whose answers would change the step go to the person first, before any tool call.
 */
export const reviewText = (item: PlanItem, premises: readonly Claim[]): string => {
  const status = stepStatus(premises)
  const facts = premises.length === 0 ? '  (none written: name the facts this step rests on, each with its source)' : premises.map(claim => `  ${GLYPH[claim.status]} ${claim.says} (${claimLabel(claim)})`).join('\n')
  return [
    `REVIEW before step "${item.name}" (from Victrix, the plan lens). The previous step is done; the person wants to preview the next one before it starts.`,
    `Preview it in three lines: what this step does${item.note ? ` (${item.note})` : ''}, how much effort it deserves, and how its result will be verified${item.judge ? ` (verify: ${item.judge})` : ''}${item.slow ? ` against the slow version (${item.slow})` : ''}.`,
    `It rests on these premises, status = ⊓ {${premises.map(claim => GLYPH[claim.status]).join(' ') || '∅'}} = ${GLYPH[status]} ${status}:`,
    facts,
    item.guard ? `Guard: ${item.guard}.` : 'No guard is written: say what the fast path checks and what it costs, or that none is needed.',
    item.options.length > 0 ? `Options worth 2× still open: ${item.options.join('; ')}.` : '',
    'Then ask the person the questions whose answers would change this step (at most three, with AskUserQuestion), and wait for the answers before any tool call. If nothing would change it, say so in one line and begin.',
  ]
    .filter(Boolean)
    .join('\n')
}

/** The drift message: the plan has not moved while the work did; Claude is asked to make the plan true again. */
export const driftText = (step: string, calls: number): string =>
  [
    `DRIFT (from Victrix, the plan lens): ${calls} tool calls on step "${step}" and the plan file has not changed since.`,
    'Make the plan true again before going on: if this work is a step the plan does not name, add it with its facts and verify line; if steps are done, mark them [x]; if the work left the plan, say why in one line to the person.',
    'Then continue.',
  ].join('\n')

// Helpers that take `$` are function declarations: the engine follows `$` only into declarations.
async function checkDrift($: Dollar) {
  const spent = await read($, activity)
  const step = spent.stepNow
  if (step === null || driftNudged === step) return
  const calls = spent.steps[step]?.calls ?? 0
  if (calls - callsAtPlanEdit < DRIFT_CALLS) return
  driftNudged = step
  await noteChange($, `drift ⋅ ${step} ⋅ ${calls} calls, plan untouched`)
  void $.prompt.submit({ text: driftText(step, calls) })
}

async function sendReview($: Dollar) {
  const item = reviewFor
  reviewFor = undefined
  if (!isReview || item === undefined) return
  const premises = factsOf(item, await read($, claims))
  await noteChange($, `review ⋅ ${item.name} ⋅ ${premises.length} premises ⋅ ${GLYPH[stepStatus(premises)]}`)
  void $.prompt.submit({ text: reviewText(item, premises) })
}

async function verifyStep($: Dollar, item: PlanItem) {
  const argv = item.judge ? argvOf(item.judge) : undefined
  if (argv === undefined) return
  const answer = await runVerify($, item.name, `verify: ${item.judge}`, argv, await read($, cwd))
  $.ui.log(`victrix: verified ${item.name}: ${answer.split('\n')[0] ?? ''}`, { to: 'debug' })
}

/** The person accepts a Lean claim's English: the one thing that lifts it from checked to proved (sound build, standard axioms, no cheat). */
async function acceptEnglish($: Dollar, claim: Claim) {
  if (claim.evidence === undefined || claim.evidence.kind !== 'lean') return
  const lifted = proved(claim, claim.evidence, true, Date.now())
  await update($, claims, all => all.map(one => (sameClaim(one, claim) ? lifted : one)))
  await noteChange($, `${GLYPH[lifted.status]} ${lifted.says} ⋅ ${lifted.status === 'proved' ? 'English accepted by you' : 'English accepted, but the build is not sound'}`)
}

async function record($: Dollar, event: ActivityEvent) {
  await update($, activity, state => reduceActivity(state, event))
}

async function noteChange($: Dollar, line: string) {
  await update($, changed, lines => [`${clock(Date.now())} ${line}`, ...lines].slice(0, CHANGED_KEPT))
}

/**
 * Who asked for the plan to be read: the person, the engine's plan-mode note, this session's own edit, the start,
 * or the watch at each turn's end that catches a change by any other hand (another session, the person, a script).
 */
type PlanSource = 'person' | 'note' | 'edit' | 'start' | 'watch'

// A plan file that cannot be read never replaces the plan being followed: a resumed session is handed a fresh plan
// name by the engine before any plan is written there, and following it would empty the map and log every step as
// removed. With nothing followed yet, the unreadable path is drawn as such, never hidden; the reason goes to the log.
async function loadPlan($: Dollar, path: string, source: PlanSource) {
  const followed = await read($, plan)
  const before = followed?.tree ?? null
  const tree = await $.fs.read(path).then(
    text => parsePlan(text),
    error => {
      $.ui.log(`victrix: plan unreadable ${path}: ${errorText(error)}`, { to: 'debug' })
      return null
    },
  )
  if (tree === null && before !== null) return
  const isSwitch = before !== null && tree !== null && followed?.path !== path && tree.title !== before.title
  // The ledger compares two plans that read. A switch to another plan is one line, never a step-removed line per
  // item; a change that arrived by any hand but this session's own says so.
  const lines = isSwitch ? [`following ⋅ ${tree?.title ?? path}`] : diffPlans(before, tree)
  const outside = !isSwitch && before !== null && lines.length > 0 && (source === 'watch' || source === 'note')
  // The watch re-reads the same file: an unchanged plan is no event, so the drift count and the lit clock stand.
  if (source === 'watch' && lines.length === 0) return
  await update($, plan, () => ({ path, tree }))
  const nowName = tree ? (nowItem(tree)?.name ?? null) : null
  const spentNow = await read($, activity)
  const wasName = spentNow.stepNow
  // The plan was just read or edited: drift counts from here, and a nudged step may be nudged again later.
  callsAtPlanEdit = nowName !== null && nowName === wasName ? (spentNow.steps[nowName]?.calls ?? 0) : 0
  driftNudged = undefined
  await record($, { kind: 'step-enter', name: nowName, at: Date.now() })
  if (nowName !== null && nowName !== wasName) {
    litFrom = wasName ?? undefined
    await flashOnce($)
  }
  await $.store.set(planPathKey(await read($, cwd)), path)
  for (const line of lines) await noteChange($, outside ? `${line} ⋅ outside this session` : line)
  // A step that just flipped to done, whose verify line is a command, is checked by the mod itself: never blocking, the result lands as a claim.
  if (before !== null && tree !== null && !isSwitch) {
    const finished = newlyDone(before, tree)
    for (const item of finished) void verifyStep($, item)
    // A chunk boundary: something finished and the light moved on; the next step is reviewed with the person first.
    const next = nowItem(tree)
    if (finished.length > 0 && next !== undefined && next.name !== wasName) reviewFor = next
  }
  await raiseQuestions($, tree)
  $.ui.log(`victrix: plan read ${path}`, { to: 'debug' })
}

// A new `claude:` fact or a 2× option under the step being worked becomes one question for the person, asked once per repo.
async function raiseQuestions($: Dollar, tree: PlanTree | null) {
  const now = tree ? nowItem(tree) : undefined
  if (!now) return
  const dir = await read($, cwd)
  const stored = await $.store.get(askedKey(dir))
  const asked = new Set(Array.isArray(stored) ? stored.filter((one): one is string => typeof one === 'string') : [])
  const fresh: Question[] = [
    ...now.facts.filter(fact => fact.source === 'claude').map(fact => ({ kind: 'feel' as const, step: now.name, says: fact.text, at: Date.now() })),
    ...now.options.map(option => ({ kind: 'build' as const, step: now.name, says: option, at: Date.now() })),
  ].filter(question => !asked.has(`${question.kind}|${question.step}|${question.says}`))
  if (fresh.length === 0) return
  await update($, questions, queue => [...queue, ...fresh.filter(one => !queue.some(q => q.kind === one.kind && q.step === one.step && q.says === one.says))])
}

async function markAsked($: Dollar, question: Question) {
  const dir = await read($, cwd)
  const stored = await $.store.get(askedKey(dir))
  const asked = Array.isArray(stored) ? stored.filter((one): one is string => typeof one === 'string') : []
  await $.store.set(askedKey(dir), [...asked, `${question.kind}|${question.step}|${question.says}`].slice(-200))
  await update($, questions, queue => queue.filter(one => !(one.kind === question.kind && one.step === question.step && one.says === question.says)))
}

// Offered only while no plan is followed: the newest plan files, by their own titles.
async function findRecent($: Dollar): Promise<RecentPlan[]> {
  const home = await $.env.get('HOME')
  if (home === undefined) return []
  const dir = `${home}/.claude/plans`
  const entries = await $.fs.list(dir).catch(error => {
    $.ui.log(`victrix: no plans folder ${dir}: ${errorText(error)}`, { to: 'debug' })
    return []
  })
  const newest = entries
    .filter(entry => entry.kind === 'file' && isPlanFile(`${dir}/${entry.name}`))
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, RECENT_KEPT)

  return Promise.all(
    newest.map(async entry => {
      const path = `${dir}/${entry.name}`
      const text = await $.fs.read(path).catch(() => '')
      return { path, title: parsePlan(text).title ?? entry.name, mtimeMs: entry.mtimeMs }
    }),
  )
}

async function refreshRecent($: Dollar) {
  const found = await findRecent($)
  await update($, recent, () => found)
}

/** The form the moment calls for, from the state the hooks keep. */
async function currentForm($: Dollar): Promise<Form> {
  const columns = await read($, viewportColumns)
  return chooseForm({
    choice: await read($, formChoice),
    isPlanMode: await read($, isPlanMode),
    isDialogUp: await read($, isDialogUp),
    canDock: columns === 0 || columns >= DOCK_MIN_COLUMNS,
  })
}

// One instrument, one form at a time: the dock opens at the form's width, or closes so the tape can draw.
async function reconcileForm($: Dollar, how: 'asked' | 'unasked') {
  if (how === 'unasked' && (await $.store.get(hiddenKey(await read($, cwd)))) === true) return
  const form = await currentForm($)
  if (form === 'tape') {
    if (await read($, isPlaced)) await $.ui.close({ id: PANE })
    await update($, isPlaced, () => false)
    return
  }
  // The terminal's width is known only once `/victrix` has run (the session start carries none); until then the
  // map asks for no width and takes the engine's own share, instead of the 24-column floor a width of 0 would give.
  const viewport = await read($, viewportColumns)
  const columns = viewport === 0 && form === 'third' ? undefined : dockColumns(form, viewport)
  const args = { id: PANE, title: TITLE, ...(columns === undefined ? {} : { columns }), ...(how === 'asked' ? { focus: true as const } : {}) }
  // The width is a request: where the person has dragged the dock, the engine keeps that width over it.
  const opened = await $.ui.open(args)
  await update($, isPlaced, () => opened.isPlaced)
  $.ui.log(`victrix: ${form} (${how}, ${columns ?? 'share'} cols): ${opened.isPlaced ? 'placed' : opened.reason}`, { to: 'debug' })
}

// The ledger: one line per pressed verb, per repo, newest last, capped (see notes.ts).
async function logNote($: Dollar, note: Note) {
  const key = logKey(await read($, cwd))
  const current = await $.store.get(key)
  const log = Array.isArray(current) ? current.filter((line): line is string => typeof line === 'string') : []
  await $.store.set(key, appendLog(log, logLine(note)))
}

// Delivers what is queued: now, as a prompt of Vada's, when the session is idle; the hook on
// prompt.submit attaches it to the person's next prompt otherwise.
async function deliverNotes($: Dollar) {
  const queued = await read($, notes)
  if (queued.length === 0) return
  await update($, notes, () => [])
  await record($, { kind: 'said', text: queued.map(describeNote).join(' ⋅ '), by: 'you' })
  void $.prompt.submit({ text: deliveryText(queued) })
  $.ui.log(`victrix: delivered ${queued.length} note(s) as a prompt`, { to: 'debug' })
}

// A pressed verb: logged at once, delivered at Claude's next step, told to the person in one toast.
async function pressVerb($: Dollar, kind: NoteKind, step: string, says?: string) {
  if (kind === 'add') {
    await update($, pendingAdd, () => step)
    $.ui.toast(`add a fact ⋅ ${step}: type it in the prompt; Claude reads it at its next step`)
    return
  }
  const note: Note = { kind, step, text: says ?? '', at: Date.now() }
  await update($, notes, queued => [...queued, note])
  await logNote($, note)
  await noteChange($, `${describeNote(note)}`)
  if (kind === 'doubt' && says !== undefined) {
    await update($, claims, list => {
      const doubted: Claim = { step, says, status: 'open', source: 'doubt', at: Date.now() }
      return list.some(claim => sameClaim(claim, doubted)) ? list.map(claim => (sameClaim(claim, doubted) ? doubted : claim)) : [...list, doubted]
    })
  }
  const working = await read($, isWorking)
  if (working) $.ui.toast(`${describeNote(note)} ⋅ Claude sees it at its next step`)
  else {
    $.ui.toast(`${describeNote(note)} ⋅ sent to Claude`)
    await deliverNotes($)
  }
}

// An answer to a gut check: yes keeps the fact assumed with the person as its source, no doubts it, not sure marks it.
async function answerQuestion($: Dollar, question: Question, answer: 'yes' | 'no' | 'unsure') {
  await markAsked($, question)
  if (question.kind === 'build') {
    if (answer === 'yes') await pressVerb($, 'add', question.step)
    await update($, pendingAdd, () => null)
    if (answer === 'yes') {
      const note: Note = { kind: 'add', step: question.step, text: `build and measure this option: ${question.says}`, at: Date.now() }
      await update($, notes, queued => [...queued, note])
      await logNote($, note)
      await noteChange($, `build it ⋅ ${question.says}`)
      if (!(await read($, isWorking))) await deliverNotes($)
    } else await noteChange($, `${answer === 'no' ? 'declined' : 'not sure about'} ⋅ ${question.says}`)
    return
  }
  const claim: Claim = { step: question.step, says: question.says, status: 'open', source: answer === 'yes' ? 'you' : answer === 'no' ? 'doubt' : 'claude', at: Date.now() }
  await update($, claims, list => (list.some(one => sameClaim(one, claim)) ? list.map(one => (sameClaim(one, claim) ? claim : one)) : [...list, claim]))
  if (answer === 'no') await pressVerb($, 'doubt', question.step, question.says)
  else await noteChange($, `${answer === 'yes' ? 'you said so' : 'you were not sure'} ⋅ ${question.says}`)
}

const resolvePath = (dir: string, path: string) => (path.startsWith('/') ? path : `${dir}/${path}`)

const clamp = (at: number, length: number) => Math.max(0, Math.min(at, length - 1))

const ago = (sinceMs: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - sinceMs) / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

type Colour = 'yellow' | 'green' | 'red' | undefined

/** The label column of every labelled row, in cells: `because `, `verify  `, `10:48   `. */
const LABEL = 9

/** Cells of a step's call tally bar on the trunk; past that many calls the number beside it carries the count. */
const TALLY_CELLS = 8

/** The plain-English twin of the maths line, short enough for the right end of a row. */
const MEANING_SHORT: Readonly<Record<Status, string>> = {
  broken: 'a premise fails',
  open: 'never above its weakest premise',
  checked: 'every premise checked',
  proved: 'every premise proved',
}

type NowLine = { readonly label: string; readonly text: string; readonly right: string }

/** The `now` zone's lines for the lit step: because, guard, each option, verify, slow; the verify's right end comes from the ledger. */
const nowDetailLines = (item: PlanItem, ledgerClaims: readonly Claim[]): NowLine[] => {
  const ran = ledgerClaims.filter(claim => claim.source === 'tool' || claim.source === 'lean')
  const verifyRight = ran.some(claim => claim.status === 'broken') ? '✗ failed' : ran.length > 0 ? `■ ran ${ran.length}` : 'not yet'
  return [
    ...(item.why ? [{ label: 'because', text: item.why, right: '' }] : []),
    ...(item.guard ? [{ label: 'guard', text: item.guard, right: '' }] : []),
    ...item.options.slice(0, 2).map(option => ({ label: 'option', text: option, right: 'not built' })),
    ...(item.judge ? [{ label: 'verify', text: item.judge, right: verifyRight }] : []),
    ...(item.slow ? [{ label: 'slow', text: item.slow, right: 'the spec' }] : []),
  ]
}

/** A card key back to its step and, for a fact row, the fact's index under that step. */
const parseCardKey = (key: string): { readonly step: string; readonly fact?: number } | null => {
  if (key.startsWith('s:')) return { step: key.slice(2) }
  const fact = /^f:(.*):(\d+)$/.exec(key)
  if (fact && fact[1] !== undefined && fact[2] !== undefined) return { step: fact[1], fact: Number(fact[2]) }
  return null
}

/** The three colours: orange for Claude (ANSI yellow), green for good, red for worried and broken; nothing else. */
const colourOf = (row: MapRow): Colour => {
  if (row.mark === 'now') return 'yellow'
  if (row.kind === 'fact') return row.status === 'broken' || row.status === 'open' ? 'red' : 'green'
  if (row.mark === 'done') return 'green'
  return undefined
}

/**
 * The face: `[-_-]` by default, `[o_o]` while a call runs, `[o_O]` only when something needs you or broke. While a
 * call runs the face breathes between the two at 0.2 Hz (2.5 s open, 2.5 s closed on the 125 ms tick), nothing faster.
 */
const BREATH_TICKS = 20
const faceOf = (isCalling: boolean, isWorried: boolean, tickNow = 0) =>
  draw.face(isWorried ? 'worried' : isCalling && (!isMotion || Math.floor(tickNow / BREATH_TICKS) % 2 === 0) ? 'working' : 'idle')

let ticker: { cancel: () => void } | undefined

// The spinner's clock, terminal only; a host without a clock (the test kit) leaves the glyph still.
// Alive while a turn runs: the clock on the lit step and the breathing face move once a second between calls, the
// spinner at TICK_MS during a call; nothing ticks while Claude is idle, so nothing moves while you type.
const SLOW_MS = 1000
let tickerMs = 0
async function startTicker($: Dollar, ms: number) {
  if (!isMotion || (await read($, surface)) !== 'terminal') return
  if (ticker !== undefined && tickerMs === ms) return
  ticker?.cancel()
  ticker = undefined
  try {
    tickerMs = ms
    ticker = $.clock.every(ms, () => {
      void update($, tick, value => value + 1)
    })
  } catch (error) {
    $.ui.log(`victrix: no clock for the spinner: ${errorText(error)}`, { to: 'debug' })
  }
}

// The arrival flash: when the lit step changes, the pane redraws four times over half a second so the new row's
// brightening (one abrupt onset, then normal) is seen even while no call runs; then it stops, as the cockpit rule says.
const FLASH_MS = 500
let flasher: { cancel: () => void } | undefined
async function flashOnce($: Dollar) {
  if (!isMotion || flasher !== undefined || (await read($, surface)) !== 'terminal') return
  try {
    let left = Math.ceil(FLASH_MS / TICK_MS)
    flasher = $.clock.every(TICK_MS, () => {
      void update($, tick, value => value + 1)
      left -= 1
      if (left <= 0) {
        flasher?.cancel()
        flasher = undefined
      }
    })
  } catch (error) {
    $.ui.log(`victrix: no clock for the flash: ${errorText(error)}`, { to: 'debug' })
  }
}

const stopTicker = () => {
  ticker?.cancel()
  ticker = undefined
  tickerMs = 0
}

// The motion switch (`motion: false` in /config): every fact stays, the spinner, the flash and the breathing stop.
let isMotion = true

// The review checkpoint (`review: false` in /config turns it off): when a step flips to done and a next step exists,
// the end of that turn sends Claude one message previewing the next step in Boris's three lines, with its premises
// and their lattice status, and asks it to put the questions that would change the step to the person first.
let isReview = true
let reviewFor: PlanItem | undefined

// Drift: the lit step keeps taking calls while the plan file is never touched, so the plan has stopped being the
// truth. After DRIFT_CALLS calls since the last plan edit, one ledger line and one message per step ask Claude to
// name the step this work belongs to, mark what is done, or add the missing step. Never a block.
const DRIFT_CALLS = 25
let callsAtPlanEdit = 0
let driftNudged: string | undefined

/** The row index the light sits on while it travels (`litFrom` → the lit row) for FLASH_MS after a step change. */
let litFrom: string | undefined

export const registerLens = (on: On, motion = true, review = true) => {
  isMotion = motion
  isReview = review
  on('session.start', async ($, e, next) => {
    await update($, cwd, () => e.cwd)
    await update($, surface, () => e.surface)
    const choice = await $.store.get(FORM_KEY)
    if (choice === 'tape' || choice === 'third' || choice === 'strip' || choice === 'auto') await update($, formChoice, () => choice)
    const kept = await $.store.get(COLUMNS_KEY).catch(() => undefined)
    if (typeof kept === 'number' && kept > 0) await update($, viewportColumns, value => (value === 0 ? kept : value))
    await $.command.register({
      name: 'victrix',
      description: 'Open the instrument: the plan as Claude works it, what it leans on, what needs you',
      argumentHint: '[plan file]',
    })
    const saved = await $.store.get(planPathKey(e.cwd))
    if (typeof saved === 'string') await loadPlan($, saved, 'start')
    if ((await read($, plan)) === null) await refreshRecent($)
    await reconcileForm($, 'unasked')

    return next(e)
  })

  on('command.run', { command: 'victrix' }, async ($, e) => {
    const dir = await read($, cwd)
    const named = e.args.trim()
    const current = await read($, plan)
    if (named !== '') await loadPlan($, resolvePath(dir, named), 'person')
    else if (current) await loadPlan($, current.path, 'person')
    else await refreshRecent($)
    await $.store.delete(hiddenKey(dir))
    await update($, viewportColumns, value => (value === 0 ? e.presentation.columns : value))
    // The one moment the engine tells the mod the terminal's width: kept per machine so later sessions ask for a quarter at once.
    if (e.presentation.columns > 0) await $.store.set(COLUMNS_KEY, e.presentation.columns).catch(() => undefined)
    // Too narrow for a dock: a pane asked for here would be seated inline, framed, above the prompt. The small form
    // is the band's one row instead, which draws while no pane of ours is placed.
    if (e.presentation.columns > 0 && e.presentation.columns < DOCK_MIN_COLUMNS) {
      if (await read($, isPlaced)) await $.ui.close({ id: PANE })
      await update($, isPlaced, () => false)
      return { text: 'Victrix: the row above the prompt; the map docks from 110 columns.' }
    }
    await reconcileForm($, 'asked')

    return { text: 'Victrix opened.' }
  })

  // A person's close (its mark or key) keeps the dock hidden across sessions until /victrix.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      await $.store.set(hiddenKey(await read($, cwd)), true)
      await update($, isPlaced, () => false)
    }
    return next(e)
  })

  // The engine names this session's own plan file in its plan-mode notes; a helper's notes are its own.
  // Total: the note passes on whatever the plan read or the dock did, so the hooks beneath (the push) always run.
  on('prompt.attachment', { type: ['plan_mode', 'plan_mode_exit', 'plan_mode_reentry'] }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    try {
      const path = 'detail' in e ? e.detail?.planFilePath : undefined
      const current = await read($, plan)
      if (path !== undefined && path !== current?.path) await loadPlan($, path, 'note')
      const inPlanMode = e.type !== 'plan_mode_exit'
      if (inPlanMode !== (await read($, isPlanMode))) {
        await update($, isPlanMode, () => inPlanMode)
        await reconcileForm($, 'unasked')
      }
    } catch (error) {
      $.ui.log(`victrix: plan note not followed: ${errorText(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  // The footer's mode labels say when plan mode is on; the hook reads them and passes the row on untouched.
  // The person's prompt carries the queued notes as context the model reads beside it; a typed
  // fact after `a` becomes that step's add-data note. Vada's own delivery prompts pass untouched.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' || e.command !== undefined) return next(e)
    const step = await read($, pendingAdd)
    const typed = e.text.trim()
    const added: Note[] = step !== null && typed !== '' ? [{ kind: 'add', step, text: typed, at: Date.now() }] : []
    for (const note of added) {
      await logNote($, note)
      await noteChange($, `you added ⋅ ${typed}`)
      await update($, claims, list => [...list, { step, says: typed, status: 'open', source: 'you', at: Date.now() } as Claim])
    }
    const queued = [...(await read($, notes)), ...added]
    if (step !== null) await update($, pendingAdd, () => null)
    if (queued.length === 0) return next(e)
    await update($, notes, () => [])
    $.ui.log(`victrix: attached ${queued.length} note(s) to the prompt`, { to: 'debug' })

    return next({ ...e, context: [...(e.context ?? []), deliveryText(queued)] })
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, isWorking, () => true)
      await record($, { kind: 'turn-start' })
      await startTicker($, SLOW_MS)
    }
    return next(e)
  })

  // A helper's turn carries agentId; only the main loop's end is a step Claude finished.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, isWorking, () => false)
      await record($, { kind: 'turn-end' })
      stopTicker()
      const spent = await read($, activity)
      await update($, stepTokens, list => [...list, spent.turnIn + spent.turnOut].slice(-24))
      const usage = await $.session.usage().catch(() => undefined)
      if (usage?.context.percent !== undefined) {
        const percent = usage.context.percent ?? 0
        await update($, contextPercent, () => percent)
        await update($, ctxHistory, list => [...list, percent].slice(-24))
      }
      // The watch: the followed file re-read once per turn, so a change by another session or the person's editor
      // lands in the ledger marked as such, and a step they finished is verified and reviewed like any other.
      const followed = await read($, plan)
      if (followed !== null) await loadPlan($, followed.path, 'watch')
      await deliverNotes($)
      await sendReview($)
      await checkDrift($)
    }
    return next(e)
  })

  // Every request's tokens count, the helpers' too: that is what the session spent. The main loop's thinking
  // chunks are kept as Claude's own words for the log, labelled as such, never read as a fact.
  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    const stream = next(e)
    for await (const chunk of stream) {
      if (isMain && chunk.kind === 'thinking' && typeof chunk.text === 'string' && chunk.text !== '') await record($, { kind: 'said', text: chunk.text })
      yield chunk
    }
    const result = await stream.result
    if (result.usage) await record($, { kind: 'usage', usage: result.usage })
    return result
  })

  // Observes only: the call runs as it would, and its result comes back unchanged.
  on('tool.call', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const input: Readonly<Record<string, unknown>> = { ...e }
    const text = describeCall(e.tool, input)
    const isDialog = isMain && (e.tool === 'ExitPlanMode' || e.tool === 'AskUserQuestion')
    const startedAt = Date.now()
    if (isMain) {
      await record($, { kind: 'call-start', text, at: startedAt })
      await startTicker($, TICK_MS)
    }
    if (isDialog) {
      const askedNow = Array.isArray(input.questions) ? input.questions.map(q => (q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string' ? (q as { question: string }).question : '')).filter(Boolean) : []
      await update($, asking, () => (e.tool === 'ExitPlanMode' ? ['the plan is up for your approval'] : askedNow))
      await update($, isDialogUp, () => true)
      await reconcileForm($, 'unasked')
    }
    const result = await next(e)
    const isOk = result.deny === undefined && result.isError !== true
    if (isMain) {
      await record($, { kind: 'call-end', text, isOk, at: startedAt, ms: Date.now() - startedAt })
      // Back to the slow tick between calls: the turn is still running.
      await startTicker($, SLOW_MS)
    }
    if (isDialog) {
      await update($, asking, () => [])
      await update($, isDialogUp, () => false)
      await reconcileForm($, 'unasked')
    }
    const path = typeof input.file_path === 'string' ? input.file_path : undefined
    const isPlanWrite = (e.tool === 'Edit' || e.tool === 'Write') && path !== undefined && isPlanFile(path)
    if (isMain && isOk && isPlanWrite) await loadPlan($, path, 'edit')

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Drawing is pure: the engine refuses any state write while a render hook runs (the whole hook is skipped and
    // nothing draws), so the viewport width is seeded at session start and read here, never written here.
    // Seated inline (the terminal too narrow for a dock), the pane is the small form: the one row, nothing else.
    if (e.props.placement === 'inline') return drawTape($, e, Math.max(20, e.props.bodyColumns))
    const { Box, Button, Text } = $.ui.resolve(e)
    const form = await currentForm($)
    const view = await read($, plan)
    const tree = view?.tree ?? null
    const offered = view ? [] : await read($, recent)
    const spent = await read($, activity)
    const queued = await read($, notes)
    const waitingAdd = await read($, pendingAdd)
    const allClaims = await read($, claims)
    const askingNow = await read($, asking)
    const pending = await read($, questions)
    const ledger = await read($, changed)
    const tickNow = await read($, tick)
    const opened = await read($, openedCard)
    const ctx = await read($, contextPercent)
    const tokens = await read($, stepTokens)
    const ctxTurns = await read($, ctxHistory)
    const choice = await read($, formChoice)
    const isFocused = e.props.isFocused
    const room = Math.max(12, e.props.bodyColumns)
    const height = Math.max(6, e.props.scroll.bodyRows)
    const nowStep = tree ? nowItem(tree) : undefined
    const now = Date.now()

    const facts = (step: string) => allClaims.filter(claim => claim.step === step)
    const isCalling = spent.doing !== null && spent.doing !== 'thinking'
    const hasBroken = allClaims.some(claim => claim.status === 'broken') || (spent.last[0] !== undefined && !spent.last[0].isOk)
    const needsYou = askingNow.length > 0 || pending.length > 0 || queued.length > 0 || waitingAdd !== null
    // The face breathes through the whole turn (thinking between calls too), not only while a call runs.
    const face = faceOf(isCalling || (await read($, isWorking)), hasBroken || needsYou, tickNow)
    const allItems = tree ? tree.sections.flatMap(section => section.items) : []
    const counted = allItems.filter(item => !item.isAbandoned)
    const doneCount = counted.filter(item => item.isDone).length
    const tally = tree ? `${doneCount}/${counted.length}` : ''
    // Every premise in the plan, with the ledger's status: the plan's own meet is the weakest of them all (T1 over steps).
    const premisesAll = allItems.filter(item => !item.isDone && !item.isAbandoned).flatMap(item => factsOf(item, allClaims))
    const premiseCounts = {
      checked: premisesAll.filter(claim => claim.status === 'checked' || claim.status === 'proved').length,
      open: premisesAll.filter(claim => claim.status === 'open').length,
      broken: premisesAll.filter(claim => claim.status === 'broken').length,
    }
    const planMeet = stepStatus(premisesAll)
    const nowFacts = nowStep ? factsOf(nowStep, allClaims) : []
    const nowStatus = stepStatus(nowFacts)
    const nowSpend = nowStep ? spent.steps[nowStep.name] : undefined
    const nowClock = nowStep ? draw.clock(timeOn(spent, nowStep.name, now)) : ''

    const moveTo = (index: number) => update($, cursor, () => clamp(index, rows.length + offered.length))
    const follow = (path: string) => loadPlan($, path, 'person')
    const toggleCard = (key: string) => update($, openedCard, current => (current === key ? null : key))
    const cycleForm = async () => {
      const nextOne = nextChoice(choice)
      await update($, formChoice, () => nextOne)
      await $.store.set(FORM_KEY, nextOne)
      await reconcileForm($, 'asked')
    }
    const hide = async () => {
      await $.store.set(hiddenKey(await read($, cwd)), true)
      await $.ui.close({ id: PANE })
    }
    const verbOn = (kind: NoteKind) => async () => {
      const row = rows[at]
      const step = row?.step || nowStep?.name
      if (!step) {
        $.ui.toast('no plan step to press this on yet')
        return
      }
      await pressVerb($, kind, step, row?.kind === 'fact' ? row.text : undefined)
    }
    const copy = async (press: { surface: Parameters<typeof $.ui.copy>[0]['surface'] }) => {
      const item = selectedStep ?? nowStep
      if (!item) return
      const text = [item.name, item.note, item.why && `because: ${item.why}`, item.judge && `verify: ${item.judge}`].filter(Boolean).join(' — ')
      const copied = await $.ui.copy({ text, surface: press.surface })
      $.ui.toast(copied.isCopied ? `copied: ${draw.fit(item.name, 40)}` : `could not copy: ${copied.reason}`)
    }
    const help = () => toggleCard('help')
    // The check tool's per-repo switch: off, only known test invocations and scripts under demo/test run.
    const repoDir = await read($, cwd)
    const allowAny = (await $.store.get(`victrix.allowAny:${repoDir}`)) === true
    const toggleAllowAny = async () => {
      await $.store.set(`victrix.allowAny:${repoDir}`, !allowAny)
      $.ui.toast(allowAny ? 'check: back to the allowlist' : 'check: any command may run in this repo')
      await update($, tick, value => value + 1)
    }
    const key = (letter: string) => (isFocused ? { hotkey: letter } : {})

    // A zone rule: `─ now ──────`, dim, the one word that names what follows.
    const zone = (label: string) => <Text key={`zone:${label}`} dimColor>{draw.rule(label, room)}</Text>
    // A labelled row: two-space indent, a label column of LABEL cells, the words cut to fit, the right end dim and right-aligned.
    const labelled = (keyName: string, label: string, text: string, right = '', colour: Colour = undefined, isDim = true) => {
      const head = `  ${draw.pad(label, LABEL)}`
      const rightCut = draw.fit(right, Math.max(0, Math.floor(room * 0.4)))
      const words = draw.fit(text, Math.max(1, room - draw.cells(head) - (rightCut ? draw.cells(rightCut) + 2 : 0)))
      const gap = ' '.repeat(Math.max(0, room - draw.cells(head) - draw.cells(words) - draw.cells(rightCut) - (rightCut ? 2 : 0)))
      return (
        <Box key={keyName} flexDirection="row">
          <Text dimColor>{head}</Text>
          <Text color={colour} dimColor={isDim && colour === undefined}>{words}</Text>
          <Text dimColor>{rightCut ? `${gap}  ${rightCut}` : ''}</Text>
        </Box>
      )
    }

    // Row budget by zone: header 1, tree, now (rule + lines + maths), you (rule + 2), did (rule + log), gauges (rule + 3), keys 1.
    const nowLines = nowStep ? nowDetailLines(nowStep, facts(nowStep.name)) : []
    const nowCap = height >= 34 ? 5 : height >= 28 ? 3 : height >= 22 ? 1 : 0
    const nowShown = nowLines.slice(0, nowCap)
    const nowZoneRows = nowStep && nowCap > 0 ? 2 + nowShown.length : 0
    let cardRows = 0
    const card = buildCard()
    const middleRows = card ? cardRows : nowZoneRows + 3
    const fixedRows = 1 + middleRows + 1 + 4 + 1
    const treeAndLog = Math.max(3, height - fixedRows)
    const budget = Math.max(3, treeAndLog - 2)
    const fitted = tree ? fitRows({ rows: form === 'strip' ? 9999 : budget, tree, claims: allClaims, cursorKey: undefined }) : { level: 0 as const, rows: [], isOverflowing: false }
    const rows = fitted.rows
    const rawAt = await read($, cursor)
    const nowIndex = rows.findIndex(row => row.isNow && row.kind === 'step')
    const at = rawAt < 0 ? clamp(Math.max(0, nowIndex), rows.length + offered.length) : clamp(rawAt, rows.length + offered.length)
    const selected = rows[at]
    const selectedStep = tree && selected ? itemNamed(tree, selected.step) : undefined

    // One row of the trunk: prefix dim, glyph coloured, the words, then the right end dim; never wider than the room.
    const trunkRow = (row: MapRow, index: number) => {
      const isLit = row.isNow && row.kind === 'step'
      // The trunk touches the lit step's bracket (`├─[◉ 14m]`) as it touches the face's; other rows keep the space.
      const prefix = isLit ? draw.trunk(row.trunk).replace(/ $/, '─') : draw.trunk(row.trunk)
      // The light travels: for FLASH_MS after a step change the bright row is the one the light has reached on its way
      // from the step it left to the lit one; then it rests on the lit step and the brightening ends.
      const elapsed = nowSpend !== undefined && nowSpend.enteredAt > 0 ? now - nowSpend.enteredAt : Number.MAX_SAFE_INTEGER
      const isFresh = isMotion && row.kind === 'step' && elapsed < FLASH_MS && index === draw.litIndex(litFrom === undefined ? undefined : rows.findIndex(one => one.kind === 'step' && one.step === litFrom), nowIndex, elapsed, FLASH_MS)
      // Time at the heart of the step (owner): the lit row carries its clock inside the bracket, yellow until done; a
      // done row carries the time it took, green, beside its check; the trunk touches the bracket as it touches the face.
      const doneMs = row.kind === 'step' && row.mark === 'done' ? (spent.steps[row.step]?.ms ?? 0) : 0
      const doneTime = doneMs > 0 ? ` ${draw.clock(doneMs)}` : ''
      const glyph = row.glyph === '' ? '' : isLit ? `[${row.glyph} ${nowClock}]` : `${row.glyph}${doneTime}`
      const head = `${prefix}${glyph}${glyph ? ' ' : ''}`
      // Every step that spent anything carries its call tally on the right: one cell per call, red for a failure,
      // `╸` for the call running now; the lit step adds its clock. A step's bar never "completes": it is what it cost.
      const spend = row.kind === 'step' ? spent.steps[row.step] : undefined
      const tallyBar = spend && spend.calls > 0 ? draw.tally(spend.calls, spend.fails, TALLY_CELLS, isLit && isCalling) : undefined
      const right = isLit ? (nowSpend && nowSpend.calls > 0 ? `${nowSpend.calls}` : '') : row.kind === 'fact' && row.status === 'broken' ? (facts(row.step).find(claim => claim.says === row.text)?.counterexample ?? row.right) : spend && spend.calls > 0 ? String(spend.calls) : row.right
      const rightCut = draw.fit(right, Math.max(0, Math.floor(room / 3)))
      const tallyWidth = tallyBar ? TALLY_CELLS + 1 : 0
      const textRoom = Math.max(1, room - draw.cells(head) - tallyWidth - (rightCut ? draw.cells(rightCut) + 2 : 0))
      const words = draw.fit(row.text, textRoom)
      const gap = ' '.repeat(Math.max(0, room - draw.cells(head) - draw.cells(words) - tallyWidth - draw.cells(rightCut) - (rightCut ? 2 : 0)))
      const colour = colourOf(row)
      const isSelected = isFocused && index === at
      const factDim = row.kind === 'fact' && row.status === 'open'
      return (
        <Button key={row.key} plain onPress={() => (row.kind === 'fact' || row.kind === 'step' ? toggleCard(row.key) : moveTo(index))}>
          <Text dimColor>{prefix}</Text>
          <Text color={factDim ? undefined : colour} dimColor={factDim} bold={isLit} inverse={isSelected || isFresh}>{glyph}{glyph ? ' ' : ''}</Text>
          <Text color={row.kind === 'fact' && !factDim ? colour : isLit ? 'yellow' : undefined} dimColor={factDim || row.kind === 'chips' || row.kind === 'title' || row.mark === 'done' || row.mark === 'abandoned'} bold={isLit} inverse={isSelected || isFresh}>{words}</Text>
          <Text dimColor>{gap}</Text>
          {tallyBar ? <Text color={isLit ? 'yellow' : 'green'} dimColor={!isLit}>{tallyBar.ok}</Text> : null}
          {tallyBar ? <Text color="red">{tallyBar.bad}</Text> : null}
          {tallyBar ? <Text color="yellow">{tallyBar.running}</Text> : null}
          {tallyBar ? <Text dimColor>{`${tallyBar.rest} `}</Text> : null}
          <Text color={row.kind === 'fact' && row.status === 'broken' ? 'red' : undefined} dimColor={!(row.kind === 'fact' && row.status === 'broken')}>{rightCut ? `  ${rightCut}` : ''}</Text>
        </Button>
      )
    }

    const bar = draw.line(doneCount, counted.length, Math.max(1, room - 2 - draw.FACE_CELLS - draw.cells(tally) - 1))
    const header = (
      <Box flexDirection="row">
        <Text dimColor>╭─</Text>
        <Text color="yellow" bold>{face}</Text>
        <Text color="green">{bar.filled}{bar.half}</Text>
        <Text dimColor>{bar.rest}</Text>
        <Text dimColor>{tally ? ` ${tally}` : ''}</Text>
      </Box>
    )

    // The `now` zone: why the step exists, its guard, its options, its verify, then the maths line that sums its premises.
    const nowZone = (): RenderChildren[] => {
      if (!nowStep || nowCap === 0) return []
      const glyphs = nowFacts.map(claim => GLYPH[claim.status]).join(' ')
      const maths = `status = ⊓ {${glyphs || '∅'}} = ${GLYPH[nowStatus]}`
      return [
        zone('now'),
        ...nowShown.map((line, index) => labelled(`now:${index}`, line.label, line.text, line.right)),
        labelled('now:maths', 'maths', maths, room >= 64 ? MEANING_SHORT[nowStatus] : '', nowStatus === 'broken' ? 'red' : nowStatus === 'checked' || nowStatus === 'proved' ? 'green' : undefined),
      ]
    }

    // The `you` zone, two rows: a question with its digit buttons, the engine's own dialog, a waiting note; else what is next.
    const youZone = (): RenderChildren[] => {
      const lines: RenderChildren[] = []
      if (waitingAdd !== null) lines.push(labelled('you:add', 'typing', `add a fact ⋅ ${waitingAdd}`, 'type it in the prompt', 'red', false))
      for (const ask of askingNow) lines.push(labelled(`you:ask:${ask}`, 'asked', `? ${ask}`, 'answer in the chat', 'red', false))
      for (const note of queued) lines.push(labelled(`you:n:${note.at}`, 'sent', describeNote(note), 'Claude sees it next step', 'red', false))
      const question = pending[0]
      if (question) {
        lines.push(labelled('you:q', '?', `${question.kind === 'feel' ? 'feel right?' : 'build it?'}  ${question.says}`, '', 'red', false))
        if (lines.length === 1) {
          lines.push(
            <Box key="you:a" flexDirection="row" gap={2}>
              <Text dimColor>{`  ${draw.pad('', LABEL)}`}</Text>
              <Button key="yes" plain hotkey="1" label={question.kind === 'feel' ? 'yes' : 'build it'} onPress={() => answerQuestion($, question, 'yes')} />
              <Button key="no" plain hotkey="2" label={question.kind === 'feel' ? 'no, check it' : 'not worth it'} onPress={() => answerQuestion($, question, 'no')} />
              {question.kind === 'feel' ? <Button key="unsure" plain hotkey="3" label="not sure" onPress={() => answerQuestion($, question, 'unsure')} /> : null}
            </Box>,
          )
        }
      }
      const nextSteps = rows.filter(row => row.kind === 'step' && row.mark === 'open' && !row.isNow)
      if (lines.length === 0) lines.push(labelled('you:none', '', 'nothing waiting', ''))
      for (const row of nextSteps) if (lines.length < 2) lines.push(labelled(`you:next:${row.key}`, 'next', `○ ${row.text}`, ''))
      while (lines.length < 2) lines.push(<Text key={`you:pad:${lines.length}`}>{' '}</Text>)
      return [zone('you'), ...lines.slice(0, 2)]
    }

    // The `did` zone: what Claude did, oldest at the top, the running call last; the right end is what Claude said before it, else the step.
    const didZone = (count: number): RenderChildren[] => {
      type LogRow = { readonly when: string; readonly what: string; readonly why: string; readonly colour: Colour; readonly isDim: boolean }
      const calls: LogRow[] = spent.last.map(entry => {
        const stepWhy = entry.step && tree ? itemNamed(tree, entry.step)?.why : undefined
        return {
          when: entry.at !== undefined ? clock(entry.at) : '',
          what: `${entry.text}${entry.isOk ? '' : ' ✗'}${entry.ms !== undefined && entry.ms >= 1000 ? ` ${draw.clock(entry.ms)}` : ''}`,
          // The reason, with its source named, never invented: Claude's own words, else the plan's why line, else say so.
          why: entry.said ? `${entry.saidBy === 'you' ? 'you said' : 'Claude said'}: ${entry.said}` : stepWhy ? `plan says: ${stepWhy}` : 'no reason on record',
          colour: entry.isOk ? undefined : 'red',
          isDim: entry.isOk,
        }
      })
      // The ledger: what changed because of evidence or you (plan diffs, verbs, checks), `HH:MM ` first.
      const changes: LogRow[] = ledger.map(line => {
        const when = /^\d\d:\d\d /.test(line) ? line.slice(0, 5) : ''
        const what = when ? line.slice(6) : line
        const isBad = what.startsWith('✗')
        const isGood = what.includes('→ done') || what.startsWith('■') || what.startsWith('◆')
        return { when, what, why: 'changed', colour: isBad ? 'red' : isGood ? 'green' : undefined, isDim: !isBad && !isGood }
      })
      // Both lists are newest first; interleave by the clock so the zone reads as one timeline, oldest at the top.
      // Ledger lines first on a tie of the minute: a change, a review or a drift line is rarer than a call and must not fall off.
      const merged = [...changes, ...calls].toSorted((a, b) => (a.when < b.when ? 1 : a.when > b.when ? -1 : 0)).slice(0, Math.max(0, count - (isCalling ? 1 : 0))).toReversed()
      // Narrow docks keep the words readable: the reason column needs 56 columns, the clock 36; the card has the rest.
      const hasWhy = room >= 56
      const hasWhen = room >= 36
      const lines = merged.map((row, index) => labelled(`did:${index}`, hasWhen ? row.when : '', row.what, hasWhy && !(index > 0 && merged[index - 1]?.why === row.why) ? row.why : '', row.colour, row.isDim))
      if (isCalling && spent.doing) lines.push(labelled('did:now', clock(now), `${draw.spinner(tickNow)} ${spent.doing}`, nowStep?.name ?? '', 'yellow', false))
      if (lines.length === 0) lines.push(labelled('did:none', '', 'nothing yet this session', ''))
      return [zone('did'), ...lines.slice(-count)]
    }

    // The gauges: plan progress with the premises and the plan's meet; context with the step's clock and spend; the flow with the sparkline.
    const gaugesZone = (): RenderChildren[] => {
      const width = room >= 60 ? 12 : 8
      const planBar = draw.line(doneCount, counted.length, width)
      const ctxBar = draw.line(ctx, 100, width)
      const premises = `premises ■${premiseCounts.checked} △${premiseCounts.open} ✗${premiseCounts.broken}   ⊓ plan = ${GLYPH[planMeet]}`
      // The trend: how much context the last turn ate, so the next compaction is no surprise (a count, not a projection).
      const lastTwo = ctxTurns.slice(-2)
      const ctxDelta = lastTwo.length === 2 && lastTwo[1] !== undefined && lastTwo[0] !== undefined && lastTwo[1] !== lastTwo[0] ? ` ${lastTwo[1] > lastTwo[0] ? '+' : ''}${lastTwo[1] - lastTwo[0]}/turn` : ''
      const stepText = nowStep ? `step ${nowClock} ⋅ ${nowSpend?.calls ?? 0} calls ⋅ ${nowSpend?.fails ?? 0} ✗ ⋅ ${formatTokens(nowSpend?.tokens ?? 0)} tok` : 'no step yet'
      const spark = draw.spark(tokens, 8)
      const turnText = `turn ${formatTokens(spent.turnIn + spent.turnOut)}`
      const flowRight = [spark, turnText].filter(Boolean).join('  ')
      const flowText = draw.flow(
        [...spent.last.slice(0, 5).toReversed().map(entry => ({ text: entry.text, isOk: entry.isOk })), ...(isCalling && spent.doing ? [{ text: spent.doing, isOk: true, isRunning: true }] : [])],
        Math.max(8, room - 2 - LABEL - draw.cells(flowRight) - 2),
        draw.spinner(tickNow),
      )
      const gaugeRow = (keyName: string, label: string, line: ReturnType<typeof draw.line>, value: string, detail: string, barColour: Colour, isDimValue = false) => {
        const head = `  ${draw.pad(label, LABEL)}`
        const used = draw.cells(head) + width + 1 + draw.cells(value)
        const detailCut = draw.fit(detail, Math.max(0, room - used - 3))
        return (
          <Box key={keyName} flexDirection="row">
            <Text dimColor>{head}</Text>
            <Text color={barColour}>{line.filled}{line.half}</Text>
            <Text dimColor>{line.rest} </Text>
            <Text dimColor={isDimValue}>{value}</Text>
            <Text dimColor>{detailCut ? `   ${detailCut}` : ''}</Text>
          </Box>
        )
      }
      // A narrow dock gets two short rows with the numbers alone: the bars and the flow need room the words do not.
      if (room < 56) {
        return [
          zone('gauges'),
          labelled('g:narrow-1', 'plan', `${tally || '—'} ⋅ ctx ${ctx}%${ctxDelta}`, '', ctx >= 80 ? 'red' : undefined),
          labelled('g:narrow-2', 'step', nowStep ? `${nowClock} ⋅ ${nowSpend?.calls ?? 0} calls ⋅ ${nowSpend?.fails ?? 0} ✗` : 'no step yet', ''),
        ]
      }
      return [
        zone('gauges'),
        gaugeRow('g:plan', 'plan', planBar, tally || '—', premises, 'green'),
        gaugeRow('g:ctx', 'ctx', ctxBar, `${String(ctx).padStart(3)}%${ctxDelta}`, stepText, ctx >= 80 ? 'red' : 'green', ctx === 0),
        <Box key="g:flow" flexDirection="row">
          <Text dimColor>{`  ${draw.pad('', LABEL)}`}</Text>
          <Text color={isCalling ? 'yellow' : undefined} dimColor={!isCalling}>{flowText}</Text>
          <Text dimColor>{`${' '.repeat(Math.max(1, room - 2 - LABEL - draw.cells(flowText) - draw.cells(flowRight)))}${flowRight}`}</Text>
        </Box>,
      ]
    }

    // The keys, one row: every verb a word and a click; the letters show only while the pane is held.
    const keysRow = () => {
      const long = [['doubt', 'add a fact', 'wrong path'], 'explain', 'help', `form: ${choiceLabel(choice)}`] as const
      const shortLabels = isFocused || room < 56
      const verbLabels = shortLabels ? ['doubt', 'fact', 'wrong'] : long[0]
      const gap = shortLabels ? 1 : 2
      return (
        <Box flexDirection="row" gap={gap}>
          <Text dimColor>{'  '}</Text>
          {VERBS.map((verb, index) => (
            <Button key={verb.kind} plain dimColor {...key(verb.hotkey)} label={verbLabels[index] ?? verb.label} onPress={verbOn(verb.kind)} />
          ))}
          <Button key="open" plain dimColor {...key('e')} label="explain" onPress={() => (selected ? toggleCard(selected.key) : nowStep ? toggleCard(stepKey(nowStep)) : help())} />
          <Button key="help" plain dimColor {...key('h')} label="help" onPress={help} />
          {isFocused ? null : <Button key="form" plain dimColor label={`form: ${choiceLabel(choice)}`} onPress={cycleForm} />}
        </Box>
      )
    }

    // The card: English, then the maths, the failing case, the because, what it holds; one blank row between sections.
    // It reports its height so the zones above are counted exactly and nothing jumps.
    function buildCard(): RenderChildren | null {
      if (opened === null) return null
      if (opened === 'help') {
        const paragraphs = [
          `[-_-]  Victrix: Claude's plan as it works it, what each step leans on, what it did, and what needs you.`,
          `◉ the step Claude is on  ✓ done  ○ next  △ assumed, nobody checked  ■ checked by a tool  ◆ proved  ✗ broken, with its case`,
          `now: why the step exists, its guard, its options, its verify, and status = ⊓ premises: a step is never stronger than its weakest premise (Anka T1).`,
          `did: every call Claude made, with what it said just before, in its own words. gauges: plan, context, the step's clock and spend.`,
          `Nothing needs pressing. doubt asks Claude to re-check a line; add a fact gives it one; wrong path tells it to back up.`,
          `Keys while this pane is held: ${VERBS.map(verb => `${verb.hotkey} ${verb.label}`).join(' ⋅ ')} ⋅ e explain ⋅ h help ⋅ m form ⋅ j k move ⋅ y copy ⋅ q hide ⋅ r right (accept a Lean claim's English, the one thing that makes it proved)`,
        ]
        const wrapped = paragraphs.map(paragraph => draw.wrap(paragraph, room - 2))
        cardRows = wrapped.reduce((sum, lines) => sum + lines.length + 1, 0) + 1
        return (
          <Box flexDirection="column">
            {paragraphs.flatMap((paragraph, index) => [
              ...(wrapped[index] ?? []).map((line, lineIndex) => (
                <Text key={`help:${index}:${lineIndex}`} bold={index === 0} dimColor={index > 0}>{`  ${line}`}</Text>
              )),
              <Text key={`help:gap:${index}`}>{' '}</Text>,
            ])}
            <Box flexDirection="row" gap={2}>
              <Text dimColor>{'  '}</Text>
              <Button key="allow-any" plain dimColor label={allowAny ? 'check runs any command in this repo (press to go back to the allowlist)' : 'let check run any command in this repo'} onPress={toggleAllowAny} />
            </Box>
          </Box>
        )
      }
      const parsed = parseCardKey(opened)
      if (!parsed) return null
      const item = tree ? itemNamed(tree, parsed.step) : undefined
      if (!item) return null
      const under = factsOf(item, allClaims)
      const claim = parsed.fact === undefined ? undefined : under[parsed.fact]
      const low = weakest(under)
      const status = claim?.status ?? stepStatus(under)
      const says = claim ? claim.says : item.note || item.name
      const premises = under.map(one => GLYPH[one.status]).join(' ') || '∅'
      // The step's status is the meet of its premises (Anka T1); the opened claim is one of them.
      const maths = `status = ⊓ {${premises}} = ${GLYPH[stepStatus(under)]}`
      const holds = claim
        ? `${claimLabel(claim)}${low && claim === low && under.length > 1 ? ' ⋅ the weakest premise of this step' : ''}`
        : `${under.length} premises ⋅ ${low ? `weakest: ${low.says}` : 'none written'}`
      const spendOf = spent.steps[item.name]
      const spendText = spendOf ? `${draw.clock(timeOn(spent, item.name, now))} ⋅ ${spendOf.calls} calls ⋅ ${spendOf.fails} ✗ ⋅ ${formatTokens(spendOf.tokens)} tokens` : 'nothing spent yet'
      const sections: RenderChildren[] = [
        <Text key="c:title" color={status === 'broken' ? 'red' : status === 'open' ? undefined : 'green'} bold>{draw.fit(`  [${GLYPH[status]}] ${says}`, room)}</Text>,
        <Text key="c:g0">{' '}</Text>,
        labelled('c:says', 'says', says, '', undefined, false),
        ...(claim?.counterexample ? [labelled('c:breaks', 'breaks', claim.counterexample, claim.evidence ? `${claim.evidence.command} ⋅ exit ${claim.evidence.exitCode}` : '', 'red', false)] : []),
        labelled('c:maths', 'maths', maths, room >= 64 ? MEANING_SHORT[status] : ''),
        labelled('c:proved', 'proved', 'status ≤ every premise', 'combine_le_premise ⋅ Lean'),
        labelled('c:meaning', 'meaning', MEANING[status], ''),
        ...(item.why ? [labelled('c:because', 'because', item.why, '')] : []),
        labelled('c:spent', 'spent', spendText, ''),
        labelled('c:holds', 'holds', holds, ''),
        ...(claim?.evidence?.english !== undefined
          ? [labelled('c:english', 'english', claim.evidence.english, claim.status === 'proved' ? 'accepted by you' : 'by a model that never saw the claim', claim.status === 'proved' ? 'green' : undefined, false)]
          : []),
        <Box key="c:keys" flexDirection="row" gap={2}>
          <Text dimColor>{`  ${draw.pad('', LABEL)}`}</Text>
          {claim?.evidence?.english !== undefined && claim.status === 'checked' ? (
            <Button key="card-right" plain {...key('r')} label="right: the English says what I meant" onPress={() => acceptEnglish($, claim)} />
          ) : null}
          <Button key="card-close" plain dimColor {...key('e')} label="close" onPress={() => toggleCard(opened)} />
        </Box>,
      ]
      cardRows = sections.length
      return <Box flexDirection="column">{sections}</Box>
    }

    // No plan yet: the newest plan files to follow, or where a plan comes from.
    const offeredRows = () =>
      offered.length === 0
        ? [<Text key="none" dimColor>{draw.fit(view ? `  ${view.tree ? '' : 'cannot read the plan ⋅ '}${view.path}` : '  no plan yet ⋅ when Claude plans (shift+tab) it shows here', room)}</Text>]
        : offered.map((pick, index) => (
            <Button key={`p:${pick.path}`} plain onPress={() => follow(pick.path)}>
              <Text inverse={isFocused && rows.length + index === at}>{draw.fit(`  ○ ${pick.title}  ${ago(pick.mtimeMs, now)}`, room)}</Text>
            </Button>
          ))

    if (form === 'strip') {
      // The strip: one ink row per step, the lit one bracketed, counts on the right; a click opens the map on that step.
      const steps = rows.filter(row => row.kind === 'step' || row.kind === 'chips' || row.kind === 'fact')
      const inkRows = steps.map((row, index) => {
        const isLast = index === steps.length - 1
        const isFact = row.kind === 'fact'
        const prefix = isFact ? draw.trunk(isLast || steps[index + 1]?.kind !== 'fact' ? 'detailLast' : 'detail') : isLast ? draw.trunk('last') : draw.trunk('step')
        const glyph = row.isNow && !isFact ? `[${row.glyph}]` : row.glyph || '✓'
        const counts = isFact ? '' : row.isNow ? '' : row.right
        const inkRoom = Math.max(1, room - draw.cells(prefix) - draw.cells(glyph) - 1 - (counts ? draw.cells(counts) + 1 : 0))
        const stepSpend = !isFact ? spent.steps[row.step] : undefined
        const stripTally = stepSpend && stepSpend.calls > 0 ? draw.tally(stepSpend.calls, stepSpend.fails, inkRoom, row.isNow && isCalling) : undefined
        const ink = stripTally ? `${stripTally.ok}${stripTally.bad}${stripTally.running}` : draw.ink(draw.cells(row.text) * 2, inkRoom, row.mark === 'open' || (isFact && row.status === 'open') ? 'open' : row.isNow ? 'now' : 'done')
        const colour = isFact ? (row.status === 'broken' ? 'red' : row.status === 'open' ? undefined : 'green') : row.isNow ? 'yellow' : row.mark === 'open' ? undefined : 'green'
        return (
          <Button key={`ink:${row.key}`} plain onPress={async () => { await update($, formChoice, () => 'third'); await moveTo(index); await reconcileForm($, 'asked') }}>
            <Text dimColor>{prefix}</Text>
            <Text color={isFact ? colour : row.isNow ? 'yellow' : undefined} dimColor={!row.isNow && !(isFact && row.status === 'broken')} bold={row.isNow && !isFact}>{glyph} </Text>
            <Text color={colour} dimColor={(row.mark === 'open' && !isFact) || (isFact && row.status === 'open')}>{ink}</Text>
            <Text dimColor>{counts ? ` ${counts}` : ''}</Text>
          </Button>
        )
      })
      const width = Math.max(4, room - 2 - 5 - 5)
      const planBar = draw.line(doneCount, counted.length, width)
      const ctxBar = draw.line(ctx, 100, width)
      const needs = askingNow[0]
        ? `? ${askingNow[0]}`
        : pending[0]
          ? `${pending[0].kind === 'feel' ? 'feel right?' : 'build it?'} ${pending[0].says}`
          : queued[0]
            ? describeNote(queued[0])
            : ''
      const stripLog = Math.max(1, height - 1 - inkRows.length - 11)
      const didRows = [...spent.last.slice(0, stripLog).toReversed()].map((entry, index) => (
        <Text key={`sdid:${index}`} color={entry.isOk ? undefined : 'red'} dimColor={entry.isOk}>{draw.fit(`  ${entry.at !== undefined ? clock(entry.at) : '     '} ${entry.text.split(' ')[0] ?? entry.text}${entry.isOk ? '' : ' ✗'}`, room)}</Text>
      ))
      return (
        <Box flexDirection="column" minHeight={height}>
          {header}
          {inkRows.length > 0 ? inkRows : offeredRows()}
          {zone('did')}
          {didRows.length > 0 ? didRows : <Text dimColor>{draw.fit('  nothing yet', room)}</Text>}
          {isCalling && spent.doing ? <Text color="yellow">{draw.fit(`  ${clock(now)} ${draw.spinner(tickNow)} ${spent.doing.split(' ')[0] ?? ''}`, room)}</Text> : null}
          <Box flexGrow={1} />
          {zone('gauges')}
          <Box flexDirection="row">
            <Text dimColor>{'  plan '}</Text>
            <Text color="green">{planBar.filled}{planBar.half}</Text>
            <Text dimColor>{planBar.rest} {tally}</Text>
          </Box>
          <Box flexDirection="row">
            <Text dimColor>{'  ctx  '}</Text>
            <Text color={ctx >= 80 ? 'red' : 'green'}>{ctxBar.filled}{ctxBar.half}</Text>
            <Text dimColor>{ctxBar.rest} {ctx}%</Text>
          </Box>
          <Text dimColor>{draw.fit(nowStep ? `  step ${nowClock} ⋅ ${nowSpend?.calls ?? 0} ⋅ ${nowSpend?.fails ?? 0}✗ ⋅ ${formatTokens(nowSpend?.tokens ?? 0)}` : '  no step yet', room)}</Text>
          <Text dimColor>{draw.fit(`  ■${premiseCounts.checked} △${premiseCounts.open} ✗${premiseCounts.broken}  ⊓ = ${GLYPH[planMeet]}`, room)}</Text>
          {zone('you')}
          <Text color={needs ? 'red' : undefined} dimColor={!needs}>{draw.fit(needs ? `  ${needs}` : '  nothing waiting', room)}</Text>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{'  '}</Text>
            {VERBS.map(verb => (
              <Button key={verb.kind} plain dimColor {...key(verb.hotkey)} label={verb.label.split(' ')[0] ?? verb.label} onPress={verbOn(verb.kind)} />
            ))}
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{'  '}</Text>
            <Button key="form" plain dimColor {...key('m')} label={`form: ${choiceLabel(choice)}`} onPress={cycleForm} />
            <Button key="help" plain dimColor {...key('h')} label="help" onPress={help} />
            {isFocused ? <Button key="hide" plain dimColor hotkey="q" label="hide" onPress={hide} /> : null}
          </Box>
        </Box>
      )
    }

    const navigation = isFocused ? (
      <Box flexDirection="row" gap={2}>
        <Text dimColor>{'  '}</Text>
        <Button key="down" plain dimColor hotkey="j" label="down" onPress={() => moveTo(at + 1)} />
        <Button key="up" plain dimColor hotkey="k" label="up" onPress={() => moveTo(at - 1)} />
        <Button key="copy" plain dimColor hotkey="y" label="copy" onPress={copy} />
        <Button key="form" plain dimColor hotkey="m" label={`form: ${choiceLabel(choice)}`} onPress={cycleForm} />
        <Button key="hide" plain dimColor hotkey="q" label="hide" onPress={hide} />
      </Box>
    ) : null

    const treeRows = rows.length > 0 ? rows.length : offeredRows().length
    const logCount = Math.max(1, height - 1 - treeRows - middleRows - 4 - 1 - 1)
    return (
      <Box flexDirection="column" minHeight={height}>
        {header}
        {rows.length > 0 ? rows.map(trunkRow) : offeredRows()}
        {card ?? [...nowZone(), ...youZone()]}
        {didZone(logCount)}
        <Box flexGrow={1} />
        {gaugesZone()}
        {keysRow()}
        {navigation}
      </Box>
    )
  })
}
