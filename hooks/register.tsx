/**
 * jev-semaphore: Jev (hosted) or Kev (local) picks the model for every subagent; a pane shows the roster,
 * each decision, the agent graph and live spawns, and a band shows how context moved between agents.
 * Non-Anthropic executors (Codex review and images, OpenCode, OpenRouter workers) are tools the role
 * agents call.
 */

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Backend, CtxNode, Decision, KeyInfo, Mode, Pins, RosterRow, Setup, Spawn, Tab } from '../types'

type Which = 'typesafe' | 'openrouter'
import { COMPOSE_SECTION, roleAgents } from './lib/agents'
import { costOf, labelOf, modelFor } from './lib/catalog'
import * as X from './lib/externals'
import { ask, backendLabel, JEV_USD_PER_MTOK, probe, redact, type Settings } from './lib/jev-client'
import { DEFAULT_MODEL, questionsFor, route, type RouteInput, stateFor } from './lib/router'
import * as S from './lib/state'
import type { LedgerRow } from './lib/state'
import { fmtUsd, ROLES } from './lib/theme'
import { animate, PANE_ID } from './ui/anim'
import { renderBand } from './ui/band'
import type { Host } from './lib/host'
import { type PaneCtx, renderPane } from './ui/pane'

const PLUGIN = 'jev-semaphore'
const AGENT_PREFIX = `${PLUGIN}:`
const PANE_TITLE = 'Sub-agent model allocation'

/* ------------------------------------------------- session state (atoms) */

const tabState = atom({ plugin: 'jev-semaphore', key: 'tab' } as const, 'routing' as Tab)
const modeState = atom({ plugin: 'jev-semaphore', key: 'mode' } as const, null as Mode | null)
const pinsState = atom({ plugin: 'jev-semaphore', key: 'pins' } as const, {} as Pins)
const rosterState = atom({ plugin: 'jev-semaphore', key: 'roster' } as const, [] as RosterRow[])
const decisionsState = atom({ plugin: 'jev-semaphore', key: 'decisions' } as const, [] as Decision[])
const spawnsState = atom({ plugin: 'jev-semaphore', key: 'spawns' } as const, [] as Spawn[])
const ctxState = atom({ plugin: 'jev-semaphore', key: 'ctx' } as const, [] as CtxNode[])
const bandCollapsedState = atom({ plugin: 'jev-semaphore', key: 'isBandCollapsed' } as const, false)
const setupState = atom({ plugin: 'jev-semaphore', key: 'setup' } as const, S.EMPTY_SETUP)
const totalsState = atom({ plugin: 'jev-semaphore', key: 'totals' } as const, S.EMPTY_TOTALS)

type Options = {
  backend: Backend
  typesafeApiKey: string
  openrouterApiKey: string
  typesafeKeyRef: string
  openrouterKeyRef: string
  kevUrl: string
  kevRepoPath: string
  kevModel: string
  kevAutostart: boolean
  mode: Mode
  floor: number
  budgetUsd: number
  externals: string[]
  workers: string[]
}

const list = (v: unknown) => (typeof v === 'string' ? v.split(',').map(s => s.trim()).filter(Boolean) : Array.isArray(v) ? v.map(String) : [])
const str = (v: unknown, d: string) => (typeof v === 'string' && v !== '' ? v : d)

function optionsOf(o: PluginOptions): Options {
  const backend = str(o.backend, 'typesafe')
  const mode = str(o.routingMode, 'auto')

  return {
    backend: (['typesafe', 'openrouter', 'kev-local', 'off'].includes(backend) ? backend : 'typesafe') as Backend,
    typesafeApiKey: str(o.typesafeApiKey, ''),
    openrouterApiKey: str(o.openrouterApiKey, ''),
    typesafeKeyRef: str(o.typesafeKeyRef, ''),
    openrouterKeyRef: str(o.openrouterKeyRef, ''),
    kevUrl: str(o.kevUrl, 'http://127.0.0.1:8009'),
    kevRepoPath: str(o.kevRepoPath, '~/Projects/kev'),
    kevModel: str(o.kevModel, 'kev-4b'),
    kevAutostart: o.kevAutostart === true,
    mode: (['auto', 'recommend', 'off'].includes(mode) ? mode : 'auto') as Mode,
    floor: typeof o.downgradeFloor === 'number' ? Math.max(0, Math.min(1, o.downgradeFloor)) : 0.6,
    budgetUsd: typeof o.budgetUsd === 'number' ? Math.max(0, o.budgetUsd) : 0,
    externals: list(o.externals ?? 'codex-review,codex-image,opencode,openrouter'),
    workers: list(o.openrouterModels ?? 'qwen/qwen3-coder'),
  }
}

/** This activation's settings and session facts; `register` replaces it on every (re)load. */
type Runtime = {
  o: Options
  settings: Settings
  cwd: string
  tools: string[]
  mainModel: string
  kevTimer: { cancel: () => void } | null
  seenTurns: Set<string>
}

function runtimeOf(o: Options): Runtime {
  return {
    o,
    settings: { backend: o.backend, typesafeApiKey: o.typesafeApiKey, openrouterApiKey: o.openrouterApiKey, kevUrl: o.kevUrl },
    cwd: '',
    tools: [],
    mainModel: 'opus',
    kevTimer: null,
    seenTurns: new Set(),
  }
}

let R: Runtime = runtimeOf(optionsOf({}))

/** The slice of `$` the library files use (`$` itself may not cross an import). */
function hostOf($: EngineInterface): Host {
  return {
    now: () => $.clock.now(),
    sleep: ms => $.clock.sleep(ms),
    every: (ms, fn) => $.clock.every(ms, fn),
    fetch: (url, init) => $.http.fetch(url, init),
    run: (argv, init) => $.process.run(argv, init),
    exists: path => $.fs.exists(path),
    home: async () => (await $.env.get('HOME')) ?? '',
    registerTool: spec => $.tool.register(spec),
    blit: args => $.ui.blit(args),
    debug: text => void $.ui.log(text, { to: 'debug' }),
  }
}

async function modeOf($: EngineInterface): Promise<Mode> {
  return (await read($, modeState)) ?? R.o.mode
}

function kevPathsOf($: EngineInterface) {
  return X.kevPaths(hostOf($), R.o.kevRepoPath, R.o.kevModel, R.o.kevUrl)
}

/** Runs `fn` on a timer, so long work (installs, probes) outlives the press or command that asked for it. */
function later($: EngineInterface, fn: () => Promise<unknown>) {
  return $.clock.after(1, () => {
    void fn().catch(error => $.ui.log(`jev-semaphore: ${String(error)}`, { to: 'debug' }))
  })
}

/* ---------------------------------------------------------------- ledger */

async function ledger($: EngineInterface): Promise<LedgerRow[]> {
  const rows = await $.store.get(S.LEDGER_KEY)

  return Array.isArray(rows) ? (rows as LedgerRow[]) : []
}

/** This project's rows only; other projects' task descriptions never show here or in an export. */
async function projectLedger($: EngineInterface): Promise<LedgerRow[]> {
  return (await ledger($)).filter(r => r.project === R.cwd)
}

/** Each subagent's own working folder (a spawn may set `cwd`, e.g. a worktree), so external tools run where it works. */
const agentCwd = new Map<string, string>()

/** Writes are queued: two spawns at once would otherwise read the same rows and drop one addition. */
let ledgerQueue: Promise<unknown> = Promise.resolve()

function writeLedger($: EngineInterface, fn: (rows: LedgerRow[]) => LedgerRow[]): Promise<void> {
  const write = ledgerQueue.then(async () => $.store.set(S.LEDGER_KEY, fn(await ledger($)).slice(-300)))
  ledgerQueue = write.catch(() => undefined)

  return write.then(() => undefined)
}

async function exportLedger($: EngineInterface): Promise<string> {
  const rows = await projectLedger($)
  const day = new Date().toISOString().slice(0, 10)
  const path = `${R.cwd}/.jev-semaphore/ledger-${day}.md`
  const lines = [
    `# jev-semaphore decision ledger (${day})`,
    '',
    '| time | role | task | picked | ran | p | source | note | outcome | cost |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      r =>
        `| ${new Date(r.at).toISOString().slice(0, 16).replace('T', ' ')} | ${r.role} | ${r.task.replaceAll('|', '/')} | ${r.picked} | ${r.applied} | ${r.candidates[0]?.p.toFixed(2) ?? ''} | ${r.source} | ${r.note.replaceAll('|', '/')} | ${r.outcome} | ${r.costUsd > 0 ? fmtUsd(r.costUsd) : ''} |`,
    ),
    '',
    "Costs are estimates from API list prices; Jev p is the decision model's probability for its pick.",
  ]
  await $.process.run(['mkdir', '-p', `${R.cwd}/.jev-semaphore`])
  await $.fs.write(path, lines.join('\n'))

  return path
}

/* ----------------------------------------------------------------- setup */

async function refreshKev($: EngineInterface) {
  const p = await kevPathsOf($)
  const [health, cloned, log] = await Promise.all([X.kevHealth(hostOf($), p.url), X.isCloned(hostOf($), p), X.kevLog(hostOf($), p)])
  await update($, setupState, (s): Setup => {
    const isBusy = s.kev.state === 'installing' || (s.kev.state === 'starting' && !health.isUp)
    const state = isBusy ? s.kev.state : health.isUp ? 'running' : cloned ? 'stopped' : 'missing'
    const detail = health.isUp ? `${p.url} · ${health.models.join(', ') || 'up'}` : isBusy ? s.kev.detail : cloned ? `repo ${p.repo}` : `not cloned at ${p.repo}`

    return s.kev.state === state && s.kev.detail === detail && s.kev.log.join() === log.join() ? s : { ...s, kev: { state, detail, log } }
  })
}

function watchKev($: EngineInterface) {
  if (R.kevTimer === null) {
    R.kevTimer = $.clock.every(5000, () => {
      void refreshKev($)
    })
  }
}

async function detectAll($: EngineInterface) {
  const externals = await X.detect(hostOf($), R.settings.openrouterApiKey, R.o.externals)
  const checkedAt = await $.clock.now()
  await update($, setupState, (s): Setup => ({ ...s, externals, checkedAt }))

  return externals
}

async function testConnection($: EngineInterface) {
  const label = backendLabel(R.o.backend)
  await update($, setupState, (s): Setup => ({ ...s, conn: { state: 'testing' } }))
  const reply = await probe(hostOf($), R.settings)
  await update($, setupState, (s): Setup => ({
    ...s,
    conn: reply.ok ? { state: 'ok', latencyMs: reply.latencyMs, version: reply.model } : { state: 'fail', error: reply.error.slice(0, 140), latencyMs: reply.latencyMs },
  }))
  $.ui.toast(reply.ok ? `Jev ${label}: ok in ${reply.latencyMs}ms (${reply.model})` : `Jev ${label} failed: ${reply.error.slice(0, 120)}`)

  return reply
}

async function kevAction($: EngineInterface, what: 'install' | 'start' | 'stop'): Promise<string> {
  const p = await kevPathsOf($)

  if (what === 'stop') {
    const r = await X.kevStop(hostOf($), p)
    await update($, setupState, (s): Setup => ({ ...s, kev: { ...s.kev, state: 'stopped', detail: r.detail } }))
    await refreshKev($)

    return `Kev: ${r.detail}.`
  }

  if (what === 'install' || !(await X.isCloned(hostOf($), p))) {
    await update($, setupState, (s): Setup => ({ ...s, kev: { ...s.kev, state: 'installing', detail: `cloning into ${p.repo} and running uv sync (a few minutes)` } }))
    const r = await X.kevInstall(hostOf($), p)
    await update($, setupState, (s): Setup => ({ ...s, kev: { ...s.kev, state: r.ok ? 'stopped' : 'failed', detail: r.detail } }))

    if (!r.ok || what === 'install') {
      $.ui.toast(r.ok ? 'Kev installed. Press Start.' : `Kev install failed: ${r.detail}`)

      return r.detail
    }
  }

  await update($, setupState, (s): Setup => ({ ...s, kev: { ...s.kev, state: 'starting', detail: `starting jaredpalmer/${p.model} on :${p.port} (first start downloads the model)` } }))
  const r = await X.kevStart(hostOf($), p)

  if (!r.ok) {
    await update($, setupState, (s): Setup => ({ ...s, kev: { ...s.kev, state: 'failed', detail: r.detail } }))

    return `Kev failed to start: ${r.detail}`
  }

  watchKev($)

  return `Kev starting (${r.detail}); the Setup tab turns green when it answers.`
}

async function setBackend($: EngineInterface, value: string) {
  const rows = await $.config.list()
  const row = rows.find(r => r.provider.plugin === PLUGIN && /backend$/i.test(r.key))

  if (row === undefined) {
    $.ui.toast('Set the backend in /config → jev-semaphore → Routing backend')

    return
  }

  const result = await $.config.set({ key: row.key, value })

  if ('deny' in result && result.deny !== undefined) {
    $.ui.toast(`Could not change the backend: ${result.deny}`)
  }
}

async function status($: EngineInterface) {
  const t = await read($, totalsState)
  const mode = await modeOf($)
  const budget = R.o.budgetUsd > 0 ? ` / ${fmtUsd(R.o.budgetUsd)}` : ''
  await $.ui.status(`◆ jev · ${backendLabel(R.o.backend)} · ${mode} · ${t.routed} routed · ${fmtUsd(t.spendUsd)}${budget}`)
}

function paneCtx($: EngineInterface, mode: Mode): PaneCtx {
  return {
    backend: R.o.backend,
    mode,
    floor: R.o.floor,
    budgetUsd: R.o.budgetUsd,
    kevModel: R.o.kevModel,
    kevUrl: R.o.kevUrl,
    kevRepo: R.o.kevRepoPath,
    mainModel: R.mainModel,
    cwd: R.cwd,
    tools: R.tools,
    act: {
      setTab: t => void update($, tabState, () => t),
      test: () => void later($, () => testConnection($)),
      kevInstall: () => void later($, () => kevAction($, 'install')),
      kevStart: () => void later($, () => kevAction($, 'start')),
      kevStop: () => void later($, () => kevAction($, 'stop')),
      detect: () => void later($, () => detectAll($)),
      setBackend: v => void later($, () => setBackend($, v)),
      setMode: m => void update($, modeState, () => m),
      saveKey: (which, key) => void later($, () => saveKey($, which, key)),
      removeKey: which => void later($, () => removeKey($, which)),
      unpin: role => void update($, pinsState, p => Object.fromEntries(Object.entries(p).filter(([r]) => r !== role))),
      exportLedger: () => void later($, async () => $.ui.toast(`Ledger exported to ${await exportLedger($)}`)),
    },
  }
}

/* ------------------------------------------------------------------ keys */

const KEYCHAIN_SERVICE = 'jev-semaphore'
/** The service keys were saved under before the rename; read as a fallback, never written. */
const LEGACY_KEYCHAIN_SERVICE = 'jev-router'

const mask = (key: string) => (key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`)

/**
 * Finds each API key, first match wins: the plugin's own secure config (an installed plugin, set with
 * `claude plugin configure`), the macOS Keychain (what the Setup tab saves), a 1Password `op://`
 * reference from /config, then TYPESAFE_API_KEY / OPENROUTER_API_KEY. Only a masked hint reaches state.
 */
async function resolveKeys($: EngineInterface) {
  const find = async (which: Which, fromConfig: string, ref: string, fromEnv: string | undefined): Promise<{ key: string; info: KeyInfo }> => {
    if (fromConfig !== '') {
      return { key: fromConfig, info: { source: 'config', hint: mask(fromConfig) } }
    }

    for (const service of [KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE]) {
      const keychain = await $.process.run(['security', 'find-generic-password', '-s', service, '-a', which, '-w']).catch(() => null)

      if (keychain?.exitCode === 0 && keychain.stdout.trim() !== '') {
        const key = keychain.stdout.trim()

        return { key, info: { source: 'keychain', hint: mask(key) } }
      }
    }

    let error: string | undefined

    if (ref.startsWith('op://')) {
      const op = await $.process.run(['op', 'read', ref], { timeoutMs: 60_000 }).catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: String(e) }))

      if (op.exitCode === 0 && op.stdout.trim() !== '') {
        const key = op.stdout.trim()

        return { key, info: { source: '1password', hint: mask(key) } }
      }

      error = `op read failed: ${op.stderr.trim().slice(0, 100)}`
    }

    if (fromEnv !== undefined && fromEnv !== '') {
      return { key: fromEnv, info: { source: 'env', hint: mask(fromEnv) } }
    }

    return { key: '', info: { source: 'missing', hint: '', ...(error !== undefined && { error }) } }
  }

  const [typesafe, openrouter] = await Promise.all([
    find('typesafe', R.o.typesafeApiKey, R.o.typesafeKeyRef, await $.env.get('TYPESAFE_API_KEY')),
    find('openrouter', R.o.openrouterApiKey, R.o.openrouterKeyRef, await $.env.get('OPENROUTER_API_KEY')),
  ])
  R.settings.typesafeApiKey = typesafe.key
  R.settings.openrouterApiKey = openrouter.key
  await update($, setupState, (s): Setup => ({ ...s, keys: { typesafe: typesafe.info, openrouter: openrouter.info } }))
}

/** Saves a pasted key to the macOS Keychain; the key goes over stdin to `security -i`, never on a command line. */
async function saveKey($: EngineInterface, which: Which, raw: string) {
  const key = raw.trim()

  if (!/^[A-Za-z0-9._~+\/=:-]{8,512}$/.test(key)) {
    $.ui.toast('That does not look like an API key (letters, digits and -_.:+/= only); nothing was saved.')

    return
  }

  const r = await $.process.run(['security', '-i'], {
    stdin: `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${which} -l "jev-semaphore ${which} API key" -w "${key}"\n`,
  })

  if (r.exitCode !== 0) {
    $.ui.toast(`Keychain refused the key: ${redact(r.stderr.trim(), [key]).slice(0, 120)}`)

    return
  }

  await resolveKeys($)
  await registerExternals($)
  $.ui.toast(`${which === 'typesafe' ? 'TypeSafe' : 'OpenRouter'} key saved to the macOS Keychain (service "${KEYCHAIN_SERVICE}").`)
}

/** Deletes the key under both service names (resolution reads the legacy one too, so leaving it would bring the key straight back). */
async function removeKey($: EngineInterface, which: Which) {
  const name = which === 'typesafe' ? 'TypeSafe' : 'OpenRouter'
  let removed = 0

  for (const service of [KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE]) {
    const r = await $.process.run(['security', 'delete-generic-password', '-s', service, '-a', which]).catch(() => null)
    removed += r?.exitCode === 0 ? 1 : 0
  }

  await resolveKeys($)
  await registerExternals($)
  const stillThere = (await read($, setupState)).keys[which].source === 'keychain'
  $.ui.toast(
    stillThere
      ? `${name} key could not be removed from the Keychain; delete it in Keychain Access (service "${KEYCHAIN_SERVICE}" or "${LEGACY_KEYCHAIN_SERVICE}").`
      : removed > 0
        ? `${name} key removed from the Keychain.`
        : `No ${name} key was stored in the Keychain.`,
  )
}

/** Re-detects the external executors and (re)registers their tools, e.g. after an OpenRouter key appears. */
async function registerExternals($: EngineInterface) {
  const externals = await detectAll($)
  R.tools = await X.registerTools(hostOf($), externals, R.o.externals, R.o.workers)
}

/* ----------------------------------------------------------- permission */

/**
 * The mod answers its own tools' `tool.call`, which bypasses the engine's permission dialog, so it
 * asks the same question itself before running anything: the session's rules and mode decide via
 * `$.tool.check`; an `ask` becomes a Yes/No to the person, and no one to ask (a `-p` run) means no.
 * Returns the refusal reason, or null to proceed.
 */
async function gateTool($: EngineInterface, tool: string, name: string, args: Record<string, unknown>, cwd: string): Promise<string | null> {
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  const input = Object.fromEntries(['base', 'focus', 'path', 'prompt', 'task', 'model'].filter(k => s(k) !== '').map(k => [k, s(k)]))
  const check = await $.tool.check({ tool, input }).catch(() => ({ decision: 'ask' as const, reason: undefined }))

  if (check.decision === 'deny') {
    return check.reason ?? `${name} is denied by your permission settings`
  }

  if (check.decision === 'allow') {
    return null
  }

  const what =
    name === X.TOOL.codexReview
      ? `run \`codex review\` in ${cwd}`
      : name === X.TOOL.codexImage
        ? `let Codex write ${s('path')} in ${cwd}`
        : name === X.TOOL.opencode
          ? `run OpenCode (it can edit files and run commands) in ${cwd}: "${s('task').slice(0, 120)}"`
          : name === X.TOOL.openrouter
            ? `send a prompt to OpenRouter${s('model') !== '' ? ` (${s('model')})` : ''}`
            : `run ${name}`
  const answer = await $.ui.ask(`Allow jev-semaphore to ${what}?`, { options: ['Allow', 'Deny'], header: 'Jev tool' }).catch(() => 'Deny')

  return answer === 'Allow' ? null : `The user did not allow ${name}.`
}

/* ----------------------------------------------------- context exchange */

function ctxLabel(tool: string, args: Record<string, unknown>): { label: string; tokens: number } | null {
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  const base = (p: string) => p.split('/').pop() ?? p

  switch (tool) {
    case 'Write':
      return { label: base(s('file_path')), tokens: s('content').length / 4 }
    case 'Edit':
    case 'MultiEdit':
      return { label: base(s('file_path')), tokens: (s('new_string').length + s('old_string').length) / 4 || 40 }
    case 'Bash':
      return { label: s('command').replace(/^(cd \S+ && )/, '').split(/\s+/).slice(0, 2).join(' ').slice(0, 18), tokens: 60 }
    case 'Agent':
      return { label: s('description').slice(0, 18) || 'handoff', tokens: s('prompt').length / 4 }
    default:
      return tool.startsWith(`mcp__${PLUGIN}__`) ? { label: tool.slice(`mcp__${PLUGIN}__`.length).replace('_', ' '), tokens: 200 } : null
  }
}


async function addCtx($: EngineInterface, agentId: string | undefined, entry: { label: string; tokens: number } | null) {
  if (entry === null || entry.label === '') {
    return
  }

  const spawns = await read($, spawnsState)
  const who = spawns.find(s => s.agentId === agentId)
  const node: CtxNode = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    label: entry.label,
    role: who?.role ?? 'main',
    model: who?.model ?? labelOf(R.mainModel),
    tokens: Math.round(entry.tokens),
    at: await $.clock.now(),
  }
  await update($, ctxState, nodes => [...nodes, node].slice(-60))
  await update($, totalsState, t => ({ ...t, ctxTokens: t.ctxTokens + node.tokens }))
  animate(hostOf($))
}


export const register: Register = (on, options) => {
  R = runtimeOf(optionsOf(options))

  /* ----------------------------------------------------------- session */

  on('session.start', async ($, e, next) => {
    R.cwd = e.cwd
    await $.command.register({
      name: 'jev-semaphore',
      description: 'Jev model routing: open the pane, or setup | ledger | test | mode <auto|recommend|off> | pin <role> <model> | unpin <role> | kev <install|start|stop|status> | export',
      argumentHint: '[setup|ledger|test|mode|pin|unpin|kev|export]',
    })

    await resolveKeys($)
    await registerExternals($)

    for (const spec of roleAgents(R.tools)) {
      await $.agent.register(spec).catch((error: unknown) => $.ui.log(`jev-semaphore: agent ${spec.name} not registered: ${String(error)}`, { to: 'debug' }))
    }

    if (R.o.backend === 'kev-local') {
      await refreshKev($)
      watchKev($)

      if (R.o.kevAutostart && (await read($, setupState)).kev.state !== 'running') {
        later($, async () => void (await kevAction($, 'start')))
      }
    }

    await status($)

    if (e.isInteractive) {
      void $.ui.open({ id: PANE_ID, title: PANE_TITLE }).catch(() => undefined)
    }

    return next(e)
  })

  on('command.run', { command: 'jev-semaphore' }, async ($, e) => {
    const [verb = '', a = '', b = ''] = e.args.trim().split(/\s+/)
    const open = async (tab: 'routing' | 'setup' | 'ledger') => {
      await update($, tabState, () => tab)
      await $.ui.open({ id: PANE_ID, title: PANE_TITLE, focus: true })
    }

    switch (verb) {
      case '':
      case 'routing':
        await open('routing')

        return { text: `Jev routing pane opened (${backendLabel(R.o.backend)}, ${await modeOf($)}).` }
      case 'setup':
      case 'ledger':
        await open(verb)

        return { text: `Jev ${verb} opened.` }
      case 'test': {
        const reply = await testConnection($)

        return { text: reply.ok ? `Jev (${backendLabel(R.o.backend)}) answered in ${reply.latencyMs}ms, model ${reply.model}.` : `Jev (${backendLabel(R.o.backend)}) failed: ${reply.error}` }
      }
      case 'mode':
        if (!['auto', 'recommend', 'off'].includes(a)) {
          return { text: 'Usage: /jev-semaphore mode auto|recommend|off' }
        }

        await update($, modeState, () => a as Mode)
        await status($)

        return { text: `Routing mode is ${a} for this session (the default lives in /config).` }
      case 'pin': {
        const model = modelFor(b)?.label

        if (!ROLES.includes(a) || model === undefined) {
          return { text: `Usage: /jev-semaphore pin <${ROLES.join('|')}> <fable|opus|sonnet|haiku>` }
        }

        await update($, pinsState, p => ({ ...p, [a]: model }))

        return { text: `${a} is pinned to ${model}; Jev still scores it, the pin decides.` }
      }
      case 'unpin':
        await update($, pinsState, p => Object.fromEntries(Object.entries(p).filter(([r]) => r !== a)))

        return { text: `${a} is routed by Jev again.` }
      case 'kev':
        if (a === 'status') {
          await refreshKev($)
          const k = (await read($, setupState)).kev

          return { text: `Kev: ${k.state} · ${k.detail}` }
        }

        if (a === 'install' || a === 'start' || a === 'stop') {
          return { text: await kevAction($, a) }
        }

        return { text: 'Usage: /jev-semaphore kev install|start|stop|status' }
      case 'export':
        return { text: `Ledger exported to ${await exportLedger($)}` }
      default:
        return { text: `Unknown: /jev-semaphore ${verb}. Try /jev-semaphore, /jev-semaphore setup, /jev-semaphore test, /jev-semaphore mode, /jev-semaphore pin, /jev-semaphore kev, /jev-semaphore export.` }
    }
  })

  on('prompt.compose', async ($, e, next) => {
    R.mainModel = e.model
    const composed = await next(e)

    if ((await modeOf($)) === 'off') {
      return composed
    }

    return { sections: [...composed.sections, { id: 'jev-semaphore', text: COMPOSE_SECTION(R.tools), scope: 'session' as const }] }
  })

  /* ------------------------------------------------------------ routing */

  on('agent.spawn', async ($, e, next) => {
    const mode = await modeOf($)

    if (mode === 'off' || e.fork || e.isTeammate === true) {
      return next(e)
    }

    const ours = e.subagentType.startsWith(AGENT_PREFIX) ? e.subagentType.slice(AGENT_PREFIX.length) : null
    const role = ours !== null && ROLES.includes(ours) ? ours : null
    const parentModel = e.parentModel ?? R.mainModel
    const current = labelOf(e.model ?? (role !== null ? (DEFAULT_MODEL[role] ?? parentModel) : parentModel))
    const [pins, totals, history] = await Promise.all([read($, pinsState), read($, totalsState), projectLedger($)])
    const input: RouteInput = {
      role,
      description: e.description,
      prompt: e.prompt,
      parentModel,
      current,
      budgetLeftUsd: R.o.budgetUsd > 0 ? Math.max(0, R.o.budgetUsd - totals.spendUsd) : null,
      history: history.filter(h => role === null || h.role === role).slice(-6).map(h => `${h.role} on ${h.applied}: ${h.outcome}`),
      canOffload: R.tools.includes(X.TOOL.openrouter) && (role === null || role === 'builder' || role === 'implementer'),
    }

    const reply = R.o.backend === 'off' ? null : await ask(hostOf($), R.settings, stateFor(input), questionsFor(input), R.o.backend === 'kev-local' ? 6000 : 3500)
    const routed = route(input, reply, {
      floor: R.o.floor,
      pin: pins[role ?? ''] ?? undefined,
      isApplied: mode === 'auto',
      source: reply === null || !reply.ok ? 'heuristic' : R.o.backend === 'kev-local' ? 'kev' : 'jev',
    })

    // A general-purpose spawn that is really a review or an image job goes to the role with the external tool.
    const steerTo =
      role === null && e.subagentType === 'general-purpose' && mode === 'auto'
        ? routed.decision.role === 'reviewer' && R.tools.includes(X.TOOL.codexReview)
          ? `${AGENT_PREFIX}reviewer`
          : routed.decision.role === 'artist' && R.tools.includes(X.TOOL.codexImage)
            ? `${AGENT_PREFIX}artist`
            : undefined
        : undefined
    const prompt =
      routed.offload && mode === 'auto'
        ? `${e.prompt}\n\n(Routing note: draft the bulk/boilerplate parts with ${X.fullName(X.TOOL.openrouter)}, then review and write them yourself.)`
        : e.prompt

    const started = await next({
      ...e,
      ...(routed.alias !== undefined && { model: routed.alias }),
      ...(steerTo !== undefined && { subagentType: steerTo }),
      prompt,
    })

    if (started.deny !== undefined) {
      return started
    }

    const now = await $.clock.now()
    const d = routed.decision
    // The engine reports what it actually resolved; that is what ran, whatever we asked for.
    const ranOn = started.model !== undefined ? labelOf(started.model) : d.applied

    if (started.agentId !== undefined && e.cwd !== undefined) {
      agentCwd.set(started.agentId, e.cwd)
    }
    const decision: Decision = { ...d, applied: ranOn, id: started.agentId ?? `${now}`, at: now, task: e.description }
    const spawn: Spawn = {
      agentId: started.agentId ?? decision.id,
      parentId: e.parentAgentId ?? null,
      role: d.role,
      task: e.description,
      model: ranOn,
      startedAt: now,
      endedAt: null,
      status: 'running',
      costUsd: 0,
    }
    const top = d.candidates[0]
    const jevCost = reply?.ok === true ? (reply.inputTokens * JEV_USD_PER_MTOK) / 1_000_000 : 0

    await Promise.all([
      update($, decisionsState, ds => [...ds, decision].slice(-100)),
      update($, spawnsState, ss => [...ss, spawn].slice(-60)),
      update($, rosterState, rs => [...rs.filter(r => r.role !== d.role), { role: d.role, model: ranOn, score: top?.score ?? null, p: top?.p ?? null }]),
      update($, totalsState, t => ({
        ...t,
        routed: t.routed + 1,
        jevCalls: t.jevCalls + (reply === null ? 0 : 1),
        jevCostUsd: t.jevCostUsd + jevCost,
        jevLatency: reply === null ? t.jevLatency : [...t.jevLatency, reply.latencyMs].slice(-40),
      })),
      writeLedger($, rows => [...rows, { ...decision, outcome: 'running', costUsd: 0, durationMs: 0, project: R.cwd }]),
    ])

    $.ui.log(
      `◆ ${d.source === 'heuristic' ? 'Heuristic' : 'Jev'}: ${d.role} → ${ranOn} (score ${top?.score.toFixed(2) ?? '—'} · p ${top?.p.toFixed(2) ?? '—'})` +
        (d.picked !== ranOn ? ` · picked ${d.picked}, ${d.note}` : '') +
        (steerTo !== undefined ? ` · routed to ${steerTo}` : ''),
    )
    animate(hostOf($))
    await status($)

    return started
  })

  /* ------------------------------------------------------------ tracking */

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const usage = e.usage
    const cost =
      usage === undefined || R.seenTurns.has(e.turnId)
        ? 0
        : (costOf(usage.model, usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens ?? 0, usage.cache_creation_input_tokens ?? 0) ?? 0)
    R.seenTurns.add(e.turnId)

    if (cost > 0) {
      await update($, totalsState, t => ({ ...t, spendUsd: t.spendUsd + cost }))
    }

    if (e.agentId === undefined) {
      if (usage !== undefined) {
        R.mainModel = usage.model
      }

      await status($)

      return result
    }

    const agentId = e.agentId
    const spawns = await read($, spawnsState)

    const now = await $.clock.now()
    const outcome = e.reason === 'answer' ? 'done' : 'failed'

    if (spawns.some(s => s.agentId === agentId)) {
      await update($, spawnsState, ss => ss.map(s => (s.agentId === agentId ? { ...s, status: outcome, endedAt: now, costUsd: s.costUsd + cost } : s)))
      animate(hostOf($))
    }

    // The ledger keeps 300 rows, the live spawn list 60, so settle the ledger row even when the spawn has scrolled off.
    await writeLedger($, rows => (rows.some(r => r.id === agentId) ? rows.map(r => (r.id === agentId ? { ...r, outcome, durationMs: e.durationMs, costUsd: r.costUsd + cost } : r)) : rows))

    await status($)

    return result
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const args = e as unknown as Record<string, unknown>

    if (tool.startsWith(`mcp__${PLUGIN}__`)) {
      const name = tool.slice(`mcp__${PLUGIN}__`.length)
      const cwd = (e.agentId !== undefined ? agentCwd.get(e.agentId) : undefined) ?? R.cwd
      const refusal = await gateTool($, tool, name, args, cwd)

      if (refusal !== null) {
        return { deny: refusal }
      }

      const answer = await X.serve(hostOf($), name, args, { cwd, openrouterKey: R.settings.openrouterApiKey, workers: R.o.workers })
      await addCtx($, e.agentId, ctxLabel(tool, args))

      return answer.isError ? { result: answer.result, isError: true as const } : { result: answer.result }
    }

    const result = await next(e)

    if (result.deny === undefined && result.isError !== true) {
      await addCtx($, e.agentId, ctxLabel(tool, args))
    }

    return result
  })

  /* ---------------------------------------------------------------- draw */

  on('ui.render', { component: 'Pane', requestId: 'jev-semaphore' }, async ($, e) => {
    const [tab, roster, decisions, spawns, totals, pins, setup, rows, now, mode] = await Promise.all([
      read($, tabState),
      read($, rosterState),
      read($, decisionsState),
      read($, spawnsState),
      read($, totalsState),
      read($, pinsState),
      read($, setupState),
      projectLedger($),
      $.clock.now(),
      modeOf($),
    ])

    return renderPane($.ui.resolve(e), e, paneCtx($, mode), { tab, roster, decisions, spawns, totals, pins, setup, ledger: rows, now })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const [nodes, totals, isCollapsed, now] = await Promise.all([read($, ctxState), read($, totalsState), read($, bandCollapsedState), $.clock.now()])
    const tree = renderBand($.ui.resolve(e), e, { nodes, totals, isCollapsed, now, toggle: () => void update($, bandCollapsedState, v => !v) })

    return tree ?? next(e)
  })
}
