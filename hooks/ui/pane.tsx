/** The sub-agent model allocation pane: Routing (roster, decision, graph, spawns), Setup and Ledger tabs. */

import type { ElementConstructor, EngineInterface, InputProps, RasterProps, RenderInput, SelectProps, SvgProps } from 'claude-code'

import type { Backend, Decision, External, KeyInfo, Mode, Pins, RosterRow, Setup, Spawn, Tab, Totals } from '../../types'
import { colorOf, labelOf, PRICES_AS_OF } from '../lib/catalog'
import { backendLabel } from '../lib/jev-client'
import { DEFAULT_MODEL } from '../lib/router'
import type { LedgerRow } from '../lib/state'
import { ACCENT, CARD_BG, FAIL, fmtK, fmtSecs, fmtUsd, hex, JEV, MUTED, OK, pad, padStart, ROLES, TEXT, WARN } from '../lib/theme'
import { PANE_ID, spinnerCells, view } from './anim'
import { barAt, BAR_MS, graphFrame, graphRows, layoutGraph, spark } from './raster'
import { graphSvg } from './svg'

export type PaneCtx = {
  backend: Backend
  mode: Mode
  floor: number
  budgetUsd: number
  kevModel: string
  kevUrl: string
  kevRepo: string
  mainModel: string
  cwd: string
  tools: readonly string[]
  act: {
    setTab: (t: Tab) => void
    test: () => void
    kevInstall: () => void
    kevStart: () => void
    kevStop: () => void
    detect: () => void
    setBackend: (b: string) => void
    setMode: (m: Mode) => void
    saveKey: (which: 'typesafe' | 'openrouter', key: string) => void
    removeKey: (which: 'typesafe' | 'openrouter') => void
    unpin: (role: string) => void
    exportLedger: () => void
  }
}

type Kit = ReturnType<EngineInterface['ui']['resolve']>

/** Everything the pane draws, read by register.tsx (which alone holds `$`). */
export type PaneData = {
  tab: Tab
  roster: RosterRow[]
  decisions: Decision[]
  spawns: Spawn[]
  totals: Totals
  pins: Pins
  setup: Setup
  ledger: LedgerRow[]
  now: number
}

const dot = (state: string) => (state === 'ok' || state === 'running' ? OK : state === 'testing' || state === 'starting' || state === 'installing' ? WARN : state === 'unknown' || state === 'stopped' ? MUTED : FAIL)

export function renderPane(resolved: Kit, e: RenderInput<'Pane'>, c: PaneCtx, d: PaneData) {
  const kit = resolved as Kit & Record<string, unknown>
  const { Box, Text, Button } = kit
  const cols = Math.max(40, e.props.bodyColumns)
  const { tab, now } = d

  const tabs = (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row" gap={1}>
        <Text color={JEV} bold>
          ◆ JEV
        </Text>
        <Text color={MUTED}>routing</Text>
        <Text color={c.backend === 'off' ? WARN : JEV}>[{backendLabel(c.backend)}{c.backend === 'kev-local' ? ` · ${c.kevModel}` : ''}]</Text>
        <Text color={c.mode === 'auto' ? OK : WARN}>{c.mode}</Text>
      </Box>
      <Box flexDirection="row" gap={1}>
        {(['routing', 'setup', 'ledger'] as const).map((t, i) => (
          <Button
            key={`tab-${t}`}
            label={t[0]!.toUpperCase() + t.slice(1)}
            hotkey={String(i + 1)}
            variant={tab === t ? 'primary' : 'secondary'}
            onPress={() => c.act.setTab(t)}
          />
        ))}
      </Box>
    </Box>
  )

  const body = tab === 'setup' ? setupTab(kit, c, d, cols) : tab === 'ledger' ? ledgerTab(kit, d, c, cols) : routingTab(kit, c, d, cols, now)

  return (
    <Box flexDirection="column" gap={1}>
      {tabs}
      {body}
    </Box>
  )
}

/* ------------------------------------------------------------------ routing */

function routingTab(kit: Kit & Record<string, unknown>, c: PaneCtx, d: PaneData, cols: number, now: number) {
  const { Box, Text } = kit
  const Raster = kit.Raster as ElementConstructor<RasterProps> | undefined
  const Svg = kit.Svg as ElementConstructor<SvgProps> | undefined
  const { roster: rosterRows, decisions, spawns, totals, pins } = d
  const latest = decisions[decisions.length - 1]
  const scoreW = 22
  const rosterOf = (role: string): RosterRow => rosterRows.find(r => r.role === role) ?? { role, model: pins[role] ?? DEFAULT_MODEL[role] ?? 'inherit', score: null, p: null }
  const rosterLabel = (role: string, r: RosterRow): string => (r.score === null ? `${r.model} ${pins[role] ? '(pin)' : '(default)'}` : r.model)
  // Sized to the longest label so the "(default)" / "(pin)" suffix is never sliced off.
  const modelW = Math.max(13, ...ROLES.map(role => rosterLabel(role, rosterOf(role)).length))
  const roleW = Math.max(12, cols - scoreW - modelW - 2)
  const isFresh = latest !== undefined && now - latest.at < 1600

  const roster = (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={TEXT}>
          Model roster
        </Text>
        <Text color={JEV}>◆ Jev routing</Text>
      </Box>
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={MUTED}>main</Text>
        <Text color={ACCENT} bold>
          {labelOf(c.mainModel)} (fixed)
        </Text>
      </Box>
      {ROLES.map(role => {
        const r = rosterOf(role)
        const isHot = isFresh && latest?.role === role
        const scoreText = r.score === null ? '' : `score ${r.score.toFixed(2)} · p ${r.p?.toFixed(2) ?? '—'}`

        return (
          <Box key={`roster-${role}`} flexDirection="row" {...(isHot && { backgroundColor: '#3a2738' })}>
            <Text color={TEXT}>{pad(role, roleW)}</Text>
            <Text color={JEV}>{padStart(scoreText, scoreW)} </Text>
            <Text color={r.score === null ? MUTED : hex(colorOf(r.model))} bold={r.score !== null}>
              {padStart(rosterLabel(role, r), modelW)}
            </Text>
          </Box>
        )
      })}
    </Box>
  )

  view.pane.bars = []
  view.pane.decisionAt = latest?.at ?? 0
  // Row: rank(2) + model(12) + " score 0.00"(11) + gap + bar + gap + p(4)
  const barGap = 3
  const barCols = Math.max(8, cols - 29 - 2 * barGap)
  view.pane.barCols = barCols

  const card =
    latest === undefined ? (
      <Box borderStyle="round" borderColor={JEV} paddingX={1} flexDirection="column">
        <Text color={JEV} bold>
          ◆ Jev · decision
        </Text>
        <Text color={MUTED}>Waiting for the first subagent spawn. Ask for something multi-part, e.g. "build me an auth page".</Text>
      </Box>
    ) : (
      <Box borderStyle="round" borderColor={JEV} paddingX={1} flexDirection="column" backgroundColor={CARD_BG}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text>
            <Text color={JEV} bold>
              ◆ Jev · decision
            </Text>
            <Text color={TEXT}> role: {latest.role}</Text>
          </Text>
          <Text color={MUTED}>{cols > 70 ? 'cost · latency · capability · context fit' : `${latest.latencyMs}ms`}</Text>
        </Box>
        {latest.candidates.map((cand, i) => {
          const color = colorOf(cand.model)
          const key = `bar-${i}`
          view.pane.bars.push({ key, value: cand.p, color, rank: i })

          return (
            <Box key={`cand-${i}`} flexDirection="row" {...(i === 0 && { backgroundColor: '#3a2738' })}>
              <Text color={MUTED}>{i + 1} </Text>
              <Text color={hex(color)} bold={i === 0}>
                {pad(cand.model, 12)}
              </Text>
              <Text color={MUTED}> score </Text>
              <Text color={TEXT}>{cand.score.toFixed(2)}</Text>
              <Box marginLeft={barGap} marginRight={barGap}>
                {Raster !== undefined ? (
                  <Raster key={key} columns={barCols} rows={1} cells={barAt(barCols, cand.p, color, now - latest.at, i)} />
                ) : (
                  <Text color={hex(color)}>{'█'.repeat(Math.round(cand.p * barCols)).padEnd(barCols, '·')}</Text>
                )}
              </Box>
              <Text color={i === 0 ? JEV : TEXT} bold={i === 0}>
                {cand.p.toFixed(2)}
              </Text>
            </Box>
          )
        })}
        <Text color={latest.note === 'host validated' ? OK : latest.source === 'heuristic' ? WARN : TEXT}>
          picked {latest.picked}
          {latest.applied !== latest.picked ? ` → ran ${latest.applied}` : ''} · {latest.note}
          {latest.risky !== null ? ` · risky ${latest.risky.toFixed(2)}` : ''}
        </Text>
      </Box>
    )

  if (now - (latest?.at ?? 0) >= BAR_MS + 900) {
    view.pane.bars = []
  }

  const isWide = cols >= 96
  const graphCols = Math.max(24, (isWide ? Math.floor(cols / 2) : cols) - 4)
  const nodes = layoutGraph(spawns, labelOf(c.mainModel))
  const born = new Map(spawns.map(s => [s.agentId, s.startedAt]))
  const running = spawns.filter(s => s.status === 'running')
  view.pane.graph = Raster !== undefined ? { key: 'graph', cols: graphCols, nodes, born, isLive: running.length > 0 } : null

  const graphBox = (
    <Box borderStyle="round" borderColor="#3b3f4a" paddingX={1} flexDirection="column" flexGrow={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={TEXT}>
          Agent graph
        </Text>
        <Text color={MUTED}>{running.length} running</Text>
      </Box>
      {Raster !== undefined ? (
        <Raster key="graph" columns={graphCols} rows={graphRows(nodes)} cells={graphFrame(nodes, graphCols, now, born)} />
      ) : Svg !== undefined ? (
        <Svg {...(() => {
          const svg = graphSvg(nodes, graphCols * 8)

          return { source: svg.source, alt: `agent graph, ${nodes.length} nodes`, width: graphCols * 8, height: svg.height }
        })()} />
      ) : (
        <Text color={MUTED}>{nodes.map(n => `${n.role}:${n.model}`).join('  ')}</Text>
      )}
    </Box>
  )

  view.pane.spinners = []
  const shown = [...spawns].reverse().slice(0, 9)
  const spawnsBox = (
    <Box borderStyle="round" borderColor="#3b3f4a" paddingX={1} flexDirection="column" flexGrow={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={TEXT}>
          Live spawns
        </Text>
        <Text color={MUTED}>{spawns.length} spawned</Text>
      </Box>
      {shown.length === 0 && <Text color={MUTED}>none yet</Text>}
      {shown.map(s => spawnRow(kit, s, now, Raster))}
    </Box>
  )

  const latencies = totals.jevLatency
  const p50 = latencies.length === 0 ? 0 : [...latencies].sort((a, b) => a - b)[Math.floor(latencies.length / 2)] ?? 0
  const budget = c.budgetUsd > 0 ? ` / ${fmtUsd(c.budgetUsd)}` : ''
  const isOver = c.budgetUsd > 0 && totals.spendUsd > c.budgetUsd

  const footer = (
    <Box flexDirection="row" gap={1}>
      <Text color={MUTED}>
        routed <Text color={TEXT}>{totals.routed}</Text> · spend <Text color={isOver ? FAIL : TEXT}>{fmtUsd(totals.spendUsd)}{budget}</Text> · jev{' '}
        <Text color={TEXT}>{totals.jevCalls}</Text> calls ≈{fmtUsd(totals.jevCostUsd)} · p50 <Text color={TEXT}>{p50}ms</Text>
      </Text>
      {Raster !== undefined && latencies.length > 1 && <Raster key="spark" columns={Math.min(16, latencies.length)} rows={1} cells={spark(latencies, Math.min(16, latencies.length), 0xe879b9)} />}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      {roster}
      {card}
      {isWide ? (
        <Box flexDirection="row" gap={1}>
          {graphBox}
          {spawnsBox}
        </Box>
      ) : (
        <Box flexDirection="column" gap={1}>
          {graphBox}
          {spawnsBox}
        </Box>
      )}
      {footer}
      <Text color={MUTED} dimColor>
        prices: API list estimates as of {PRICES_AS_OF} · score = feature fit · p = Jev probability
      </Text>
    </Box>
  )
}

function spawnRow(kit: Kit, s: Spawn, now: number, Raster: ElementConstructor<RasterProps> | undefined) {
  const { Box, Text } = kit
  const color = colorOf(s.model)
  const elapsed = (s.endedAt ?? now) - s.startedAt
  const key = `spin-${s.agentId.slice(0, 40)}`

  if (s.status === 'running' && Raster !== undefined) {
    view.pane.spinners.push({ key, color })
  }

  return (
    <Box key={`spawn-${s.agentId}`} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color={hex(color)}>● </Text>
          <Text color={TEXT} bold>
            {s.parentId !== null ? '└ ' : ''}
            {s.role}
          </Text>
        </Text>
        <Text color={hex(color)}>{s.model}</Text>
      </Box>
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={MUTED} wrap="truncate-end">
          {'  '}
          {s.task}
        </Text>
        {s.status === 'running' ? (
          <Box flexDirection="row">
            {Raster !== undefined ? <Raster key={key} columns={1} rows={1} cells={spinnerCells(now, color)} /> : <Text color={WARN}>…</Text>}
            <Text color={WARN}> running</Text>
          </Box>
        ) : (
          <Text color={s.status === 'failed' ? FAIL : MUTED}>
            {fmtSecs(elapsed)} · {s.status}
            {s.costUsd > 0 ? ` · ${fmtUsd(s.costUsd)}` : ''}
          </Text>
        )}
      </Box>
    </Box>
  )
}

/* -------------------------------------------------------------------- setup */

function setupTab(kit: Kit & Record<string, unknown>, c: PaneCtx, d: PaneData, cols: number) {
  const { Box, Text, Button } = kit
  const Select = kit.Select as ElementConstructor<SelectProps> | undefined
  const { setup, pins } = d
  const Input = kit.Input as ElementConstructor<InputProps> | undefined
  const SOURCE: Record<KeyInfo['source'], string> = {
    config: 'plugin secure config',
    keychain: 'macOS Keychain',
    '1password': '1Password (op read)',
    env: 'environment variable',
    missing: 'missing',
  }
  const keyRow = (which: 'typesafe' | 'openrouter', label: string, info: KeyInfo, isNeeded: boolean) => (
    <Box key={`key-row-${which}`} flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text color={TEXT}>{pad(label, 16)}</Text>
          {info.source === 'missing' ? (
            <Text color={isNeeded ? WARN : MUTED}>✗ not set{isNeeded ? ' · needed for this backend' : ''}</Text>
          ) : (
            <Text color={OK}>
              ✓ {info.hint} <Text color={MUTED}>· {SOURCE[info.source]}</Text>
            </Text>
          )}
        </Text>
        {info.source === 'keychain' && <Button key={`key-remove-${which}`} label="Remove" onPress={() => c.act.removeKey(which)} />}
      </Box>
      {info.error !== undefined && (
        <Text color={FAIL} dimColor>
          {'  '}
          {info.error}
        </Text>
      )}
      {Input !== undefined && info.source !== 'config' && (
        <Input
          key={`key-${which}`}
          label={info.source === 'missing' ? `Paste ${label}` : `Replace ${label}`}
          placeholder="saved to the macOS Keychain, never to settings.json"
          submitLabel="Save"
          onSubmit={(v: string) => c.act.saveKey(which, v)}
        />
      )}
    </Box>
  )
  const conn = setup.conn
  const kev = setup.kev
  const backends: { value: Backend; label: string }[] = [
    { value: 'typesafe', label: 'Hosted Jev · TypeSafe (api.typesafe.ai)' },
    { value: 'openrouter', label: 'Hosted Jev · OpenRouter' },
    { value: 'kev-local', label: `Local Kev · ${c.kevModel} @ ${c.kevUrl}` },
    { value: 'off', label: 'Off · heuristic feature routing only' },
  ]

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={JEV} paddingX={1}>
        <Text bold color={JEV}>
          1 · Routing backend
        </Text>
        {Select !== undefined ? (
          <Select key="backend" label="Backend" value={c.backend} options={backends} onSelect={(v: string) => c.act.setBackend(v)} />
        ) : (
          backends.map(b => (
            <Text key={`be-${b.value}`} color={b.value === c.backend ? JEV : MUTED}>
              {b.value === c.backend ? '◉' : '○'} {b.label}
            </Text>
          ))
        )}
        {keyRow('typesafe', 'TypeSafe key', setup.keys.typesafe, c.backend === 'typesafe')}
        {keyRow('openrouter', 'OpenRouter key', setup.keys.openrouter, c.backend === 'openrouter')}
        <Text color={MUTED} dimColor>
          or in /config → jev-semaphore → "… 1Password ref" (op://…), or env TYPESAFE_API_KEY / OPENROUTER_API_KEY
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="test" label="Test connection" hotkey="t" variant="primary" onPress={() => c.act.test()} />
          <Text color={dot(conn.state)}>●</Text>
          <Text color={TEXT}>
            {conn.state === 'ok'
              ? `ok · ${conn.latencyMs}ms · ${conn.version ?? ''}`
              : conn.state === 'fail'
                ? `failed · ${conn.error ?? ''}`
                : conn.state === 'testing'
                  ? 'testing…'
                  : 'not tested yet'}
          </Text>
        </Box>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor="#3b3f4a" paddingX={1}>
        <Text bold color={TEXT}>
          2 · Local Kev server
        </Text>
        <Text>
          <Text color={dot(kev.state)}>● </Text>
          <Text color={TEXT}>{kev.state}</Text>
          <Text color={MUTED}> · {kev.detail || `repo ${c.kevRepo}`}</Text>
        </Text>
        <Box flexDirection="row" gap={1}>
          <Button key="kev-install" label={kev.state === 'missing' ? 'Install (clone + uv sync)' : 'Reinstall'} hotkey="i" onPress={() => c.act.kevInstall()} />
          <Button key="kev-start" label="Start" hotkey="s" variant={kev.state === 'stopped' ? 'primary' : 'secondary'} onPress={() => c.act.kevStart()} />
          <Button key="kev-stop" label="Stop" hotkey="x" onPress={() => c.act.kevStop()} />
        </Box>
        {kev.log.slice(-6).map((line, i) => (
          <Text key={`kevlog-${i}`} color={MUTED} wrap="truncate-end">
            {'  '}
            {line}
          </Text>
        ))}
        <Text color={MUTED} dimColor>
          needs uv + Python 3.12 (torch has no 3.14 wheels) · first start downloads jaredpalmer/{c.kevModel}
        </Text>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor="#3b3f4a" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color={TEXT}>
            3 · External executors
          </Text>
          <Button key="detect" label="Re-detect" hotkey="d" onPress={() => c.act.detect()} />
        </Box>
        {setup.externals.length === 0 && <Text color={MUTED}>detecting…</Text>}
        {setup.externals.map((x: External) => (
          <Box key={`ext-${x.id}`} flexDirection="column">
            <Text>
              <Text color={x.isReady ? OK : WARN}>{x.isReady ? '✓' : '✗'} </Text>
              <Text color={TEXT} bold>
                {pad(x.id, 11)}
              </Text>
              <Text color={MUTED}>
                {x.version ? `${x.version} · ` : ''}
                {x.detail}
              </Text>
            </Text>
            {x.hint !== '' && (
              <Text color={WARN} dimColor>
                {'    '}→ {x.hint}
              </Text>
            )}
          </Box>
        ))}
        <Text color={MUTED} dimColor>
          tools registered: {c.tools.length === 0 ? 'none' : c.tools.join(', ')}
        </Text>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor="#3b3f4a" paddingX={1}>
        <Text bold color={TEXT}>
          4 · Routing policy
        </Text>
        <Box flexDirection="row" gap={1}>
          <Text color={TEXT}>mode</Text>
          {(['auto', 'recommend', 'off'] as const).map(m => (
            <Button key={`mode-${m}`} label={m} variant={c.mode === m ? 'primary' : 'secondary'} onPress={() => c.act.setMode(m)} />
          ))}
        </Box>
        <Text color={MUTED}>
          downgrade floor <Text color={TEXT}>{c.floor.toFixed(2)}</Text> · budget <Text color={TEXT}>{c.budgetUsd > 0 ? fmtUsd(c.budgetUsd) : 'off'}</Text> · edit in /config
        </Text>
        {Object.entries(pins).map(([role, model]) => (
          <Box key={`pin-${role}`} flexDirection="row" gap={1}>
            <Text color={TEXT}>
              pin {role} → <Text color={hex(colorOf(model))}>{model}</Text>
            </Text>
            <Button key={`unpin-${role}`} label="unpin" onPress={() => c.act.unpin(role)} />
          </Box>
        ))}
        {Object.keys(pins).length === 0 && <Text color={MUTED}>no pins · /jev-semaphore pin &lt;role&gt; &lt;model&gt;</Text>}
      </Box>

      <Box flexDirection="column" paddingX={1}>
        <Text bold color={TEXT}>
          Where things live
        </Text>
        <Text color={MUTED}>settings  /config → jev-semaphore (non-secret rows; 1Password refs live there too)</Text>
        <Text color={MUTED}>API keys  macOS Keychain, service "jev-semaphore" (Keychain Access.app to inspect)</Text>
        <Text color={MUTED}>kev log   ~/.cache/jev-semaphore/kev.log</Text>
        <Text color={MUTED}>ledger    {c.cwd}/.jev-semaphore/ (Export on the Ledger tab)</Text>
        {cols < 60 && <Text color={WARN}>widen the pane for the full view</Text>}
      </Box>
    </Box>
  )
}

/* ------------------------------------------------------------------- ledger */

function ledgerTab(kit: Kit & Record<string, unknown>, d: PaneData, c: PaneCtx, cols: number) {
  const { Box, Text, Button } = kit
  const rows = d.ledger.slice(-14).reverse()
  const decisions = d.decisions
  const agree = decisions.filter((d: Decision) => d.picked === d.applied).length

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text color={TEXT}>
          <Text bold>Decision ledger</Text>
          <Text color={MUTED}>
            {' '}
            · this session {decisions.length} decisions, {agree} ran as picked
          </Text>
        </Text>
        <Button key="export" label="Export" hotkey="e" variant="primary" onPress={() => c.act.exportLedger()} />
      </Box>
      <Text color={MUTED}>{pad('role', 13)}{pad('picked → ran', cols > 80 ? 30 : 24)}{pad('p', 6)}{pad('src', 10)}outcome</Text>
      {rows.length === 0 && <Text color={MUTED}>No decisions recorded yet.</Text>}
      {rows.map(r => {
        const top = r.candidates[0]

        return (
          <Text key={`ledger-${r.id}`} wrap="truncate-end">
            <Text color={TEXT}>{pad(r.role, 13)}</Text>
            <Text color={hex(colorOf(r.picked))}>{r.picked}</Text>
            <Text color={MUTED}>{pad(r.applied !== r.picked ? ` → ${r.applied}` : '', (cols > 80 ? 30 : 24) - r.picked.length)}</Text>
            <Text color={JEV}>{pad(top ? top.p.toFixed(2) : '—', 6)}</Text>
            <Text color={r.source === 'heuristic' ? WARN : MUTED}>{pad(r.source, 10)}</Text>
            <Text color={r.outcome === 'failed' ? FAIL : r.outcome === 'done' ? OK : WARN}>
              {r.outcome}
              {r.durationMs > 0 ? ` ${fmtSecs(r.durationMs)}` : ''}
              {r.costUsd > 0 ? ` ${fmtUsd(r.costUsd)}` : ''}
            </Text>
          </Text>
        )
      })}
      <Text color={MUTED} dimColor>
        kept across sessions (last 300) · costs are API list-price estimates · {fmtK(rows.length)} shown
      </Text>
    </Box>
  )
}

export { PANE_ID }
