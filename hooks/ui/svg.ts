/** The desktop surface draws the same graph and timeline as SVG (it has no Raster); CSS animates them. */

import type { CtxNode } from '../../types'
import { colorOf } from '../lib/catalog'
import { hex } from '../lib/theme'
import type { GraphNode } from './raster'

const esc = (s: string) => s.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] ?? c)

const STYLE =
  '<style>text{font:10px ui-monospace,Menlo,monospace;fill:#d7dae0}.m{fill:#7c8494}' +
  '.run{animation:p 1.1s ease-in-out infinite}@keyframes p{50%{opacity:.35}}' +
  '.edge{stroke-dasharray:400;stroke-dashoffset:400;animation:d .6s ease-out forwards}@keyframes d{to{stroke-dashoffset:0}}</style>'

export function graphSvg(nodes: readonly GraphNode[], width: number): { source: string; height: number } {
  const levels = Math.max(0, ...nodes.map(n => n.depth)) + 1
  const height = levels * 70 + 10
  const slots = Math.max(1, ...nodes.map(n => n.x + 1))
  const x = (n: GraphNode) => ((n.x + 0.5) / slots) * width
  const y = (n: GraphNode) => n.depth * 70 + 16
  const byId = new Map(nodes.map(n => [n.id, n]))
  const edges = nodes
    .map(n => {
      const p = n.parent === null ? undefined : byId.get(n.parent)

      return p === undefined ? '' : `<line class="edge" x1="${x(p)}" y1="${y(p)}" x2="${x(n)}" y2="${y(n)}" stroke="${hex(colorOf(n.model))}" stroke-opacity=".5"/>`
    })
    .join('')
  const dots = nodes
    .map(n => {
      const c = n.status === 'failed' ? '#f7768e' : hex(colorOf(n.model))
      const mark = n.status === 'done' ? `<text x="${x(n) - 3}" y="${y(n) + 3}" style="fill:#14161b;font-size:8px">✓</text>` : ''

      return (
        `<circle class="${n.status === 'running' ? 'run' : ''}" cx="${x(n)}" cy="${y(n)}" r="${n.status === 'main' ? 8 : 6}" fill="${c}"/>${mark}` +
        `<text x="${x(n)}" y="${y(n) + 20}" text-anchor="middle">${esc(n.role)}</text>` +
        `<text class="m" x="${x(n)}" y="${y(n) + 31}" text-anchor="middle">${esc(n.model)}</text>`
      )
    })
    .join('')

  return { source: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${STYLE}${edges}${dots}</svg>`, height }
}

export function timelineSvg(nodes: readonly CtxNode[], width: number): string {
  const shown = nodes.slice(-14)
  const step = shown.length > 1 ? (width - 60) / (shown.length - 1) : 0
  const pts = shown.map((n, i) => ({ n, x: 30 + i * step, y: i % 2 === 0 ? 14 : 44 }))
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
  const dots = pts
    .map(
      p =>
        `<circle cx="${p.x}" cy="${p.y}" r="4" fill="${hex(colorOf(p.n.model))}"/>` +
        `<text class="m" x="${p.x}" y="${p.y + 15}" text-anchor="middle">${esc(p.n.label.slice(0, 16))}</text>`,
    )
    .join('')
  const packet =
    pts.length > 1
      ? `<circle r="2.5" fill="#fff"><animateMotion dur="1.2s" repeatCount="1" fill="freeze" path="M${pts[pts.length - 2]!.x},${pts[pts.length - 2]!.y} L${pts[pts.length - 1]!.x},${pts[pts.length - 1]!.y}"/></circle>`
      : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 72" width="${width}" height="72">${STYLE}<path class="edge" d="${path}" fill="none" stroke="#5a4a5a"/>${dots}${packet}</svg>`
}
