import { expect, mock, test } from 'claude-code/testing'
import type { Engine, TestBody } from 'claude-code/testing'

import type { Claim } from '../types'
import { axiomsOf, cheatsIn, isAllowed, isStale, linesOf, missingExtremes, moduleOf, resolvePath, statementOf } from './check'

type On = Parameters<TestBody>[1]

const CWD = '/repo'
const TOOL = 'mcp__victrix__check'
const TMP = '/tmp/t'

type Run = { readonly argv: readonly string[]; readonly cwd?: string; readonly stdin?: string; readonly timeoutMs?: number }
type Answer = { readonly exitCode?: number; readonly stdout?: string; readonly stderr?: string }
type Runner = (run: Run) => Answer | Promise<Answer>

type World = {
  readonly files: Map<string, { text: string; mtimeMs: number }>
  readonly runs: Run[]
  readonly tools: unknown[]
  readonly prompts: string[]
  readonly writes: { path: string; text: string }[]
  readonly state: Record<string, unknown>
}

type Setup = {
  readonly files?: Record<string, string>
  readonly runner?: Runner
  readonly store?: Record<string, unknown>
  readonly reply?: string | null
  readonly dirs?: Record<string, readonly { name: string; kind: 'file' | 'dir' }[]>
  readonly isStoreBroken?: boolean
}

// The kit's bottom hook throws, so these stand in for the engine beneath the mod.
const beneath = (on: On, { files = {}, runner = () => ({}), store = {}, reply = 'It says one plus one is two.', dirs = {}, isStoreBroken = false }: Setup = {}): World => {
  const world: World = {
    files: new Map(Object.entries(files).map(([path, text]) => [path, { text, mtimeMs: 1_000 }])),
    runs: [],
    tools: [],
    prompts: [],
    writes: [],
    state: {},
  }
  if (isStoreBroken)
    on('store.get', async () => {
      throw new Error('store gone')
    })
  else mock.store(on, store)
  mock.env(on, { HOME: '/home/me', TMPDIR: TMP })
  mock.clock(on)
  // The kit holds plugin state; this records each write on its way down, so a test reads what the mod last set.
  on('state.set', async (_$, e, next) => {
    world.state[(e as { key: string }).key] = (e as { value: unknown }).value
    return next(e)
  })
  // The lens loads beside the check tool; these answer what it asks of the engine at start and around tool calls.
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.close', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', async (_$, e) => {
    world.tools.push(e)
    return { value: { tool: `mcp__victrix__${e.name}` } }
  })
  on('process.run', async (_$, e) => {
    const run = { argv: e.argv, ...e.init }
    world.runs.push(run)
    const answer = await runner(run)
    return { value: { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', async (_$, e) => {
    const file = world.files.get(e.path)
    if (file === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('fs.read', async (_$, e) => {
    const file = world.files.get(e.path)
    if (file === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: file.text }
  })
  on('fs.write', async (_$, e) => {
    world.writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => {
    const entries = dirs[e.path]
    if (entries === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: entries.map(entry => ({ ...entry, size: 1, isLink: false, mtimeMs: 1 })) }
  })
  on('model.complete', async (_$, e) => {
    world.prompts.push(e.prompt)
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return { value: reply === null ? { isAnswered: false, reason: 'empty-reply', usage } : { isAnswered: true, text: reply, usage } }
  })
  on('tool.call', async (_$, e) => ({
    result: { type: 'update', filePath: String((e as { file_path?: string }).file_path), content: '', structuredPatch: [], originalFile: null },
  }) as never)
  return world
}

const START = { cwd: CWD, surface: 'terminal', isInteractive: true } as const

const check = async ($: Engine, input: Record<string, unknown>): Promise<string> => {
  const answer = (await $.tool.call({ tool: TOOL, tool_use_id: 'c1', ...input } as never)) as { result?: unknown; text?: string }
  return String(answer.text ?? answer.result)
}

const claimsOf = (world: World): readonly Claim[] => (world.state.claims as readonly Claim[] | undefined) ?? []

const ledgerOf = (world: World): readonly string[] => (world.state.changed as readonly string[] | undefined) ?? []

const STEP = { step: 'Lens', says: 'the parser keeps every line' } as const

// Pure helpers

test('isAllowed: runners pass, scripts only under demo/ or test/, bash only with such a script', async () => {
  expect(isAllowed(['bun', 'test'], CWD)).toBe(true)
  expect(isAllowed(['bun', 'test', 'cart.spec.ts'], CWD)).toBe(true)
  expect(isAllowed(['lake', 'build'], CWD)).toBe(true)
  expect(isAllowed(['python3', '-m', 'pytest', '-q'], CWD)).toBe(true)
  expect(isAllowed(['go', 'test', './...'], CWD)).toBe(true)
  // A bare interpreter is a second Bash: refused, as is any code-loading flag on an allowed head.
  expect(isAllowed(['node', '-e', 'process.exit(1)'], CWD)).toBe(false)
  expect(isAllowed(['python3', '-c', 'import os'], CWD)).toBe(false)
  expect(isAllowed(['python3', 'slow.py'], CWD)).toBe(false)
  expect(isAllowed(['python3', 'test/slow.py'], CWD)).toBe(true)
  expect(isAllowed(['node', 'demo/gen.js', '200'], CWD)).toBe(true)
  expect(isAllowed(['npx', 'anything'], CWD)).toBe(false)
  expect(isAllowed(['bun', 'run', 'x.ts'], CWD)).toBe(false)
  expect(isAllowed(['npm', 'test', '--', '-r', 'evil'], CWD)).toBe(false)
  expect(isAllowed(['make'], CWD)).toBe(false)
  expect(isAllowed(['rm', '-rf', '/'], CWD)).toBe(false)
  expect(isAllowed(['bash', '-c', 'rm -rf /'], CWD)).toBe(false)
  expect(isAllowed(['bash', 'demo/run.sh'], CWD)).toBe(true)
  expect(isAllowed(['./tests/go.sh'], CWD)).toBe(true)
  expect(isAllowed(['./test/../evil.sh'], CWD)).toBe(false)
  expect(isAllowed(['curl'], CWD)).toBe(false)
  expect(isAllowed([], CWD)).toBe(false)
})

test('resolvePath folds . and .. and keeps absolute paths', async () => {
  expect(resolvePath('/repo', 'a/./b/../c.ts')).toBe('/repo/a/c.ts')
  expect(resolvePath('/repo', '/etc/x')).toBe('/etc/x')
  expect(resolvePath('/repo', '.')).toBe('/repo')
})

test('isStale: a moved or vanished file is stale, an unchanged or unseen one is not', async () => {
  const evidence = { files: [{ path: '/repo/a.ts', mtimeMs: 5 }] }
  expect(isStale(evidence, { '/repo/a.ts': 5 })).toBe(false)
  expect(isStale(evidence, { '/repo/a.ts': 6 })).toBe(true)
  expect(isStale(evidence, { '/repo/a.ts': undefined })).toBe(true)
  expect(isStale(evidence, { '/repo/b.ts': 9 })).toBe(false)
  expect(isStale({}, { '/repo/a.ts': 6 })).toBe(false)
})

test('missingExtremes names each extreme a list lacks, and none for a full one', async () => {
  expect(missingExtremes(['', '-1', '4294967296', 'NaN', '3 3'])).toEqual([])
  expect(missingExtremes(['1', '2'])).toEqual(['an empty string', 'a negative number', 'a very large number (>= 2^31)', 'NaN', 'a duplicate'])
  expect(missingExtremes(['', '', '-2147483648'])).toEqual(['NaN'])
})

test('linesOf keeps blank lines and drops only the one after a final newline', async () => {
  expect(linesOf('a\n\nb\n')).toEqual(['a', '', 'b'])
  expect(linesOf('a')).toEqual(['a'])
  expect(linesOf('\n')).toEqual([''])
})

test('axiomsOf reads a list, none, or nothing', async () => {
  expect(axiomsOf("'X.t' depends on axioms: [propext, Classical.choice, Quot.sound]")).toEqual(['propext', 'Classical.choice', 'Quot.sound'])
  expect(axiomsOf("'X.t' depends on axioms: [propext,\n Classical.choice]")).toEqual(['propext', 'Classical.choice'])
  expect(axiomsOf("'X.t' does not depend on any axioms")).toEqual([])
  expect(axiomsOf('unknown constant')).toBeUndefined()
})

test('cheatsIn flags sorry and friends with lines, never inside comments', async () => {
  const text = ['theorem a : 1 = 1 := by sorry', '-- sorry in prose', '/- native_decide here -/', 'axiom bad : False', 'attribute [implemented_by f] g', 'lemma x : True := by native_decide'].join('\n')
  expect(cheatsIn('A.lean', text)).toEqual([
    'no-cheat: sorry in A.lean:1',
    'no-cheat: axiom (a user axiom) in A.lean:4',
    'no-cheat: implemented_by in A.lean:5',
    'no-cheat: native_decide in A.lean:6',
  ])
  expect(cheatsIn('B.dfy', 'method m() ensures true { assume(false); }')).toEqual(['no-cheat: assume(false) in B.dfy:1', 'no-cheat: ensures true in B.dfy:1'])
  expect(cheatsIn('C.lean', 'theorem ok : 1 + 1 = 2 := rfl')).toEqual([])
})

test('statementOf takes the lines from `theorem <name>` to the first :=', async () => {
  const text = 'import X\n\ntheorem Anka.two (n : Nat) :\n    n + 0 = n := by\n  simp\n'
  expect(statementOf(text, 'Anka.two')).toBe('theorem Anka.two (n : Nat) :\n    n + 0 = n')
  expect(statementOf(text, 'two')).toBe('theorem Anka.two (n : Nat) :\n    n + 0 = n')
  expect(statementOf(text, 'three')).toBeUndefined()
})

test('moduleOf turns a file under the repo into its import name', async () => {
  expect(moduleOf('/repo/formal', 'Anka/Core.lean')).toBe('Anka.Core')
  expect(moduleOf('/repo/formal', 'Anka.lean')).toBe('Anka')
})

// The tool, end to end

test('session start registers the check tool with its schema', async ($, on) => {
  const world = beneath(on)
  await $.session.start(START)
  expect(world.tools).toEqual([expect.objectContaining({ name: 'check', inputSchema: expect.objectContaining({ required: ['step', 'says', 'kind'] }) })])
})

test('test lane: exit 0 is checked with no cases, a ledger line, and the label first in the answer', async ($, on) => {
  const world = beneath(on, { files: { '/repo/src/parse.test.ts': 'x' }, runner: () => ({ stdout: 'ok\n3 pass\n' }) })
  await $.session.start(START)
  const answer = await check($, { ...STEP, kind: 'test', command: ['bun', 'test', 'src/parse.test.ts'] })
  expect(world.runs[0]).toMatchObject({ argv: ['bun', 'test', 'src/parse.test.ts'], cwd: CWD, timeoutMs: 30_000 })
  const [claim] = claimsOf(world)
  expect(claim).toMatchObject({ ...STEP, status: 'checked', source: 'tool' })
  expect(claim?.evidence).toMatchObject({ kind: 'test', command: 'bun test src/parse.test.ts', exitCode: 0, tail: 'ok\n3 pass' })
  expect(claim?.evidence?.cases).toBeUndefined()
  expect(claim?.evidence?.files).toEqual([{ path: '/repo/src/parse.test.ts', mtimeMs: 1_000 }])
  expect(claim?.isChecking).toBeUndefined()
  expect(answer.split('\n')[0]).toBe('tool ran')
  expect((ledgerOf(world))[0]).toMatch(/^\d\d:\d\d ■ the parser keeps every line ⋅ ran 1$/)
})

test('test lane: exit 1 is broken with the last line as the counterexample, replacing the claim in place', async ($, on) => {
  let exitCode = 0
  const world = beneath(on, { runner: () => ({ exitCode, stderr: 'warn\n', stdout: 'expected 3\nreceived 2\n\n' }) })
  await $.session.start(START)
  await check($, { ...STEP, kind: 'test', command: ['bun', 'test'] })
  exitCode = 1
  const answer = await check($, { ...STEP, kind: 'test', command: ['bun', 'test'] })
  const all = claimsOf(world)
  expect(all).toHaveLength(1)
  expect(all[0]).toMatchObject({ status: 'broken', counterexample: 'received 2' })
  expect(answer.split('\n')[0]).toBe('received 2 ⋅ tool ran')
  expect((ledgerOf(world))[0]).toMatch(/✗ the parser keeps every line ⋅ received 2$/)
})

test('the claim reads checking while its command runs', async ($, on) => {
  let release = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  let seen: readonly Claim[] = []
  const world = beneath(on, {
    runner: async () => {
      await held
      return {}
    },
  })
  await $.session.start(START)
  const running = check($, { ...STEP, kind: 'test', command: ['bun', 'test'] })
  await new Promise<void>(resolve => setTimeout(resolve, 50))
  seen = claimsOf(world)
  release()
  await running
  expect(seen[0]?.isChecking).toBe(true)
  expect((claimsOf(world))[0]?.isChecking).toBeUndefined()
})

test('a command off the allowlist is refused and records nothing', async ($, on) => {
  const world = beneath(on)
  await $.session.start(START)
  const answer = await check($, { ...STEP, kind: 'test', command: ['curl', 'https://example.com'] })
  expect(answer).toBe('check refused: curl is not on the allowlist (test invocations such as bun test, pytest, go test, cargo test, lake build; scripts under demo/ or test/)')
  expect(world.runs).toEqual([])
  expect(claimsOf(world)).toEqual([])
  expect(ledgerOf(world)).toEqual([])
})

test('a repo the person opened up runs anything', async ($, on) => {
  const world = beneath(on, { store: { [`victrix.allowAny:${CWD}`]: true } })
  await $.session.start(START)
  await check($, { ...STEP, kind: 'test', command: ['curl', 'x'] })
  expect(world.runs).toHaveLength(1)
})

test('differential: three agreeing inputs are checked with 3 cases, and the tail says what extremes are missing', async ($, on) => {
  const world = beneath(on, { runner: run => ({ stdout: `out:${run.stdin}` }) })
  await $.session.start(START)
  const answer = await check($, { ...STEP, kind: 'differential', slow: ['python3', 'test/slow.py'], fast: ['python3', 'test/fast.py'], inputs: ['1', '2', '3'] })
  const [claim] = claimsOf(world)
  expect(claim).toMatchObject({ status: 'checked' })
  expect(claim?.evidence).toMatchObject({ kind: 'differential', cases: 3, exitCode: 0 })
  expect(claim?.evidence?.tail).toContain('coverage: partial ⋅ missing: an empty string, a negative number, a very large number (>= 2^31), NaN, a duplicate')
  expect(world.runs.map(run => run.stdin)).toEqual(['1', '1', '2', '2', '3', '3'])
  expect(answer.split('\n')[0]).toBe('ran 3 cases ⋅ tool ran')
})

test('differential: a full list of extremes has no coverage note', async ($, on) => {
  const world = beneath(on, { runner: run => ({ stdout: String(run.stdin) }) })
  await $.session.start(START)
  await check($, { ...STEP, kind: 'differential', slow: ['node', 'test/s.js'], fast: ['node', 'test/f.js'], inputs: ['', '-1', '4294967296', 'NaN', 'NaN'] })
  const [claim] = claimsOf(world)
  expect(claim?.evidence?.tail).not.toContain('coverage')
  expect(claim?.evidence?.cases).toBe(5)
})

test('differential: the first mismatch is broken with input → slow / fast', async ($, on) => {
  const world = beneath(on, { runner: run => ({ stdout: run.argv[1] === 'test/fast.py' && run.stdin === '2' ? '5\n' : '4\n' }) })
  await $.session.start(START)
  await check($, { ...STEP, kind: 'differential', slow: ['python3', 'test/slow.py'], fast: ['python3', 'test/fast.py'], inputs: ['1', '2', '3'] })
  const [claim] = claimsOf(world)
  expect(claim).toMatchObject({ status: 'broken', counterexample: '"2" → slow: "4\\n" fast: "5\\n"' })
  expect(claim?.evidence?.cases).toBe(2)
})

test('differential: inputs from a generator are its stdout lines', async ($, on) => {
  const world = beneath(on, { runner: run => (run.argv[1] === 'test/gen.py' ? { stdout: 'a\n\nb\n' } : { stdout: 'same' }) })
  await $.session.start(START)
  await check($, { ...STEP, kind: 'differential', slow: ['python3', 'test/s.py'], fast: ['python3', 'test/f.py'], inputs: { generate: ['python3', 'test/gen.py'] } })
  expect((claimsOf(world))[0]?.evidence?.cases).toBe(3)
  expect(world.runs.filter(run => run.argv[1] === 'test/s.py').map(run => run.stdin)).toEqual(['a', '', 'b'])
})

test('fuzz: runs at most 200 generated inputs, all exit 0 is checked', async ($, on) => {
  const many = Array.from({ length: 250 }, (_, index) => String(index)).join('\n')
  const world = beneath(on, { runner: run => (run.argv[1] === 'test/gen.py' ? { stdout: many } : {}) })
  await $.session.start(START)
  await check($, { ...STEP, kind: 'fuzz', command: ['python3', 'test/prop.py'], inputs: { generate: ['python3', 'test/gen.py'] } })
  const [claim] = claimsOf(world)
  expect(world.runs.filter(run => run.argv[1] === 'test/prop.py')).toHaveLength(200)
  expect(claim).toMatchObject({ status: 'checked' })
  expect(claim?.evidence?.cases).toBe(200)
  expect(claim?.evidence?.tail).toContain('capped at 200 of 250 inputs')
})

test('fuzz: the first non-zero exit is the counterexample', async ($, on) => {
  const world = beneath(on, { runner: run => (run.argv[1] === 'test/gen.py' ? { stdout: '1\n2\n3\n' } : run.stdin === '2' ? { exitCode: 3, stderr: 'boom\n' } : {}) })
  await $.session.start(START)
  await check($, { ...STEP, kind: 'fuzz', command: ['python3', 'test/prop.py'], inputs: { generate: ['python3', 'test/gen.py'] } })
  expect((claimsOf(world))[0]).toMatchObject({ status: 'broken', counterexample: '"2" → exit 3: boom' })
})

// Lean

const FORMAL = '/repo/formal'
const LAKEFILE = `${FORMAL}/lakefile.toml`
const LAKE_TOML = 'name = "Anka"\n\n[[lean_lib]]\nname = "Anka"\n'
const GOOD = 'theorem Anka.two (n : Nat) :\n    n + 0 = n := by\n  simp\n'
const LEAN_STEP = { step: 'Proofs', says: 'adding zero changes nothing', kind: 'lean', theorem: 'Anka.two', file: 'Anka.lean', cwd: 'formal' } as const

const leanRunner = (axioms: string, build = 0): Runner => run => {
  if (run.argv[0] === 'lean') return { stdout: 'Lean (version 4.22.0, arm64-apple-darwin)\n' }
  if (run.argv[1] === 'build') return { exitCode: build, stdout: build === 0 ? 'Build completed successfully.\n' : 'error: Anka.lean:3:2: unsolved goals\n' }
  return { stdout: axioms }
}

test('lean: no lakefile answers so and records nothing', async ($, on) => {
  const world = beneath(on)
  await $.session.start(START)
  const answer = await check($, LEAN_STEP)
  expect(answer).toContain('no lakefile.toml or lakefile.lean in /repo/formal')
  expect(world.runs).toEqual([])
  expect(claimsOf(world)).toEqual([])
})

test('lean: a green build, standard axioms and no sorry is checked, not proved, axioms and checker recorded', async ($, on) => {
  const world = beneath(on, {
    files: { [LAKEFILE]: LAKE_TOML, [`${FORMAL}/Anka.lean`]: GOOD },
    runner: leanRunner("'Anka.two' depends on axioms: [propext, Quot.sound]\n"),
  })
  await $.session.start(START)
  const answer = await check($, LEAN_STEP)
  const [claim] = claimsOf(world)
  expect(claim).toMatchObject({ status: 'checked', source: 'lean' })
  expect(claim?.evidence).toMatchObject({ kind: 'lean', theorem: 'Anka.two', axioms: ['propext', 'Quot.sound'], hasSorry: false, exitCode: 0 })
  expect(claim?.evidence?.tail).toContain('checker: Lean (version 4.22.0, arm64-apple-darwin)')
  expect(claim?.evidence?.files?.map(file => file.path)).toEqual([`${FORMAL}/Anka.lean`, LAKEFILE])
  expect(world.writes).toEqual([{ path: expect.stringMatching(/^\/tmp\/t\/victrix-axioms-\d+\.lean$/), text: 'import Anka\n#print axioms Anka.two\n' }])
  expect(world.runs.some(run => run.argv.join(' ').startsWith('lake env lean /tmp/t/'))).toBe(true)
  // The back-translation sees only the statement, never the claim's words.
  expect(world.prompts).toHaveLength(1)
  expect(world.prompts[0]).toContain('theorem Anka.two (n : Nat) :\n    n + 0 = n')
  expect(world.prompts[0]).not.toContain('adding zero')
  expect(answer).toContain('English (back-translated, not yet accepted): It says one plus one is two.')
  expect((ledgerOf(world))[0]).toMatch(/■ adding zero changes nothing ⋅ lake build green ⋅ English: It says one plus one is two\.$/)
})

test('lean: no model reply leaves the English unconfirmed in the tail', async ($, on) => {
  const world = beneath(on, { files: { [LAKEFILE]: LAKE_TOML, [`${FORMAL}/Anka.lean`]: GOOD }, runner: leanRunner("'Anka.two' does not depend on any axioms\n"), reply: null })
  await $.session.start(START)
  await check($, LEAN_STEP)
  const [claim] = claimsOf(world)
  expect(claim).toMatchObject({ status: 'checked' })
  expect(claim?.evidence?.axioms).toEqual([])
  expect(claim?.evidence?.tail).toContain('English unconfirmed ⋅ empty-reply')
})

test('lean: a sorry in the file is broken', async ($, on) => {
  const world = beneath(on, {
    files: { [LAKEFILE]: LAKE_TOML, [`${FORMAL}/Anka.lean`]: 'theorem Anka.two (n : Nat) : n + 0 = n := by\n  sorry\n' },
    runner: leanRunner("'Anka.two' depends on axioms: [sorryAx]\n"),
  })
  await $.session.start(START)
  await check($, LEAN_STEP)
  expect((claimsOf(world))[0]).toMatchObject({ status: 'broken', counterexample: 'no-cheat: sorry in /repo/formal/Anka.lean:2', evidence: expect.objectContaining({ hasSorry: true }) })
})

test('lean: a non-standard axiom is broken', async ($, on) => {
  const world = beneath(on, { files: { [LAKEFILE]: LAKE_TOML, [`${FORMAL}/Anka.lean`]: GOOD }, runner: leanRunner("'Anka.two' depends on axioms: [propext, Anka.magic]\n") })
  await $.session.start(START)
  await check($, LEAN_STEP)
  expect((claimsOf(world))[0]).toMatchObject({ status: 'broken', counterexample: 'non-standard axiom: Anka.magic' })
})

test('lean: a red build is broken with its last line', async ($, on) => {
  const world = beneath(on, { files: { [LAKEFILE]: LAKE_TOML, [`${FORMAL}/Anka.lean`]: GOOD }, runner: leanRunner('', 1) })
  await $.session.start(START)
  await check($, LEAN_STEP)
  expect((claimsOf(world))[0]).toMatchObject({ status: 'broken', counterexample: 'error: Anka.lean:3:2: unsolved goals' })
})

test('lean: with no file named, the scan reads the lib the lakefile names', async ($, on) => {
  const world = beneath(on, {
    files: { [LAKEFILE]: LAKE_TOML, [`${FORMAL}/Anka.lean`]: GOOD, [`${FORMAL}/Anka/Core.lean`]: 'theorem c : True := by native_decide\n' },
    dirs: { [`${FORMAL}/Anka`]: [{ name: 'Core.lean', kind: 'file' }] },
    runner: leanRunner("'Anka.two' depends on axioms: [propext]\n"),
  })
  await $.session.start(START)
  await check($, { ...LEAN_STEP, file: undefined })
  expect((claimsOf(world))[0]).toMatchObject({ status: 'broken', counterexample: 'no-cheat: native_decide in /repo/formal/Anka/Core.lean:1' })
})

// Stale, and failures

test('an Edit to a file a claim names marks it stale, status kept; an unnamed file or a helper does not', async ($, on) => {
  const world = beneath(on, { files: { '/repo/src/parse.ts': 'x' }, runner: () => ({}) })
  await $.session.start(START)
  await check($, { ...STEP, kind: 'test', command: ['bun', 'test', 'src/parse.ts'] })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e0', file_path: '/repo/src/other.ts', old_string: 'a', new_string: 'b' } as never)
  world.files.set('/repo/src/parse.ts', { text: 'y', mtimeMs: 2_000 })
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e1', agentId: 'helper', file_path: '/repo/src/parse.ts', old_string: 'a', new_string: 'b' } as never)
  expect((claimsOf(world))[0]?.stale).toBeUndefined()
  await $.tool.call({ tool: 'Edit', tool_use_id: 'e2', file_path: '/repo/src/parse.ts', old_string: 'a', new_string: 'b' } as never)
  expect((claimsOf(world))[0]).toMatchObject({ status: 'checked', stale: true })
})

test('a command that cannot start answers check failed, restores the claim, and nothing crashes', async ($, on) => {
  const world = beneath(on, {
    runner: () => {
      throw new Error('spawn bun ENOENT')
    },
  })
  await $.session.start(START)
  const answer = await check($, { ...STEP, kind: 'test', command: ['bun', 'test'] })
  expect(answer).toContain('check failed:')
  expect(claimsOf(world)).toEqual([])
  expect(ledgerOf(world)).toEqual([])
})

test('a throwing hook beneath the tool answers check failed and records nothing', async ($, on) => {
  const world = beneath(on, { isStoreBroken: true })
  await $.session.start(START)
  const answer = await check($, { ...STEP, kind: 'test', command: ['bun', 'test'] })
  expect(answer).toMatch(/^check failed: /)
  expect(world.runs).toEqual([])
  expect(claimsOf(world)).toEqual([])
})

test('bad input answers check failed with what is wrong', async ($, on) => {
  const world = beneath(on)
  await $.session.start(START)
  expect(await check($, { step: 'Lens', says: 'x', kind: 'test' })).toBe('check failed: test needs command as a non-empty argv array')
  expect(await check($, { step: 'Lens', says: 'x', kind: 'nope' })).toBe("check failed: kind must be 'test', 'differential', 'fuzz' or 'lean'")
})
