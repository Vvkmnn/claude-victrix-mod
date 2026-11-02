// Began as the plan lens of github.com/Vvkmnn/claude-emporium (plugins/emporium/hooks/lens.tsx,
// Oct 2026, same author); carried on here as Vada: assumptions, the three verbs, and the top lines.
import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register, RenderChildren } from 'claude-code'

import type { Activity, Note, NoteKind, PlanView, RecentPlan } from '../types'
import { EMPTY_ACTIVITY, describeCall, formatTokens, reduceActivity } from './activity'
import type { ActivityEvent } from './activity'
import { VERBS, appendLog, deliveryText, describeNote, logLine } from './notes'
import { arrange, fit, itemNamed, nowItem, outline, parsePlan, tally } from './plan'
import type { OutlineRow } from './plan'

type On = Parameters<Register>[0]
type Dollar = Pick<CoreEngineInterface, 'state' | 'fs' | 'store' | 'ui' | 'env' | 'prompt'>

export const PANE = 'victrix'
export const TITLE = '⊢ VICTRIX'
const RECENT_KEPT = 3
const LABEL_COLUMNS = 7

const plan = atom({ plugin: 'victrix', key: 'plan' } as const, null as PlanView | null)
const cursor = atom({ plugin: 'victrix', key: 'cursor' } as const, 0)
const toggled = atom({ plugin: 'victrix', key: 'toggled' } as const, [] as readonly string[])
const cwd = atom({ plugin: 'victrix', key: 'cwd' } as const, '')
const recent = atom({ plugin: 'victrix', key: 'recent' } as const, [] as readonly RecentPlan[])
const activity = atom({ plugin: 'victrix', key: 'activity' } as const, EMPTY_ACTIVITY as Activity)
const notes = atom({ plugin: 'victrix', key: 'notes' } as const, [] as readonly Note[])
const pendingAdd = atom({ plugin: 'victrix', key: 'pendingAdd' } as const, null as string | null)
const isWorking = atom({ plugin: 'victrix', key: 'isWorking' } as const, false)
const showWhy = atom({ plugin: 'victrix', key: 'showWhy' } as const, false)

// Per repo, so two repos never overwrite each other's choice or ledger.
const planPathKey = (dir: string) => `victrix.planPath:${dir}`
const hiddenKey = (dir: string) => `victrix.hidden:${dir}`
const logKey = (dir: string) => `victrix.log:${dir}`

// Plan files live as <anything>/.claude/plans/<name>.md; their archives are history, not the plan.
const isPlanFile = (path: string) => /\/\.claude\/plans\/[^/]+\.md$/.test(path) && !path.includes('.archive-')

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

// Helpers that take `$` are function declarations: the engine follows `$` only into declarations.
async function record($: Dollar, event: ActivityEvent) {
  await update($, activity, state => reduceActivity(state, event))
}

// An unreadable plan is drawn as such (tree null), never hidden; the reason goes to the debug log.
async function loadPlan($: Dollar, path: string) {
  const tree = await $.fs.read(path).then(
    text => parsePlan(text),
    error => {
      $.ui.log(`victrix: plan unreadable ${path}: ${errorText(error)}`, { to: 'debug' })
      return null
    },
  )
  await update($, plan, () => ({ path, tree }))
  await $.store.set(planPathKey(await read($, cwd)), path)
  $.ui.log(`victrix: plan read ${path}`, { to: 'debug' })
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

async function openPane($: Dollar, how: 'asked' | 'unasked') {
  const opened = await $.ui.open(how === 'asked' ? { id: PANE, title: TITLE, focus: true } : { id: PANE, title: TITLE })
  $.ui.log(`victrix: lens open (${how}): ${opened.isPlaced ? 'placed' : opened.reason}`, { to: 'debug' })
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
  void $.prompt.submit({ text: deliveryText(queued) })
  $.ui.log(`victrix: delivered ${queued.length} note(s) as a prompt`, { to: 'debug' })
}

// A pressed verb: logged at once, delivered at Claude's next step, told to the person in one toast.
async function pressVerb($: Dollar, kind: NoteKind, step: string) {
  if (kind === 'add') {
    await update($, pendingAdd, () => step)
    $.ui.toast(`add data · ${step}: type the fact in the prompt; Vada attaches it to this step`)
    return
  }
  const note: Note = { kind, step, text: '', at: Date.now() }
  await update($, notes, queued => [...queued, note])
  await logNote($, note)
  const working = await read($, isWorking)
  if (working) $.ui.toast(`${describeNote(note)} · reaches Claude at its next step`)
  else {
    $.ui.toast(`${describeNote(note)} · sent to Claude`)
    await deliverNotes($)
  }
}

const resolvePath = (dir: string, path: string) => (path.startsWith('/') ? path : `${dir}/${path}`)

const clamp = (at: number, length: number) => Math.max(0, Math.min(at, length - 1))

const flip = (keys: readonly string[], key: string) =>
  keys.includes(key) ? keys.filter(one => one !== key) : [...keys, key]

// vim h on a row that is not open walks to its parent, as a tree view does.
const parentOf = (rows: readonly OutlineRow[], at: number) => {
  const depth = rows[at]?.depth ?? 0
  const before = rows.slice(0, at).map((row, index) => ({ row, index }))
  return before.reverse().find(({ row }) => row.depth < depth)?.index ?? at
}

// Shape carries the meaning, colour only repeats it: ✓ done · ◉ now · ○ open · △ assumed · ~ abandoned.
const GLYPHS: Readonly<Record<OutlineRow['mark'], string>> = { done: '✓', abandoned: '~', open: '○', now: '◉', assumed: '△', section: '' }

const rowText = (row: OutlineRow) => {
  const fold = row.isFoldable ? (row.isOpen ? '▾' : '▸') : ' '
  const body = row.kind === 'section' ? `${row.label.toUpperCase()} ${row.count}` : `${GLYPHS[row.mark]} ${row.label}`
  return `${'  '.repeat(Math.max(0, row.depth - 1))}${fold} ${body}`
}

const ago = (mtimeMs: number, now: number) => {
  const minutes = Math.max(0, Math.round((now - mtimeMs) / 60_000))
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

const firstSentence = (text: string) => {
  const end = text.search(/[.!?](\s|$)/)
  return end === -1 ? text : text.slice(0, end + 1)
}

export const registerLens = (on: On) => {
  on('session.start', async ($, e, next) => {
    await update($, cwd, () => e.cwd)
    await $.command.register({
      name: 'victrix',
      description: 'Open the Vada plan lens: the plan live, its assumptions, and what Claude is doing',
      argumentHint: '[plan file]',
    })
    const saved = await $.store.get(planPathKey(e.cwd))
    if (typeof saved === 'string') await loadPlan($, saved)
    if ((await read($, plan)) === null) await refreshRecent($)
    if ((await $.store.get(hiddenKey(e.cwd))) !== true) await openPane($, 'unasked')

    return next(e)
  })

  on('command.run', { command: 'victrix' }, async ($, e) => {
    const dir = await read($, cwd)
    const named = e.args.trim()
    const current = await read($, plan)
    if (named !== '') await loadPlan($, resolvePath(dir, named))
    else if (current) await loadPlan($, current.path)
    else await refreshRecent($)
    await $.store.delete(hiddenKey(dir))
    await openPane($, 'asked')

    return { text: 'Vada lens opened.' }
  })

  // A person's close (its mark or key) keeps the lens hidden across sessions until /victrix.
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await $.store.set(hiddenKey(await read($, cwd)), true)
    return next(e)
  })

  // The engine names this session's own plan file in its plan-mode notes; a helper's notes are its own.
  on('prompt.attachment', { type: ['plan_mode', 'plan_mode_exit', 'plan_mode_reentry'] }, async ($, e, next) => {
    const path = e.agentId === undefined && 'detail' in e ? e.detail?.planFilePath : undefined
    const current = await read($, plan)
    if (path !== undefined && path !== current?.path) await loadPlan($, path)

    return next(e)
  })

  // The person's prompt carries the queued notes as context the model reads beside it; a typed
  // fact after `a` becomes that step's add-data note. Vada's own delivery prompts pass untouched.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin' || e.command !== undefined) return next(e)
    const step = await read($, pendingAdd)
    const typed = e.text.trim()
    const added: Note[] = step !== null && typed !== '' ? [{ kind: 'add', step, text: typed, at: Date.now() }] : []
    for (const note of added) await logNote($, note)
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
    }
    return next(e)
  })

  // A helper's turn carries agentId; only the main loop's end is a step Claude finished.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, isWorking, () => false)
      await record($, { kind: 'turn-end' })
      await deliverNotes($)
    }
    return next(e)
  })

  // Every request's tokens count, the helpers' too: that is what the session spent.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    if (result.usage) await record($, { kind: 'usage', usage: result.usage })
    return result
  })

  // Observes only: the call runs as it would, and its result comes back unchanged.
  on('tool.call', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const input: Readonly<Record<string, unknown>> = { ...e }
    const text = describeCall(e.tool, input)
    if (isMain) await record($, { kind: 'call-start', text })
    const result = await next(e)
    const isOk = result.deny === undefined && result.isError !== true
    if (isMain) await record($, { kind: 'call-end', text, isOk })
    const path = typeof input.file_path === 'string' ? input.file_path : undefined
    const isPlanWrite = (e.tool === 'Edit' || e.tool === 'Write') && path !== undefined && isPlanFile(path)
    if (isMain && isOk && isPlanWrite) await loadPlan($, path)

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const view = await read($, plan)
    const tree = view?.tree ?? null
    const offered = view ? [] : await read($, recent)
    const spent = await read($, activity)
    const queued = await read($, notes)
    const waitingAdd = await read($, pendingAdd)
    const explaining = await read($, showWhy)
    const { body, tray } = tree ? arrange(outline(tree, await read($, toggled))) : { body: [], tray: [] }
    const rows = [...body, ...tray]
    const at = clamp(await read($, cursor), rows.length + offered.length)
    const now = Date.now()
    const nowStep = tree ? nowItem(tree) : undefined
    const selectedStep = tree && rows[at] ? itemNamed(tree, rows[at].step) : undefined

    const moveTo = (index: number) => update($, cursor, () => clamp(index, rows.length + offered.length))
    // A fold moves rows (an opened tray section joins the body), so the selection follows the row acted on.
    const toggle = async (key: string) => {
      const keys = await update($, toggled, current => flip(current, key))
      if (!tree) return
      const after = arrange(outline(tree, keys))
      const index = [...after.body, ...after.tray].findIndex(row => row.key === key)
      if (index >= 0) await update($, cursor, () => index)
    }
    const follow = (path: string) => loadPlan($, path)
    const open = () => {
      const row = rows[at]
      const pick = offered[at - rows.length]
      if (pick) return follow(pick.path)
      return row?.isFoldable && !row.isOpen ? toggle(row.key) : undefined
    }
    const fold = () => {
      const row = rows[at]
      return row?.isOpen ? toggle(row.key) : moveTo(parentOf(rows, at))
    }
    const hide = async () => {
      await $.store.set(hiddenKey(await read($, cwd)), true)
      await $.ui.close({ id: PANE })
    }
    const explain = () => update($, showWhy, current => !current)
    const pressRow = (index: number) => async () => {
      const row = rows[index]
      if (row?.isFoldable) await toggle(row.key)
      else await moveTo(index)
    }
    // A verb needs a step: the selected row's; on a section head, or with nothing selected, the step being worked.
    const verbOn = (kind: NoteKind) => async () => {
      const row = rows[at]
      const step = row !== undefined && row.kind !== 'section' ? row.step : nowStep?.name
      if (step === undefined) {
        $.ui.toast('no plan step to press this on yet')
        return
      }
      await pressVerb($, kind, step)
    }
    const copy = async (press: { surface: Parameters<typeof $.ui.copy>[0]['surface'] }) => {
      const item = selectedStep ?? nowStep
      if (!item) return
      const text = [item.name, item.note, item.why && `why: ${item.why}`, item.judge && `judge: ${item.judge}`].filter(Boolean).join(' — ')
      const copied = await $.ui.copy({ text, surface: press.surface })
      $.ui.toast(copied.isCopied ? `copied: ${fit(item.name, 40)}` : `could not copy: ${copied.reason}`)
    }

    const group = (label: string, ...children: RenderChildren[]) => (
      <Box flexDirection="row" marginBottom={1}>
        <Box width={LABEL_COLUMNS} flexShrink={0}>
          <Text dimColor bold>{label}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {children}
        </Box>
      </Box>
    )

    // Cells beside the label column; every string is cut to it here, not left to the renderer.
    const room = Math.max(12, e.props.bodyColumns - LABEL_COLUMNS)
    const trayRoom = Math.max(8, Math.floor(room / Math.max(1, tray.length)) - 3)

    const line = (text: string, props: Record<string, unknown> = {}) => (
      <Text {...props}>{fit(text, room)}</Text>
    )

    const outlineRow = (row: OutlineRow, index: number, width = room) => (
      <Button key={row.key} plain onPress={pressRow(index)}>
        <Text
          inverse={index === at}
          bold={row.isNow}
          color={row.mark === 'now' ? 'claude' : row.mark === 'assumed' ? 'warning' : undefined}
          dimColor={row.mark === 'done' || row.mark === 'abandoned'}
          strikethrough={row.mark === 'abandoned'}
        >
          {fit(rowText(row), width)}
        </Text>
      </Button>
    )

    const header = (
      <Box flexDirection="row" marginBottom={1}>
        <Text color="claude" bold>{TITLE}</Text>
        <Text dimColor>{fit(tree?.progress ? ` · ${tree.progress}` : view ? '' : ' · no plan followed', Math.max(4, e.props.bodyColumns - TITLE.length))}</Text>
      </Box>
    )

    // The three checks on top: what Claude thinks you want, what it leans on, why this step.
    const topLines = () => {
      if (!tree) return null
      const wants = tree.summary ? firstSentence(tree.summary) : tree.title ?? 'the plan has no summary yet'
      const assumed = nowStep?.assumptions.length ?? 0
      const world = nowStep === undefined
        ? 'every step is done'
        : assumed === 0
          ? `nothing assumed in the wording of "${nowStep.name}"`
          : `△ ${assumed} assumed under "${nowStep.name}" · from the plan's wording`
      const why = nowStep === undefined ? '' : nowStep.why || nowStep.note || 'the plan gives no why for this step'
      return [
        group('WANTS', line(wants)),
        group('WORLD', line(world, assumed > 0 ? { color: 'warning' } : { dimColor: true })),
        group('WHY', line(why, why.startsWith('the plan gives') ? { dimColor: true } : {})),
      ]
    }

    const planGroup = () => {
      if (view && !tree) return group('PLAN', line('cannot read the plan', { color: 'warning' }), line(view.path.length > room ? `…${view.path.slice(-(room - 1))}` : view.path, { dimColor: true }))
      if (tree) {
        return group(
          'PLAN',
          line(tree.title ?? view?.path ?? '', { bold: true }),
          ...body.map((row, index) => outlineRow(row, index)),
          tray.length > 0 && (
            <Box flexDirection="row" gap={3}>
              {tray.map((row, index) => outlineRow(row, body.length + index, trayRoom))}
            </Box>
          ),
        )
      }
      if (offered.length === 0) return group('PLAN', line('no plan files yet', { bold: true }), line('enter plan mode (shift+tab) and it shows here', { dimColor: true }))
      return group(
        'PLAN',
        line('none followed · pick one', { bold: true }),
        ...offered.map((pick, index) => (
          <Button key={`p:${pick.path}`} plain onPress={() => follow(pick.path)}>
            <Text inverse={rows.length + index === at}>
              {fit(`${pick.title}  ${ago(pick.mtimeMs, now)}`, room)}
            </Text>
          </Button>
        )),
      )
    }

    // `e` on a row: that step's why, trade and judge in full, the plan's own words.
    const explainGroup = () => {
      if (!explaining || !selectedStep) return null
      const parts = [
        ['why', selectedStep.why],
        ['trade', selectedStep.trade],
        ['judge', selectedStep.judge],
        ['note', selectedStep.note],
      ].filter(([, text]) => text !== '')
      return group(
        'STEP',
        line(selectedStep.name, { bold: true }),
        ...(parts.length === 0 ? [line('the plan says nothing more about this step', { dimColor: true })] : parts.map(([name, text]) => line(`${name}: ${text}`))),
      )
    }

    const doing = spent.doing ?? (spent.last[0] ? `idle · last ${spent.last[0].text}` : 'idle')
    const lastLines = spent.last.length === 0
      ? [line('nothing yet this session', { dimColor: true })]
      : spent.last.map(entry => line(entry.isOk ? entry.text : `${entry.text} · failed`, entry.isOk ? { dimColor: true } : { color: 'warning' }))

    const notesGroup = () => {
      if (queued.length === 0 && waitingAdd === null) return null
      return group(
        'NOTES',
        ...(waitingAdd === null ? [] : [line(`add data · ${waitingAdd} · type the fact in the prompt`, { color: 'claude' })]),
        ...queued.map(note => line(`${describeNote(note)} · at Claude's next step`, { color: 'warning' })),
      )
    }

    const counts = tree ? tally(tree) : null
    const tallyLine = counts
      ? `✓ ${counts.done} · ○ ${counts.open} · △ ${counts.assumed}${counts.abandoned > 0 ? ` · ~ ${counts.abandoned}` : ''}`
      : ''
    const foot = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>{fit(tallyLine, Math.max(8, Math.floor(e.props.bodyColumns / 2)))}</Text>
        <Text dimColor>{`${formatTokens(spent.tokensIn)} in · ${formatTokens(spent.tokensOut)} out`}</Text>
      </Box>
    )

    const legend = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        <Button key="down" plain dimColor hotkey="j" label="down" onPress={() => moveTo(at + 1)} />
        <Button key="up" plain dimColor hotkey="k" label="up" onPress={() => moveTo(at - 1)} />
        <Button key="open" plain dimColor hotkey="l" label="open" onPress={open} />
        <Button key="fold" plain dimColor hotkey="h" label="fold" onPress={fold} />
        {VERBS.map(verb => (
          <Button key={verb.kind} plain dimColor hotkey={verb.hotkey} label={verb.label} onPress={verbOn(verb.kind)} />
        ))}
        <Button key="explain" plain dimColor hotkey="e" label="explain" onPress={explain} />
        <Button key="copy" plain dimColor hotkey="y" label="copy" onPress={copy} />
        <Button key="hide" plain dimColor hotkey="q" label="hide" onPress={hide} />
      </Box>
    )

    return (
      <Box flexDirection="column" minHeight={e.props.scroll.bodyRows}>
        {header}
        {topLines()}
        {planGroup()}
        {explainGroup()}
        {notesGroup()}
        {group('NOW', line(doing, { bold: spent.doing !== null }))}
        {group('LAST', ...lastLines)}
        <Box flexGrow={1} />
        {foot}
        {legend}
      </Box>
    )
  })
}
