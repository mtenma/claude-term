interface ResizableTerminal {
  readonly cols: number
  readonly rows: number
  resize(cols: number, rows: number): void
}

interface Disposable {
  dispose(): void
}

interface BufferLine {
  isWrapped: boolean
  getWidth(column: number): number
  hasContent(column: number): number
  getTrimmedLength(): number
}

interface NormalBuffer {
  x: number
  y: number
  ybase: number
  savedX: number
  savedY: number
  readonly _isReflowEnabled: boolean
  resize(cols: number, rows: number): void
  lines: {
    readonly length: number
    get(row: number): BufferLine | undefined
    onInsert(listener: (event: {index: number, amount: number}) => void): Disposable
    onDelete(listener: (event: {index: number, amount: number}) => void): Disposable
    onTrim(listener: (amount: number) => void): Disposable
  }
}

interface TerminalCore {
  buffers: {normal: NormalBuffer}
  options: {reflowCursorLine: boolean}
}

function getCore(term: ResizableTerminal): TerminalCore {
  const core = (term as ResizableTerminal & {_core?: TerminalCore})._core
  const buffer = core?.buffers?.normal
  if (!buffer || typeof buffer.resize !== 'function' || typeof buffer.lines?.onInsert !== 'function' ||
      typeof buffer.lines.onDelete !== 'function' || typeof buffer.lines.onTrim !== 'function' ||
      typeof buffer._isReflowEnabled !== 'boolean' || typeof core?.options.reflowCursorLine !== 'boolean') {
    throw new Error('Unsupported xterm resize internals; verify terminalResize when upgrading xterm')
  }
  return core
}

function wrappedLength(line: BufferLine, next: BufferLine | undefined, cols: number): number {
  if (!next?.isWrapped) return line.getTrimmedLength()
  // xterm leaves an empty last cell when the next wide character does not fit.
  // That padding is not part of the logical line (BufferReflow.ts in xterm 6).
  return !line.hasContent(cols - 1) && line.getWidth(cols - 1) === 1 && next.getWidth(0) === 2
    ? cols - 1 : cols
}

function captureCursor(buffer: NormalBuffer, oldCols: number, newCols: number, cursorRow: number, cursorX: number) {
  let first = cursorRow
  while (first > 0 && buffer.lines.get(first)?.isWrapped) first--
  let last = cursorRow
  while (last + 1 < buffer.lines.length && buffer.lines.get(last + 1)?.isWrapped) last++

  let offset = cursorX
  let cells = 0
  const lengths: number[] = []
  let length = 0
  for (let row = first; row <= last; row++) {
    const line = buffer.lines.get(row)!
    const used = wrappedLength(line, row < last ? buffer.lines.get(row + 1) : undefined, oldCols)
    if (row < cursorRow) offset += used
    cells += used
    for (let column = 0; column < used;) {
      const width = line.getWidth(column) === 2 ? 2 : 1
      if (length + width > newCols) {
        lengths.push(length)
        length = 0
      }
      length += width
      column += width
    }
  }
  lengths.push(length)

  let row = 0
  let column = offset
  while (row < lengths.length - 1 &&
      (column > lengths[row] || column === lengths[row] &&
        (lengths[row] < newCols || cursorX !== oldCols))) {
    column -= lengths[row++]
  }
  // A cursor positioned in empty cells has no text to reflow there. Retain the
  // terminal's usual column clamp instead of inserting artificial spaces.
  column = Math.min(column, offset > cells ? newCols - 1 : newCols)
  return {first, row, column}
}

function resizeColumns(core: TerminalCore, resize: NormalBuffer['resize'], oldCols: number, cols: number, rows: number): void {
  const buffer = core.buffers.normal
  if (!buffer._isReflowEnabled || buffer.lines.length === 0) {
    resize.call(buffer, cols, rows)
    return
  }
  const cursor = captureCursor(buffer, oldCols, cols, buffer.ybase + buffer.y, buffer.x)
  const saved = captureCursor(buffer, oldCols, cols,
    Math.min(buffer.lines.length - 1, Math.max(0, buffer.savedY)), buffer.savedX)
  const anchors = [cursor, saved]
  const listeners = [
    buffer.lines.onInsert(({index, amount}) => {
      for (const anchor of anchors) if (anchor.first >= index) anchor.first += amount
    }),
    buffer.lines.onDelete(({index, amount}) => {
      for (const anchor of anchors) if (anchor.first >= index) anchor.first -= Math.min(amount, anchor.first - index)
    }),
    buffer.lines.onTrim((amount) => { for (const anchor of anchors) anchor.first -= amount }),
  ]
  const previousReflow = core.options.reflowCursorLine
  try {
    core.options.reflowCursorLine = true
    resize.call(buffer, cols, rows)
    buffer.x = cursor.column
    buffer.y = Math.max(0, Math.min(rows - 1, cursor.first + cursor.row - buffer.ybase))
    buffer.savedX = saved.column
    buffer.savedY = Math.max(0, Math.min(buffer.ybase + rows - 1, saved.first + saved.row))
  } finally {
    core.options.reflowCursorLine = previousReflow
    for (const listener of listeners) listener.dispose()
  }
}

/**
 * Resize only after preceding writes have finished parsing, outside a write callback.
 * xterm 6 skips the cursor's wrapped line by default; enabling its reflow alone
 * loses the logical cursor position and the next write overwrites existing text.
 * Keep cell/attribute reflow in xterm and isolate its pinned private cursor API here.
 */
export function resizeTerminal(term: ResizableTerminal, cols: number, rows: number): void {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new Error('Terminal dimensions must be integers')
  cols = Math.max(2, cols)
  rows = Math.max(1, rows)
  if (term.cols === cols && term.rows === rows) return
  const core = getCore(term)
  const buffer = core.buffers.normal
  const resize = buffer.resize
  const descriptor = Object.getOwnPropertyDescriptor(buffer, 'resize')
  const oldCols = term.cols
  const oldRows = term.rows
  // Complete cursor correction before public resize listeners/renderers run.
  // Only the normal buffer is intercepted; the alternate screen is resized by
  // xterm once, with its native terminal semantics.
  buffer.resize = (nextCols, nextRows) => {
    if (oldCols !== nextCols) resizeColumns(core, resize, oldCols, nextCols, oldRows)
    if (oldRows !== nextRows) {
      // Reflow columns first: shrinking scrollback capacity along with rows must
      // not trim the beginning of a logical line before its cursor is mapped.
      const pendingWrap = buffer.x === nextCols
      const savedPendingWrap = buffer.savedX === nextCols
      resize.call(buffer, nextCols, nextRows)
      if (pendingWrap) buffer.x = nextCols
      if (savedPendingWrap) buffer.savedX = nextCols
    }
  }
  try {
    term.resize(cols, rows)
  } finally {
    if (descriptor) Object.defineProperty(buffer, 'resize', descriptor)
    else delete (buffer as Partial<NormalBuffer>).resize
  }
}
