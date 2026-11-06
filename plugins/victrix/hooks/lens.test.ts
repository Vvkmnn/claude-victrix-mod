import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

import { renderPlain } from './render'
import type { Drawn } from './render'

type On = Parameters<TestBody>[1]

const SURFACES = ['terminal', 'desktop'] as const

const HOME = '/home/me'
const PLANS = `${HOME}/.claude/plans`
const PATH = `${PLANS}/brave-otter.md`
const CWD = '/repo'

const PLAN = [
  '# Brave otter',
  '**Progress: 1/3 done** | Active: Lens',
  '## Summary',
  'Plans get too big to follow. The lens walks them live.',
  '## Done',
  '- [x] **Crab** — band',
  '## In Progress',
  '- [ ] **Lens** — the outline · because: plans are hard to follow · verify: one screen · facts: claude: prices are in cents · guard: cut every row, 1 compare',
  '  - [x] **Parser**',
  '  - [ ] **Panel**',
  '## Up Next',
  '- [ ] **Gaits**',
].join('\n')

const PANE_PROPS = {
  title: 'victrix',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 5 },
  view: {},
} as const

type Listed = { readonly name: string; readonly mtimeMs: number }

type World = {
  readonly files: Map<string, string>
  readonly opened: { id: string; title?: string; focus?: true; columns?: number }[]
  readonly closed: unknown[]
  readonly registered: unknown[]
  readonly read: string[]
  readonly submitted: { text: string; context?: readonly string[] }[]
  readonly toasts: string[]
  readonly statuses: (string | undefined)[]
  readonly copied: string[]
  readonly store: Record<string, unknown>
}

type Setup = { files?: Record<string, string>; store?: Record<string, unknown>; listed?: readonly Listed[]; placed?: boolean }

/** A gate a test opens to let a tool call beneath the mod finish, so the in-flight state can be looked at first. */
const gate = () => {
  let open = () => {}
  const until = new Promise<void>(resolve => { open = resolve })
  return { until, open: () => open() }
}

// The kit's bottom hook throws, so these stand in for the engine beneath the mod and record what it asked of it.
const beneath = (on: On, { files = {}, store = {}, listed = [], placed = true }: Setup = {}): World => {
  const world: World = { files: new Map(Object.entries(files)), opened: [], closed: [], registered: [], read: [], submitted: [], toasts: [], statuses: [], copied: [], store }
  on('store.get', async (_$, e) => ({ value: world.store[e.key] }))
  on('store.set', async (_$, e) => {
    world.store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', async (_$, e) => {
    delete world.store[e.key]
    return { value: undefined }
  })
  on('store.keys', async () => ({ value: Object.keys(world.store) }))
  mock.env(on, { HOME })
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async (_$, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', async (_$, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', async (_$, e) => {
    world.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => {
    world.registered.push(e)
    return { value: { command: e.name } }
  })
  on('ui.open', async (_$, e) => {
    world.opened.push(e)
    return { value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }
  })
  on('ui.close', async (_$, e) => {
    world.closed.push(e)
    return { value: undefined }
  })
  on('fs.read', async (_$, e) => {
    world.read.push(e.path)
    const text = world.files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.list', async (_$, e) => {
    if (e.path !== PLANS) throw new Error(`ENOENT: ${e.path}`)
    return { value: listed.map(entry => ({ ...entry, kind: 'file', size: 1, isLink: false })) }
  })
  on('prompt.attachment', async (_$, e) => ({ text: e.text }))
  on('prompt.submit', async (_$, e) => {
    world.submitted.push({ text: e.text, context: e.context })
    return { text: e.text, context: e.context }
  })
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('tool.call', async (_$, e) => ({
    result: { type: 'update', filePath: String((e as { file_path?: string }).file_path), content: '', structuredPatch: [], originalFile: null },
  }) as never)
  return world
}

const START = { cwd: CWD, surface: 'terminal', isInteractive: true } as const

const RUN = {
  command: 'victrix',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const

const TYPED = (text: string) => ({ text, origin: { kind: 'composer' }, wait: false }) as const

const planNote = (path: string, agentId?: string, type: 'plan_mode' | 'plan_mode_exit' = 'plan_mode') => ({
  type,
  text: 'Plan mode is active.',
  origin: { kind: 'engine' },
  ...(agentId === undefined ? {} : { agentId }),
  detail: { reminder: 'full', planFilePath: path, hasPlan: true },
}) as const

type Found = { text: string; props: Record<string, unknown> }
type Site = { findAll: (query: { type: string }) => Promise<readonly Found[]>; press: (target: { key: string }) => Promise<unknown>; drawn: () => Promise<unknown> }

/** The site laid out as plain rows at a width, as the preview does, so a test can count rows and measure them. */
const rowsOf = async (site: Site, columns: number): Promise<string[]> => renderPlain((await site.drawn()) as Drawn, columns)

/** Lets a call that was started without await reach the mod's hook before the pane is looked at. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 25))

const textsOf = async (site: Site) => (await site.findAll({ type: 'Text' })).map(text => text.text)
const joined = async (site: Site) => (await textsOf(site)).join('')
const selectedOf = async (site: Site) => (await site.findAll({ type: 'Text' })).filter(text => text.props.inverse === true).map(text => text.text).join('')
const keysOf = async (site: Site) => (await site.findAll({ type: 'Button' })).map(button => String(button.props.hotkey ?? ''))

for (const surface of SURFACES) {
  const mountPane = ($: Engine): Promise<Site> =>
    $.ui.mount({ plugin: 'victrix', surface, component: 'Pane', requestId: 'victrix', props: PANE_PROPS })
  const mountBand = ($: Engine, props = BAND_PROPS): Promise<Site> =>
    $.ui.mount({ plugin: 'victrix', surface, component: 'AbovePrompt', requestId: 'victrix', props })

  // Opening, forms, hiding

  test(`${surface}: session start registers /victrix and opens the map unasked at the engine's share, the width being unknown yet`, async ($, on) => {
    const world = beneath(on)
    await $.session.start(START)
    expect(world.registered).toEqual([expect.objectContaining({ name: 'victrix', description: expect.stringContaining('plan') })])
    expect(world.opened).toEqual([{ id: 'victrix', title: 'victrix', backgroundColor: 'transparent' }])
  })

  test(`${surface}: a dock the person hid stays hidden at the next session start`, async ($, on) => {
    const world = beneath(on, { store: { [`victrix.hidden:${CWD}`]: true } })
    await $.session.start(START)
    expect(world.opened).toEqual([])
  })

  test(`${surface}: /victrix opens the dock focused, clears the hide, and says so`, async ($, on) => {
    const world = beneath(on, { store: { [`victrix.hidden:${CWD}`]: true } })
    await $.session.start(START)
    const answer = await $.command.run(RUN)
    expect(answer).toMatchObject({ text: 'Victrix opened.' })
    expect(world.store[`victrix.hidden:${CWD}`]).toBeUndefined()
    expect(world.opened.at(-1)).toMatchObject({ id: 'victrix', focus: true })
  })

  test(`${surface}: the dock is the map at 27% of the terminal in plan mode and stays so after it`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.command.run(RUN)
    await $.prompt.attachment(planNote(PATH))
    expect(world.opened.at(-1)?.columns).toBe(43)
    await $.prompt.attachment(planNote(PATH, undefined, 'plan_mode_exit'))
    expect(world.opened.at(-1)?.columns).toBe(43)
  })

  test(`${surface}: q hides the dock and keeps it hidden`, async ($, on) => {
    const world = beneath(on)
    await $.session.start(START)
    const pane = await mountPane($)
    await pane.press({ key: 'k:q' })
    expect(world.closed).toEqual([expect.objectContaining({ id: 'victrix' })])
    expect(world.store[`victrix.hidden:${CWD}`]).toBe(true)
  })

  // The plan on the trunk

  test(`${surface}: the plan-mode note names the plan and the trunk draws it: done, the lit step, its facts, the rest`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    const texts = await textsOf(pane)
    const drawn = texts.join('')
    // The hub: the snake's corner at the top left, its tail along the top row, the plan's name and count beside the spine.
    expect(drawn).toContain('┏━')
    expect(drawn).toContain('1/3 steps · ')
    // The snake comes down the steps: the done step ticked, the live one with its clock, the tasks ahead as food.
    expect(drawn).toMatch(/┃ \[ \] Lens\s+· \d+s/)
    expect(drawn).toContain('[✓] Crab')
    expect(drawn).toContain('○ [ ] Gaits')
    // Proof: the meet in notation, the fact in words then its rung, the check with its verify line.
    expect(drawn).toContain('Lens ≤ min {')
    expect(drawn).toContain('prices are in cents')
    expect(drawn).toContain('Claude assumes this; nobody checked it')
    expect(drawn).toContain('check one screen')
    expect(drawn).toContain('proof')
    expect(drawn).toContain('process')
    // No zone rules, no gauges, no tree glyphs, nothing of the old labels.
    expect(drawn).not.toContain('─ now ')
    expect(drawn).not.toContain('gauges')
    expect(drawn).not.toContain('├')
    expect((await pane.findAll({ type: 'Text' })).find(text => text.text === 'Lens')?.props.color).toBe('rgb(215,119,87)')
    // An assumed fact is quiet: the theme's text with the ○ carrying the meaning; red is kept for broken and needs-you.
    expect((await pane.findAll({ type: 'Text' })).find(text => text.text === 'prices are in cents')?.props.color).toBeUndefined()
  })

  test(`${surface}: every row fits the pane: no Text wider than the body`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    for (const text of await textsOf(pane)) expect(Array.from(text).length).toBeLessThanOrEqual(PANE_PROPS.bodyColumns)
  })

  test(`${surface}: a helper's plan note is not this session's plan`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH, 'agent-1'))
    expect(world.read).toEqual([])
  })

  test(`${surface}: an edit to the plan re-reads it, redraws, and writes one changed line`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    world.files.set(PATH, PLAN.replace('- [ ] **Lens**', '- [x] **Lens**'))
    await $.tool.call({ tool: 'Edit', tool_use_id: 't1', file_path: PATH, old_string: 'a', new_string: 'b' } as never)
    const pane = await mountPane($)
    expect(await joined(pane)).toContain('2/3 steps')
    expect(await joined(pane)).toContain('Lens · open → done')
  })

  test(`${surface}: the mod sets no status line under the prompt: the pane and the row are its only places`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    await $.turn.start({ turnId: 'turn-1', prompt: 'go' } as never)
    await $.turn.complete({ turnId: 'turn-1' } as never)
    expect(world.statuses).toEqual([])
  })

  test(`${surface}: a plan path that cannot be read never replaces the plan being followed (a resumed session's fresh name)`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    await $.prompt.attachment(planNote(`${PLANS}/ghost-not-written-yet.md`))
    const pane = await mountPane($)
    const drawn = await joined(pane)
    expect(drawn).toContain('[ ] Lens')
    expect(drawn).not.toContain('cannot read the plan')
    expect(drawn).not.toContain('step removed')
    expect(world.read.filter(path => path.endsWith('ghost-not-written-yet.md')).length).toBeGreaterThan(0)
  })

  test(`${surface}: a switch to another plan that reads is one ledger line, and a change from outside this session says so`, async ($, on) => {
    const other = `${PLANS}/calm-heron.md`
    const world = beneath(on, { files: { [PATH]: PLAN, [other]: PLAN.replace('# Brave otter', '# Calm heron').replace('**Lens**', '**Wings**') } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    await $.prompt.attachment(planNote(other))
    const pane = await mountPane($)
    expect(await joined(pane)).toContain('following · Calm heron')
    expect(await joined(pane)).not.toContain('step removed')
    world.files.set(other, world.files.get(other)!.replace('- [ ] **Wings**', '- [x] **Wings**'))
    await $.turn.start({ turnId: 'turn-1', prompt: 'go' } as never)
    await $.turn.complete({ turnId: 'turn-1' } as never)
    expect(await joined(pane)).toContain('Wings · open → done · outside this session')
  })

  test(`${surface}: a step flipping to done sends a review of the next step at the turn's end: three lines, premises, questions first`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    await $.turn.start({ turnId: 'turn-1', prompt: 'go' } as never)
    world.files.set(PATH, PLAN.replace('- [ ] **Lens**', '- [x] **Lens**'))
    await $.tool.call({ tool: 'Edit', tool_use_id: 't1', file_path: PATH, old_string: 'a', new_string: 'b' } as never)
    expect(world.submitted).toEqual([])
    await $.turn.complete({ turnId: 'turn-1' } as never)
    const review = world.submitted.find(one => one.text.includes('REVIEW before step'))
    expect(review?.text).toContain('REVIEW before step "Gaits"')
    expect(review?.text).toContain('Preview it in three lines')
    expect(review?.text).toContain('status = min {')
    expect(review?.text).toContain('wait for the answers before any tool call')
    const pane = await mountPane($)
    expect(await joined(pane)).toContain('review · Gaits')
  })

  test(`${surface}: many calls on one step with the plan untouched is drift: one ledger line and one message, once per step`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    await $.turn.start({ turnId: 'turn-1', prompt: 'go' } as never)
    for (let n = 0; n < 25; n += 1) await $.tool.call({ tool: 'Read', tool_use_id: `r${n}`, file_path: `/repo/src/${n}.ts` } as never)
    await $.turn.complete({ turnId: 'turn-1' } as never)
    const drift = world.submitted.filter(one => one.text.includes('DRIFT'))
    expect(drift).toHaveLength(1)
    expect(drift[0]?.text).toContain('25 tool calls on step "Lens"')
    expect(await joined(await mountPane($))).toContain('drift · Lens · 25 calls')
    await $.turn.start({ turnId: 'turn-2', prompt: 'go' } as never)
    await $.tool.call({ tool: 'Read', tool_use_id: 'r99', file_path: '/repo/src/99.ts' } as never)
    await $.turn.complete({ turnId: 'turn-2' } as never)
    expect(world.submitted.filter(one => one.text.includes('DRIFT'))).toHaveLength(1)
  })

  test(`${surface}: a write to a plan file adopts it when no note named one`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.tool.call({ tool: 'Write', tool_use_id: 't1', file_path: PATH, content: PLAN } as never)
    expect(world.store[`victrix.planPath:${CWD}`]).toBe(PATH)
  })

  test(`${surface}: edits to other files and to plan archives never read them as the plan`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.tool.call({ tool: 'Edit', tool_use_id: 't1', file_path: '/repo/src/index.ts', old_string: 'a', new_string: 'b' } as never)
    await $.tool.call({ tool: 'Edit', tool_use_id: 't2', file_path: `${PLANS}/brave-otter.archive-2026-10-13.md`, old_string: 'a', new_string: 'b' } as never)
    expect(world.read).toEqual([])
  })

  test(`${surface}: the plan followed in this repo is followed again at session start`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN }, store: { [`victrix.planPath:${CWD}`]: PATH } })
    await $.session.start(START)
    expect(world.read).toContain(PATH)
    expect(await joined(await mountPane($))).toContain('1/3 steps')
  })

  test(`${surface}: /victrix <path> follows the named plan, relative to the repo`, async ($, on) => {
    const world = beneath(on, { files: { '/repo/docs/PLAN.md': PLAN } })
    await $.session.start(START)
    await $.command.run({ ...RUN, args: 'docs/PLAN.md' })
    expect(world.read).toContain('/repo/docs/PLAN.md')
  })

  test(`${surface}: an unreadable plan is drawn as such, with its path`, async ($, on) => {
    beneath(on, { store: { [`victrix.planPath:${CWD}`]: PATH } })
    await $.session.start(START)
    const texts = await textsOf(await mountPane($))
    expect(texts.some(text => text.includes('cannot read the plan · '))).toBe(true)
  })

  test(`${surface}: with no plan anywhere the pane says so and how one comes`, async ($, on) => {
    beneath(on)
    await $.session.start(START)
    const drawn = await joined(await mountPane($))
    expect(drawn).toContain('no plan yet')
    expect(drawn).toContain('shift+tab')
  })

  test(`${surface}: with no plan followed it offers the newest plan files, newest first, and a press follows one`, async ($, on) => {
    const world = beneath(on, {
      files: { [PATH]: PLAN, [`${PLANS}/older.md`]: '# Older plan\n## Up Next\n- [ ] **x**' },
      listed: [
        { name: 'older.md', mtimeMs: 1_000 },
        { name: 'brave-otter.md', mtimeMs: 2_000 },
      ],
    })
    await $.session.start(START)
    const pane = await mountPane($)
    const texts = await textsOf(pane)
    expect(texts.indexOf('Brave otter')).toBeLessThan(texts.indexOf('Older plan'))
    await pane.press({ key: `plan:${PATH}` })
    expect(world.store[`victrix.planPath:${CWD}`]).toBe(PATH)
  })

  // What Claude is doing

  test(`${surface}: the running call shows in the flow, then stays as the last call`, async ($, on) => {
    const held = gate()
    on('tool.call', { tool: 'Read' }, async () => { await held.until; return { result: 'ok' } as never })
    beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    await $.turn.start({ turnId: 'turn-1', prompt: 'go' } as never)
    const call = $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: '/repo/src/cart.ts' } as never)
    await settle()
    const pane = await mountPane($)
    expect(await joined(pane)).toContain('read cart.ts')
    expect((await textsOf(pane)).join('')).toContain('┏━')
    held.open()
    await call
    // Once it ends the head row goes back to thinking and the read stays as the last action (owner: the log shows
    // anything Claude is doing for the plan, reads included).
    expect(await joined(pane)).toContain('thinking')
    expect(await joined(pane)).toContain('✓ read cart.ts')
  })

  test(`${surface}: a helper's calls reach the log at engine speed behind the helper's description, running then done, and never move the head row`, async ($, on) => {
    const held = gate()
    on('tool.call', { tool: 'Read' }, async () => { await held.until; return { result: '1\tx\n2\ty' } as never })
    on('agent.list', async () => ({ value: [{ id: 'a1', description: 'scan the glyph dictionary', status: 'running' }] }) as never)
    beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    await $.turn.start({ turnId: 'turn-1', prompt: 'go' } as never)
    const call = $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: '/repo/src/layout.ts', agentId: 'a1' } as never)
    await settle()
    const pane = await mountPane($)
    const during = await joined(pane)
    // The tag is the Agent call's description, cut to 24 cells.
    expect(during).toContain('scan the glyph dictiona… · read layout.ts')
    expect(during).toContain('thinking')
    held.open()
    await call
    const after = await joined(pane)
    expect(after).toMatch(/✓ scan the glyph dictiona… · read layout\.ts\s+· 2 lines/)
    expect(after).toContain('thinking')
  })

  test(`${surface}: a failed call is red in doing and counts against the step; a declined one is dim and counts for nothing`, async ($, on) => {
    on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: 'boom' }) as never)
    on('tool.call', { tool: 'Write' }, async () => ({ deny: 'the person said no' }) as never)
    beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    await $.tool.call({ tool: 'Bash', tool_use_id: 't1', command: 'npm test' } as never)
    await $.tool.call({ tool: 'Write', tool_use_id: 't2', file_path: '/repo/src/a.ts', content: 'x' } as never)
    const pane = await mountPane($)
    const texts = await pane.findAll({ type: 'Text' })
    expect(texts.find(text => text.text.startsWith('run npm test'))?.props.color).toBe('error')
    const declined = texts.find(text => text.text.includes('declined by you'))
    expect(declined?.props.color).toBeUndefined()
    expect(declined?.props.dimColor).toBe(true)
    expect(await joined(pane)).toContain('✗')
  })

  // Steering

  test(`${surface}: the keys live behind ?: bound while the pane is held, none while it is loose, and no labels either way`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const held = await mountPane($)
    expect(await keysOf(held)).toEqual(expect.arrayContaining(['d', 'a', 'w', 'e', 'h', 'q']))
    // A key carries no word of its own on screen: the rows are the only buttons with text, and `?` is the one control.
    const keyed = (await held.findAll({ type: 'Button' })).filter(button => button.props.hotkey !== undefined)
    expect(keyed.every(button => String(button.props.label ?? '') === '')).toBe(true)
    expect(await joined(held)).toContain('?')
  })

  test(`${surface}: with the pane loose no letter key is bound`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const loose = await $.ui.mount({ plugin: 'victrix', surface, component: 'Pane', requestId: 'victrix', props: { ...PANE_PROPS, isFocused: false } })
    expect((await keysOf(loose)).filter(key => /[a-z]/.test(key))).toEqual([])
    expect(await joined(loose)).toContain('?')
  })

  test(`${surface}: d while Claude is idle sends the doubt to Claude at once, as a prompt, and logs it`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    await pane.press({ key: 'doubt' })
    expect(world.submitted[0]?.text).toContain('DOUBT on step "Lens"')
    const log = world.store[`victrix.log:${CWD}`] as string[]
    expect(log[0]).toContain('doubt · Lens')
    expect(await joined(pane)).toContain('doubt · Lens')
  })

  test(`${surface}: a verb delivered before a call becomes that call's reason in the did zone, as "you said"`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    await pane.press({ key: 'doubt' })
    await $.turn.start({ turnId: 'turn-2', prompt: 'go' } as never)
    await $.tool.call({ tool: 'Edit', tool_use_id: 'r1', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' } as never)
    expect(await joined(pane)).toContain('you said: doubt · Lens')
  })

  test(`${surface}: w while Claude works waits in the you slot and rides the person's next prompt as context`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    await $.turn.start({ turnId: 'turn-1', prompt: 'go' } as never)
    const pane = await mountPane($)
    await pane.press({ key: 'wrong' })
    expect(world.submitted).toEqual([])
    expect(await joined(pane)).toContain('wrong path · Lens')
    await $.prompt.submit(TYPED('carry on'))
    expect(world.submitted[0]?.context?.[0]).toContain('WRONG PATH on step "Lens"')
    expect(await joined(pane)).not.toContain('Claude sees it next step')
  })

  test(`${surface}: notes still queued when the turn ends are sent as Vada's own prompt`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    await $.turn.start({ turnId: 'turn-1', prompt: 'go' } as never)
    await (await mountPane($)).press({ key: 'doubt' })
    expect(world.submitted).toEqual([])
    await $.turn.complete({ turnId: 'turn-1', answer: '', durationMs: 1, isAborted: false, reason: 'done' } as never)
    expect(world.submitted[0]?.text).toContain('DOUBT on step "Lens"')
  })

  test(`${surface}: a asks for the fact in the prompt; the typed prompt becomes that step's fact, by you, not checked`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    await pane.press({ key: 'add' })
    // The ask lives on the ribbon above the prompt, never in the pane.
    const ribbon = await mountBand($)
    expect(await joined(ribbon)).toContain('add a fact · Lens')
    expect(await joined(pane)).not.toContain('add a fact')
    await $.prompt.submit(TYPED('prices are integers in cents'))
    expect(world.submitted[0]?.context?.[0]).toContain('ADD DATA for step "Lens": prices are integers in cents.')
    expect(await joined(pane)).toContain('prices are integers in cents')
    await pane.press({ key: 'proof:fact:1' })
    expect(await joined(pane)).toContain('you said so · not checked yet')
  })

  test(`${surface}: a slash command typed after a is not the fact; the ask stays`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    await pane.press({ key: 'add' })
    await $.prompt.submit({ ...TYPED('/victrix'), command: { name: 'victrix', args: '' } } as never)
    expect(await joined(await mountBand($))).toContain('add a fact · Lens')
  })

  test(`${surface}: a verb with no plan says so and sends nothing`, async ($, on) => {
    const world = beneath(on)
    await $.session.start(START)
    await (await mountPane($)).press({ key: 'doubt' })
    expect(world.toasts).toEqual(['no plan step to press this on yet'])
    expect(world.submitted).toEqual([])
  })

  test(`${surface}: e opens the card: notation on the left, words on the right, the meet and the step's because`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    await pane.press({ key: 'k:e' })
    const texts = await textsOf(pane)
    expect(texts.some(text => text.includes('says'))).toBe(true)
    expect(texts.some(text => text.includes('Lens ≤ min'))).toBe(true)
    expect(texts.some(text => text.includes('{ ○'))).toBe(true)
    expect(texts.some(text => text.includes('because') && text.includes('plans are hard to follow'))).toBe(true)
    expect(texts.some(text => /^\s{4}so\s{2,}/.test(text))).toBe(true)
    await pane.press({ key: 'close' })
    expect(await joined(pane)).toContain('[ ] Lens')
  })

  test(`${surface}: the ? popup names it once, teaches the ladder and the keys, and nothing else on screen names it`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    const before = await joined(pane)
    expect(before).not.toContain('Victrix')
    await pane.press({ key: 'k:h' })
    const after = await joined(pane)
    expect(after.split('Victrix').length - 1).toBe(1)
    expect(after).toContain('✗ ≤ ○ ≤ ■ ≤ ●')
    // Every key is a labelled button in the card, from the one table: by letter or by click.
    const labels = (await pane.findAll({ type: 'Button' })).map(button => String(button.props.label ?? ''))
    for (const words of ['size: pane, row, hidden', 'explain this step', 'doubt this step', 'add a fact', 'wrong path', 'hide the pane']) expect(labels).toContain(words)
    expect(after).toContain('Tao')
  })

  // Gut checks and the engine's dialogs

  test(`${surface}: a fact Claude made raises one question; no, check it doubts the fact and asks only once`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    // The engine's own band stands beneath the ribbon: once the question is answered the ribbon yields to it.
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return Text({ children: ['the engine'] })
    })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    // The question is the ribbon's, above the prompt, with the fewest words; the pane never asks.
    const ribbon = await mountBand($)
    expect(await joined(ribbon)).toContain('Claude assumed · prices are in cents · true?')
    expect(await joined(pane)).not.toContain('Claude assumed · prices')
    await ribbon.press({ key: 't:2' })
    expect(world.submitted[0]?.text).toContain('DOUBT on step "Lens"')
    expect(world.store[`victrix.asked:${CWD}`]).toEqual(['feel|Lens|prices are in cents'])
    expect(await joined(ribbon)).not.toContain('Claude assumed · prices')
    await pane.press({ key: 'proof:fact:0' })
    expect(await joined(pane)).toContain('you doubted it · re-check pending')
  })

  test(`${surface}: an AskUserQuestion in flight shows its question on the ribbon, leaves the pane as it is, and clears when answered`, async ($, on) => {
    const held = gate()
    on('tool.call', { tool: 'AskUserQuestion' }, async () => { await held.until; return { result: 'ok' } as never })
    const world = beneath(on, { files: { [PATH]: PLAN.replace(' · facts: claude: prices are in cents', '') } })
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return Text({ children: ['the engine'] })
    })
    await $.session.start(START)
    await $.command.run(RUN)
    await $.prompt.attachment(planNote(PATH))
    const call = $.tool.call({ tool: 'AskUserQuestion', tool_use_id: 't1', questions: [{ question: 'Which colour?', header: 'c', options: [], multiSelect: false }] } as never)
    await settle()
    const ribbon = await mountBand($)
    expect(await joined(ribbon)).toContain('? Which colour?')
    expect(world.opened.at(-1)?.columns).toBe(43)
    held.open()
    await call
    expect(world.opened.at(-1)?.columns).toBe(43)
  })

  // Sizes: pane, row, hidden; `s` moves through them from what is on screen

  test(`${surface}: s from the row goes to hidden: the same snake, short, with victrix▶, its tally and the one key, no step`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN }, placed: false })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const band = await mountBand($)
    await band.press({ key: 'k:s' })
    expect(world.store['victrix.form']).toBe('hidden')
    const texts = await textsOf(band)
    expect(texts).toContain('victrix')
    expect(texts.some(text => /^Lens/.test(text))).toBe(false)
    const labels = (await band.findAll({ type: 'Button' })).map(button => String(button.props.label ?? ''))
    expect(labels).toContain('? keys')
    const rows = await rowsOf(band, BAND_PROPS.bodyColumns)
    expect(rows[0]).toContain('victrix▶')
  })

  test(`${surface}: s from hidden opens the pane again and forgets a close the person made`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN }, store: { 'victrix.form': 'hidden', [`victrix.hidden:${CWD}`]: true } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    expect(world.opened).toEqual([])
    const band = await mountBand($)
    await band.press({ key: 'k:s' })
    expect(world.store['victrix.form']).toBe('pane')
    expect(world.store[`victrix.hidden:${CWD}`]).toBeUndefined()
    expect(world.opened.at(-1)?.id).toBe('victrix')
  })

  test(`${surface}: a size stored by 0.3.0 reads by its new name: tape is the row, so no pane opens`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN }, store: { 'victrix.form': 'tape' } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    expect(world.opened).toEqual([])
  })

  test(`${surface}: the row's ? keys lists every row key as a labelled button; the pane's own explain and hide are not offered`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN }, placed: false })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const band = await mountBand($)
    const closed = (await band.findAll({ type: 'Button' })).map(button => String(button.props.label ?? ''))
    expect(closed.filter(label => label !== '' && label !== '? keys' && !/^(run the check|ask Claude to find out|not sure|I checked|you check|build it|not worth it)$/.test(label))).toEqual([])
    await band.press({ key: 'keys' })
    const labels = (await band.findAll({ type: 'Button' })).map(button => String(button.props.label ?? ''))
    for (const words of ['size: pane, row, hidden', "run the step's check", 'doubt this step', 'add a fact', 'wrong path']) expect(labels).toContain(words)
    expect(labels).not.toContain('explain this step')
    expect(labels).not.toContain('hide the pane')
  })

  // The tape

  test(`${surface}: the row draws only when no pane is placed, with the snake's head victrix▶, the lit step and the because line`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN }, placed: false })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const band = await mountBand($)
    const texts = await textsOf(band)
    expect(texts).toContain('victrix')
    expect(texts).not.toContain('[-_-]')
    expect(texts.some(text => /^Lens \d+s$/.test(text))).toBe(true)
    expect(texts.filter(text => text.includes('▶')).length).toBe(1)
    expect(texts).toContain('Claude assumed · prices are in cents · true?')
    expect(await joined(band)).toContain('because plans are hard to follow')
    const rows = await rowsOf(band, BAND_PROPS.bodyColumns)
    expect(rows.length).toBe(2)
    for (const row of rows) expect(Array.from(row).length).toBeLessThanOrEqual(BAND_PROPS.bodyColumns)
  })

  test(`${surface}: the ribbon is one row at rest and never wider than its site, down to 40 columns`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN.replace(' · facts: claude: prices are in cents', '') }, placed: false })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    for (const bodyColumns of [120, 80, 60, 40]) {
      const band = await $.ui.mount({ plugin: 'victrix', surface, component: 'AbovePrompt', requestId: `victrix-${bodyColumns}`, props: { ...BAND_PROPS, bodyColumns } as typeof BAND_PROPS })
      const rows = await rowsOf(band, bodyColumns)
      expect(rows.length).toBe(1)
      expect(rows[0]).toContain('victrix▶')
      expect(rows[0]).toContain('Lens')
      expect(Array.from(rows[0] ?? '').length).toBeLessThanOrEqual(bodyColumns)
    }
  })

  test(`${surface}: the ribbon yields to the engine while the pane is placed and nothing waits`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN.replace(' · facts: claude: prices are in cents', '') } })
    on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
      const { Text } = $.ui.resolve(e)
      return Text({ children: ['the engine'] })
    })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const band = await mountBand($)
    expect(await textsOf(band)).toEqual(['the engine'])
  })
}
