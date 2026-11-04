import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { PUSH_TEXT } from './push'

// The lens reads the plan the note names; these stand beneath it so its hook runs as in a session.
const beneath = (on: Parameters<TestBody>[1]) => {
  on('store.get', async () => ({ value: undefined }))
  on('store.set', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: false, reason: 'narrow' } }))
  on('ui.close', async () => ({ value: undefined }))
  on('fs.read', async () => {
    throw new Error('ENOENT')
  })
  on('prompt.attachment', async (_$, e) => ({ text: e.text }))
}

const note = (detail: { reminder: 'full' | 'sparse' }, agentId?: string) =>
  ({ type: 'plan_mode', text: 'Plan mode is active.', origin: { kind: 'engine' }, detail: { ...detail, planFilePath: '/home/me/.claude/plans/a.md', hasPlan: true }, ...(agentId ? { agentId } : {}) }) as const

test('the full plan-mode reminder on the main loop carries the push after the engine\'s own text', async ($, on) => {
  beneath(on)
  const result = await $.prompt.attachment(note({ reminder: 'full' }))
  expect(result.text).toBe(`Plan mode is active.\n\n${PUSH_TEXT}`)
})

test('a sparse reminder, a helper\'s loop, and other attachments pass untouched', async ($, on) => {
  beneath(on)
  expect((await $.prompt.attachment(note({ reminder: 'sparse' }))).text).toBe('Plan mode is active.')
  expect((await $.prompt.attachment(note({ reminder: 'full' }, 'helper-1'))).text).toBe('Plan mode is active.')
  const exit = await $.prompt.attachment({ type: 'plan_mode_exit', text: 'Plan mode is off.', origin: { kind: 'engine' }, detail: { planFilePath: '/home/me/.claude/plans/a.md', hasPlan: true } })
  expect(exit.text).toBe('Plan mode is off.')
})

test('the push switch off leaves the reminder alone', { options: { push: false } }, async ($, on) => {
  beneath(on)
  expect((await $.prompt.attachment(note({ reminder: 'full' }))).text).toBe('Plan mode is active.')
})

test('the push is short: Boris\'s three lines and the tags, under 130 words', () => {
  expect(PUSH_TEXT.split(/\s+/).length).toBeLessThan(130)
  for (const tag of ['facts:', 'guard:', 'options:', 'verify:', 'slow:', 'data:', 'code:', 'you:', 'claude:']) expect(PUSH_TEXT).toContain(tag)
})
