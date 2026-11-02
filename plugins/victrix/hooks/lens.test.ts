import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

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
  '- [ ] **Lens** — the outline · why: plans are hard to follow · judge: one screen · assume: prices are in cents',
  '  - [x] **Parser**',
  '  - [ ] **Panel**',
  '## Up Next',
  '- [ ] **Gaits**',
].join('\n')

const PANE_PROPS = {
  title: '⊢ VICTRIX',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

type Listed = { readonly name: string; readonly mtimeMs: number }

type World = {
  readonly files: Map<string, string>
  readonly opened: { id: string; title?: string; focus?: true }[]
  readonly closed: unknown[]
  readonly registered: unknown[]
  readonly read: string[]
  readonly submitted: { text: string; context?: readonly string[] }[]
  readonly toasts: string[]
  readonly copied: string[]
  readonly store: Record<string, unknown>
}

type Setup = { files?: Record<string, string>; store?: Record<string, unknown>; listed?: readonly Listed[] }

// The kit's bottom hook throws, so these stand in for the engine beneath the mod and record what it asked of it.
const beneath = (on: On, { files = {}, store = {}, listed = [] }: Setup = {}): World => {
  const world: World = { files: new Map(Object.entries(files)), opened: [], closed: [], registered: [], read: [], submitted: [], toasts: [], copied: [], store }
  // The store answers from `world.store` so a test can read what the mod wrote (the ledger).
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
    return { value: { isPlaced: true } }
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

const planNote = (path: string, agentId?: string) => ({
  type: 'plan_mode',
  text: 'Plan mode is active.',
  origin: { kind: 'engine' },
  ...(agentId === undefined ? {} : { agentId }),
  detail: { reminder: 'full', planFilePath: path, hasPlan: true },
}) as const

type Found = { text: string; props: Record<string, unknown> }
type Pane = { findAll: (query: { type: string }) => Promise<readonly Found[]>; press: (target: { key: string }) => Promise<unknown> }

const textsOf = async (pane: Pane) => (await pane.findAll({ type: 'Text' })).map(text => text.text)
const selectedOf = async (pane: Pane) => (await pane.findAll({ type: 'Text' })).find(text => text.props.inverse === true)?.text

for (const surface of SURFACES) {
  const mountPane = ($: Engine): Promise<Pane> =>
    $.ui.mount({ plugin: 'victrix', surface, component: 'Pane', requestId: 'victrix', props: PANE_PROPS })

  // Opening

  test(`${surface}: session start registers /victrix with a description`, async ($, on) => {
    const world = beneath(on)
    await $.session.start(START)

    expect(world.registered).toEqual([
      expect.objectContaining({ name: 'victrix', description: expect.stringContaining('plan lens') }),
    ])
  })

  test(`${surface}: session start opens the lens by itself, unfocused`, async ($, on) => {
    const world = beneath(on)
    await $.session.start(START)

    expect(world.opened).toEqual([{ id: 'victrix', title: '⊢ VICTRIX' }])
  })

  test(`${surface}: a lens the person hid stays hidden at the next session start`, async ($, on) => {
    const world = beneath(on, { store: { [`victrix.hidden:${CWD}`]: true } })
    await $.session.start(START)

    expect(world.opened).toEqual([])
  })

  test(`${surface}: /victrix opens the lens focused, clears the hide, and says so`, async ($, on) => {
    const world = beneath(on, { store: { [`victrix.hidden:${CWD}`]: true } })
    await $.session.start(START)
    const answer = await $.command.run(RUN)
    await $.session.start(START)

    expect(world.opened).toEqual([
      { id: 'victrix', title: '⊢ VICTRIX', focus: true },
      { id: 'victrix', title: '⊢ VICTRIX' },
    ])
    expect(answer).toMatchObject({ text: 'Vada lens opened.' })
  })

  test(`${surface}: q hides the lens and keeps it hidden`, async ($, on) => {
    const world = beneath(on)
    await $.session.start(START)
    const pane = await mountPane($)
    await pane.press({ key: 'hide' })
    await $.session.start(START)

    expect(world.closed).toEqual([expect.objectContaining({ id: 'victrix' })])
    expect(world.opened).toHaveLength(1)
  })

  // Which plan

  test(`${surface}: the plan-mode note names the plan, and the lens draws its outline with Vada's glyphs`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.prompt.attachment(planNote(PATH))
    const texts = await textsOf(await mountPane($))

    expect(world.read).toEqual([PATH])
    expect(texts).toEqual(expect.arrayContaining([
      '⊢ VICTRIX',
      ' · 1/3 done',
      'Brave otter',
      '▾ IN PROGRESS 1',
      '▾ ◉ Lens',
      '    △ prices are in cents',
      '    ✓ Parser',
      '    ○ Panel',
      '▸ DONE 1',
      '▸ UP NEXT 1',
    ]))
  })

  test(`${surface}: WANTS, WORLD and WHY read the summary, the assumptions and the why of the step being worked`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN } })
    await $.prompt.attachment(planNote(PATH))
    const texts = await textsOf(await mountPane($))

    expect(texts).toEqual(expect.arrayContaining([
      'WANTS',
      'Plans get too big to follow.',
      'WORLD',
      '△ 1 assumed under "Lens" · from the plan\'s wording',
      'WHY',
      'plans are hard to follow',
    ]))
  })

  test(`${surface}: the foot tallies the plan`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN } })
    await $.prompt.attachment(planNote(PATH))
    const texts = await textsOf(await mountPane($))

    expect(texts).toContain('✓ 2 · ○ 3 · △ 1')
  })

  test(`${surface}: a helper's plan note is not this session's plan`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.prompt.attachment(planNote(PATH, 'helper-1'))

    expect(world.read).toEqual([])
  })

  test(`${surface}: an edit to the plan re-reads it and the lens redraws`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    world.files.set(PATH, PLAN.replace('- [ ] **Panel**', '- [x] **Panel**'))
    await $.tool.call({ tool: 'Edit', file_path: PATH, old_string: '[ ] **Panel**', new_string: '[x] **Panel**' })

    expect(await textsOf(pane)).toContain('    ✓ Panel')
  })

  test(`${surface}: a write to a plan file adopts it when no note named one`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.tool.call({ tool: 'Write', file_path: PATH, content: PLAN })

    expect(world.read).toEqual([PATH])
  })

  test(`${surface}: edits to other files and to plan archives never read them as the plan`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Write', file_path: `${PLANS}/brave-otter.archive-2026-10-13.md`, content: 'x' })

    expect(world.read).toEqual([])
  })

  test(`${surface}: the plan followed in this repo is followed again at session start`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN }, store: { [`victrix.planPath:${CWD}`]: PATH, 'victrix.planPath:/other': '/x.md' } })
    await $.session.start(START)

    expect(world.read).toEqual([PATH])
  })

  test(`${surface}: /victrix <path> follows the named plan, relative to the repo`, async ($, on) => {
    const world = beneath(on, { files: { [`${CWD}/docs/plan.md`]: PLAN } })
    await $.session.start(START)
    await $.command.run({ ...RUN, args: 'docs/plan.md' })

    expect(world.read).toEqual([`${CWD}/docs/plan.md`])
  })

  test(`${surface}: an unreadable plan is drawn as such, with its path`, async ($, on) => {
    beneath(on)
    await $.prompt.attachment(planNote(PATH))
    const texts = await textsOf(await mountPane($))

    // 53 cells beside the label column: a path that does not fit keeps its end, the file's name.
    expect(texts).toContain('cannot read the plan')
    expect(texts).toContain(PATH)
  })

  // Never empty

  test(`${surface}: with no plan anywhere the lens still says how to get one, and shows the session`, async ($, on) => {
    beneath(on)
    await $.session.start(START)
    const texts = await textsOf(await mountPane($))

    expect(texts).toEqual(expect.arrayContaining(['⊢ VICTRIX', 'PLAN', 'no plan files yet', 'NOW', 'idle', 'LAST', 'nothing yet this session', '0 in · 0 out']))
  })

  test(`${surface}: with no plan followed it offers the newest plan files, newest first, and a press follows one`, async ($, on) => {
    const older = `${PLANS}/old.md`
    const world = beneath(on, {
      files: { [PATH]: PLAN, [older]: '# Old plan' },
      listed: [
        { name: 'old.md', mtimeMs: 1 },
        { name: 'brave-otter.md', mtimeMs: 2 },
        { name: 'brave-otter.archive-2026-10-13.md', mtimeMs: 3 },
        { name: 'notes.txt', mtimeMs: 4 },
      ],
    })
    await $.session.start(START)
    const pane = await mountPane($)
    const texts = await textsOf(pane)
    const offered = texts.slice(texts.indexOf('none followed · pick one'))

    expect(offered[0]).toBe('none followed · pick one')
    expect(offered[1]?.startsWith('Brave otter')).toBe(true)
    expect(offered[2]?.startsWith('Old plan')).toBe(true)
    await pane.press({ key: `p:${PATH}` })
    expect(world.read.at(-1)).toBe(PATH)
    expect(await textsOf(pane)).toContain('Brave otter')
  })

  test(`${surface}: the lens shows the running call, then logs it under LAST`, async ($, on) => {
    beneath(on)
    await $.session.start(START)
    const pane = await mountPane($)
    await $.turn.start({ text: 'go', turnId: 't1' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/repo/hooks/plan.ts' })
    const texts = await textsOf(pane)

    expect(texts).toEqual(expect.arrayContaining(['thinking', 'read plan.ts']))
  })

  // Keys and clicks

  test(`${surface}: j and k move the selection; l opens and h folds the selected row`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN } })
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)

    expect(await selectedOf(pane)).toBe('▾ IN PROGRESS 1')
    for (const _ of [1, 2, 3, 4, 5]) await pane.press({ key: 'down' })
    expect(await selectedOf(pane)).toBe('▸ DONE 1')
    await pane.press({ key: 'open' })
    expect(await textsOf(pane)).toContain('  ✓ Crab')
    expect(await selectedOf(pane)).toBe('▾ DONE 1')
    await pane.press({ key: 'fold' })
    expect(await textsOf(pane)).not.toContain('  ✓ Crab')
    await pane.press({ key: 'up' })
    expect(await selectedOf(pane)).toBe('    ○ Panel')
  })

  test(`${surface}: h on a row that is not open walks to its parent`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN } })
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    for (const _ of [1, 2]) await pane.press({ key: 'down' })

    expect(await selectedOf(pane)).toBe('    △ prices are in cents')
    await pane.press({ key: 'fold' })
    expect(await selectedOf(pane)).toBe('▾ ◉ Lens')
  })

  test(`${surface}: clicking a folded section on the tray opens it`, async ($, on) => {
    beneath(on, { files: { [PATH]: PLAN } })
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    await pane.press({ key: 's:Up Next' })

    expect(await textsOf(pane)).toEqual(expect.arrayContaining(['▾ UP NEXT 1', '  ○ Gaits']))
  })

  test(`${surface}: every key is drawn as a labeled button bound to its vim key`, async ($, on) => {
    beneath(on)
    const pane = await mountPane($)
    const buttons = (await pane.findAll({ type: 'Button' })) as unknown as readonly { key: string; props: Record<string, unknown> }[]

    expect(buttons.map(button => [button.key, button.props.hotkey, button.props.label])).toEqual([
      ['down', 'j', 'down'],
      ['up', 'k', 'up'],
      ['open', 'l', 'open'],
      ['fold', 'h', 'fold'],
      ['doubt', 'd', 'doubt'],
      ['add', 'a', 'add data'],
      ['wrong', 'w', 'wrong path'],
      ['explain', 'e', 'explain'],
      ['copy', 'y', 'copy'],
      ['hide', 'q', 'hide'],
    ])
  })

  // The verbs

  test(`${surface}: d while Claude is idle sends the doubt to Claude at once, as a prompt, and logs it`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    await pane.press({ key: 'down' })
    await pane.press({ key: 'doubt' })

    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]?.text).toContain('DOUBT on step "Lens"')
    expect(world.toasts).toEqual(['doubt · Lens · sent to Claude'])
    const log = world.store[`victrix.log:${CWD}`]
    expect(Array.isArray(log) ? log.map(String) : log).toEqual([expect.stringMatching(/^\d{4}-\d\d-\d\dT.* doubt · Lens$/)])
  })

  test(`${surface}: w while Claude works waits, shows under NOTES, and rides the person's next prompt as context`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    await $.turn.start({ text: 'go', turnId: 't1' } as never)
    await pane.press({ key: 'down' })
    await pane.press({ key: 'wrong' })

    expect(world.submitted).toEqual([])
    expect(world.toasts).toEqual(['wrong path · Lens · reaches Claude at its next step'])
    expect(await textsOf(pane)).toContain("wrong path · Lens · at Claude's next step")
    await $.prompt.submit(TYPED('carry on'))
    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]?.text).toBe('carry on')
    expect(world.submitted[0]?.context?.[0]).toContain('WRONG PATH on step "Lens"')
    expect(await textsOf(pane)).not.toContain("wrong path · Lens · at Claude's next step")
  })

  test(`${surface}: notes still queued when the turn ends are sent as Vada's own prompt`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    await $.turn.start({ text: 'go', turnId: 't1' } as never)
    await pane.press({ key: 'doubt' })
    await $.turn.complete({ turnId: 't1', reason: 'completed', answer: 'done', durationMs: 1, isAborted: false } as never)

    expect(world.submitted).toHaveLength(1)
    expect(world.submitted[0]?.text).toContain('DOUBT on step "Lens"')
  })

  test(`${surface}: a asks for the fact in the prompt; the next typed prompt becomes that step's add-data note`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    await pane.press({ key: 'down' })
    await pane.press({ key: 'add' })

    expect(world.toasts).toEqual(['add data · Lens: type the fact in the prompt; Vada attaches it to this step'])
    expect(await textsOf(pane)).toContain('add data · Lens · type the fact in the prompt')
    await $.prompt.submit(TYPED('prices are integers in cents'))
    expect(world.submitted[0]?.context?.[0]).toContain('ADD DATA for step "Lens": prices are integers in cents.')
    expect(await textsOf(pane)).not.toContain('add data · Lens · type the fact in the prompt')
  })

  test(`${surface}: a slash command typed after a is not the fact; the ask stays`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.session.start(START)
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    await pane.press({ key: 'add' })
    await $.prompt.submit({ ...TYPED('/victrix'), command: { name: 'victrix', args: '' } } as never)

    expect(world.submitted[0]?.context).toBeUndefined()
    expect(await textsOf(pane)).toContain('add data · Lens · type the fact in the prompt')
  })

  test(`${surface}: a verb with no plan says so and sends nothing`, async ($, on) => {
    const world = beneath(on)
    await $.session.start(START)
    const pane = await mountPane($)
    await pane.press({ key: 'doubt' })

    expect(world.submitted).toEqual([])
    expect(world.toasts).toEqual(['no plan step to press this on yet'])
  })

  test(`${surface}: e explains the selected step in the plan's words and y copies it`, async ($, on) => {
    const world = beneath(on, { files: { [PATH]: PLAN } })
    await $.prompt.attachment(planNote(PATH))
    const pane = await mountPane($)
    await pane.press({ key: 'down' })
    await pane.press({ key: 'explain' })

    expect(await textsOf(pane)).toEqual(expect.arrayContaining(['STEP', 'Lens', 'why: plans are hard to follow', 'judge: one screen', 'note: the outline']))
    await pane.press({ key: 'copy' })
    expect(world.copied).toEqual(['Lens — the outline — why: plans are hard to follow — judge: one screen'])
    expect(world.toasts).toEqual(['copied: Lens'])
  })
}
