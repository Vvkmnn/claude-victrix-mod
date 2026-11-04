// Not a test of behaviour: a preview. Each scenario mounts the instrument, lays the drawn tree out as ANSI rows
// and prints them between markers, so `demo/preview.sh` can turn them into PNGs to look at. The one assertion is
// the owner's: no row wider than its site.
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

import { renderAnsi, renderPlain } from './render'
import type { Drawn } from './render'

type On = Parameters<TestBody>[1]

const HOME = '/home/me'
const PLANS = `${HOME}/.claude/plans`
const PATH = `${PLANS}/discount.md`
const CWD = '/repo'

const PLAN = [
  '# Discount codes for the shop',
  '**Progress: 2/7 done** | Active: Apply promos',
  '## Summary',
  'Add discount codes to the shop. The scary part is a total that goes negative when two codes stack.',
  '## Done',
  '- [x] **Schema** — promos table',
  '- [x] ~~**Coupons v1**~~ — abandoned: replaced by promos',
  '## In Progress',
  '- [ ] **Apply promos** — subtract each promo · because: one rule in one place, over capping each promo · facts: data: prices in the seed are integers in cents · facts: claude: promos never exceed the price · guard: if total < 0 clamp to 0 and log, 1 compare · options: cache promo lookups per request (2×) · verify: bun test · slow: sum every line, then subtract every promo',
  '- [ ] **Show the total** — in the cart view · verify: snapshot test',
  '## Up Next',
  '- [ ] **Stacking rules** — facts: claude: a code is used at most once per cart',
  '- [ ] **Receipts**',
  '- [ ] **Refunds** — facts: claude: refunds are rare, so the slow path is fine',
  '- [ ] **Admin screen**',
  '- [ ] **Ship**',
].join('\n')

const beneath = (on: On, placed = true, planText = PLAN) => {
  const store: Record<string, unknown> = {}
  on('store.get', async (_$, e) => ({ value: store[e.key] }))
  on('store.set', async (_$, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', async () => ({ value: undefined }))
  on('store.keys', async () => ({ value: [] }))
  mock.env(on, { HOME })
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: placed ? { isPlaced: true } : { isPlaced: false, reason: 'narrow' } }))
  on('ui.close', async () => ({ value: undefined }))
  on('fs.read', async (_$, e) => {
    if (e.path === PATH) return { value: planText }
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.list', async () => ({ value: [] }))
  on('prompt.attachment', async (_$, e) => ({ text: e.text }))
  on('prompt.submit', async (_$, e) => ({ text: e.text, context: e.context }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', async () => ({ text: '' }))
  on('tool.call', async (_$, e) => (e.tool === 'Bash' ? { deny: 'exit 1: SAVE50 + SAVE60 on $10 = −$1' } : { result: 'ok' }) as never)
}

const START = { cwd: CWD, surface: 'terminal', isInteractive: true } as const

const planNote = { type: 'plan_mode', text: 'Plan mode is active.', origin: { kind: 'engine' }, detail: { reminder: 'full', planFilePath: PATH, hasPlan: true } } as const

const print = (name: string, columns: number, tree: Drawn) => {
  const rows = renderAnsi(tree, columns)
  console.log(`@@victrix-preview ${name} ${columns}`)
  for (const row of rows) console.log(row)
  console.log('@@end')
  for (const row of renderPlain(tree, columns)) expect(Array.from(row).length).toBeLessThanOrEqual(columns)
}

const paneProps = (columns: number, rows: number, isFocused = false) => ({ title: '[-_-]', isFocused, bodyColumns: columns, placement: 'dock', scroll: { offset: 0, bodyRows: rows }, view: {} }) as const

const mountPane = ($: Engine, columns: number, rows: number, isFocused = false) =>
  $.ui.mount({ plugin: 'victrix', surface: 'terminal', component: 'Pane', requestId: 'victrix', props: paneProps(columns, rows, isFocused) })

// A session mid-work: a plan followed, one failed check, one call running, one note queued.
async function liveSession($: Engine) {
  await $.session.start(START)
  await $.prompt.attachment(planNote)
  await $.turn.start({ turnId: 'turn-1', prompt: 'go' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: '/repo/src/cart.ts' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 't2', command: 'bun test' } as never)
  await $.tool.call({ tool: 'Edit', tool_use_id: 't3', file_path: '/repo/src/cart.ts', old_string: 'a', new_string: 'b' } as never)
}

// The real rungs (form.ts): 50 columns by 50 rows is a 13" MacBook full-screen at the fresh-install share, the
// width every line is written for; 60 is a 16"; 40 and 24 a dock dragged narrow; 12 and 10 the engine's own
// narrowing under a dialog; 66 is luxury and no longer previewed.
test('preview: the map at 27% of a 13-inch MacBook, 50 columns, while planning', async ($, on) => {
  beneath(on)
  await liveSession($)
  const pane = await mountPane($, 50, 50)
  print('map-50', 50, (await pane.drawn()) as Drawn)
})

test('preview: the map held, with the card open on the broken-looking fact', async ($, on) => {
  beneath(on)
  await liveSession($)
  const pane = await mountPane($, 50, 50, true)
  await pane.press({ key: 'proof:fact:1' })
  print('card-50', 50, (await pane.drawn()) as Drawn)
})

// The width ladder: one drawing cropped from the right, small rungs first (owner, 2026-11-05).
for (const columns of [10, 12, 24, 40, 60]) {
  test(`preview: the pane at ${columns} columns while working, the same drawing cropped`, async ($, on) => {
    beneath(on)
    await liveSession($)
    const pane = await mountPane($, columns, 24)
    print(`pane-${columns}`, columns, (await pane.drawn()) as Drawn)
  })
}

// The ribbon at a half-screen window (92 columns, no dock seats) and at a fresh Terminal.app window (80).
for (const columns of [92, 80]) {
  test(`preview: the ribbon at ${columns} columns when no dock fits`, async ($, on) => {
    beneath(on, false)
    await liveSession($)
    const band = await $.ui.mount({ plugin: 'victrix', surface: 'terminal', component: 'AbovePrompt', requestId: 'victrix', props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: columns, scroll: { offset: 0, bodyRows: 5 }, view: {} } })
    print(`tape-${columns}`, columns, (await band.drawn()) as Drawn)
  })
}

test('preview: the map with no plan yet', async ($, on) => {
  beneath(on)
  await $.session.start(START)
  const pane = await mountPane($, 50, 24)
  print('empty-50', 50, (await pane.drawn()) as Drawn)
})

test('preview: the help card', async ($, on) => {
  beneath(on)
  await liveSession($)
  const pane = await mountPane($, 50, 50, true)
  await pane.press({ key: 'k:h' })
  print('help-50', 50, (await pane.drawn()) as Drawn)
})

// A film: one session as frames, for a GIF. Each frame is the pane after one more thing happened.
test('preview film: a session on the discount shop, frame by frame', async ($, on) => {
  beneath(on)
  // The engine's own band stands beneath the ribbon: once the question is answered the ribbon yields to it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: [''] })
  })
  on('process.run', async (_$, e) => {
    const argv = (e as { argv?: readonly string[] }).argv ?? []
    const isTest = argv.join(' ').includes('bun test')
    return { value: { exitCode: isTest ? 1 : 0, stdout: isTest ? 'cart.spec.ts:\n✗ SAVE50 + SAVE60 on $10 must not go below $0\n  expected ≥ 0, got -10000\n 1 pass\n 2 fail' : 'ok', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  const frames: string[][] = []
  const shoot = async (pane: Awaited<ReturnType<typeof mountPane>>) => frames.push(renderAnsi((await pane.drawn()) as Drawn, 50))

  await $.session.start(START)
  const pane = await mountPane($, 50, 50)
  await shoot(pane)
  await $.prompt.attachment(planNote)
  await shoot(pane)
  await $.turn.start({ turnId: 'turn-1', prompt: 'go' } as never)
  const read = $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: '/repo/src/cart.ts' } as never)
  await new Promise<void>(resolve => setTimeout(() => resolve(), 20))
  await shoot(pane)
  await read
  const run = $.tool.call({ tool: 'Bash', tool_use_id: 't2', command: 'bun test' } as never)
  await new Promise<void>(resolve => setTimeout(() => resolve(), 20))
  await shoot(pane)
  await run
  await shoot(pane)
  await $.tool.call({ tool: 'mcp__victrix__check', tool_use_id: 't3', step: 'Apply promos', says: 'promos never exceed the price', kind: 'test', command: ['bun', 'test', 'cart.spec.ts'] } as never)
  await shoot(pane)
  await $.tool.call({ tool: 'Edit', tool_use_id: 't4', file_path: '/repo/src/cart.ts', old_string: 'total -= promo.offCents', new_string: 'total = Math.max(0, total - promo.offCents)' } as never)
  await shoot(pane)
  // The question is answered on the ribbon above the prompt; the pane only shows what the answer did.
  const ribbon = await $.ui.mount({ plugin: 'victrix', surface: 'terminal', component: 'AbovePrompt', requestId: 'victrix', props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 120, scroll: { offset: 0, bodyRows: 5 }, view: {} } })
  await ribbon.press({ key: 't:2' })
  await shoot(pane)
  await $.turn.complete({ turnId: 'turn-1' } as never)
  await shoot(pane)
  frames.forEach((rows, index) => {
    console.log(`@@victrix-preview film-${String(index + 1).padStart(2, '0')} 50`)
    for (const row of rows) console.log(row)
    console.log('@@end')
  })
  expect(frames.length).toBe(9)
})

// A big plan, as the owner's real ones are: forty steps with tags, so the fit ladder's folding is seen, not assumed.
const BIG_PLAN = [
  '# A forty-step plan',
  '**Progress: 12/40 done** | Active: Step 13',
  '## Summary',
  'A long plan that no one can read whole; the lens must still show where Claude is and what it leans on.',
  '## Done',
  ...Array.from({ length: 12 }, (_, n) => `- [x] **Step ${n + 1}** — done work · verify: bun test`),
  '## In Progress',
  '- [ ] **Step 13** — the one being worked · because: the owner asked for it first · facts: claude: the cache is warm by then · facts: data: the seed has 2,000 rows · guard: if rows > 10,000 then stream, 1 compare · options: parse in a worker (3×) · verify: bun test · slow: read every row twice',
  '## Up Next',
  ...Array.from({ length: 27 }, (_, n) => `- [ ] **Step ${n + 14}** — later work${n % 3 === 0 ? ' · facts: claude: this will be easy' : ''}`),
].join('\n')

const bigBeneath = (on: On) => beneath(on, true, BIG_PLAN)

test('preview: a forty-step plan at 50 columns and 50 rows folds, never overflows', async ($, on) => {
  bigBeneath(on)
  await liveSession($)
  const pane = await mountPane($, 50, 50)
  print('big-50', 50, (await pane.drawn()) as Drawn)
})

test('preview: a forty-step plan quartered, 30 columns and 24 rows (a 110-column terminal at the share, half height)', async ($, on) => {
  bigBeneath(on)
  await liveSession($)
  const pane = await mountPane($, 30, 24)
  print('big-30', 30, (await pane.drawn()) as Drawn)
})
