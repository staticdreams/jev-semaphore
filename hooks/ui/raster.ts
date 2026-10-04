/**
 * Cell drawing for the terminal's `Raster`: a grid of glyphs over a braille layer for lines, packed as the
 * base64 the element takes (`columns * rows` little-endian u32 triplets `[codePoint, fg, bg]`).
 * Every frame is a pure function of the data and a clock reading, so the same code paints the first
 * render and each `$.ui.blit` of an animation.
 */

import type { CtxNode, Spawn } from '../../types'
import { colorOf } from '../lib/catalog'

export const DEFAULT = 0x01000000
export const TRACK = 0x343a46

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64Of(bytes: Uint8Array): string {
  let out = ''

  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    out +=
      (B64[a >> 2] ?? '') +
      (B64[((a & 3) << 4) | (b >> 4)] ?? '') +
      (i + 1 < bytes.length ? (B64[((b & 15) << 2) | (c >> 6)] ?? '') : '=') +
      (i + 2 < bytes.length ? (B64[c & 63] ?? '') : '=')
  }

  return out
}

export const rgb = (r: number, g: number, b: number): number =>
  ((Math.max(0, Math.min(255, Math.round(r))) << 16) | (Math.max(0, Math.min(255, Math.round(g))) << 8) | Math.max(0, Math.min(255, Math.round(b)))) >>> 0

export function mix(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t))
  const ch = (c: number, s: number) => (c >> s) & 0xff

  return rgb(ch(a, 16) + (ch(b, 16) - ch(a, 16)) * k, ch(a, 8) + (ch(b, 8) - ch(a, 8)) * k, ch(a, 0) + (ch(b, 0) - ch(a, 0)) * k)
}

/** Ease-out cubic, 0..1. */
export const ease = (t: number): number => 1 - Math.pow(1 - Math.max(0, Math.min(1, t)), 3)

// Braille dot bits by [x 0..1][y 0..3].
const DOT = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
] as const

export class Grid {
  readonly glyph: Uint32Array
  readonly fg: Uint32Array
  readonly bg: Uint32Array
  private readonly dots: Uint8Array
  private readonly dotFg: Uint32Array

  constructor(
    readonly columns: number,
    readonly rows: number,
  ) {
    const n = columns * rows
    this.glyph = new Uint32Array(n).fill(0x20)
    this.fg = new Uint32Array(n).fill(DEFAULT)
    this.bg = new Uint32Array(n).fill(DEFAULT)
    this.dots = new Uint8Array(n)
    this.dotFg = new Uint32Array(n).fill(DEFAULT)
  }

  set(x: number, y: number, glyph: string, fg: number, bg?: number): void {
    const cx = Math.round(x)
    const cy = Math.round(y)

    if (cx < 0 || cy < 0 || cx >= this.columns || cy >= this.rows) {
      return
    }

    const i = cy * this.columns + cx
    const point = glyph.codePointAt(0) ?? 0x20
    this.glyph[i] = point >= 0x20 && point <= 0xffff ? point : 0x20
    this.fg[i] = fg >>> 0

    if (bg !== undefined) {
      this.bg[i] = bg >>> 0
    }
  }

  text(x: number, y: number, s: string, fg: number, bg?: number): void {
    ;[...s].forEach((ch, k) => this.set(x + k, y, ch, fg, bg))
  }

  /** Centered text, clipped to the grid. */
  label(cx: number, y: number, s: string, fg: number): void {
    this.text(Math.round(cx - s.length / 2), y, s, fg)
  }

  /** A line in braille sub-cells: x in half columns (0..2*columns), y in quarter rows (0..4*rows). */
  line(x0: number, y0: number, x1: number, y1: number, color: number): void {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))))

    for (let s = 0; s <= steps; s++) {
      this.dot(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps, color)
    }
  }

  dot(px: number, py: number, color: number): void {
    const x = Math.round(px)
    const y = Math.round(py)
    const cx = x >> 1
    const cy = y >> 2

    if (x < 0 || y < 0 || cx >= this.columns || cy >= this.rows) {
      return
    }

    const i = cy * this.columns + cx
    this.dots[i] = (this.dots[i] ?? 0) | (DOT[x & 1]?.[y & 3] ?? 0)
    this.dotFg[i] = color >>> 0
  }

  pack(): string {
    const n = this.columns * this.rows
    const bytes = new Uint8Array(n * 12)
    const view = new DataView(bytes.buffer)

    for (let i = 0; i < n; i++) {
      const isGlyph = this.glyph[i] !== 0x20
      const dots = this.dots[i] ?? 0
      const point = isGlyph || dots === 0 ? (this.glyph[i] ?? 0x20) : 0x2800 + dots
      view.setUint32(i * 12, point, true)
      view.setUint32(i * 12 + 4, isGlyph || dots === 0 ? (this.fg[i] ?? DEFAULT) : (this.dotFg[i] ?? DEFAULT), true)
      view.setUint32(i * 12 + 8, this.bg[i] ?? DEFAULT, true)
    }

    return base64Of(bytes)
  }
}

const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const

/** One bar row, `fraction` of `columns` filled with eighth-block precision. */
export function bar(columns: number, fraction: number, color: number, glow = 0): string {
  const g = new Grid(columns, 1)
  const fill = Math.max(0, Math.min(1, fraction)) * columns
  const whole = Math.floor(fill)
  const part = Math.floor((fill - whole) * 8)
  const lit = mix(color, 0xffffff, glow)

  for (let x = 0; x < columns; x++) {
    if (x < whole) {
      g.set(x, 0, '█', lit, TRACK)
    } else if (x === whole && part > 0) {
      g.set(x, 0, EIGHTHS[part] ?? ' ', lit, TRACK)
    } else {
      g.set(x, 0, ' ', DEFAULT, TRACK)
    }
  }

  return g.pack()
}

/** Bars grow from 0 to their value over this long after a decision lands. */
export const BAR_MS = 650

export function barAt(columns: number, value: number, color: number, sinceMs: number, rank: number): string {
  const t = (sinceMs - rank * 70) / BAR_MS
  const glow = t >= 0 && t < 1.4 ? Math.max(0, 0.35 * (1 - Math.abs(t - 1) * 2.5)) : 0

  return bar(columns, value * ease(t), color, glow)
}

/* ---------------------------------------------------------------- agent graph */

export type GraphNode = { id: string; role: string; model: string; status: Spawn['status'] | 'main'; depth: number; x: number; parent: string | null }

/** Lays the spawn tree out level by level: each node at the centre of the slots its subtree spans. */
export function layoutGraph(spawns: readonly Spawn[], mainModel: string): GraphNode[] {
  const children = new Map<string, Spawn[]>()

  for (const s of spawns) {
    const parent = s.parentId !== null && spawns.some(o => o.agentId === s.parentId) ? s.parentId : 'main'
    children.set(parent, [...(children.get(parent) ?? []), s])
  }

  const nodes: GraphNode[] = []
  let slot = 0

  const walk = (id: string, role: string, model: string, status: GraphNode['status'], depth: number, parent: string | null): number => {
    const kids = children.get(id) ?? []

    if (kids.length === 0) {
      const x = slot++
      nodes.push({ id, role, model, status, depth, x, parent })

      return x
    }

    const xs = kids.map(k => walk(k.agentId, k.role, k.model, k.status, depth + 1, id))
    const x = ((xs[0] ?? 0) + (xs[xs.length - 1] ?? 0)) / 2
    nodes.push({ id, role, model, status, depth, x, parent })

    return x
  }

  walk('main', 'main', mainModel, 'main', 0, null)

  return nodes
}

const ROW_H = 4

export const graphRows = (nodes: readonly GraphNode[]): number => Math.max(3, (Math.max(0, ...nodes.map(n => n.depth)) + 1) * ROW_H - 1)

/** The agent graph at clock `now`: running nodes pulse, fresh nodes fade in, edges in the child's hue. */
export function graphFrame(nodes: readonly GraphNode[], columns: number, now: number, bornAt: ReadonlyMap<string, number>): string {
  const rows = graphRows(nodes)
  const g = new Grid(columns, rows)
  const slots = Math.max(1, ...nodes.map(n => n.x + 1))
  const cx = (n: GraphNode) => Math.round(((n.x + 0.5) / slots) * (columns - 2)) + 1
  const cy = (n: GraphNode) => n.depth * ROW_H
  const byId = new Map(nodes.map(n => [n.id, n]))

  for (const n of nodes) {
    const parent = n.parent === null ? undefined : byId.get(n.parent)

    if (parent !== undefined) {
      const age = now - (bornAt.get(n.id) ?? 0)
      const grow = ease(age / 500)
      const x0 = cx(parent) * 2 + 1
      const y0 = cy(parent) * 4 + 6
      const x1 = cx(n) * 2 + 1
      const y1 = cy(n) * 4 - 1
      g.line(x0, y0, x0 + (x1 - x0) * grow, y0 + (y1 - y0) * grow, mix(colorOf(n.model), 0x2a2e38, 0.45))
    }
  }

  for (const n of nodes) {
    const color = colorOf(n.model)
    const x = cx(n)
    const y = cy(n)
    const age = now - (bornAt.get(n.id) ?? 0)
    const fade = n.status === 'main' ? 1 : ease(age / 400)
    const pulse = n.status === 'running' ? 0.5 + 0.5 * Math.sin(now / 180) : 0
    const glyph = n.status === 'done' ? '✓' : n.status === 'failed' ? '✗' : n.status === 'running' ? (pulse > 0.5 ? '◉' : '●') : '●'
    const tint = n.status === 'failed' ? 0xf7768e : mix(mix(0x2a2e38, color, fade), 0xffffff, pulse * 0.35)
    g.set(x, y, glyph, tint)
    g.label(x, y + 1, n.role, mix(0x2a2e38, 0xd7dae0, fade))
    g.label(x, y + 2, n.model, mix(0x2a2e38, mix(color, 0x7c8494, 0.3), fade))
  }

  return g.pack()
}

/* ---------------------------------------------------------- context exchange */

export const TIMELINE_ROWS = 4

/** The context-exchange timeline: two staggered lanes, a packet travelling along the newest edge. */
export function timelineFrame(nodes: readonly CtxNode[], columns: number, now: number): string {
  const g = new Grid(columns, TIMELINE_ROWS)
  const shown = nodes.slice(-Math.max(2, Math.floor(columns / 12)))
  const step = shown.length > 1 ? (columns - 8) / (shown.length - 1) : 0
  const pos = shown.map((n, i) => ({ n, x: Math.round(4 + i * step), y: i % 2 === 0 ? 0 : 2 }))

  pos.forEach((p, i) => {
    const prev = pos[i - 1]

    if (prev !== undefined) {
      g.line(prev.x * 2 + 1, prev.y * 4 + 2, p.x * 2 + 1, p.y * 4 + 2, mix(colorOf(p.n.model), 0x2a2e38, 0.55))
    }
  })

  pos.forEach((p, i) => {
    const color = colorOf(p.n.model)
    const isNewest = i === pos.length - 1
    const age = now - p.n.at
    const glow = isNewest ? Math.max(0, 1 - age / 1500) : 0
    g.set(p.x, p.y, isNewest && glow > 0 ? '◉' : '●', mix(color, 0xffffff, glow * 0.5))
    const label = p.n.label.length > step - 1 && step > 0 ? p.n.label.slice(0, Math.max(4, Math.floor(step) - 1)) : p.n.label
    g.label(p.x, p.y + 1, label, mix(0x7c8494, 0xd7dae0, glow))
  })

  const last = pos[pos.length - 1]
  const before = pos[pos.length - 2]

  if (last !== undefined && before !== undefined) {
    const t = (now - last.n.at) / 900

    if (t >= 0 && t < 1) {
      const k = ease(t)
      const px = before.x + (last.x - before.x) * k
      const py = before.y + (last.y - before.y) * k
      g.set(px, py, '•', 0xffffff)
    }
  }

  return g.pack()
}

/* ------------------------------------------------------------------- sparkline */

const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

export function spark(values: readonly number[], columns: number, color: number): string {
  const g = new Grid(columns, 1)
  const shown = values.slice(-columns)
  const max = Math.max(1, ...shown)
  shown.forEach((v, i) => g.set(columns - shown.length + i, 0, SPARK[Math.min(7, Math.floor((v / max) * 7.99))] ?? '▁', color))

  return g.pack()
}
