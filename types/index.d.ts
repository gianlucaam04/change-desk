export type Change = {
  path: string
  tool: string
  // content before Claude's first edit; null = the file did not exist
  before: string | null
  edits: number
  isUndone: boolean
  // number of the prompt that made this edit, counted from the session's start
  turn: number
  // text of the prompt that led to this edit
  prompt: string
}
export type Limit = { kind: string; percent: number; resetsAt?: string }
export type Meter = {
  percent: number
  tokens: number
  window: number
  usd: number
  limits: Limit[]
  // limits read from the last session that had them, until fresh ones arrive
  isStale: boolean
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
