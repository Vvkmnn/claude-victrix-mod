// Began as the plan lens of github.com/Vvkmnn/claude-emporium (plugins/emporium/hooks/lens.tsx,
// Oct 2026, same author); carried on here as Victrix: one snake through the plan.
import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register, RenderChildren } from 'claude-code'

import type { Activity, Claim, Note, NoteKind, PlanItem, PlanTree, PlanView, Question, RecentPlan, Status } from '../types'
import { EMPTY_ACTIVITY, describeCall, describeResult, formatTokens, reduceActivity, timeOn } from './activity'
import type { ActivityEvent } from './activity'
import * as draw from './draw'
import { runVerify } from './check'
import { factKey, factsOf, fitRows, stepKey } from './fit'
import type { MapRow } from './fit'
import { chooseSize, dockColumns, nextSize } from './form'
import type { Size, SizeChoice } from './form'
import { GLYPH, MEANING, label as claimLabel, proved, sameClaim, stepStatus, weakest } from './lattice'
import { VERBS, appendLog, deliveryText, describeNote, logLine } from './notes'
import { itemNamed, nowItem, parsePlan } from './plan'
import { isInhibited, signalsOf, worst } from './signals'
import type { Signal } from './signals'

type On = Parameters<Register>[0]
export type Dollar = Pick<CoreEngineInterface, 'state' | 'fs' | 'store' | 'ui' | 'env' | 'prompt' | 'clock' | 'session' | 'process' | 'model'>


export const PANE = 'victrix'
export const TITLE = 'victrix'

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
const sizeChoice = atom({ plugin: 'victrix', key: 'sizeChoice' } as const, 'auto' as SizeChoice)
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
const signals = atom({ plugin: 'victrix', key: 'signals' } as const, [] as readonly Signal[])
const alert = atom({ plugin: 'victrix', key: 'alert' } as const, null as Signal | null)
const RECENT_KEPT = 3
const CHANGED_KEPT = 40
// The turn's start and the last verb press, for the signals: which calls are this turn's, and the inhibit window after a
// press. Module variables: session-only, reset on reload, never read in a draw.
let turnStartedAt = 0
let lastVerbAt = 0
const notified = new Set<string>()
// The spinner's tick: the one declared exception to the ≤ 2 Hz motion rule, alive only while a call runs on the terminal.
const TICK_MS = 125

// Per repo, so two repos never overwrite each other's choice or ledger.
const planPathKey = (dir: string) => `victrix.planPath:${dir}`
const logKey = (dir: string) => `victrix.log:${dir}`
const askedKey = (dir: string) => `victrix.asked:${dir}`
/** The terminal's width as last reported by a drawing, kept per machine so a new session can ask for a quarter at once. */
const COLUMNS_KEY = 'victrix.columns'

// Plan files live as <anything>/.claude/plans/<name>.md; their archives are history, not the plan.
const isPlanFile = (path: string) => /\/\.claude\/plans\/[^/]+\.md$/.test(path) && !path.includes('.archive-')

// A helper's tag for the log: the Agent call's own description of it, from the engine's roster, remembered per
// loop so the roster is read once; `helper` when the roster cannot be read or has no entry.
const helperTags = new Map<string, string>()
async function helperTag($: CoreEngineInterface, agentId: string): Promise<string> {
  const known = helperTags.get(agentId)
  if (known !== undefined) return known
  let tag = 'helper'
  try {
    const roster = await $.agent.list()
    const entry = roster.find(one => one.id === agentId)
    const words = entry?.description?.replace(/\s+/g, ' ').trim()
    if (words) tag = words.length > 24 ? `${words.slice(0, 23)}…` : words
  } catch {
    // The roster is a courtesy: a helper without one is still a helper.
  }
  helperTags.set(agentId, tag)
  return tag
}

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
    if (old === undefined) lines.push(before === null ? `plan read · ${name}` : `step added · ${name}`)
    else if (old !== state) lines.push(`${name} · ${old} → ${state}`)
  }
  for (const name of was.keys()) if (!now.has(name)) lines.push(`step removed · ${name}`)
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
    `It rests on these premises, status = min {${premises.map(claim => GLYPH[claim.status]).join(' ') || ' '}} = ${GLYPH[status]} ${status}:`,
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
  await noteChange($, `drift · ${step} · ${calls} calls, plan untouched`)
  void $.prompt.submit({ text: driftText(step, calls) })
}

async function sendReview($: Dollar) {
  const item = reviewFor
  reviewFor = undefined
  if (!isReview || item === undefined) return
  const premises = factsOf(item, await read($, claims))
  await noteChange($, `review · ${item.name} · ${premises.length} premises · ${GLYPH[stepStatus(premises)]}`)
  void $.prompt.submit({ text: reviewText(item, premises) })
}

export async function verifyStep($: Dollar, item: PlanItem) {
  const argv = item.judge ? argvOf(item.judge) : undefined
  if (argv === undefined) return
  const answer = await runVerify($, item.name, `verify: ${item.judge}`, argv, await read($, cwd))
  $.ui.log(`victrix: verified ${item.name}: ${answer.split('\n')[0] ?? ''}`, { to: 'debug' })
}

/** The person accepts a Lean claim's English: the one thing that lifts it from checked to proved (sound build, standard axioms, no cheat). */
export async function acceptEnglish($: Dollar, claim: Claim) {
  if (claim.evidence === undefined || claim.evidence.kind !== 'lean') return
  const lifted = proved(claim, claim.evidence, true, Date.now())
  await update($, claims, all => all.map(one => (sameClaim(one, claim) ? lifted : one)))
  await noteChange($, `${GLYPH[lifted.status]} ${lifted.says} · ${lifted.status === 'proved' ? 'English accepted by you' : 'English accepted, but the build is not sound'}`)
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
export async function loadPlan($: Dollar, path: string, source: PlanSource) {
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
  const lines = isSwitch ? [`following · ${tree?.title ?? path}`] : diffPlans(before, tree)
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
  for (const line of lines) await noteChange($, outside ? `${line} · outside this session` : line)
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

/** The size the moment calls for, from the state the hooks keep. */
export async function currentSize($: Dollar): Promise<Size> {
  const columns = await read($, viewportColumns)
  return chooseSize({
    choice: await read($, sizeChoice),
    isPlanMode: await read($, isPlanMode),
    isDialogUp: await read($, isDialogUp),
  })
}

// One drawing, one size at a time: the pane opens at its width, or closes so the row (or the hidden row) can draw.
async function reconcileForm($: Dollar, how: 'asked' | 'unasked') {
  const size = await currentSize($)
  if (size !== 'pane') {
    if (await read($, isPlaced)) await $.ui.close({ id: PANE })
    await update($, isPlaced, () => false)
    return
  }
  // The terminal's width is known only once `/victrix` has run (the session start carries none); until then the
  // map asks for no width and takes the engine's own share, instead of the 24-column floor a width of 0 would give.
  const viewport = await read($, viewportColumns)
  const columns = viewport === 0 ? undefined : dockColumns(viewport)
  // Transparent: the pane shows the person's own terminal background, never the engine's panel grey (owner, 2026-11-05).
  const args = { id: PANE, title: TITLE, backgroundColor: 'transparent' as const, ...(columns === undefined ? {} : { columns }), ...(how === 'asked' ? { focus: true as const } : {}) }
  // The width is a request: where the person has dragged the dock, the engine keeps that width over it.
  const opened = await $.ui.open(args)
  await update($, isPlaced, () => opened.isPlaced)
  $.ui.log(`victrix: ${size} (${how}, ${columns ?? 'share'} cols): ${opened.isPlaced ? 'placed' : opened.reason}`, { to: 'debug' })
}

/**
 * `s`, from any size: the next of pane, row, hidden, for this session only; every session starts at the pane, the
 * largest (owner, 2026-11-07: "default to largest mode always").
 */
export async function cycleSize($: Dollar) {
  // From what is on screen, not what was asked: a pane the engine would not seat shows as the row, and `s` must
  // then go on to hidden, never stay on a row the person already sees.
  const size = await currentSize($)
  const shown = size === 'pane' && !(await read($, isPlaced)) ? 'row' : size
  const next = nextSize(shown)
  await update($, sizeChoice, () => next)
  await reconcileForm($, 'asked')
}

/** `q`: the pane goes, the row stays, for the rest of this session only. */
export async function hidePane($: Dollar) {
  await update($, sizeChoice, () => 'row')
  await reconcileForm($, 'asked')
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
  await record($, { kind: 'said', text: queued.map(describeNote).join(' · '), by: 'you' })
  void $.prompt.submit({ text: deliveryText(queued) })
  $.ui.log(`victrix: delivered ${queued.length} note(s) as a prompt`, { to: 'debug' })
}

// A pressed verb: logged at once, delivered at Claude's next step, told to the person in one toast.
/**
 * The trust signals, recomputed after every call and at the turn's end from what the mod holds: this turn's calls and
 * what Claude said before them, the live step's calls so far, its claims, its verify line, the open options and the
 * unsure answers. The pane shows them all in words; the line above the prompt takes only the worst, a warning at once,
 * a caution at the turn's end, and neither while the person types, a dialog is up, or a verb was pressed moments ago.
 */
async function refreshSignals($: Dollar, moment: 'call' | 'turn-end') {
  const view = await read($, plan)
  const tree = view?.tree ?? null
  const live = tree ? nowItem(tree) : undefined
  if (!live) {
    await update($, signals, () => [])
    return
  }
  const spent = await read($, activity)
  const turnCalls = spent.last.filter(line => (line.at ?? 0) >= turnStartedAt)
  const spoken = [...turnCalls.filter(line => line.saidBy !== 'you' && line.said).map(line => line.said ?? ''), ...(spent.saidBy === 'claude' && spent.said ? [spent.said] : [])]
  const pending = await read($, questions)
  const ledger = await read($, changed)
  const found = signalsOf({
    spoken,
    calls: turnCalls,
    stepCalls: spent.last.filter(line => line.step === live.name),
    claims: factsOf(live, await read($, claims)),
    hasJudge: live.judge !== '',
    openOptions: pending.filter(question => question.kind === 'build').length,
    unsure: ledger.filter(line => line.includes('not sure about ·')).length,
    // Off-plan turns are U5's; until it counts them the signal cannot fire.
    offPlanTurns: 0,
  })
  await update($, signals, () => found)
  const top = worst(found)
  const candidate = top && top.level !== 'advisory' && (top.level === 'warning' || moment === 'turn-end') ? top : undefined
  if (candidate === undefined) return
  const { text } = await $.prompt.read()
  const busy = { isTyping: text.trim() !== '', isDialogUp: await read($, isDialogUp), msSinceVerb: Date.now() - lastVerbAt }
  if (isInhibited(candidate, busy)) return
  await update($, alert, () => candidate)
  if (candidate.level === 'warning' && !notified.has(candidate.words)) {
    notified.add(candidate.words)
    await $.ui.notify(candidate.words, { title: 'victrix' }).then(undefined, () => undefined)
  }
}

/** The person answers the line: run the step's check, send Claude to find the evidence, or say they are not sure; the line goes either way. */
export async function answerAlert($: Dollar, signal: Signal, answer: 'run' | 'ask' | 'unsure') {
  await update($, alert, () => null)
  const view = await read($, plan)
  const live = view?.tree ? nowItem(view.tree) : undefined
  if (answer === 'run') {
    if (live) await verifyStep($, live)
    return
  }
  if (answer === 'ask') {
    if (live) await pressVerb($, 'doubt', live.name, `${signal.words} · find the evidence yourself, or say what you need from me`)
    return
  }
  await noteChange($, `not sure about · ${signal.words}`)
}

export async function pressVerb($: Dollar, kind: NoteKind, step: string, says?: string) {
  lastVerbAt = Date.now()
  if (kind === 'add') {
    await update($, pendingAdd, () => step)
    $.ui.toast(`add a fact · ${step}: type it in the prompt; Claude reads it at its next step`)
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
  if (working) $.ui.toast(`${describeNote(note)} · Claude sees it at its next step`)
  else {
    $.ui.toast(`${describeNote(note)} · sent to Claude`)
    await deliverNotes($)
  }
}

// An answer to a gut check: yes keeps the fact assumed with the person as its source, no doubts it, not sure marks it.
export async function answerQuestion($: Dollar, question: Question, answer: 'yes' | 'no' | 'unsure') {
  await markAsked($, question)
  if (question.kind === 'build') {
    if (answer === 'yes') await pressVerb($, 'add', question.step)
    await update($, pendingAdd, () => null)
    if (answer === 'yes') {
      const note: Note = { kind: 'add', step: question.step, text: `build and measure this option: ${question.says}`, at: Date.now() }
      await update($, notes, queued => [...queued, note])
      await logNote($, note)
      await noteChange($, `build it · ${question.says}`)
      if (!(await read($, isWorking))) await deliverNotes($)
    } else await noteChange($, `${answer === 'no' ? 'declined' : 'not sure about'} · ${question.says}`)
    return
  }
  const claim: Claim = { step: question.step, says: question.says, status: 'open', source: answer === 'yes' ? 'you' : answer === 'no' ? 'doubt' : 'claude', at: Date.now() }
  await update($, claims, list => (list.some(one => sameClaim(one, claim)) ? list.map(one => (sameClaim(one, claim) ? claim : one)) : [...list, claim]))
  if (answer === 'no') await pressVerb($, 'doubt', question.step, question.says)
  else await noteChange($, `${answer === 'yes' ? 'you said so' : 'you were not sure'} · ${question.says}`)
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

let ticker: { cancel: () => void } | undefined

// The spinner's clock, terminal only; a host without a clock (the test kit) leaves the glyph still.
// Alive while a turn runs: the clock on the lit step moves once a second between calls, the
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
    const kept = await $.store.get(COLUMNS_KEY).catch(() => undefined)
    if (typeof kept === 'number' && kept > 0) await update($, viewportColumns, value => (value === 0 ? kept : value))
    await $.command.register({
      name: 'victrix',
      description: 'Open the instrument: the plan as Claude works it, what it leans on, what needs you',
      argumentHint: '[plan file]',
    })
    // The saved plan belongs to an earlier session in this repo: follow it only when this session is that one resumed
    // (it already holds messages). A new session follows the plan its own plan mode names, and until then offers the
    // recent ones; otherwise a new chat showed an older chat's plan (owner's desktop test, 2026-11-07).
    const saved = await $.store.get(planPathKey(e.cwd))
    const isResumed = (await $.session.messages().catch(() => [])).length > 0
    if (typeof saved === 'string' && isResumed) await loadPlan($, saved, 'start')
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
    await update($, sizeChoice, () => 'auto')
    await update($, viewportColumns, value => (value === 0 ? e.presentation.columns : value))
    // The one moment the engine tells the mod the terminal's width: kept per machine so later sessions ask for a quarter at once.
    if (e.presentation.columns > 0) await $.store.set(COLUMNS_KEY, e.presentation.columns).catch(() => undefined)
    // Always the full pane, at any width: a narrow surface seats it inline above the prompt (owner, 2026-11-07).
    await reconcileForm($, 'asked')

    return { text: 'Victrix opened.' }
  })

  // A person's close (the engine's ✕ or ctrl+x x) is their choice of the row for the rest of this session, so a later
  // mode change never reopens what they closed; the next session starts at the pane again (owner, 2026-11-07).
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      await update($, sizeChoice, () => 'row')
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
      await noteChange($, `you added · ${typed}`)
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
      turnStartedAt = Date.now()
      await update($, isWorking, () => true)
      await record($, { kind: 'turn-start' })
      await startTicker($, SLOW_MS)
      // A caution from the last turn has had its moment; a warning stays until answered (a dismissed caution keeps
      // its status visible in the block, the cockpit's rule).
      await update($, alert, current => (current !== null && current.level !== 'warning' ? null : current))
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
      await refreshSignals($, 'turn-end')
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
    // Every loop's calls reach the log at engine speed (owner: "let the process log move at AI speed", helpers too);
    // a helper's carry its Agent description as a tag. Only the main loop drives the head row and the ticker.
    const helper = isMain ? undefined : await helperTag($, e.agentId!)
    await record($, { kind: 'call-start', text, at: startedAt, ...(helper === undefined ? {} : { helper }) })
    if (isMain) await startTicker($, TICK_MS)
    if (isDialog) {
      const askedNow = Array.isArray(input.questions) ? input.questions.map(q => (q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string' ? (q as { question: string }).question : '')).filter(Boolean) : []
      await update($, asking, () => (e.tool === 'ExitPlanMode' ? ['the plan is up for your approval'] : askedNow))
      await update($, isDialogUp, () => true)
      await reconcileForm($, 'unasked')
    }
    const result = await next(e)
    // A decline (the person's, or the permission system's) is not a failure of Claude's: logged as a decline, dim.
    const isDeclined = result.deny !== undefined
    const isOk = !isDeclined && result.isError !== true
    const detail = isDeclined ? undefined : describeResult(e.tool, input, result)
    await record($, { kind: 'call-end', text, isOk, ...(isDeclined ? { isDeclined: true } : {}), at: startedAt, ms: Date.now() - startedAt, ...(helper === undefined ? {} : { helper }), ...(detail === undefined ? {} : { detail }) })
    if (isMain) {
      // Back to the slow tick between calls: the turn is still running.
      await startTicker($, SLOW_MS)
      await refreshSignals($, 'call')
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

}
