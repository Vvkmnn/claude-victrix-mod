// The pane: the drawing `layout.ts` computes, painted with the engine's elements; the card and the `?` popup over it.
// Drawing is pure: nothing here writes state; presses call the lens's handlers. Live is Anthropic's orange, the rest
// is the person's theme through its keys (`success`, `error`, `inactive`, dim text).
import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register, RenderChildren, RenderInput } from 'claude-code'

import type { Activity, Claim, Note, PlanView, Question, RecentPlan, Signal } from '../types'
import { EMPTY_ACTIVITY, formatTokens, timeOn } from './activity'
import * as draw from './draw'
import { factsOf } from './fit'
import { GLYPH, MEANING, label as claimLabel, stepStatus, weakest } from './lattice'
import { LIVE_COLOUR, layout, meetLine, shortClock, statusWord } from './layout'
import type { LayoutRow, Paint, Press } from './layout'
import { PANE, acceptEnglish, hiddenKey, loadPlan, pressVerb, verifyStep } from './lens'
import { VERBS } from './notes'
import { itemNamed, nowItem } from './plan'
import { drawTape } from './tape'

type On = Parameters<Register>[0]
type Dollar = Pick<CoreEngineInterface, 'state' | 'store' | 'ui' | 'fs' | 'process' | 'model' | 'clock'>

// Atoms are declared in the file that reads them: the engine lists a module's state by scanning its own consts.
const plan = atom({ plugin: 'victrix', key: 'plan' } as const, null as PlanView | null)
const cwd = atom({ plugin: 'victrix', key: 'cwd' } as const, '')
const recent = atom({ plugin: 'victrix', key: 'recent' } as const, [] as readonly RecentPlan[])
const activity = atom({ plugin: 'victrix', key: 'activity' } as const, EMPTY_ACTIVITY as Activity)
const notes = atom({ plugin: 'victrix', key: 'notes' } as const, [] as readonly Note[])
const isWorking = atom({ plugin: 'victrix', key: 'isWorking' } as const, false)
const claims = atom({ plugin: 'victrix', key: 'claims' } as const, [] as readonly Claim[])
const tick = atom({ plugin: 'victrix', key: 'tick' } as const, 0)
const questions = atom({ plugin: 'victrix', key: 'questions' } as const, [] as readonly Question[])
const changed = atom({ plugin: 'victrix', key: 'changed' } as const, [] as readonly string[])
const openedCard = atom({ plugin: 'victrix', key: 'openedCard' } as const, null as string | null)
const isPlanMode = atom({ plugin: 'victrix', key: 'isPlanMode' } as const, false)
const signals = atom({ plugin: 'victrix', key: 'signals' } as const, [] as readonly Signal[])

/**
 * The theme-key or colour each paint resolves to; `text` is the theme's own foreground. The maths and the face share
 * `permission`, the calm accent every theme defines for the engine's own asks (teal in Kanagawa, lavender in the dark
 * preset): one voice for the notation, never the orange of the live step.
 */
export const colourOf = (paint: Paint): string | undefined => (paint === 'live' ? LIVE_COLOUR : paint === 'math' ? 'permission' : paint === 'good' ? 'success' : paint === 'bad' ? 'error' : paint === 'faint' ? 'inactive' : undefined)

const parseCard = (key: string): { readonly step: string; readonly fact?: number } | null => {
  const fact = /^fact:(.+):(\d+)$/.exec(key)
  if (fact) return { step: fact[1] ?? '', fact: Number(fact[2]) }
  const step = /^step:(.+)$/.exec(key)
  return step ? { step: step[1] ?? '' } : null
}

export const registerPane = (on: On) => {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Seated inline (no dock fits), the pane is the small form: the one row; the ask row stays the band's, so the
    // digits are mounted once.
    if (e.props.placement === 'inline') return drawTape($, e, Math.max(20, e.props.bodyColumns), 'rest', Date.now())
    const { Box, Button, Text } = $.ui.resolve(e)
    const view = await read($, plan)
    const tree = view?.tree ?? null
    const spent = await read($, activity)
    const allClaims = await read($, claims)
    const tickNow = await read($, tick)
    const opened = await read($, openedCard)
    const working = await read($, isWorking)
    const offered = tree ? [] : await read($, recent)
    const columns = Math.max(8, e.props.bodyColumns)
    const height = Math.max(4, e.props.scroll.bodyRows)
    const isFocused = e.props.isFocused
    const now = Date.now()
    const live = tree ? nowItem(tree) : undefined
    const isCalling = spent.doing !== null && spent.doing !== 'thinking'
    const key = (letter: string) => (isFocused ? { hotkey: letter } : {})

    const toggleCard = (name: string) => update($, openedCard, current => (current === name ? null : name))
    const hide = async () => {
      await $.store.set(hiddenKey(await read($, cwd)), true)
      await $.ui.close({ id: PANE })
    }
    const press = (what: Press) => async () => {
      if (what.kind === 'help') return toggleCard('help')
      if (what.kind === 'plan') return loadPlan($, what.path, 'person')
      if (what.kind === 'step') return toggleCard(`step:${what.step}`)
      if (what.kind === 'fact') return toggleCard(`fact:${what.step}:${what.index}`)
      const item = tree ? itemNamed(tree, what.step) : undefined
      if (item) await verifyStep($, item)
    }
    const verbOn = (kind: (typeof VERBS)[number]['kind']) => async () => {
      if (!live) {
        $.ui.toast('no plan step to press this on yet')
        return
      }
      await pressVerb($, kind, live.name)
    }

    // The keys live behind `?`: while the pane is held they still work, as letters, without labels on screen. Over a
    // card the visible `close` button owns `e`, so the hidden one is left out there (two on one hotkey: the later wins).
    const hiddenKeys = (withExplain: boolean) =>
      isFocused ? (
        <Box key="keys" height={0} overflow="hidden">
          {VERBS.map(verb => <Button key={verb.kind} plain hotkey={verb.hotkey} label="" onPress={verbOn(verb.kind)} />)}
          {withExplain ? <Button key="k:e" plain hotkey="e" label="" onPress={() => (live ? toggleCard(`step:${live.name}`) : toggleCard('help'))} /> : null}
          <Button key="k:h" plain hotkey="h" label="" onPress={() => toggleCard('help')} />
          <Button key="k:q" plain hotkey="q" label="" onPress={hide} />
          {live?.judge ? <Button key="k:c" plain hotkey="c" label="" onPress={press({ kind: 'check', step: live.name })} /> : null}
        </Box>
      ) : null

    if (opened !== null) {
      const body = opened === 'help' ? helpRows(columns) : cardRows($, opened, tree, allClaims, spent, now, columns)
      if (body !== null) {
        const claim = opened === 'help' ? undefined : openedClaim(opened, tree, allClaims)
        return (
          <Box flexDirection="column" minHeight={height}>
            {body.map((line, index) => (
              <Text key={`card:${index}`} color={colourOf(line.paint)} dimColor={line.paint === 'dim'} bold={line.bold === true}>{draw.fit(line.text, columns)}</Text>
            ))}
            <Box flexGrow={1} />
            <Box flexDirection="row" gap={2}>
              <Text dimColor>{'    '}</Text>
              {claim?.evidence?.english !== undefined && claim.status === 'checked' ? <Button key="right" plain {...key('r')} label="right: the English says what I meant" onPress={() => acceptEnglish($, claim)} /> : null}
              <Button key="close" plain dimColor {...key('e')} label="close" onPress={() => toggleCard(opened)} />
            </Box>
            {hiddenKeys(false)}
          </Box>
        )
      }
    }

    const rows = layout({
      columns,
      rows: height,
      tree,
      claims: allClaims,
      spent,
      now,
      tick: tickNow,
      isCalling,
      isWorking: working,
      recent: offered.map(pick => ({ title: pick.title, path: pick.path })),
      ledger: await read($, changed),
      isPlanning: await read($, isPlanMode),
      signals: await read($, signals),
      // One read per draw; the layout never reads the clock itself.
      // A followed path that cannot be read is said in words, never hidden (the never-dead rule).
      ...(view && view.tree === null ? { problem: `cannot read the plan · ${view.path}` } : {}),
    })

    const paintRow = (line: LayoutRow) => {
      const spans = line.spans.map((part, index) => (
        <Text key={`${line.key}:${index}`} color={colourOf(part.paint)} dimColor={part.paint === 'dim'} bold={part.bold === true}>{part.text}</Text>
      ))
      if (line.spans.length === 0) return <Text key={line.key}>{' '}</Text>
      return line.press ? (
        <Button key={line.key} plain onPress={press(line.press)}>{spans}</Button>
      ) : (
        <Box key={line.key} flexDirection="row">{spans}</Box>
      )
    }

    return (
      <Box flexDirection="column" minHeight={height}>
        {rows.map(paintRow)}
        {hiddenKeys(true)}
      </Box>
    )
  })
}

type CardLine = { readonly text: string; readonly paint: Paint; readonly bold?: boolean }

const openedClaim = (opened: string, tree: PlanView['tree'] | null, allClaims: readonly Claim[]): Claim | undefined => {
  const parsed = parseCard(opened)
  const item = parsed && tree ? itemNamed(tree, parsed.step) : undefined
  if (!item || parsed?.fact === undefined) return undefined
  return factsOf(item, allClaims)[parsed.fact]
}

/** The `?` popup: what the marks mean, the ladder, the meet in one sentence, the three stages of rigour, the keys, the credits. */
const helpRows = (columns: number): CardLine[] => {
  const line = (text: string, paint: Paint = 'text', bold = false): CardLine => ({ text, paint, bold })
  const wrap = (text: string, paint: Paint = 'dim') => draw.wrap(text, Math.max(10, columns - 4)).map(part => line(`    ${part}`, paint))
  return [
    line('    -_-  Victrix', 'math', true),
    ...wrap('The plan beside the chat, drawn as one line: the snake is born at the right, wraps the face, and comes down the steps eating them; the orange head is Claude on the current task; proof is the maths under it; process is what Claude just did.'),
    line(''),
    line('    ✗ ⊑ △ ⊑ ◇ ⊑ ■ ⊑ ◆', 'math', true),
    ...wrap('broken, assumed, checked by you, checked by a tool, proved in the model. A claim climbs only on evidence.'),
    ...wrap('step ⊑ ⊓ {facts}: a step is never stronger than its weakest fact (theorem T1, formal/Anka.lean).'),
    line(''),
    ...wrap('Three stages of rigour (Tao): hand-waving, rigorous, post-rigorous. This pane serves the second: it asks for the proof of the obvious.'),
    line(''),
    ...wrap('keys  d doubt a line   a add a fact   w wrong path   e explain   c run the check   q hide   h this', 'text'),
    line(''),
    ...wrap('The ribbon above the prompt is the same instrument when no pane fits.'),
    line(''),
    // The end note, haiku-light: the maker, the muses, and (later) where to find it.
    line('    by V · inspired by Terence & Boris · github.com/Vvkmnn/claude-victrix-mod', 'faint'),
  ]
}

/** The card for a step or a fact: notation on the left, words on the right, Tao’s blueprint; U8 gives it its full shape. */
const cardRows = ($: Dollar, opened: string, tree: PlanView['tree'] | null, allClaims: readonly Claim[], spent: Activity, now: number, columns: number): CardLine[] | null => {
  void $
  const parsed = parseCard(opened)
  const item = parsed && tree ? itemNamed(tree, parsed.step) : undefined
  if (!item) return null
  const under = factsOf(item, allClaims)
  const claim = parsed?.fact === undefined ? undefined : under[parsed.fact]
  const low = weakest(under)
  const status = claim?.status ?? stepStatus(under)
  const says = claim ? claim.says : item.note || item.name
  const paint: Paint = status === 'broken' ? 'bad' : status === 'open' ? 'text' : 'good'
  const pair = (left: string, right: string, colour: Paint = 'text'): CardLine => ({ text: `    ${left.padEnd(14)}${right}`, paint: colour })
  const spend = spent.steps[item.name]
  const lines: CardLine[] = [
    { text: `    ${GLYPH[status]} ${says}`, paint, bold: true },
    { text: '', paint: 'text' },
    pair('says', says),
    pair(`${item.name.split(' ')[0]} ⊑ ⊓`, meetLine(item.name, under, columns).replace(/^.*?⊑ ⊓ /, ''), stepStatus(under) === 'broken' ? 'bad' : 'dim'),
    ...(claim ? [pair('⊢', claim.evidence ? `${claim.evidence.command} · exit ${claim.evidence.exitCode}${claim.evidence.cases ? ` · ${claim.evidence.cases} cases` : ''}` : statusWord(claim), claim.status === 'open' ? 'dim' : paint)] : []),
    ...(claim?.counterexample ? [pair('✗ ∃', claim.counterexample, 'bad')] : []),
    pair('∴', claim ? claimLabel(claim) : MEANING[status], 'dim'),
    ...(low && claim === low && under.length > 1 ? [pair('', 'the weakest fact of this step', 'dim')] : []),
    ...(item.why ? [pair('because', item.why, 'dim')] : []),
    pair('Σ', spend ? `${formatTokens(spend.tokens)} tokens · ${spend.calls} calls · ${spend.fails} failed · t ${shortClock(timeOn(spent, item.name, now))}` : 'nothing spent yet', 'dim'),
    ...(claim?.evidence?.english !== undefined ? [pair('english', `${claim.evidence.english}${claim.status === 'proved' ? ' · accepted by you' : ' · by a model that never saw the claim'}`, claim.status === 'proved' ? 'good' : 'dim')] : []),
  ]
  return lines
}

export type { RenderChildren, RenderInput }
