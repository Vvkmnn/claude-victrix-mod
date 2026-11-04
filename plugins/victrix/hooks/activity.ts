import type { Activity, ActivityLine, StepSpend } from '../types'

/** Calls kept for the log; the flow row shows the last few. */
export const LAST_KEPT = 40

export const EMPTY_ACTIVITY: Activity = { doing: null, last: [], tokensIn: 0, tokensOut: 0, turnIn: 0, turnOut: 0, stepNow: null, steps: {}, said: '', saidBy: 'claude' }

export type Usage = {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
}

export type ActivityEvent =
  | { readonly kind: 'turn-start' }
  /** A call began; `helper` names a subagent's loop (its Agent description), absent on the main loop. */
  | { readonly kind: 'call-start'; readonly text: string; readonly at?: number; readonly helper?: string }
  | { readonly kind: 'call-end'; readonly text: string; readonly isOk: boolean; readonly isDeclined?: boolean; readonly at?: number; readonly ms?: number; readonly helper?: string; readonly detail?: string }
  | { readonly kind: 'usage'; readonly usage: Usage }
  | { readonly kind: 'turn-end' }
  /** The plan's lit step changed: spend from now on lands on `name` (null when every step is done). */
  | { readonly kind: 'step-enter'; readonly name: string | null; readonly at: number }
  /** Words before the next call: a thinking chunk from the main loop (Claude's own), or the person's verb as delivered. */
  | { readonly kind: 'said'; readonly text: string; readonly by?: 'claude' | 'you' }

const basename = (path: string) => path.split('/').filter(Boolean).pop() ?? path

const clip = (text: string, length: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat
}

const field = (input: Readonly<Record<string, unknown>>, key: string) => {
  const value = input[key]
  return typeof value === 'string' ? value : undefined
}

/** One short line for a tool call: what it did and to what, as a person would say it. */
export const describeCall = (tool: string, input: Readonly<Record<string, unknown>>): string => {
  const path = field(input, 'file_path') ?? field(input, 'notebook_path')
  const verbs: Readonly<Record<string, string>> = { Read: 'read', Edit: 'edit', Write: 'write', NotebookEdit: 'edit' }
  const verb = verbs[tool]
  if (verb !== undefined && path !== undefined) return `${verb} ${basename(path)}`

  const command = field(input, 'command')
  if (tool === 'Bash' && command !== undefined) return `run ${clip(command, 40)}`

  const pattern = field(input, 'pattern')
  if ((tool === 'Grep' || tool === 'Glob') && pattern !== undefined) return `search ${clip(pattern, 32)}`

  const description = field(input, 'description')
  if ((tool === 'Agent' || tool === 'Task') && description !== undefined) return `helper: ${clip(description, 36)}`

  const url = field(input, 'url')
  if (url !== undefined) return `fetch ${clip(url.replace(/^https?:\/\//, ''), 36)}`

  return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' ') : tool.toLowerCase()
}

const lineCount = (text: string) => (text === '' ? 0 : text.split('\n').length)
const counted = (count: number, word: string) => `${count} ${count === 1 ? word : `${word}s`}`
const number = (input: Readonly<Record<string, unknown>>, key: string) => (typeof input[key] === 'number' ? (input[key] as number) : undefined)
const resultText = (result: unknown): string => {
  if (typeof result === 'string') return result
  if (result && typeof result === 'object' && 'result' in result && typeof (result as { result: unknown }).result === 'string') return (result as { result: string }).result
  return ''
}

/**
 * The lowest level the engine gave for a finished call, for the person watching (owner, 2026-11-05): lines added and
 * removed for an edit, lines written, the range read, the hits a search found, the exit code of a failed run.
 * Nothing is estimated: a call the engine said nothing countable about gets no detail.
 */
export const describeResult = (tool: string, input: Readonly<Record<string, unknown>>, result: unknown): string | undefined => {
  if (tool === 'Edit') {
    const added = lineCount(field(input, 'new_string') ?? '')
    const removed = lineCount(field(input, 'old_string') ?? '')
    return `+${added} −${removed}`
  }
  if (tool === 'Write') return counted(lineCount(field(input, 'content') ?? ''), 'line')
  if (tool === 'Read') {
    const offset = number(input, 'offset')
    const limit = number(input, 'limit')
    if (offset !== undefined || limit !== undefined) {
      const start = offset ?? 1
      return limit !== undefined ? `${start}–${start + limit - 1}` : `from ${start}`
    }
    const lines = lineCount(resultText(result).trim())
    return lines > 0 ? counted(lines, 'line') : undefined
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const text = resultText(result).trim()
    const found = /^Found (\d+) (files?|matches?|lines?)/.exec(text)
    if (found) return `${found[1]} ${found[2]}`
    const lines = lineCount(text)
    return lines > 0 ? counted(lines, tool === 'Glob' ? 'file' : 'hit') : 'nothing'
  }
  if (tool === 'Bash') {
    const exit = /[Ee]xit code:? (\d+)/.exec(resultText(result))
    return exit ? `exit ${exit[1]}` : undefined
  }
  return undefined
}

// Fresh tokens only: a cache read re-sends the whole context at a tenth of the price or less, so counting it would
// show the context size, not what the step cost.
const sum = (usage: Usage) => ({
  in: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
  out: usage.output_tokens ?? 0,
})

const push = (last: readonly ActivityLine[], line: ActivityLine) => [line, ...last].slice(0, LAST_KEPT)

const SAID_KEPT = 160

/** The first sentence of Claude's words, one line, short enough for a log row. */
export const firstSentence = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  const end = flat.search(/[.!?](\s|$)/)
  return clip(end === -1 ? flat : flat.slice(0, end + 1), 72)
}

const EMPTY_SPEND: StepSpend = { calls: 0, fails: 0, tokens: 0, enteredAt: 0, ms: 0 }

const spendOn = (state: Activity, change: (spend: StepSpend) => StepSpend): Activity => {
  if (state.stepNow === null) return state
  const current = state.steps[state.stepNow] ?? EMPTY_SPEND
  return { ...state, steps: { ...state.steps, [state.stepNow]: change(current) } }
}

/** Folds one engine fact into the activity the lens draws; never throws, never mutates. */
export const reduceActivity = (state: Activity, event: ActivityEvent): Activity => {
  switch (event.kind) {
    case 'turn-start':
      return { ...state, doing: 'thinking', turnIn: 0, turnOut: 0, said: state.saidBy === 'you' ? state.said : '' }
    case 'call-start': {
      // A helper's call does not move the head row (that is the main loop's); it shows as a running line of its own
      // until it ends. Every loop's call counts as effort on the step.
      const counted = spendOn(state, spend => ({ ...spend, calls: spend.calls + 1 }))
      if (event.helper === undefined) return { ...counted, doing: event.text }
      const running: ActivityLine = { text: event.text, isOk: true, isRunning: true, helper: event.helper, at: event.at, step: state.stepNow ?? undefined }
      return { ...counted, last: push(state.last, running) }
    }
    case 'call-end': {
      const line: ActivityLine = {
        text: event.text,
        isOk: event.isOk,
        ...(event.isDeclined ? { isDeclined: true } : {}),
        at: event.at,
        ms: event.ms,
        step: state.stepNow ?? undefined,
        ...(event.helper === undefined ? { said: state.said === '' ? undefined : firstSentence(state.said), saidBy: state.said === '' ? undefined : state.saidBy } : { helper: event.helper }),
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      }
      // A helper's line replaces its own running line; the main loop's head row goes back to thinking.
      const kept = event.helper === undefined ? state.last : state.last.filter(one => !(one.isRunning && one.helper === event.helper && one.text === event.text))
      const next = event.helper === undefined ? { ...state, doing: 'thinking', last: push(kept, line), said: '', saidBy: 'claude' as const } : { ...state, last: push(kept, line) }
      // A decline is the person's choice, not a failure of Claude's: it never counts against the step.
      return event.isOk || event.isDeclined ? next : spendOn(next, spend => ({ ...spend, fails: spend.fails + 1 }))
    }
    case 'usage': {
      const spent = sum(event.usage)
      return spendOn(
        {
          ...state,
          tokensIn: state.tokensIn + spent.in,
          tokensOut: state.tokensOut + spent.out,
          turnIn: state.turnIn + spent.in,
          turnOut: state.turnOut + spent.out,
        },
        spend => ({ ...spend, tokens: spend.tokens + spent.in + spent.out }),
      )
    }
    case 'turn-end':
      return { ...state, doing: null }
    case 'step-enter': {
      if (event.name === state.stepNow) return state
      // Close the clock on the step being left, open it on the new one (its earlier time kept if Claude returns).
      const left = state.stepNow === null ? state : spendOn(state, spend => ({ ...spend, ms: spend.ms + Math.max(0, event.at - spend.enteredAt), enteredAt: 0 }))
      if (event.name === null) return { ...left, stepNow: null }
      const entered = left.steps[event.name] ?? EMPTY_SPEND
      return { ...left, stepNow: event.name, steps: { ...left.steps, [event.name]: { ...entered, enteredAt: event.at } } }
    }
    case 'said': {
      // The person's words replace whatever Claude was thinking; Claude's words append to Claude's.
      const by = event.by ?? 'claude'
      if (by === 'you') return { ...state, said: event.text.slice(-SAID_KEPT), saidBy: 'you' }
      return state.saidBy === 'you' ? state : { ...state, said: `${state.said}${event.text}`.slice(-SAID_KEPT), saidBy: 'claude' }
    }
  }
}

/** Time spent on a step so far: the closed stretches plus the open one, if it is the lit step now. */
export const timeOn = (state: Activity, step: string, now: number): number => {
  const spend = state.steps[step]
  if (!spend) return 0
  return spend.ms + (state.stepNow === step && spend.enteredAt > 0 ? Math.max(0, now - spend.enteredAt) : 0)
}

/** Token counts as a reader scans them: 950, 12k, 1.2M. */
export const formatTokens = (count: number): string => {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}
