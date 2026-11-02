import type { Activity, ActivityLine } from '../types'

export const LAST_KEPT = 5

export const EMPTY_ACTIVITY: Activity = { doing: null, last: [], tokensIn: 0, tokensOut: 0, turnIn: 0, turnOut: 0 }

export type Usage = {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly cache_read_input_tokens?: number
  readonly cache_creation_input_tokens?: number
}

export type ActivityEvent =
  | { readonly kind: 'turn-start' }
  | { readonly kind: 'call-start'; readonly text: string }
  | { readonly kind: 'call-end'; readonly text: string; readonly isOk: boolean }
  | { readonly kind: 'usage'; readonly usage: Usage }
  | { readonly kind: 'turn-end' }

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

const sum = (usage: Usage) => ({
  in: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
  out: usage.output_tokens ?? 0,
})

const push = (last: readonly ActivityLine[], line: ActivityLine) => [line, ...last].slice(0, LAST_KEPT)

/** Folds one engine fact into the activity the lens draws; never throws, never mutates. */
export const reduceActivity = (state: Activity, event: ActivityEvent): Activity => {
  switch (event.kind) {
    case 'turn-start':
      return { ...state, doing: 'thinking', turnIn: 0, turnOut: 0 }
    case 'call-start':
      return { ...state, doing: event.text }
    case 'call-end':
      return { ...state, doing: 'thinking', last: push(state.last, { text: event.text, isOk: event.isOk }) }
    case 'usage': {
      const spent = sum(event.usage)
      return {
        ...state,
        tokensIn: state.tokensIn + spent.in,
        tokensOut: state.tokensOut + spent.out,
        turnIn: state.turnIn + spent.in,
        turnOut: state.turnOut + spent.out,
      }
    }
    case 'turn-end':
      return { ...state, doing: null }
  }
}

/** Token counts as a reader scans them: 950, 12k, 1.2M. */
export const formatTokens = (count: number): string => {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}
