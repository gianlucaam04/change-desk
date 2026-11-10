export type Change = {
  path: string
  tool: string
  // content before Claude's first edit; null = the file did not exist
  before: string | null
  edits: number
  isUndone: boolean
  // when Claude last edited the file in this entry, in $.clock.now() ms;
  // 0 when rebuilt from the transcript, which keeps no time per call
  at: number
  // lines added and removed, summed from the diffs Claude Code recorded
  added: number
  removed: number
  // number of the prompt that made this edit, counted from the session's start
  turn: number
  // text of the prompt that led to this edit
  prompt: string
  // true when Claude Code did not record the original (too large): no undo
  isBeforeLost?: boolean
}
export type Limit = { kind: string; percent: number; resetsAt?: string }
export type Meter = {
  // null until a response reports the context fill
  percent: number | null
  tokens: number
  window: number
  usd: number
  // empty until the server's first response reports them
  limits: Limit[]
}

declare module 'claude-code' {
  interface PluginState {
    'change-desk': {
      changes: Shaped<Change[]>
      meter: Shaped<Meter | null>
      turn: Shaped<number>
      prompt: Shaped<string>
    }
  }
}
