import type { Register } from 'claude-code'

import { registerCheck } from './check'
import { registerLens } from './lens'
import { registerPane } from './pane'
import { registerPush } from './push'
import { registerTape } from './tape'

export const register: Register = (on, options) => {
  registerLens(on, options.motion !== false, options.review !== false)
  registerPane(on)
  registerTape(on)
  registerPush(on, options.push !== false)
  if (options.check !== false) registerCheck(on)
}
