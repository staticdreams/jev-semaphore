export type Backend = 'typesafe' | 'openrouter' | 'kev-local' | 'off'
export type Mode = 'auto' | 'recommend' | 'off'
export type Tab = 'routing' | 'setup' | 'ledger'
export type DecisionSource = 'jev' | 'kev' | 'heuristic' | 'pin'

/** One ranked model in a decision: `score` is our feature fit, `p` Jev's probability. */
export type Candidate = { model: string; score: number; p: number }

export type Decision = {
  id: string
  at: number
  role: string
  task: string
  /** What Jev ranked first. */
  picked: string
  /** What the subagent actually ran on (differs when a floor, pin or recommend mode kept it). */
  applied: string
  candidates: Candidate[]
  source: DecisionSource
  note: string
  latencyMs: number
  risky: number | null
}

export type RosterRow = { role: string; model: string; score: number | null; p: number | null }

export type SpawnStatus = 'running' | 'done' | 'failed'

export type Spawn = {
  agentId: string
  parentId: string | null
  role: string
  task: string
  model: string
  startedAt: number
  endedAt: number | null
  status: SpawnStatus
  costUsd: number
}

export type CtxNode = { id: string; label: string; role: string; model: string; tokens: number; at: number }

export type ConnState = { state: 'unknown' | 'testing' | 'ok' | 'fail'; latencyMs?: number; version?: string; error?: string }

export type KevState = { state: 'stopped' | 'starting' | 'running' | 'failed' | 'installing' | 'missing'; detail: string; log: string[] }

export type ExternalId = 'codex' | 'opencode' | 'openrouter'

export type External = { id: ExternalId; isReady: boolean; version: string; detail: string; hint: string }

export type KeySource = 'config' | 'keychain' | '1password' | 'env' | 'missing'

/** Where a key was found, and a masked hint of it; the key itself never enters state. */
export type KeyInfo = { source: KeySource; hint: string; error?: string }

export type Setup = { conn: ConnState; kev: KevState; externals: External[]; checkedAt: number; keys: { typesafe: KeyInfo; openrouter: KeyInfo } }

export type Totals = { routed: number; spendUsd: number; jevCalls: number; jevCostUsd: number; jevLatency: number[]; ctxTokens: number }

export type Pins = Record<string, string>

declare module 'claude-code' {
  interface PluginState {
    'jev-semaphore': {
      tab: Tab
      mode: Mode | null
      pins: Pins
      roster: RosterRow[]
      decisions: Decision[]
      spawns: Spawn[]
      ctx: CtxNode[]
      setup: Setup
      totals: Totals
      isBandCollapsed: boolean
    }
  }
}
