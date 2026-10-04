/**
 * Non-Anthropic executors. A subagent's own model must be Anthropic's, so these are reached as tools the
 * role agents call: Codex for an unbiased review and for image generation, OpenCode as another worker,
 * and OpenRouter models for cheap bulk drafting.
 */

import type { Host } from './host'
import { redact } from './jev-client'

import type { External } from '../../types'

export const TOOL = {
  codexReview: 'codex_review',
  codexImage: 'codex_image',
  opencode: 'opencode_run',
  openrouter: 'openrouter_draft',
} as const

export const fullName = (name: string): `mcp__${string}__${string}` => `mcp__jev-semaphore__${name}`

async function run(host: Host, argv: string[], timeoutMs = 10_000, cwd?: string) {
  try {
    return await host.run(argv, { timeoutMs, ...(cwd !== undefined && { cwd }) })
  } catch (error) {
    return { exitCode: 127, stdout: '', stderr: String(error), isStdoutTruncated: false, isStderrTruncated: false }
  }
}

/** What is installed and usable, with a fix for what is not. */
export async function detect(host: Host, openrouterKey: string, wanted: readonly string[]): Promise<External[]> {
  const [codex, features, opencode, orKey] = await Promise.all([
    run(host, ['codex', '--version']),
    run(host, ['codex', 'features', 'list']),
    run(host, ['opencode', '--version']),
    openrouterKey === ''
      ? Promise.resolve(null)
      : host.fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${openrouterKey}` } }).catch(() => null),
  ])

  const codexOk = codex.exitCode === 0
  const imageOk = codexOk && /image_generation\s+\S+\s+true/.test(features.stdout)
  const codexBits = [wanted.includes('codex-review') && 'review', wanted.includes('codex-image') && (imageOk ? 'image_generation on' : 'image_generation off')].filter(Boolean)

  return [
    {
      id: 'codex',
      isReady: codexOk && (wanted.includes('codex-review') || wanted.includes('codex-image')),
      version: codexOk ? codex.stdout.trim().replace(/^codex-cli\s*/, '') : '',
      detail: codexOk ? codexBits.join(' · ') || 'disabled in /config' : 'not found on PATH',
      hint: codexOk ? (imageOk ? '' : 'codex features enable image_generation') : 'brew install codex  (then: codex login)',
    },
    {
      id: 'opencode',
      isReady: opencode.exitCode === 0 && wanted.includes('opencode'),
      version: opencode.exitCode === 0 ? opencode.stdout.trim() : '',
      detail: opencode.exitCode === 0 ? (wanted.includes('opencode') ? 'worker' : 'disabled in /config') : 'not found on PATH',
      hint: opencode.exitCode === 0 ? '' : 'brew install sst/tap/opencode',
    },
    {
      id: 'openrouter',
      isReady: orKey?.ok === true && wanted.includes('openrouter'),
      version: '',
      detail: openrouterKey === '' ? 'no API key' : orKey?.ok === true ? 'key valid · cheap workers' : `key rejected (${orKey?.status ?? 'offline'})`,
      hint: openrouterKey === '' ? 'paste the key in /jev-semaphore setup (saved to the Keychain)' : '',
    },
  ]
}

/** Registers the tools whose executor is ready; answered by `serve`. */
export async function registerTools(host: Host, externals: readonly External[], wanted: readonly string[], workers: readonly string[]): Promise<string[]> {
  const ready = (id: External['id']) => externals.some(x => x.id === id && x.isReady)
  const names: string[] = []

  if (ready('codex') && wanted.includes('codex-review')) {
    await host.registerTool({
      name: TOOL.codexReview,
      description:
        'Independent code review by OpenAI Codex (a different model family, so it does not share Claude\'s blind spots). ' +
        'Reviews uncommitted changes by default, or changes against a base branch. Returns Codex\'s findings as text. Takes 1-5 minutes.',
      inputSchema: {
        type: 'object',
        properties: {
          base: { type: 'string', description: 'Review against this base branch instead of uncommitted changes' },
          focus: { type: 'string', description: 'What to pay attention to (e.g. "auth flow and CSRF")' },
        },
      },
    })
    names.push(TOOL.codexReview)
  }

  if (ready('codex') && wanted.includes('codex-image')) {
    await host.registerTool({
      name: TOOL.codexImage,
      description:
        'Generates an image with Codex\'s image generation and saves it as a PNG in the project. ' +
        'Describe subject, style, palette and composition. Returns the saved path. Takes about a minute.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to draw, in detail' },
          path: { type: 'string', description: 'Where to save it, relative to the project (e.g. public/logo.png)' },
        },
        required: ['prompt', 'path'],
      },
    })
    names.push(TOOL.codexImage)
  }

  if (ready('opencode')) {
    await host.registerTool({
      name: TOOL.opencode,
      description: 'Hands a self-contained coding task to OpenCode (another agent, its own configured model) and returns its answer.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task, with every detail it needs' },
          model: { type: 'string', description: 'Optional provider/model for OpenCode' },
        },
        required: ['task'],
      },
    })
    names.push(TOOL.opencode)
  }

  if (ready('openrouter')) {
    await host.registerTool({
      name: TOOL.openrouter,
      description:
        `Drafts text or code with a cheap non-Claude model on OpenRouter (${workers.join(', ')}). ` +
        'Use for bulk boilerplate, fixtures and repetitive edits; always review what it returns before writing it.',
      inputSchema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to draft, with all context it needs' },
          model: { type: 'string', enum: [...workers], description: 'Which worker; defaults to the first' },
        },
        required: ['prompt'],
      },
    })
    names.push(TOOL.openrouter)
  }

  return names
}

export type ToolAnswer = { result: string; isError?: true }

const fail = (text: string): ToolAnswer => ({ result: text, isError: true })

const out = (r: { exitCode: number; stdout: string; stderr: string }, what: string): ToolAnswer =>
  r.exitCode === 0 ? { result: r.stdout.trim() || `${what} finished with no output.` } : fail(`${what} failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(-2000)}`)

export async function serve(host: Host, name: string, args: Record<string, unknown>, ctx: { cwd: string; openrouterKey: string; workers: readonly string[] }): Promise<ToolAnswer> {
  const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '')
  // Free text from the model goes in as a positional; a leading "-" would otherwise be parsed as a CLI option.
  const text = (k: string) => str(k).replace(/^\s*-/, ' -')

  switch (name) {
    case TOOL.codexReview: {
      const base = str('base')

      if (base.startsWith('-')) {
        return fail('base must be a branch name')
      }

      const argv = ['codex', 'review', ...(base !== '' ? ['--base', base] : ['--uncommitted'])]

      return out(await run(host, str('focus') !== '' ? [...argv, text('focus')] : argv, 600_000, ctx.cwd), 'codex review')
    }
    case TOOL.codexImage: {
      const path = str('path').replace(/^\/+/, '')

      if (path === '' || path.includes('..')) {
        return fail('path must be a relative path inside the project')
      }

      const r = await run(
        host,
        ['codex', 'exec', '--enable', 'image_generation', '--skip-git-repo-check', '-s', 'workspace-write', '-C', ctx.cwd,
          `Use your image generation tool to create this image: ${str('prompt')}\nSave the final PNG at ${path} (create folders as needed). Reply with only the saved path.`],
        600_000,
        ctx.cwd,
      )
      // A file that was already there proves nothing: codex must also have exited cleanly.
      const saved = r.exitCode === 0 && (await host.exists(`${ctx.cwd.replace(/\/+$/, '')}/${path}`))

      return !saved ? fail(`codex did not save ${path} (exit ${r.exitCode}). ${(r.stderr || r.stdout).slice(-800)}`) : { result: `Saved ${path}` }
    }
    case TOOL.opencode:
      if (str('model').startsWith('-')) {
        return fail('model must be a model id')
      }

      return out(await run(host, ['opencode', 'run', ...(str('model') !== '' ? ['-m', str('model')] : []), text('task')], 600_000, ctx.cwd), 'opencode')
    case TOOL.openrouter: {
      const model = ctx.workers.includes(str('model')) ? str('model') : (ctx.workers[0] ?? '')
      const r = await host
        .fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${ctx.openrouterKey}`, 'x-title': 'jev-semaphore' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: str('prompt') }] }),
        })
        .catch((error: unknown) => ({ ok: false, status: 0, text: String(error), headers: {} }))

      if (!r.ok) {
        return fail(`OpenRouter ${model} failed (${r.status}): ${redact(r.text, [ctx.openrouterKey]).slice(0, 400)}`)
      }

      try {
        const body = JSON.parse(r.text) as { choices?: { message?: { content?: string } }[] }

        return { result: `[draft by ${model} — review before use]\n\n${body.choices?.[0]?.message?.content ?? ''}` }
      } catch {
        return fail(`OpenRouter ${model} sent an unreadable reply`)
      }
    }
    default:
      return fail(`unknown tool ${name}`)
  }
}

/* -------------------------------------------------------------- managed Kev */

const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`

export type KevPaths = { repo: string; log: string; pid: string; port: string; model: string; url: string }

export async function kevPaths(host: Host, repoPath: string, model: string, url: string): Promise<KevPaths> {
  const home = await host.home()
  const repo = repoPath.replace(/^~(?=\/|$)/, home)
  const port = /:(\d+)/.exec(url.replace(/^https?:\/\//, ''))?.[1] ?? '8009'

  return { repo, log: `${home}/.cache/jev-semaphore/kev.log`, pid: `${home}/.cache/jev-semaphore/kev.pid`, port, model, url: url.replace(/\/+$/, '') }
}

export async function kevHealth(host: Host, url: string): Promise<{ isUp: boolean; models: string[] }> {
  const reply = await Promise.race([
    host.fetch(`${url}/v1/models`).catch(() => null),
    host.sleep(1500).then(() => null),
  ])

  if (reply?.ok !== true) {
    return { isUp: false, models: [] }
  }

  try {
    const body = JSON.parse(reply.text) as { data?: { id?: string }[] }

    return { isUp: true, models: (body.data ?? []).map(m => m.id ?? '').filter(Boolean) }
  } catch {
    return { isUp: true, models: [] }
  }
}

export const isCloned = async (host: Host, p: KevPaths): Promise<boolean> => host.exists(`${p.repo}/pyproject.toml`)

/** Clones kev and installs its serving extras on Python 3.12 (torch has no 3.14 wheels). */
export async function kevInstall(host: Host, p: KevPaths): Promise<{ ok: boolean; detail: string }> {
  if (!(await isCloned(host, p))) {
    const clone = await run(host, ['git', 'clone', '--depth', '1', 'https://github.com/jaredpalmer/kev', p.repo], 300_000)

    if (clone.exitCode !== 0) {
      return { ok: false, detail: `git clone failed: ${clone.stderr.slice(-300)}` }
    }
  }

  const sync = await run(host, ['uv', 'sync', '--python', '3.12', '--extra', 'serve'], 600_000, p.repo)

  return sync.exitCode === 0 ? { ok: true, detail: 'installed' } : { ok: false, detail: `uv sync failed: ${sync.stderr.slice(-300)}` }
}

/**
 * Starts Kev detached (nohup), so it outlives hot reloads and this session; its pid and log live
 * under ~/.cache/jev-semaphore. The first start downloads the checkpoint from Hugging Face.
 */
export async function kevStart(host: Host, p: KevPaths): Promise<{ ok: boolean; detail: string }> {
  // Folder and cd run in the foreground and abort on failure; only the server itself is backgrounded.
  const cmd =
    `mkdir -p "$(dirname ${quote(p.log)})" || exit 1; cd ${quote(p.repo)} || exit 1; ` +
    `nohup uv run --python 3.12 --extra serve python -m kev.serve --run ${quote(`jaredpalmer/${p.model}`)} --port ${quote(p.port)} > ${quote(p.log)} 2>&1 & ` +
    `echo $! > ${quote(p.pid)} && cat ${quote(p.pid)}`
  const r = await run(host, ['sh', '-c', cmd], 15_000)

  return r.exitCode === 0 ? { ok: true, detail: `pid ${r.stdout.trim()}` } : { ok: false, detail: r.stderr.slice(-300) || `exit ${r.exitCode}` }
}

/**
 * Stops only the Kev this mod started: the saved pid must still be a `kev.serve` process (a stale pid can
 * belong to anything by now). Kev servers started by hand are left alone.
 */
export async function kevStop(host: Host, p: KevPaths): Promise<{ ok: boolean; detail: string }> {
  const cmd =
    `[ -f ${quote(p.pid)} ] || { echo 'no managed Kev (no pid file)'; exit 0; }; ` +
    `pid=$(cat ${quote(p.pid)}); rm -f ${quote(p.pid)}; ` +
    `case "$pid" in ''|*[!0-9]*) echo 'pid file was invalid'; exit 0;; esac; ` +
    `if ps -p "$pid" -o command= 2>/dev/null | grep -q 'kev\\.serve'; then kill "$pid" && echo "stopped pid $pid"; ` +
    `else echo "pid $pid is no longer Kev; nothing killed"; fi`
  const r = await run(host, ['sh', '-c', cmd], 10_000)

  return { ok: r.exitCode === 0, detail: (r.stdout.trim() || r.stderr.trim()).slice(0, 200) }
}

export async function kevLog(host: Host, p: KevPaths, lines = 8): Promise<string[]> {
  const r = await run(host, ['tail', '-n', String(lines), p.log])

  return r.exitCode === 0 ? r.stdout.split('\n').filter(l => l.trim() !== '').map(l => l.slice(0, 160)) : []
}
