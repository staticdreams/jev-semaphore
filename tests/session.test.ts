import type { On, RenderInput } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PLUGIN = 'jev-semaphore'

const SPAWN = { tool_use_id: 'toolu_1', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5', background: false, fork: false }

const SESSION = { surface: 'terminal' as const, isInteractive: true, cwd: '/work' }

const PANE: RenderInput<'Pane'> = {
  component: 'Pane',
  surface: 'terminal',
  requestId: 'jev-semaphore',
  viewport: { columns: 200, rows: 60, isFullscreen: true },
  props: { title: 'Sub-agent model allocation', isFocused: false, bodyColumns: 96, placement: 'dock', scroll: { offset: 0, bodyRows: 56 }, view: {} },
}

const BAND: RenderInput<'AbovePrompt'> = {
  component: 'AbovePrompt',
  surface: 'terminal',
  requestId: 'band',
  viewport: { columns: 200, rows: 60, isFullscreen: true },
  props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 19 }, view: {} },
}

const JEV_REPLY = JSON.stringify({
  model: 'jev-1.13.0',
  answers: {
    model: { type: 'choice', choice: 'haiku-4.5', confidence: 0.8, probabilities: { 'fable-5.1': 0.02, 'opus-5.5': 0.05, 'sonnet-5.5': 0.08, 'haiku-4.5': 0.85 } },
    risky: { type: 'noul', noul: 0.1 },
  },
  usage: { input_tokens: 1200, output_tokens: 0 },
})

/** Stands in for the engine beneath the plugin: registrations succeed, surfaces accept what they are given. */
function engine(on: On) {
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__jev-semaphore__${e.name}` } }))
  on('agent.register', ($, e) => ({ value: { agent: `jev-semaphore:${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.blit', () => ({ value: {} }))
  on('tool.call', () => ({ result: 'ok' }))
}

test('a spawn of a role agent is routed to Jev’s pick and drawn', { options: { backend: 'typesafe', typesafeApiKey: 'test-key', externals: '' } }, async ($, on) => {
  const spawned: { model?: string; subagentType: string }[] = []
  const asked: string[] = []
  engine(on)
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: 'not found', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', ($, e) => {
    asked.push(e.url)

    return { value: { status: 200, ok: true, headers: {}, text: JEV_REPLY } }
  })
  on('agent.spawn', ($, e) => {
    spawned.push({ model: e.model, subagentType: e.subagentType })

    return { model: e.model ?? 'inherit', agentId: 'agent-1' }
  })

  await $.session.start(SESSION)
  const started = await $.agent.spawn({ ...SPAWN, prompt: 'Run the test suite and report failures', description: 'run tests', subagentType: 'jev-semaphore:executor' })

  expect(started.deny).toBeUndefined()
  expect(asked[0]).toBe('https://api.typesafe.ai/v1/systemone')
  expect(spawned[0]?.model).toBe('haiku')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /haiku-4\.5/ })).toBeDefined()
    await ui.press({ key: 'tab-setup' })
    expect(await ui.find({ type: 'Text', text: /Routing backend/ })).toBeDefined()
    await ui.press({ key: 'tab-ledger' })
    expect(await ui.find({ type: 'Text', text: /Decision ledger/ })).toBeDefined()
    await ui.press({ key: 'tab-routing' })
    await ui.unmount()
  }
})

test('with the backend off, routing falls back to the heuristic and still records', { options: { backend: 'off', externals: '' } }, async ($, on) => {
  engine(on)
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/test' })
  on('process.run', () => ({ value: { exitCode: 127, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('agent.spawn', ($, e) => ({ model: e.model ?? 'inherit', agentId: 'agent-2' }))

  await $.session.start(SESSION)
  await $.agent.spawn({ ...SPAWN, prompt: 'Plan the auth page work and split it into tasks', description: 'plan auth page', subagentType: 'jev-semaphore:orchestrator' })
  await $.tool.call({ tool: 'Write', file_path: '/work/src/app/auth/page.tsx', content: 'export default function Page() {}' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /heuristic/ })).toBeDefined()
    await pane.unmount()
    const band = await $.ui.mount({ plugin: PLUGIN, ...BAND, surface })
    expect(await band.find({ type: 'Text', text: /Context exchange/ })).toBeDefined()
    await band.unmount()
  }
})


test('a key from the environment is found, used and shown by source, never in full', { options: { backend: 'typesafe', externals: '' } }, async ($, on) => {
  const auth: string[] = []
  engine(on)
  mock.clock(on)
  mock.store(on)
  mock.env(on, { HOME: '/home/test', TYPESAFE_API_KEY: 'ts_test_fake0000ffff' })
  // No Keychain item: `security` exits 44, every other executable is missing.
  on('process.run', ($, e) => ({ value: { exitCode: e.argv[0] === 'security' ? 44 : 127, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('http.fetch', ($, e) => {
    auth.push(e.init?.headers?.authorization ?? '')

    return { value: { status: 200, ok: true, headers: {}, text: JEV_REPLY } }
  })
  on('agent.spawn', ($, e) => ({ model: e.model ?? 'inherit', agentId: 'agent-3' }))

  await $.session.start(SESSION)
  await $.agent.spawn({ ...SPAWN, prompt: 'Run the tests', description: 'run tests', subagentType: 'jev-semaphore:executor' })
  expect(auth[0]).toBe('Bearer ts_test_fake0000ffff')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, ...PANE, surface })
    await ui.press({ key: 'tab-setup' })
    expect(await ui.find({ type: 'Text', text: /environment variable/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /fake0000ffff/ })).toBeUndefined()
    await ui.unmount()
  }
})
