// A small layout of a drawn tree into ANSI rows, close enough to the terminal's to judge the instrument by eye:
// a column Box stacks rows, a row Box joins them with its gap, Text carries colour, dim, bold and inverse, a plain
// Button draws its label with the hotkey prefix the engine draws. Pure; used by the preview test and the lab.

export type Drawn = { readonly type: string; readonly props?: Record<string, unknown>; readonly children?: readonly unknown[] } | string | null | undefined

const ANSI: Readonly<Record<string, string>> = {
  yellow: '\u001b[33m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
}
const DIM = '\u001b[2m'
const BOLD = '\u001b[1m'
const INVERSE = '\u001b[7m'
const RESET = '\u001b[0m'

type Styled = { readonly text: string; readonly style: string }

const styleOf = (props: Record<string, unknown>): string =>
  [
    typeof props.color === 'string' ? (ANSI[props.color] ?? '') : '',
    props.dimColor === true ? DIM : '',
    props.bold === true || props.weight === 'semibold' || props.weight === 'bold' ? BOLD : '',
    props.inverse === true ? INVERSE : '',
  ].join('')

const gapCells = (gap: unknown): number => (typeof gap === 'number' ? gap : gap === 'xs' || gap === 'sm' ? 1 : gap === 'md' ? 2 : gap === 'lg' ? 3 : gap === 'xl' ? 4 : 0)

/** The rows one element draws, each row a list of styled runs. */
const rowsOf = (node: Drawn): Styled[][] => {
  if (node === null || node === undefined) return []
  if (typeof node === 'string') return [[{ text: node, style: '' }]]
  const props = node.props ?? {}
  const children = (node.children ?? []) as Drawn[]
  switch (node.type) {
    case 'Text': {
      const style = styleOf(props)
      const runs = children.flatMap(child => (typeof child === 'string' ? [{ text: child, style }] : rowsOf(child).flat().map(run => ({ ...run, style: style + run.style }))))
      return [runs]
    }
    case 'Button': {
      const hotkey = typeof props.hotkey === 'string' ? props.hotkey : ''
      const label = typeof props.label === 'string' ? props.label : ''
      const inner: Styled[] = children.length > 0 ? children.flatMap(child => rowsOf(child).flat()) : [{ text: label, style: props.dimColor === true ? DIM : '' }]
      const prefix: Styled[] = hotkey ? [{ text: hotkey, style: ANSI.yellow ?? '' }, { text: ': ', style: props.dimColor === true ? DIM : '' }] : []
      return [[...prefix, ...inner]]
    }
    case 'Box': {
      const isRow = props.flexDirection === 'row' || props.flexDirection === 'row-reverse'
      const gap = gapCells(props.gap ?? props.columnGap)
      const parts = children.map(rowsOf).filter(rows => rows.length > 0)
      if (isRow) {
        const height = Math.max(1, ...parts.map(rows => rows.length))
        const out: Styled[][] = Array.from({ length: height }, () => [])
        parts.forEach((rows, index) => {
          for (let r = 0; r < height; r += 1) {
            if (index > 0 && gap > 0) out[r]?.push({ text: ' '.repeat(gap), style: '' })
            out[r]?.push(...(rows[r] ?? []))
          }
        })
        return out
      }
      const stacked = parts.flat()
      const grow = children.some(child => typeof child === 'object' && child !== null && (child as { props?: { flexGrow?: number } }).props?.flexGrow !== undefined)
      const minHeight = typeof props.minHeight === 'number' ? props.minHeight : 0
      if (grow && stacked.length < minHeight) {
        // The flexGrow spacer sits before the rows that follow it: pad where it stands.
        const at = children.findIndex(child => typeof child === 'object' && child !== null && (child as { props?: { flexGrow?: number } }).props?.flexGrow !== undefined)
        const before = children.slice(0, at).map(rowsOf).flat().length
        const padding = Array.from({ length: minHeight - stacked.length }, (): Styled[] => [])
        return [...stacked.slice(0, before), ...padding, ...stacked.slice(before)]
      }
      return stacked
    }
    default:
      return children.flatMap(rowsOf)
  }
}

const cellsOf = (text: string) => Array.from(text).length

/** The drawn tree as ANSI rows, each padded or cut to `columns` cells. */
export const renderAnsi = (tree: Drawn, columns: number): string[] =>
  rowsOf(tree).map(runs => {
    let used = 0
    const parts: string[] = []
    for (const run of runs) {
      const room = columns - used
      if (room <= 0) break
      const chars = Array.from(run.text)
      const text = chars.length > room ? chars.slice(0, room).join('') : run.text
      used += cellsOf(text)
      parts.push(run.style ? `${run.style}${text}${RESET}` : text)
    }
    return parts.join('') + ' '.repeat(Math.max(0, columns - used))
  })

/** The same rows without colour, for assertions. */
export const renderPlain = (tree: Drawn, columns: number): string[] => renderAnsi(tree, columns).map(row => row.replace(/\u001b\[[0-9;]*m/g, ''))
