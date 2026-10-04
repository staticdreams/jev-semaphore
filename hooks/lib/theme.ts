/** Palette and glyphs, matched to the reference screenshots: a dark panel with a Jev-pink accent and per-model hues. */

export const JEV = '#E879B9'
export const JEV_DIM = '#8a4a6e'
export const ACCENT = '#f0a06a'
export const OK = '#7ee08a'
export const WARN = '#f2c76b'
export const FAIL = '#f7768e'
export const MUTED = '#7c8494'
export const TEXT = '#d7dae0'
export const CARD_BG = '#2a1f2a'

export const hex = (color: number): string => `#${color.toString(16).padStart(6, '0')}`

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

export const ROLE_BLURB: Record<string, string> = {
  orchestrator: 'plans and splits the work, spawns the others',
  builder: 'scaffolds files, routes and boilerplate',
  implementer: 'writes the substantive feature code',
  executor: 'runs commands, tests and type checks',
  iterator: 'fixes a failing test or small defect',
  reviewer: 'independent review of finished changes',
  artist: 'generates images and visual assets',
}

export const ROLES = Object.keys(ROLE_BLURB)

export const fmtUsd = (usd: number): string => (usd >= 1 ? `$${usd.toFixed(2)}` : usd >= 0.01 ? `$${usd.toFixed(3)}` : usd > 0 ? '<$0.01' : '$0')

export const fmtK = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`)

export const fmtSecs = (ms: number): string => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`)

export const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length))

export const padStart = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s)
