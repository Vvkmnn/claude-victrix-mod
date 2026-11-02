import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import type { Note, PlanView } from '../types'
import { nowItem } from './plan'
import { registerLens } from './lens'

// Read-only views of the lens's state for the one-line band.
const plan = atom({ plugin: 'victrix', key: 'plan' } as const, null as PlanView | null)
const notes = atom({ plugin: 'victrix', key: 'notes' } as const, [] as readonly Note[])

export const register: Register = on => {
  registerLens(on)

  // One quiet line above the prompt, on every surface: where the plan is and what waits for Claude.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const view = await read($, plan)
    const queued = await read($, notes)
    const tree = view?.tree
    if (!tree) return next(e)
    const step = nowItem(tree)
    const parts = [
      tree.progress,
      step ? `now ${step.name}` : 'all steps done',
      queued.length > 0 ? `${queued.length} note${queued.length === 1 ? '' : 's'} waiting` : undefined,
    ].filter(Boolean)
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box justifyContent="flex-end">
        <Text color={queued.length > 0 ? 'claude' : 'subtle'}>{`⊢ ${parts.join(' · ')}`}</Text>
      </Box>
    )
  })
}
