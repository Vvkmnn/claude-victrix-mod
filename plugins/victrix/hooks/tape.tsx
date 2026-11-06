// The tape: the horizontal form of the instrument, one row above the prompt, drawn only when no dock is placed
// or the person chose it; it grows by one row only while something needs you. The map keeps the did-log and gauges.
import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register, RenderInput } from 'claude-code'

import type { Activity, Claim, Note, PlanView, Question, RecentPlan, Signal } from '../types'
import { EMPTY_ACTIVITY, timeOn } from './activity'
import { describeNote } from './notes'
import * as draw from './draw'
import type { SizeChoice } from './form'
import { LIVE_COLOUR, shortClock } from './layout'
import { answerAlert, answerQuestion, cycleSize, pressVerb, verifyStep } from './lens'
import { nowItem } from './plan'
import { HEAD, KEYS_BUTTON, MARK_NAME, keysOn } from './ui'
import type { KeyAction } from './ui'

type On = Parameters<Register>[0]


// Atoms are declared in the file that reads them: the engine lists a module's state by scanning its own consts.
const plan = atom({ plugin: 'victrix', key: 'plan' } as const, null as PlanView | null)
const cursor = atom({ plugin: 'victrix', key: 'cursor' } as const, 0)
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
const alert = atom({ plugin: 'victrix', key: 'alert' } as const, null as Signal | null)

type Dollar = import('./lens').Dollar
type TapeSite = RenderInput<'Pane'> | RenderInput<'AbovePrompt'>
export type { CoreEngineInterface }

export const registerTape = (on: On) => {
  // The band draws the whole tape only when no pane of ours is placed anywhere (the pane draws it itself when the
  // engine seats it inline, and the map when docked). With the pane placed, the band carries only the ask: the one
  // red line above the prompt while something needs the person (owner, 2026-11-05). Drawing is pure.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const placed = await read($, isPlaced)
    const now = Date.now()
    if (!placed) return drawTape($, e, Math.max(20, e.props.bodyColumns), 'full', now)
    const waits = (await read($, alert)) !== null || (await read($, questions)).length > 0 || (await read($, asking)).length > 0 || (await read($, notes)).length > 0 || (await read($, pendingAdd)) !== null
    return waits ? drawTape($, e, Math.max(20, e.props.bodyColumns), 'ask', now) : next(e)
  })
}

/**
 * The row with its ask row (`full`), or only the ask row above the prompt while the pane is placed (`ask`). `now` is
 * read once by the caller so the band and the pane draw the same second.
 */
export async function drawTape($: Dollar, e: TapeSite, room: number, mode: 'full' | 'ask' = 'full', now: number = Date.now()) {
    const { Box, Button, Text } = $.ui.resolve(e)
    const view = await read($, plan)
    const tree = view?.tree ?? null
    const spent = await read($, activity)
    const queued = await read($, notes)
    const askingNow = await read($, asking)
    const pending = await read($, questions)
    const allClaims = await read($, claims)
    const tickNow = await read($, tick)
    const nowStep = tree ? nowItem(tree) : undefined
    const isCalling = spent.doing !== null && spent.doing !== 'thinking'
    const underNow = nowStep ? allClaims.filter(claim => claim.step === nowStep.name) : []
    const brokenClaim = underNow.find(claim => claim.status === 'broken')
    const needsYou = askingNow.length > 0 || pending.length > 0 || queued.length > 0
    // No face: the snake is the character and its head is the mark, `victrix▶` (owner, 2026-11-07); worry is said by
    // the red ask line below, never by the head.
    void needsYou
    const isHidden = (await read($, sizeChoice)) === 'hidden'
    const isKeysOpen = (await read($, openedCard)) === 'help'
    const all = tree ? tree.sections.flatMap(section => section.items) : []
    const done = all.filter(item => item.isDone && !item.isAbandoned).length
    const total = all.filter(item => !item.isAbandoned).length
    const tally = tree ? `${done}/${total}` : ''

    // The row at rest, left to right: the snake (done in colour, its head `victrix▶` where progress has reached, the
    // rest dim) with its tally, the lit step with its clock, why the step exists (dim), the running call, and the one
    // key `h: ? keys`. Each part is cut from the right as the row narrows, never wrapped: the snake and the step
    // survive at 40 columns. Hidden is the same snake, short, with its tally and the key alone.
    // The same marks as the pane (owner: "exactly similar in any view"): `▶ step clock`, the orange, the units.
    // No `▶` before the step: the triangle is the snake's head alone (owner, 2026-11-07); the step reads in orange.
    const stepText = nowStep ? `${nowStep.name} ${shortClock(timeOn(spent, nowStep.name, now))}` : tree ? 'every step done' : 'no plan yet'
    const barRoom = isHidden ? 6 : Math.max(4, Math.min(16, Math.floor(room / 6)))
    const bar = draw.line(done, total, barRoom)
    const keysCells = draw.cells(`${KEYS_BUTTON.hotkey}: ${KEYS_BUTTON.label}`) + 2
    const head = barRoom + draw.cells(HEAD) + 1 + draw.cells(tally) + 2 + keysCells
    const callText = isCalling && spent.doing ? `${draw.spinner(tickNow)} ${spent.doing}` : ''
    const callRoom = callText && !isHidden && room >= 60 ? Math.min(draw.cells(callText), Math.floor(room / 4)) : 0
    const callCut = callRoom ? draw.fit(callText, callRoom) : ''
    // The step takes what the head and the call leave; under eight cells it is dropped whole rather than overflow.
    const stepRoom = isHidden ? 0 : room - head - (callRoom ? callRoom + 2 : 0)
    const stepCut = stepRoom >= 8 ? draw.fit(stepText, Math.min(draw.cells(stepText), stepRoom)) : ''
    const whyText = nowStep?.why ? `because ${nowStep.why}` : nowStep?.note ? nowStep.note : (tree?.summary ?? '')
    // One cell held back for the gap's minimum, so a full `because` line never pushes the key off the row.
    const whyRoom = room - head - draw.cells(stepCut) - 2 - 1 - (callRoom ? callRoom + 2 : 0)
    const whyCut = !isHidden && whyRoom >= 12 && room >= 80 ? draw.fit(whyText, whyRoom) : ''
    const gap = ' '.repeat(Math.max(1, room - head - draw.cells(stepCut) - (whyCut ? draw.cells(whyCut) + 2 : 0) - draw.cells(callCut)))

    // The ask: one line, the fewest words that still say what is assumed and what each answer does; the digits are
    // the keys; gone the moment it is answered. `1` is a check only because the person says they checked.
    // A trust signal that reached the line (a warning at once, a caution at the turn's end) comes before the mod's
    // own questions: the worst thing wins, one line at a time. Its words say which side needs more.
    const warning = await read($, alert)
    const question = warning ? undefined : pending[0]
    const waitingAdd = await read($, pendingAdd)
    const ask = warning
      ? `${warning.needs === 'maths' ? 'the maths needs more' : 'Claude needs a steer'} · ${warning.words}`
      : waitingAdd !== null
        ? `add a fact · ${waitingAdd} · type it in the prompt`
        : question
          ? question.kind === 'feel' ? `Claude assumed · ${question.says} · true?` : `build ${question.says}?`
          : askingNow[0]
            ? `? ${askingNow[0]}  ·  answer in the chat`
            : queued[0]
              ? `${describeNote(queued[0])}  ·  Claude sees it next step`
              : brokenClaim
                ? `✗ ${brokenClaim.says}  ·  ${brokenClaim.counterexample ?? 'a case fails'}`
                : ''
    const canRun = nowStep?.judge !== undefined && nowStep.judge !== ''
    // The answers, written once: they draw the buttons and measure the room they take. The engine draws a plain
    // Button as `1: label`, so a label carries no digit of its own; the words are the owner's.
    type Answer = { readonly hotkey: string; readonly label: string; readonly onPress: () => unknown }
    const answers: readonly Answer[] = warning
      ? [
          ...(canRun ? [{ hotkey: '1', label: 'run the check', onPress: () => answerAlert($, warning, 'run') }] : []),
          { hotkey: '2', label: 'ask Claude to find out', onPress: () => answerAlert($, warning, 'ask') },
          { hotkey: '3', label: 'not sure', onPress: () => answerAlert($, warning, 'unsure') },
        ]
      : question
        ? [
            { hotkey: '1', label: question.kind === 'feel' ? 'I checked' : 'build it', onPress: () => answerQuestion($, question, 'yes') },
            { hotkey: '2', label: question.kind === 'feel' ? 'you check' : 'not worth it', onPress: () => answerQuestion($, question, 'no') },
            ...(question.kind === 'feel' ? [{ hotkey: '3', label: 'not sure', onPress: () => answerQuestion($, question, 'unsure') }] : []),
          ]
        : []
    // Measured, not guessed: each answer is `n: label` with the row's two-cell gap before it.
    const keysRoom = answers.reduce((sum, answer) => sum + draw.cells(`${answer.hotkey}: ${answer.label}`) + 2, 0)
    const askColour = warning && warning.level !== 'warning' ? LIVE_COLOUR : 'error'
    const askRow = ask ? (
      <Box key="ask" flexDirection="row" gap={2}>
        <Text dimColor>{mode === 'ask' ? '  ' : '╰ '}</Text>
        {/* `╰ ` (2) and the Box's two-cell gap before the words, then the answers with theirs (in keysRoom). */}
        <Text color={askColour}>{draw.fit(ask, room - 2 - 2 - keysRoom)}</Text>
        {answers.map(answer => <Button key={`t:${answer.hotkey}`} plain hotkey={answer.hotkey} label={answer.label} onPress={answer.onPress} />)}
      </Box>
    ) : null

    if (mode === 'ask') return <Box flexDirection="column">{askRow}</Box>
    const hasAskRow = mode === 'full' && askRow !== null

    // The keys card's handlers, the row's own: it has no card to explain in, so `e` and `q` are the pane's alone.
    const toggleKeys = () => update($, openedCard, current => (current === 'help' ? null : 'help'))
    const onStep = (act: (name: string) => Promise<unknown>) => async () => {
      if (!nowStep) return $.ui.toast('no plan step to press this on yet')
      await act(nowStep.name)
    }
    const handlers: Readonly<Partial<Record<KeyAction, () => unknown>>> = {
      size: () => cycleSize($),
      check: onStep(async () => (nowStep?.judge ? verifyStep($, nowStep) : $.ui.toast('this step has no check to run'))),
      doubt: onStep(name => pressVerb($, 'doubt', name)),
      add: onStep(name => pressVerb($, 'add', name)),
      wrong: onStep(name => pressVerb($, 'wrong', name)),
      keys: toggleKeys,
    }
    const rowKeys = keysOn('row')
    // Every key works whether the card is open or not (the card is where they are named); closed, they sit in a
    // zero-height box, the pane's pattern, and fire only while the band holds the focus, never while typing.
    const keyButtons = rowKeys.map(entry => (
      <Button key={`k:${entry.hotkey}`} plain hotkey={entry.hotkey} label={isKeysOpen ? entry.label : ''} onPress={() => handlers[entry.action]?.()} />
    ))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text color="success">{bar.filled}{bar.half}</Text>
          <Text>{MARK_NAME}</Text>
          <Text color={LIVE_COLOUR} bold>{draw.MARK.head}</Text>
          <Text dimColor>{bar.rest} {tally}  </Text>
          <Text color={LIVE_COLOUR} bold={nowStep !== undefined}>{stepCut}</Text>
          <Text dimColor>{whyCut ? `  ${whyCut}` : ''}</Text>
          <Text dimColor>{gap}</Text>
          <Text color={LIVE_COLOUR}>{callCut}</Text>
          <Text>{'  '}</Text>
          <Button key="keys" plain hotkey={KEYS_BUTTON.hotkey} label={KEYS_BUTTON.label} onPress={toggleKeys} />
        </Box>
        {hasAskRow ? askRow : null}
        {isKeysOpen ? <Box flexDirection="column">{keyButtons.filter((_, index) => rowKeys[index]?.action !== 'keys')}</Box> : <Box height={0} overflow="hidden">{keyButtons.filter((_, index) => rowKeys[index]?.action !== 'keys')}</Box>}
      </Box>
    )
}
