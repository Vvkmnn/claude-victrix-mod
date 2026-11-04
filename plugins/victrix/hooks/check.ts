// The `check` tool: the mod runs a claim's check itself and the exit code decides; stdout is never a verdict.
// Lanes: a test command, a differential (slow vs fast on the same inputs), a fuzz run, and a Lean build with
// its axioms and a no-cheat scan. Every result lands in the `claims` atom by `sameClaim` and one ledger line.
import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register } from 'claude-code'

import type { Claim, Evidence } from '../types'
import { GLYPH, checked, claimOf, isStandardAxioms, label, proved, sameClaim } from './lattice'

type On = Parameters<Register>[0]
type Dollar = Pick<CoreEngineInterface, 'state' | 'fs' | 'store' | 'ui' | 'env' | 'process' | 'model'>

// Atoms are declared in the file that reads them: the engine lists a module's state by scanning its own consts.
const claims = atom({ plugin: 'victrix', key: 'claims' } as const, [] as readonly Claim[])
const changed = atom({ plugin: 'victrix', key: 'changed' } as const, [] as readonly string[])
const cwd = atom({ plugin: 'victrix', key: 'cwd' } as const, '')

export const TOOL = 'mcp__victrix__check'
const RUN_MS = 30_000
// `lake build` of a real library outlasts 30 s; ten minutes is `$.process.run`'s ceiling.
const LAKE_MS = 600_000
const TAIL_LINES = 12
const CASES_CAP = 200
const CHANGED_KEPT = 40
const BACK_MODEL = 'haiku'
const LARGE = 2 ** 31

export type CheckKind = Evidence['kind']

/** What the model sends: the claim (step and words), the lane, and that lane's commands. */
export type CheckInput = {
  readonly step: string
  readonly says: string
  readonly kind: CheckKind
  readonly command?: readonly string[]
  readonly slow?: readonly string[]
  readonly fast?: readonly string[]
  readonly inputs?: readonly string[] | { readonly generate: readonly string[] }
  readonly theorem?: string
  readonly file?: string
  readonly cwd?: string
}

type File = { readonly path: string; readonly mtimeMs: number }

/** What one lane ran: the evidence, and for Lean the English the back-translation gave (or why none). */
type Ran = { readonly evidence: Evidence; readonly english?: string }

const DESCRIPTION = [
  'Run the check behind one plan claim and record its verdict in the plan lens. The exit code decides; stdout is never trusted as a verdict.',
  "kind 'test': `command` (argv, no shell) runs; exit 0 = checked.",
  "kind 'differential': `slow` and `fast` (argv) each read every input on stdin; stdout must match byte for byte. `inputs` is a list, or { generate: argv } whose stdout lines are the inputs. Include an empty string, a negative number, a number >= 2^31, NaN and a duplicate.",
  "kind 'fuzz': `command` runs once per input from `inputs.generate` (at most 200), each on stdin; any non-zero exit is the counterexample.",
  "kind 'lean': `lake build` in `cwd` (needs lakefile.toml or lakefile.lean), then `#print axioms <theorem>`, and a scan of `file` for sorry and other cheats. At most checked until a person accepts the English.",
  'Commands must be test runners (bun, npm, pytest, go, cargo, make, lake, …) or scripts under demo/, test/ or tests/.',
].join(' ')

const ARGV = { type: 'array', items: { type: 'string' }, minItems: 1 } as const

const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    step: { type: 'string', description: 'The plan step the claim sits under, by its bold name.' },
    says: { type: 'string', description: 'The claim, in the words the plan uses.' },
    kind: { type: 'string', enum: ['test', 'differential', 'fuzz', 'lean'] },
    command: { ...ARGV, description: 'test and fuzz: the command, as an argv array.' },
    slow: { ...ARGV, description: 'differential: the obvious reference version.' },
    fast: { ...ARGV, description: 'differential: the version measured against it.' },
    inputs: {
      description: 'differential and fuzz: a list of inputs, or { generate: argv } whose stdout lines are the inputs.',
      oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'object', properties: { generate: ARGV }, required: ['generate'] }],
    },
    theorem: { type: 'string', description: 'lean: the theorem whose axioms are printed.' },
    file: { type: 'string', description: 'lean: the .lean file holding it, relative to cwd.' },
    cwd: { type: 'string', description: 'Where the commands run, relative to the repo; the repo by default.' },
  },
  required: ['step', 'says', 'kind'],
} as const

// Pure helpers

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

const clock = (at: number) => {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** `dir` joined with `path` unless absolute, `.` and `..` folded, so `test/../x` is not under `test/`. */
export const resolvePath = (dir: string, path: string): string => {
  const joined = path.startsWith('/') ? path : `${dir}/${path}`
  const parts = joined.split('/').reduce<string[]>((kept, part) => {
    if (part === '' || part === '.') return kept
    if (part === '..') return kept.slice(0, -1)
    return [...kept, part]
  }, [])
  return `/${parts.join('/')}`
}

/** The last `count` lines of a text, trailing blank lines dropped. */
export const lastLines = (text: string, count: number): string => {
  const lines = text.replace(/\s+$/, '').split('\n')
  return lines.slice(-count).join('\n')
}

const lastNonEmpty = (text: string): string | undefined => text.split('\n').map(line => line.trim()).filter(Boolean).at(-1)

/** Lines of a generator's stdout: every line, the empty one after a final newline dropped, blank lines kept. */
export const linesOf = (stdout: string): string[] => {
  const lines = stdout.split('\n')
  return stdout.endsWith('\n') ? lines.slice(0, -1) : lines
}

// Known test invocations only, never a bare interpreter: `node -e`, `python -c` or `npx anything` would make this
// tool a second Bash. The head and its first word are matched together; code-loading flags are refused anywhere.
const INVOCATIONS: readonly (readonly string[])[] = [
  ['bun', 'test'],
  ['npm', 'test'],
  ['npm', 'run'],
  ['pnpm', 'test'],
  ['pnpm', 'run'],
  ['yarn', 'test'],
  ['yarn', 'run'],
  ['node', '--test'],
  ['deno', 'test'],
  ['pytest'],
  ['python', '-m', 'pytest'],
  ['python3', '-m', 'pytest'],
  ['go', 'test'],
  ['cargo', 'test'],
  ['make', 'test'],
  ['make', 'check'],
  ['lake', 'build'],
  ['lake', 'env', 'lean'],
  ['lake', 'test'],
  ['lean', '--version'],
]
// After the invocation, every further argument must be allowed by shape, never merely not forbidden: a denylist of
// code-loading flags loses to `--eval=…`, getopt abbreviations (`--ev`), attached values (`-fMakefile`) and make's
// `NAME=value` positionals. So: a flag must be one of a few harmless ones, exactly; anything else must be a plain
// token (letters, digits, `. _ @ / -`, so no `=`, no space, no shell character) that resolves inside the repo.
const SAFE_FLAGS: ReadonlySet<string> = new Set(['-v', '--verbose', '-q', '--quiet', '--bail', '-k', '-run', '--release'])
const PLAIN_TOKEN = /^[\w.@/-]+$/
const SHELLS: ReadonlySet<string> = new Set(['bash', 'sh'])
// An interpreter may run a script, but only one under the script folders: the slow and fast versions of a differential live there.
const INTERPRETERS: ReadonlySet<string> = new Set(['python', 'python3', 'node', 'bun', 'deno'])
const SCRIPT_DIRS = ['demo', 'test', 'tests'] as const

const isUnderScriptDir = (dir: string, path: string) => SCRIPT_DIRS.some(sub => resolvePath(dir, path).startsWith(`${resolvePath(dir, sub)}/`))

/** Every token is resolved as a path and must be the repo itself or sit under it: no `..` segment anywhere, no absolute path elsewhere. */
const isPathInside = (dir: string, part: string): boolean => {
  if (part.split('/').includes('..')) return false
  const root = resolvePath(dir, '.')
  const resolved = resolvePath(dir, part)
  return resolved === root || resolved.startsWith(`${root}/`)
}

/** One argument after the invocation: a harmless flag exactly, or a plain token inside the repo. */
const isSafeExtra = (dir: string, part: string): boolean => (part.startsWith('-') ? SAFE_FLAGS.has(part) : PLAIN_TOKEN.test(part) && isPathInside(dir, part))

/**
 * True when the command may run: a known test invocation followed only by safe arguments, or a script under demo/,
 * test/ or tests/ of `dir` (bare, or via a shell or an interpreter) followed only by safe arguments.
 */
export const isAllowed = (argv: readonly string[], dir: string): boolean => {
  const [head, script] = argv
  if (head === undefined) return false
  const known = INVOCATIONS.find(words => words.every((word, index) => argv[index] === word))
  if (known !== undefined) return argv.slice(known.length).every(part => isSafeExtra(dir, part))
  if (SHELLS.has(head) || INTERPRETERS.has(head)) {
    return script !== undefined && !script.startsWith('-') && PLAIN_TOKEN.test(script) && isUnderScriptDir(dir, script) && argv.slice(2).every(part => isSafeExtra(dir, part))
  }
  return head.includes('/') && PLAIN_TOKEN.test(head) && isUnderScriptDir(dir, head) && argv.slice(1).every(part => isSafeExtra(dir, part))
}

export const refusal = (head: string) => `check refused: ${head} is not on the allowlist (test invocations such as bun test, pytest, go test, cargo test, lake build; scripts under demo/ or test/)`

/** True when the claim's files moved since the check: a path seen now with another mtime, or seen now as gone (undefined). */
export const isStale = (evidence: Pick<Evidence, 'files'>, statNow: Readonly<Record<string, number | undefined>>): boolean =>
  (evidence.files ?? []).some(file => file.path in statNow && statNow[file.path] !== file.mtimeMs)

/** What the coverage of a differential's inputs lacks of the extremes: empty, negative, ≥ 2^31, NaN, a duplicate. */
export const missingExtremes = (inputs: readonly string[]): string[] => {
  const tokens = inputs.map(input => input.split(/[\s,;[\]()]+/).filter(Boolean))
  const numbers = tokens.flat().map(Number).filter(value => !Number.isNaN(value))
  const hasDuplicate = new Set(inputs).size < inputs.length || tokens.some(list => new Set(list).size < list.length)
  const wanted: readonly [string, boolean][] = [
    ['an empty string', inputs.includes('')],
    ['a negative number', numbers.some(value => value < 0)],
    ['a very large number (>= 2^31)', numbers.some(value => Math.abs(value) >= LARGE)],
    ['NaN', tokens.some(list => list.includes('NaN'))],
    ['a duplicate', hasDuplicate],
  ]
  return wanted.filter(([, isThere]) => !isThere).map(([name]) => name)
}

const CHEATS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'sorry', pattern: /\bsorry\b/ },
  { name: 'sorryAx', pattern: /\bsorryAx\b/ },
  { name: 'native_decide', pattern: /\bnative_decide\b/ },
  { name: 'implemented_by', pattern: /\bimplemented_by\b/ },
  { name: '@[extern', pattern: /@\[extern\b/ },
  { name: 'axiom (a user axiom)', pattern: /^\s*(?:(?:private|protected|noncomputable|unsafe)\s+)*axiom\s/ },
  { name: 'assume(false)', pattern: /\bassume\s*\(\s*false\s*\)/ },
  { name: 'ensures true', pattern: /\bensures\s+true\b/ },
  { name: 'requires false', pattern: /\brequires\s+false\b/ },
]

// Comments are blanked, newlines kept, so a `sorry` in prose is no cheat and line numbers still hold.
const stripComments = (text: string) =>
  text.replace(/\/-[\s\S]*?-\//g, comment => comment.replace(/[^\n]/g, ' ')).replace(/--.*$/gm, '')

/** Every cheat in a proof file, one `name in path:line` each; empty when clean. */
export const cheatsIn = (path: string, text: string): string[] =>
  stripComments(text)
    .split('\n')
    .flatMap((line, index) => CHEATS.filter(cheat => cheat.pattern.test(line)).map(cheat => `no-cheat: ${cheat.name} in ${path}:${index + 1}`))

/** The axioms `#print axioms` named: a list, `[]` for none, undefined when the output says neither. */
export const axiomsOf = (stdout: string): string[] | undefined => {
  if (/does not depend on any axioms/.test(stdout)) return []
  const found = /depends on axioms:\s*\[([^\]]*)\]/.exec(stdout)
  return found ? (found[1] ?? '').split(',').map(axiom => axiom.trim()).filter(Boolean) : undefined
}

/** The statement of `theorem <name>`: its lines up to the first `:=`, or undefined when the file has none. */
export const statementOf = (text: string, theorem: string): string | undefined => {
  const short = theorem.split('.').at(-1) ?? theorem
  const escaped = short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const start = new RegExp(`(?:^|\\s)(?:theorem|lemma)\\s+(?:[\\w.]+\\.)?${escaped}(?![\\w.'])`, 'm').exec(text)
  if (!start) return undefined
  const from = text.slice(start.index).trimStart()
  const end = from.indexOf(':=')
  return (end === -1 ? from : from.slice(0, end)).trim()
}

/** The lean_lib's name in a lakefile, toml or lean, or the package's when no lib names itself. */
export const libOf = (lakefile: string): string | undefined => {
  const toml = /\[\[lean_lib\]\][^[]*?name\s*=\s*"([^"]+)"/.exec(lakefile) ?? /^name\s*=\s*"([^"]+)"/m.exec(lakefile)
  const lean = /lean_lib\s+«?([\w.]+)»?/.exec(lakefile)
  return toml?.[1] ?? lean?.[1]
}

/** The module a .lean file under `dir` is imported as: its path from `dir`, `/` as `.`, no extension. */
export const moduleOf = (dir: string, file: string): string => {
  const root = `${resolvePath(dir, '.')}/`.replace(/\/+$/, '/')
  const path = resolvePath(dir, file)
  return (path.startsWith(root) ? path.slice(root.length) : path.replace(/^\//, '')).replace(/\.lean$/, '').split('/').join('.')
}

/** The ledger line a finished check writes, newest first in `changed`. */
export const ledgerLine = (at: number, claim: Claim, english?: string): string => {
  const glyph = GLYPH[claim.status]
  const tail =
    claim.status === 'broken'
      ? (claim.counterexample ?? 'a case fails')
      : claim.source === 'lean'
        ? `lake build green${english === undefined ? '' : ` · English: ${english}`}`
        : `ran ${claim.evidence?.cases ?? 1}`
  return `${clock(at)} ${glyph} ${claim.says} · ${tail}`
}

/** The tool's answer to the model: the claim's label, then the tail; never a question back. */
export const answerText = (claim: Claim, english?: string): string =>
  [label(claim), lastLines(claim.evidence?.tail ?? '', TAIL_LINES), english === undefined ? '' : `English (back-translated, not yet accepted): ${english}`]
    .filter(Boolean)
    .join('\n')

const isArgv = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(part => typeof part === 'string')

/** The model's input, checked field by field; a string says what is wrong. */
export const parseInput = (raw: Readonly<Record<string, unknown>>): CheckInput | string => {
  const { step, says, kind, command, slow, fast, inputs, theorem, file } = raw
  if (typeof step !== 'string' || step === '') return 'step must be a non-empty string'
  if (typeof says !== 'string' || says === '') return 'says must be a non-empty string'
  if (kind !== 'test' && kind !== 'differential' && kind !== 'fuzz' && kind !== 'lean') return "kind must be 'test', 'differential', 'fuzz' or 'lean'"
  if ((kind === 'test' || kind === 'fuzz') && !isArgv(command)) return `${kind} needs command as a non-empty argv array`
  if (kind === 'differential' && (!isArgv(slow) || !isArgv(fast))) return 'differential needs slow and fast as argv arrays'
  const isList = Array.isArray(inputs) && inputs.every(input => typeof input === 'string')
  const isGenerate = typeof inputs === 'object' && inputs !== null && !Array.isArray(inputs) && isArgv((inputs as { generate?: unknown }).generate)
  if (kind === 'differential' && !isList && !isGenerate) return 'differential needs inputs: a list of strings or { generate: argv }'
  if (kind === 'fuzz' && !isGenerate) return 'fuzz needs inputs: { generate: argv }'
  return {
    step,
    says,
    kind,
    command: isArgv(command) ? command : undefined,
    slow: isArgv(slow) ? slow : undefined,
    fast: isArgv(fast) ? fast : undefined,
    inputs: isList ? (inputs as string[]) : isGenerate ? { generate: (inputs as { generate: string[] }).generate } : undefined,
    theorem: typeof theorem === 'string' && theorem !== '' ? theorem : undefined,
    file: typeof file === 'string' && file !== '' ? file : undefined,
    cwd: typeof raw.cwd === 'string' && raw.cwd !== '' ? raw.cwd : undefined,
  }
}

/** Every argv the input will run, for the allowlist. */
const commandsOf = (input: CheckInput): readonly (readonly string[])[] =>
  [input.command, input.slow, input.fast, input.inputs !== undefined && !Array.isArray(input.inputs) ? (input.inputs as { generate: readonly string[] }).generate : undefined].filter(
    (argv): argv is readonly string[] => argv !== undefined,
  )

const looksLikePath = (part: string) => !part.startsWith('-') && (part.includes('/') || /\.[A-Za-z0-9]+$/.test(part))

const upsert = (all: readonly Claim[], claim: Claim): readonly Claim[] =>
  all.some(old => sameClaim(old, claim)) ? all.map(old => (sameClaim(old, claim) ? claim : old)) : [...all, claim]

const quote = (text: string) => JSON.stringify(text)

// Helpers that take `$` are function declarations: the engine follows `$` only into declarations.

async function mtimeOf($: Dollar, path: string): Promise<number | undefined> {
  return $.fs.stat(path).then(
    stat => (stat.kind === 'file' ? stat.mtimeMs : undefined),
    () => undefined,
  )
}

async function lakefileOf($: Dollar, dir: string): Promise<string | undefined> {
  for (const name of ['lakefile.toml', 'lakefile.lean']) {
    const path = resolvePath(dir, name)
    if ((await mtimeOf($, path)) !== undefined) return path
  }
  return undefined
}

/** The files a check leans on, with their mtimes now: `file`, the lakefile, path-like argv entries that exist. */
async function filesOf($: Dollar, dir: string, candidates: readonly string[]): Promise<File[]> {
  const lakefile = await lakefileOf($, dir)
  const paths = [...new Set([...candidates.map(part => resolvePath(dir, part)), ...(lakefile ? [lakefile] : [])])]
  const files: File[] = []
  for (const path of paths) {
    const mtimeMs = await mtimeOf($, path)
    if (mtimeMs !== undefined) files.push({ path, mtimeMs })
  }
  return files
}

async function noteChange($: Dollar, line: string) {
  await update($, changed, lines => [line, ...lines].slice(0, CHANGED_KEPT))
}

async function inputsOf($: Dollar, input: CheckInput, dir: string): Promise<{ readonly list: readonly string[]; readonly failed?: string }> {
  if (input.inputs === undefined) return { list: [] }
  if (Array.isArray(input.inputs)) return { list: input.inputs as readonly string[] }
  const generate = (input.inputs as { generate: readonly string[] }).generate
  const ran = await $.process.run(generate, { cwd: dir, timeoutMs: RUN_MS })
  if (ran.exitCode !== 0) return { list: [], failed: `generate exited ${ran.exitCode}: ${lastNonEmpty(`${ran.stderr}\n${ran.stdout}`) ?? 'no output'}` }
  return { list: linesOf(ran.stdout) }
}

async function runTest($: Dollar, argv: readonly string[], dir: string): Promise<Ran> {
  const started = Date.now()
  const ran = await $.process.run(argv, { cwd: dir, timeoutMs: RUN_MS })
  const evidence: Evidence = {
    kind: 'test',
    command: argv.join(' '),
    exitCode: ran.exitCode,
    ms: Date.now() - started,
    tail: lastLines([ran.stderr, ran.stdout].filter(text => text.trim() !== '').join('\n'), TAIL_LINES),
    files: await filesOf($, dir, argv.filter(looksLikePath)),
  }
  return { evidence }
}

async function runDifferential($: Dollar, input: CheckInput, dir: string): Promise<Ran> {
  const slow = input.slow ?? []
  const fast = input.fast ?? []
  const started = Date.now()
  const { list, failed } = await inputsOf($, input, dir)
  const missing = missingExtremes(list)
  const notes = [
    ...(missing.length > 0 ? [`coverage: partial · missing: ${missing.join(', ')}`] : []),
    ...(list.length > CASES_CAP ? [`capped at ${CASES_CAP} of ${list.length} inputs`] : []),
  ]
  let cases = 0
  let mismatch = failed
  for (const value of list.slice(0, CASES_CAP)) {
    if (mismatch !== undefined) break
    const slowRan = await $.process.run(slow, { cwd: dir, stdin: value, timeoutMs: RUN_MS })
    const fastRan = await $.process.run(fast, { cwd: dir, stdin: value, timeoutMs: RUN_MS })
    cases += 1
    if (slowRan.exitCode !== 0) mismatch = `${quote(value)} → slow exited ${slowRan.exitCode}: ${lastNonEmpty(slowRan.stderr) ?? 'no output'}`
    else if (fastRan.exitCode !== 0) mismatch = `${quote(value)} → fast exited ${fastRan.exitCode}: ${lastNonEmpty(fastRan.stderr) ?? 'no output'}`
    else if (slowRan.stdout !== fastRan.stdout) mismatch = `${quote(value)} → slow: ${quote(slowRan.stdout)} fast: ${quote(fastRan.stdout)}`
  }
  const generate = input.inputs !== undefined && !Array.isArray(input.inputs) ? (input.inputs as { generate: readonly string[] }).generate : []
  const evidence: Evidence = {
    kind: 'differential',
    command: `slow: ${slow.join(' ')} · fast: ${fast.join(' ')}`,
    exitCode: mismatch === undefined && list.length > 0 ? 0 : 1,
    cases,
    ms: Date.now() - started,
    tail: [...notes, mismatch ?? (list.length === 0 ? 'no inputs to compare' : `${cases} inputs agree byte for byte`)].join('\n'),
    files: await filesOf($, dir, [...slow, ...fast, ...generate].filter(looksLikePath)),
  }
  return { evidence }
}

async function runFuzz($: Dollar, input: CheckInput, dir: string): Promise<Ran> {
  const command = input.command ?? []
  const started = Date.now()
  const { list, failed } = await inputsOf($, input, dir)
  const capped = list.slice(0, CASES_CAP)
  let cases = 0
  let failure = failed
  for (const value of capped) {
    if (failure !== undefined) break
    const ran = await $.process.run(command, { cwd: dir, stdin: value, timeoutMs: RUN_MS })
    cases += 1
    if (ran.exitCode !== 0) failure = `${quote(value)} → exit ${ran.exitCode}: ${lastNonEmpty(`${ran.stderr}\n${ran.stdout}`) ?? 'no output'}`
  }
  const generate = input.inputs !== undefined && !Array.isArray(input.inputs) ? (input.inputs as { generate: readonly string[] }).generate : []
  const evidence: Evidence = {
    kind: 'fuzz',
    command: command.join(' '),
    exitCode: failure === undefined && capped.length > 0 ? 0 : 1,
    cases,
    ms: Date.now() - started,
    tail: [
      ...(list.length > CASES_CAP ? [`capped at ${CASES_CAP} of ${list.length} inputs`] : []),
      failure ?? (capped.length === 0 ? 'no inputs generated' : `${cases} inputs exited 0`),
    ].join('\n'),
    files: await filesOf($, dir, [...command, ...generate].filter(looksLikePath)),
  }
  return { evidence }
}

/** Every .lean file under `path`, depth-first, at most a few levels down. */
async function leanFilesUnder($: Dollar, path: string, depth: number): Promise<string[]> {
  if (depth < 0) return []
  const entries = await $.fs.list(path).catch(() => [])
  const found: string[] = []
  for (const entry of entries) {
    const child = `${path}/${entry.name}`
    if (entry.kind === 'file' && entry.name.endsWith('.lean')) found.push(child)
    else if (entry.kind === 'dir' && !entry.name.startsWith('.')) found.push(...(await leanFilesUnder($, child, depth - 1)))
  }
  return found
}

/** The files the no-cheat scan reads: `file`, else every .lean file the build log names, else the lib's. */
async function proofFilesOf($: Dollar, input: CheckInput, dir: string, buildLog: string, lib: string | undefined): Promise<string[]> {
  if (input.file !== undefined) return [resolvePath(dir, input.file)]
  const named = [...new Set((buildLog.match(/[\w./-]+\.lean\b/g) ?? []).map(path => resolvePath(dir, path)))]
  const existing: string[] = []
  for (const path of named) if ((await mtimeOf($, path)) !== undefined) existing.push(path)
  if (existing.length > 0) return existing
  if (lib === undefined) return []
  const root = resolvePath(dir, `${lib.split('.').join('/')}.lean`)
  return [...((await mtimeOf($, root)) !== undefined ? [root] : []), ...(await leanFilesUnder($, resolvePath(dir, lib.split('.').join('/')), 4))]
}

async function backTranslate($: Dollar, statement: string): Promise<{ readonly english?: string; readonly why?: string }> {
  const prompt = [
    'Here is the statement of a Lean 4 theorem. Say in one plain-English sentence exactly what it states, nothing more.',
    'No preamble, no proof sketch, no judgement of whether it is true.',
    '',
    statement,
  ].join('\n')
  const reply = await $.model.complete({ model: BACK_MODEL, prompt, maxTokens: 200, effort: 'low', timeoutMs: 30_000 })
  if (!reply.isAnswered) return { why: reply.reason }
  const sentence = reply.text.trim().split('\n').map(line => line.trim()).filter(Boolean).join(' ')
  return sentence === '' ? { why: 'empty-reply' } : { english: sentence }
}

async function runLean($: Dollar, input: CheckInput, dir: string, lakefile: string): Promise<Ran> {
  const started = Date.now()
  const version = await $.process.run(['lean', '--version'], { cwd: dir, timeoutMs: RUN_MS }).then(
    ran => lastNonEmpty(ran.stdout) ?? lastNonEmpty(ran.stderr) ?? 'lean --version printed nothing',
    error => `lean --version failed: ${errorText(error)}`,
  )
  const build = await $.process.run(['lake', 'build'], { cwd: dir, timeoutMs: LAKE_MS })
  const buildLog = `${build.stderr}\n${build.stdout}`
  const lib = libOf(await $.fs.read(lakefile).catch(() => ''))
  const proofFiles = await proofFilesOf($, input, dir, buildLog, lib)
  const texts: { readonly path: string; readonly text: string }[] = []
  for (const path of proofFiles) texts.push({ path, text: await $.fs.read(path).catch(() => '') })
  const cheats = texts.flatMap(({ path, text }) => cheatsIn(path, text))

  const theorem = input.theorem
  let axioms: string[] | undefined
  let axiomsLine = theorem === undefined ? 'no theorem named: axioms unchecked' : 'axioms not printed: the build failed'
  let exitCode = build.exitCode
  if (build.exitCode === 0 && theorem !== undefined) {
    const module = input.file !== undefined ? moduleOf(dir, input.file) : lib
    if (module === undefined) {
      axiomsLine = 'axioms unchecked: no module to import (name file, or a lean_lib in the lakefile)'
      exitCode = 1
    } else {
      const tmp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/+$/, '')
      const probe = `${tmp}/victrix-axioms-${Date.now()}.lean`
      await $.fs.write(probe, `import ${module}\n#print axioms ${theorem}\n`)
      const printed = await $.process.run(['lake', 'env', 'lean', probe], { cwd: dir, timeoutMs: LAKE_MS })
      axioms = printed.exitCode === 0 ? axiomsOf(printed.stdout) : undefined
      exitCode = printed.exitCode
      axiomsLine =
        printed.exitCode !== 0
          ? `#print axioms failed: ${lastNonEmpty(`${printed.stderr}\n${printed.stdout}`) ?? `exit ${printed.exitCode}`}`
          : axioms === undefined
            ? `axioms not found for ${theorem} in: ${lastNonEmpty(printed.stdout) ?? 'no output'}`
            : `axioms: ${axioms.length === 0 ? 'none' : axioms.join(', ')}`
    }
  }
  const nonStandard = axioms === undefined ? [] : axioms.filter(axiom => !isStandardAxioms([axiom]))

  const statement = theorem === undefined ? undefined : texts.map(({ text }) => statementOf(text, theorem)).find(found => found !== undefined)
  const back = statement === undefined ? { why: theorem === undefined ? 'no theorem named' : 'statement not found in the file' } : await backTranslate($, statement)
  const englishLine = back.english !== undefined ? undefined : `English unconfirmed · ${back.why ?? 'no model available'}`

  // proved() takes the tail's last line as the counterexample, so the reason it fails comes last.
  const reason =
    build.exitCode !== 0
      ? (lastNonEmpty(buildLog) ?? `lake build exited ${build.exitCode}`)
      : cheats.length > 0
        ? cheats[0]
        : nonStandard.length > 0
          ? `non-standard axiom: ${nonStandard.join(', ')}`
          : axiomsLine
  const tail = [
    `checker: ${version}`,
    `lake build exited ${build.exitCode}`,
    ...(build.exitCode !== 0 ? [lastLines(buildLog, 4)] : []),
    ...(englishLine ? [englishLine] : []),
    ...cheats.slice(1, 4),
    ...(axiomsLine === reason ? [] : [axiomsLine]),
    reason,
  ].join('\n')
  const evidence: Evidence = {
    kind: 'lean',
    command: theorem === undefined ? 'lake build' : `lake build · #print axioms ${theorem}`,
    exitCode,
    ms: Date.now() - started,
    tail: lastLines(tail, TAIL_LINES),
    theorem,
    axioms,
    hasSorry: cheats.length > 0,
    english: back.english,
    files: await filesOf($, dir, proofFiles),
  }
  return { evidence, english: back.english }
}

/** Whether anything may run: only a repo the person opened up in the store (`victrix.allowAny:<repo>`); no name-based bypass. */
async function isOpen($: Dollar, repo: string): Promise<boolean> {
  return (await $.store.get(`victrix.allowAny:${repo}`)) === true
}

/**
 * Runs one check and records it: the claim is marked checking, the lane runs, and the claim lands checked,
 * broken or (Lean) at most checked, with one ledger line. Answers the text the model reads; never throws.
 */
async function runCheck($: Dollar, input: CheckInput): Promise<string> {
  const repo = await read($, cwd)
  const root = resolvePath(repo === '' ? '/' : repo, '.')
  const dir = resolvePath(root, input.cwd ?? '.')
  if (dir !== root && !dir.startsWith(`${root}/`)) return `check refused: cwd ${dir} is outside the repo ${root}`
  if (!(await isOpen($, repo))) {
    const refused = commandsOf(input).find(argv => !isAllowed(argv, dir))
    if (refused !== undefined) return refusal(refused[0] ?? '')
  }
  const lakefile = input.kind === 'lean' ? await lakefileOf($, dir) : undefined
  if (input.kind === 'lean' && lakefile === undefined) return `check: no lakefile.toml or lakefile.lean in ${dir}; nothing recorded`

  const before = (await read($, claims)).find(claim => sameClaim(claim, input))
  const base: Claim = before ?? claimOf(input.step, input.says, 'tool', Date.now())
  await update($, claims, all => upsert(all, { ...base, isChecking: true }))
  try {
    const ran =
      input.kind === 'test'
        ? await runTest($, input.command ?? [], dir)
        : input.kind === 'differential'
          ? await runDifferential($, input, dir)
          : input.kind === 'fuzz'
            ? await runFuzz($, input, dir)
            : await runLean($, input, dir, lakefile ?? '')
    const at = Date.now()
    const after = input.kind === 'lean' ? proved(base, ran.evidence, false, at) : checked(base, ran.evidence, at)
    await update($, claims, all => upsert(all, after))
    await noteChange($, ledgerLine(at, after, ran.english))
    return answerText(after, ran.english)
  } catch (error) {
    // A run that could not start or timed out decides nothing: the claim goes back to what it was.
    await update($, claims, all => (before ? upsert(all, before) : all.filter(claim => !sameClaim(claim, input))))
    return `check failed: ${errorText(error)}`
  }
}

/**
 * Runs a step's verify command as a `test` check, for the lens to call when a step flips to done.
 * Answers the text a `check` call would; never throws.
 */
export async function runVerify($: Dollar, step: string, says: string, argv: readonly string[], dir: string): Promise<string> {
  try {
    return await runCheck($, { step, says, kind: 'test', command: argv, cwd: dir })
  } catch (error) {
    return `check failed: ${errorText(error)}`
  }
}

/** Marks stale every claim whose evidence names `path`, when its mtime moved; status stays. */
async function markStale($: Dollar, path: string) {
  const all = await read($, claims)
  const named = all.filter(claim => claim.evidence?.files?.some(file => file.path === path) === true && claim.stale !== true)
  if (named.length === 0) return
  const statNow = { [path]: await mtimeOf($, path) }
  const stale = named.filter(claim => claim.evidence !== undefined && isStale(claim.evidence, statNow))
  if (stale.length === 0) return
  await update($, claims, current => current.map(claim => (stale.some(old => sameClaim(old, claim)) ? { ...claim, stale: true as const } : claim)))
}

// Matchers, not bare hooks: the lens already holds the module's one matcher-less `session.start` and `tool.call`,
// and the engine's scanner refuses a second. `isInteractive` either way is every session.
const EVERY_SESSION = { isInteractive: [true, false] } as const
const EDITS = { tool: ['Edit', 'Write', 'NotebookEdit'] } as const

export const registerCheck = (on: On) => {
  on('session.start', EVERY_SESSION, async ($, e, next) => {
    try {
      await update($, cwd, value => (value === '' ? e.cwd : value))
      await $.tool.register({ name: 'check', description: DESCRIPTION, inputSchema: INPUT_SCHEMA, isDeferred: false })
    } catch (error) {
      $.ui.log(`victrix: check tool not registered: ${errorText(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    try {
      const input = parseInput({ ...e } as Readonly<Record<string, unknown>>)
      const text = typeof input === 'string' ? `check failed: ${input}` : await runCheck($, input)
      return { result: text }
    } catch (error) {
      return { result: `check failed: ${errorText(error)}` }
    }
  })

  // Observes only: the edit runs as it would; a main-loop edit to a file a claim's evidence names marks it stale.
  on('tool.call', EDITS, async ($, e, next) => {
    const result = await next(e)
    try {
      const path = (e as { file_path?: unknown }).file_path
      const isOk = result.deny === undefined && result.isError !== true
      if (e.agentId === undefined && isOk && typeof path === 'string') {
        await markStale($, resolvePath((await read($, cwd)) || '/', path))
      }
    } catch (error) {
      $.ui.log(`victrix: stale check failed: ${errorText(error)}`, { to: 'debug' })
    }
    return result
  })
}
