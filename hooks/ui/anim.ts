/**
 * One frame loop for every animated cell grid (decision bars, graph pulses, spinners, the context packet).
 * Render hooks record what they mounted here; the loop repaints those Rasters with `$.ui.blit`, never a
 * render pass, and stops itself as soon as nothing is moving.
 */

import type { Host } from '../lib/host'

import type { CtxNode } from '../../types'
import { barAt, BAR_MS, type GraphNode, graphFrame, timelineFrame } from './raster'
import { SPINNER } from '../lib/theme'
import { DEFAULT, Grid } from './raster'

export const PANE_ID = 'jev-semaphore'
const FRAME_MS = 40

type BarSlot = { key: string; value: number; color: number; rank: number }

export const view = {
  pane: {
    barCols: 0,
    bars: [] as BarSlot[],
    decisionAt: 0,
    graph: null as null | { key: string; cols: number; nodes: GraphNode[]; born: Map<string, number>; isLive: boolean },
    spinners: [] as { key: string; color: number }[],
  },
  band: { requestId: null as string | null, cols: 0, nodes: [] as CtxNode[] },
}

let timer: { cancel: () => void } | null = null
let refused = false

export function spinnerCells(now: number, color: number): string {
  const g = new Grid(1, 1)
  g.set(0, 0, SPINNER[Math.floor(now / 80) % SPINNER.length] ?? '⠋', color, DEFAULT)

  return g.pack()
}

function isMoving(now: number): boolean {
  const p = view.pane
  const newestCtx = view.band.nodes[view.band.nodes.length - 1]

  return (
    now - p.decisionAt < BAR_MS + 900 ||
    p.spinners.length > 0 ||
    p.graph?.isLive === true ||
    (p.graph !== null && [...p.graph.born.values()].some(t => now - t < 600)) ||
    (newestCtx !== undefined && now - newestCtx.at < 1600)
  )
}

async function frame(host: Host): Promise<void> {
  const now = await host.now()
  const p = view.pane
  const jobs: Promise<{ deny?: string }>[] = []

  if (now - p.decisionAt < BAR_MS + 900) {
    for (const b of p.bars) {
      jobs.push(host.blit({ requestId: PANE_ID, key: b.key, cells: barAt(p.barCols, b.value, b.color, now - p.decisionAt, b.rank) }))
    }
  }

  for (const s of p.spinners) {
    jobs.push(host.blit({ requestId: PANE_ID, key: s.key, cells: spinnerCells(now, s.color) }))
  }

  if (p.graph !== null) {
    jobs.push(host.blit({ requestId: PANE_ID, key: p.graph.key, cells: graphFrame(p.graph.nodes, p.graph.cols, now, p.graph.born) }))
  }

  if (view.band.requestId !== null && view.band.nodes.length > 0) {
    jobs.push(host.blit({ requestId: view.band.requestId, key: 'ctx', cells: timelineFrame(view.band.nodes, view.band.cols, now) }))
  }

  const results = await Promise.all(jobs.map(j => j.catch(() => ({ deny: 'error' }))))

  if (!refused && results.some(r => r.deny !== undefined && r.deny !== 'error')) {
    refused = true
    host.debug(`jev-semaphore: a repaint was refused (${results.find(r => r.deny)?.deny}); animation continues on redraws`)
  }

  if (!isMoving(now)) {
    stop()
  }
}

/** Starts the loop if it is not running; safe to call from any hook or handler. */
export function animate(host: Host): void {
  if (timer !== null) {
    return
  }

  timer = host.every(FRAME_MS, () => {
    void frame(host)
  })
}

export function stop(): void {
  timer?.cancel()
  timer = null
}
