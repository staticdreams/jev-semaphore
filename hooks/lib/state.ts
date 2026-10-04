/** Initial values and ledger shape for the session state; the atoms themselves live in register.tsx (the validator reads them there). */

import type { Decision, Setup, Totals } from '../../types'


export const EMPTY_SETUP: Setup = {
  conn: { state: 'unknown' },
  kev: { state: 'stopped', detail: '', log: [] },
  externals: [],
  checkedAt: 0,
  keys: { typesafe: { source: 'missing', hint: '' }, openrouter: { source: 'missing', hint: '' } },
}

export const EMPTY_TOTALS: Totals = { routed: 0, spendUsd: 0, jevCalls: 0, jevCostUsd: 0, jevLatency: [], ctxTokens: 0 }

/** Ledger rows kept across sessions in `$.store` (the last 300 decisions with their outcome). */
export const LEDGER_KEY = 'ledger'
/** `project` is the session's working folder: the store is shared by every project, so views and exports filter on it. */
export type LedgerRow = Decision & { outcome: 'done' | 'failed' | 'running'; costUsd: number; durationMs: number; project?: string }
