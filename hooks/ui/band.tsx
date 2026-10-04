/** The band above the prompt: how context moved between agents, as an animated two-lane timeline. */

import type { ElementConstructor, EngineInterface, RasterProps, RenderInput, SelectProps, SvgProps } from 'claude-code'

import type { CtxNode, Totals } from '../../types'
import { fmtK, JEV, MUTED, TEXT } from '../lib/theme'
import { view } from './anim'
import { TIMELINE_ROWS, timelineFrame } from './raster'
import { timelineSvg } from './svg'

type Kit = ReturnType<EngineInterface['ui']['resolve']>

export type BandData = { nodes: CtxNode[]; totals: Totals; isCollapsed: boolean; now: number; toggle: () => void }

/** Returns a tree, or null to leave the band to the engine. */
export function renderBand(resolved: Kit, e: RenderInput<'AbovePrompt'>, d: BandData) {
  const { nodes, totals, isCollapsed, now } = d

  if (e.props.hasSurvey || nodes.length === 0) {
    view.band.requestId = null

    return null
  }

  const kit = resolved as Kit & Record<string, unknown>
  const { Box, Text, Button } = kit
  const Raster = kit.Raster as ElementConstructor<RasterProps> | undefined
  const Svg = kit.Svg as ElementConstructor<SvgProps> | undefined
  const cols = Math.max(30, e.props.bodyColumns - 2)

  const header = (
    <Box flexDirection="row" justifyContent="space-between">
      <Text>
        <Text bold color={TEXT}>
          Context exchange{' '}
        </Text>
        <Text color={JEV}>◆ Jev moves context between agents</Text>
      </Text>
      <Box flexDirection="row" gap={1}>
        <Text color={MUTED}>
          context exchanged {fmtK(totals.ctxTokens)} tokens · {nodes.length} nodes
        </Text>
        <Button key="toggle" label={isCollapsed ? 'show' : 'hide'} plain onPress={() => d.toggle()} />
      </Box>
    </Box>
  )

  if (isCollapsed) {
    view.band.requestId = null

    return header
  }

  if (Raster !== undefined) {
    view.band = { requestId: e.requestId, cols, nodes }

    return (
      <Box flexDirection="column">
        {header}
        <Raster key="ctx" columns={cols} rows={TIMELINE_ROWS} cells={timelineFrame(nodes, cols, now)} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {header}
      {Svg !== undefined ? (
        <Svg source={timelineSvg(nodes, cols * 8)} alt={`context timeline, ${nodes.length} nodes`} width={cols * 8} height={72} />
      ) : (
        <Text color={MUTED} wrap="truncate-start">
          {nodes.map(n => n.label).join(' → ')}
        </Text>
      )}
    </Box>
  )
}
