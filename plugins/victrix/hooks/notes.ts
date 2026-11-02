import type { Note, NoteKind } from '../types'

/** The ledger keeps this many lines per repo: small and earned, never a transcript. */
export const LOG_KEPT = 150

export type Verb = { readonly kind: NoteKind; readonly hotkey: string; readonly label: string }

/** The three verbs, in the order the legend draws them; every one is a key and a visible button. */
export const VERBS: readonly Verb[] = [
  { kind: 'doubt', hotkey: 'd', label: 'doubt' },
  { kind: 'add', hotkey: 'a', label: 'add data' },
  { kind: 'wrong', hotkey: 'w', label: 'wrong path' },
]

const WORDS: Readonly<Record<NoteKind, string>> = { doubt: 'doubt', add: 'add data', wrong: 'wrong path' }

/** One short line for a note, as the lens and the log show it. */
export const describeNote = (note: Note): string =>
  note.text === '' ? `${WORDS[note.kind]} · ${note.step}` : `${WORDS[note.kind]} · ${note.step} · ${note.text}`

const instruction = (note: Note): string => {
  switch (note.kind) {
    case 'doubt':
      return `DOUBT on step "${note.step}": the person doubts what this step rests on. Before relying on it, re-check it with a tool (read the code, run it, measure it) and say what you found.`
    case 'wrong':
      return `WRONG PATH on step "${note.step}": the person says this branch is wrong. Stop it, say in one line why it was chosen, and propose another route in the plan file.`
    case 'add':
      return `ADD DATA for step "${note.step}": ${note.text}. Fold this fact into the plan; replan only the steps it changes.`
  }
}

/**
 * What Claude reads for a batch of notes: one block, imperative, never a question back to the
 * person. The same text whether it rides along a typed prompt as context or is submitted alone.
 */
export const deliveryText = (notes: readonly Note[]): string =>
  [
    'Vada, the plan lens: the person pressed these on the plan. Act on each at your next step; do not stop to ask whether to.',
    ...notes.map(note => `- ${instruction(note)}`),
  ].join('\n')

/** The ledger line: when, which verb, which step, the fact if any. */
export const logLine = (note: Note): string => `${new Date(note.at).toISOString()} ${describeNote(note)}`

/** Appends to the ledger, newest last, keeping the newest LOG_KEPT lines. */
export const appendLog = (log: readonly string[], line: string): string[] => [...log, line].slice(-LOG_KEPT)
