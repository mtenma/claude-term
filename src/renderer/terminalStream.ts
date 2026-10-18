import type {TermAck, TermInput, TermOut} from '../shared/types'
import {resizeTerminal} from '../shared/terminalResize'

interface StreamTerminal {
  readonly cols: number
  readonly rows: number
  reset(): void
  resize(cols: number, rows: number): void
  write(data: string, callback: () => void): void
}

interface PendingOutput {
  payload: TermOut | null
  resolve(): void
  reject(error: unknown): void
}

const WRITE_BATCH_SIZE = 64 * 1024

/** 出力のパース順と、その画面から返す入力・受信確認の宛先を一緒に管理する。 */
export class TerminalStream {
  private queue: PendingOutput[] = []
  private draining = false
  private pending = 0
  displayedId: string | null = null

  constructor(
    private term: StreamTerminal,
    private onInput: (input: TermInput) => void,
    private onAck: (ack: TermAck) => void,
    private onSnapshot: (id: string) => void,
  ) {}

  get busy(): boolean {
    return this.pending > 0
  }

  input(data: string): void {
    if (this.displayedId !== null) this.onInput({id: this.displayedId, data})
  }

  accept(payload: TermOut | null): Promise<void> {
    this.pending++
    return new Promise((resolve, reject) => {
      this.queue.push({payload, resolve, reject})
      if (!this.draining) void this.drain()
    })
  }

  private async drain(): Promise<void> {
    this.draining = true
    while (this.queue.length) {
      const first = this.queue.shift()!
      const batch = [first]
      let payload = first.payload
      // PTY の約1KBの断片ごとに Chromium のタイマーを待つと、大量出力が遅延する。
      // 同じ表示の連続データだけをまとめ、resize・snapshot・消去の境界は越えない。
      if (payload?.kind === 'data') {
        const parts = [payload.data]
        let size = payload.data.length
        while (this.queue.length) {
          const next = this.queue[0].payload
          if (next?.kind !== 'data' || next.id !== payload.id || next.epoch !== payload.epoch ||
              size + next.data.length > WRITE_BATCH_SIZE) break
          batch.push(this.queue.shift()!)
          parts.push(next.data)
          size += next.data.length
        }
        payload = {...payload, data: parts.join('')}
      }
      try {
        await this.apply(payload)
        for (const item of batch) item.resolve()
      } catch (error) {
        // 呼出元に通知しつつ、後続の snapshot による復元は続けられるようにする。
        for (const item of batch) item.reject(error)
      } finally {
        this.pending -= batch.length
      }
    }
    this.draining = false
  }

  private async apply(payload: TermOut | null): Promise<void> {
    if (payload === null) {
      this.displayedId = null
      this.term.reset()
      return
    }
    if (payload.kind === 'resize') {
      if (payload.reflowCursorLine) resizeTerminal(this.term, payload.cols, payload.rows)
      else this.term.resize(payload.cols, payload.rows)
      return
    }
    if (payload.kind === 'snapshot') {
      // main 側の選択は既に次へ進んでいても、ここで復元する画面の宛先を使う。
      this.displayedId = payload.id
      this.term.reset()
      this.term.resize(payload.cols, payload.rows)
    }
    await new Promise<void>((resolve) => this.term.write(payload.data, resolve))
    this.onAck({id: payload.id, epoch: payload.epoch, bytes: payload.data.length})
    if (payload.kind === 'snapshot') this.onSnapshot(payload.id)
  }
}
