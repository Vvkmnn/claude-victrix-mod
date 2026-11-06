// The design system's shared parts, pure data (no `$`): the one key table and Victrix's mark. Every surface draws its
// `?` card and its key hints from KEYS, so a key's letter and its words are written once (docs/DESIGN.md). The
// footer of every size shows only `h: ? keys` (owner, 2026-11-07); the rest live in that card, each a labelled
// button that works by click as well as by key (hotkeys do nothing in VS Code; the desktop draws native buttons).
import { MARK } from './draw'

export type KeyAction = 'size' | 'explain' | 'check' | 'doubt' | 'add' | 'wrong' | 'hide' | 'keys'
export type Surface = 'pane' | 'row'

export type KeyEntry = {
  /** One lowercase letter: the engine refuses anything else (`?` included), and fires it only while our site holds focus. */
  readonly hotkey: string
  readonly action: KeyAction
  /** The words after the letter, saying what pressing it will do. */
  readonly label: string
  /** Where the key works: the row has no card to explain in and nothing to hide into. */
  readonly on: readonly Surface[]
}

export const KEYS: readonly KeyEntry[] = [
  { hotkey: 's', action: 'size', label: 'size: pane, row, hidden', on: ['pane', 'row'] },
  { hotkey: 'e', action: 'explain', label: 'explain this step', on: ['pane'] },
  { hotkey: 'c', action: 'check', label: "run the step's check", on: ['pane', 'row'] },
  { hotkey: 'd', action: 'doubt', label: 'doubt this step', on: ['pane', 'row'] },
  { hotkey: 'a', action: 'add', label: 'add a fact', on: ['pane', 'row'] },
  { hotkey: 'w', action: 'wrong', label: 'wrong path', on: ['pane', 'row'] },
  { hotkey: 'q', action: 'hide', label: 'hide the pane', on: ['pane'] },
  { hotkey: 'h', action: 'keys', label: 'close these keys', on: ['pane', 'row'] },
]

/** The keys one surface offers, in the table's order. */
export const keysOn = (surface: Surface): readonly KeyEntry[] => KEYS.filter(entry => entry.on.includes(surface))

/** The one footer button on every size: the engine draws it `h: ? keys`. */
export const KEYS_BUTTON = { hotkey: 'h', label: '? keys' } as const

/** Victrix's mark, the snake's head: the name blended into the line right behind the triangle (owner, 2026-11-07). */
export const MARK_NAME = 'victrix'
export const HEAD = `${MARK_NAME}${MARK.head}`
