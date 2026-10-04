/**
 * The models Jev chooses among. Jev and Kev rank options we describe; they hold no catalog of their own,
 * so prices, context and the capability tier are written into each option's description.
 *
 * Prices: Anthropic first-party API list prices, USD per million tokens, as of PRICES_AS_OF.
 * `capability` is this mod's own 0-1 heuristic tier (not a benchmark score); `swe` stays null until a
 * dated, sourced SWE-bench figure is added, and the UI shows "unknown" for it.
 */

export const PRICES_AS_OF = '2026-09-25'

export type Provider = 'anthropic' | 'codex' | 'opencode' | 'openrouter'

export type Model = {
  /** What the pane shows and what Jev's choice option is keyed by. */
  label: string
  provider: Provider
  /** For Anthropic models, the alias `agent.spawn` takes. */
  alias?: 'fable' | 'opus' | 'sonnet' | 'haiku'
  /** Prefixes of resolved ids (`claude-opus-5-5`) this entry prices. */
  ids: readonly string[]
  inputUsd: number | null
  outputUsd: number | null
  contextK: number | null
  /** Relative latency, 0 fastest to 1 slowest. */
  latency: number
  capability: number
  swe: number | null
  color: number
}

export const ANTHROPIC: readonly Model[] = [
  { label: 'fable-5.1', provider: 'anthropic', alias: 'fable', ids: ['claude-fable-5-1'], inputUsd: 10, outputUsd: 50, contextK: 1000, latency: 0.95, capability: 1, swe: null, color: 0xb794f6 },
  { label: 'opus-5.5', provider: 'anthropic', alias: 'opus', ids: ['claude-opus-5-5'], inputUsd: 4, outputUsd: 20, contextK: 1000, latency: 0.7, capability: 0.9, swe: null, color: 0xf0a06a },
  { label: 'sonnet-5.5', provider: 'anthropic', alias: 'sonnet', ids: ['claude-sonnet-5-5'], inputUsd: 2, outputUsd: 10, contextK: 1000, latency: 0.45, capability: 0.78, swe: null, color: 0xf2c76b },
  { label: 'haiku-4.5', provider: 'anthropic', alias: 'haiku', ids: ['claude-haiku-4-5'], inputUsd: 1, outputUsd: 5, contextK: 200, latency: 0.15, capability: 0.55, swe: null, color: 0x6fd3c7 },
]

export const CODEX: Model = { label: 'codex', provider: 'codex', ids: [], inputUsd: null, outputUsd: null, contextK: null, latency: 0.8, capability: 0.85, swe: null, color: 0x7ee08a }
export const OPENCODE: Model = { label: 'opencode', provider: 'opencode', ids: [], inputUsd: null, outputUsd: null, contextK: null, latency: 0.6, capability: 0.7, swe: null, color: 0x8fb4ff }

export function openrouterModel(slug: string, inputUsd: number | null = null, outputUsd: number | null = null, contextK: number | null = null): Model {
  return { label: `or:${slug.split('/').pop() ?? slug}`, provider: 'openrouter', ids: [slug], inputUsd, outputUsd, contextK, latency: 0.5, capability: 0.6, swe: null, color: 0x7aa2f7 }
}

/** The entry that prices a resolved model id or alias, if any. */
export function modelFor(idOrAlias: string): Model | undefined {
  const id = idOrAlias.toLowerCase()

  return ANTHROPIC.find(m => m.alias === id || m.label === id || m.ids.some(prefix => id.startsWith(prefix)))
}

export const labelOf = (idOrAlias: string | undefined): string => (idOrAlias === undefined ? "inherit" : (modelFor(idOrAlias)?.label ?? idOrAlias))

export const colorOf = (label: string): number =>
  [...ANTHROPIC, CODEX, OPENCODE].find(m => m.label === label)?.color ?? (label.startsWith('or:') ? 0x7aa2f7 : 0x9aa0a6)

/** Estimated USD for a usage record, null when the model is not priced. */
export function costOf(model: string, inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): number | null {
  const m = modelFor(model)

  if (m?.inputUsd == null || m.outputUsd == null) {
    return null
  }

  // Cache reads bill at a tenth of input and 5-minute cache writes at 1.25x, the API's standing ratios.
  return (inputTokens * m.inputUsd + cacheReadTokens * m.inputUsd * 0.1 + cacheWriteTokens * m.inputUsd * 1.25 + outputTokens * m.outputUsd) / 1_000_000
}

/** The option text Jev reads for a model. */
export function describe(m: Model): string {
  const price = m.inputUsd == null ? 'price unknown' : `$${m.inputUsd}/$${m.outputUsd} per MTok in/out (as of ${PRICES_AS_OF})`
  const ctx = m.contextK == null ? 'context unknown' : `${m.contextK >= 1000 ? `${m.contextK / 1000}M` : `${m.contextK}K`} context`
  const speed = m.latency < 0.3 ? 'fast' : m.latency < 0.6 ? 'medium speed' : 'slow'
  const tier = m.capability >= 0.95 ? 'frontier' : m.capability >= 0.85 ? 'very strong' : m.capability >= 0.7 ? 'strong' : 'light'

  return `${m.label}: ${tier} reasoning, ${speed}, ${price}, ${ctx}${m.provider === 'anthropic' ? '' : `, runs via ${m.provider}`}`
}
