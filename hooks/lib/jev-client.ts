/**
 * One client for the System One decision API that hosted Jev (TypeSafe, OpenRouter) and local Kev share:
 * POST {base}/v1/systemone with { state, model, questions } -> { model, answers, usage, latency_ms }.
 */

import type { Host } from './host'

import type { Backend } from '../../types'

export type Question =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }

export type Answer = { type: string; choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }

export type JevReply =
  | { ok: true; model: string; answers: Record<string, Answer>; latencyMs: number; inputTokens: number }
  | { ok: false; error: string; latencyMs: number }

export type Settings = { backend: Backend; typesafeApiKey: string; openrouterApiKey: string; kevUrl: string }

type Endpoint = { url: string; model: string; headers: Record<string, string> } | { error: string }

/** Jev's own price as jev-pilot quotes OpenRouter's listing (input only, output free); an estimate, labelled so. */
export const JEV_USD_PER_MTOK = 0.04

export function endpointOf(s: Settings): Endpoint {
  const json = { 'content-type': 'application/json' }

  switch (s.backend) {
    case 'typesafe':
      return s.typesafeApiKey === ''
        ? { error: 'TypeSafe key missing: paste it in /jev-semaphore setup' }
        : { url: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', headers: { ...json, authorization: `Bearer ${s.typesafeApiKey}` } }
    case 'openrouter':
      return s.openrouterApiKey === ''
        ? { error: 'OpenRouter key missing: paste it in /jev-semaphore setup' }
        : {
            url: 'https://openrouter.ai/api/v1/systemone',
            model: '~typesafe/jev-latest',
            headers: { ...json, authorization: `Bearer ${s.openrouterApiKey}`, 'x-title': 'jev-semaphore (Claude Code mod)' },
          }
    case 'kev-local':
      return { url: `${s.kevUrl.replace(/\/+$/, '')}/v1/systemone`, model: 'kev-latest', headers: json }
    case 'off':
      return { error: 'routing backend is off' }
  }
}

/**
 * Scrubs secrets from text bound for state, toasts or the ledger: the given keys verbatim, plus anything
 * that looks like a bearer token or a provider key, since an auth error can echo what it was sent.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text

  for (const s of secrets) {
    if (s.length >= 8) {
      out = out.replaceAll(s, '[redacted]')
    }
  }

  return out.replace(/(Bearer\s+)[^\s"',]+/gi, '$1[redacted]').replace(/\b(sk|ts|rk|pk)[-_][A-Za-z0-9_-]{12,}/g, '[redacted]')
}

export const backendLabel = (b: Backend): string =>
  b === 'typesafe' ? 'hosted · typesafe' : b === 'openrouter' ? 'hosted · openrouter' : b === 'kev-local' ? 'local · kev' : 'off · heuristic'

/** Parses a reply body, keeping only well-formed answers. */
export function parseReply(text: string, latencyMs: number): JevReply {
  let body: unknown

  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, error: `unreadable reply: ${text.slice(0, 120)}`, latencyMs }
  }

  if (typeof body !== 'object' || body === null || !('answers' in body)) {
    const message = typeof body === 'object' && body !== null && 'error' in body ? JSON.stringify((body as { error: unknown }).error) : text.slice(0, 120)

    return { ok: false, error: message, latencyMs }
  }

  const raw = body as { model?: unknown; answers: unknown; usage?: { input_tokens?: unknown } }
  const answers: Record<string, Answer> = {}

  if (typeof raw.answers === 'object' && raw.answers !== null) {
    for (const [id, a] of Object.entries(raw.answers as Record<string, unknown>)) {
      if (typeof a === 'object' && a !== null) {
        const v = a as Record<string, unknown>
        answers[id] = {
          type: typeof v.type === 'string' ? v.type : 'unknown',
          ...(typeof v.choice === 'string' && { choice: v.choice }),
          ...(typeof v.confidence === 'number' && { confidence: v.confidence }),
          ...(typeof v.noul === 'number' && { noul: v.noul }),
          // The Vercel gateway spells noul `boolean`.
          ...(typeof v.boolean === 'number' && { noul: v.boolean }),
          ...(typeof v.probabilities === 'object' && v.probabilities !== null && { probabilities: v.probabilities as Record<string, number> }),
        }
      }
    }
  }

  return {
    ok: true,
    model: typeof raw.model === 'string' ? raw.model : 'unknown',
    answers,
    latencyMs,
    inputTokens: typeof raw.usage?.input_tokens === 'number' ? raw.usage.input_tokens : 0,
  }
}

/** Asks the configured backend; never rejects, a timeout or failure comes back as `ok: false`. */
export async function ask(host: Host, s: Settings, state: unknown, questions: Record<string, Question>, timeoutMs: number): Promise<JevReply> {
  const endpoint = endpointOf(s)
  const started = await host.now()

  if ('error' in endpoint) {
    return { ok: false, error: endpoint.error, latencyMs: 0 }
  }

  const request = host
    .fetch(endpoint.url, { method: 'POST', headers: endpoint.headers, body: JSON.stringify({ state, model: endpoint.model, questions }) })
    .then(async r => {
      const latencyMs = (await host.now()) - started

      return r.ok ? parseReply(r.text, latencyMs) : ({ ok: false, error: `HTTP ${r.status}: ${r.text.slice(0, 160)}`, latencyMs } as JevReply)
    })
    .catch(async (error: unknown): Promise<JevReply> => ({ ok: false, error: String(error).slice(0, 160), latencyMs: (await host.now()) - started }))

  const timeout = host.sleep(timeoutMs).then((): JevReply => ({ ok: false, error: `no answer within ${timeoutMs}ms`, latencyMs: timeoutMs }))
  const reply = await Promise.race([request, timeout])

  return reply.ok ? reply : { ...reply, error: redact(reply.error, [s.typesafeApiKey, s.openrouterApiKey]) }
}

/** A one-question probe for the Setup tab's connection test. */
export function probe(host: Host, s: Settings): Promise<JevReply> {
  return ask(
    host,
    s,
    'A developer asks a coding assistant to rename one variable in a single file.',
    { size: { type: 'choice', instructions: 'How large is this task?', criteria: { small: 'minutes of work', large: 'hours of work' } } },
    s.backend === 'kev-local' ? 20_000 : 8_000,
  )
}
