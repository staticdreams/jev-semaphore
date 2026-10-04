import { describe, expect, test } from 'claude-code/testing'

import { costOf, labelOf } from '../hooks/lib/catalog'
import { parseReply, redact } from '../hooks/lib/jev-client'
import { guessRole, questionsFor, route, type RouteInput } from '../hooks/lib/router'
import { bar, Grid } from '../hooks/ui/raster'

const INPUT: RouteInput = {
  role: 'executor',
  description: 'run tests',
  prompt: 'Run npm test and report failures.',
  parentModel: 'claude-opus-5-5',
  current: 'haiku-4.5',
  budgetLeftUsd: null,
  history: [],
  canOffload: false,
}

const reply = (probabilities: Record<string, number>, extra: Record<string, unknown> = {}) =>
  parseReply(JSON.stringify({ model: 'jev-1.13.0', answers: { model: { type: 'choice', choice: 'x', probabilities }, ...extra }, usage: { input_tokens: 900 } }), 420)

const FLAT = { 'fable-5.1': 0.05, 'opus-5.5': 0.1, 'sonnet-5.5': 0.15, 'haiku-4.5': 0.7 }

describe('Jev replies', () => {
  test('a well-formed reply parses with its probabilities and usage', () => {
    const r = reply(FLAT)
    expect(r.ok).toBe(true)
    expect(r.ok && r.answers.model?.probabilities?.['haiku-4.5']).toBe(0.7)
    expect(r.ok && r.inputTokens).toBe(900)
  })

  test('an error body and unreadable text come back as failures, never throws', () => {
    expect(parseReply('{"error":{"message":"bad key"}}', 10).ok).toBe(false)
    expect(parseReply('<html>502</html>', 10).ok).toBe(false)
  })

  test('the gateway spelling of noul is read too', () => {
    const r = parseReply(JSON.stringify({ answers: { risky: { type: 'boolean', boolean: 0.9 } } }), 1)
    expect(r.ok && r.answers.risky?.noul).toBe(0.9)
  })
})

describe('routing', () => {
  test('Jev’s confident pick is applied and ranked first', () => {
    const routed = route(INPUT, reply(FLAT), { floor: 0.6, pin: undefined, isApplied: true, source: 'jev' })
    expect(routed.decision.picked).toBe('haiku-4.5')
    expect(routed.alias).toBe('haiku')
    expect(routed.decision.candidates).toHaveLength(4)
  })

  test('a downgrade below the floor keeps the current model, judged on the unrounded p', () => {
    // 0.596 displays as 0.60 but must not clear a 0.60 floor.
    const unsure = { 'fable-5.1': 0.05, 'opus-5.5': 0.15, 'sonnet-5.5': 0.204, 'haiku-4.5': 0.596 }
    const routed = route({ ...INPUT, current: 'sonnet-5.5' }, reply(unsure), { floor: 0.6, pin: undefined, isApplied: true, source: 'jev' })
    expect(routed.decision.picked).toBe('haiku-4.5')
    expect(routed.decision.applied).toBe('sonnet-5.5')
    expect(routed.decision.note).toContain('floor')
  })

  test('moving off an unknown model still has to clear the floor', () => {
    const unsure = { 'fable-5.1': 0.05, 'opus-5.5': 0.15, 'sonnet-5.5': 0.3, 'haiku-4.5': 0.5 }
    const routed = route({ ...INPUT, current: 'claude-opus-4-6' }, reply(unsure), { floor: 0.6, pin: undefined, isApplied: true, source: 'jev' })
    expect(routed.decision.applied).toBe('claude-opus-4-6')
  })

  test('malformed probabilities fall back to the heuristic instead of breaking', () => {
    const bad = parseReply(JSON.stringify({ answers: { model: { type: 'choice', probabilities: { 'haiku-4.5': 'oops', 'opus-5.5': -3 } }, risky: { type: 'noul', noul: 'x' } } }), 5)
    const routed = route(INPUT, bad, { floor: 0.6, pin: undefined, isApplied: true, source: 'jev' })
    expect(routed.decision.candidates.every(c => c.p >= 0 && c.p <= 1)).toBe(true)
    expect(routed.decision.risky).toBeNull()
  })

  test('a risky task is raised to at least sonnet', () => {
    const r = reply(FLAT, { risky: { type: 'noul', noul: 0.92 } })
    const routed = route(INPUT, r, { floor: 0.6, pin: undefined, isApplied: true, source: 'jev' })
    expect(routed.decision.applied).toBe('sonnet-5.5')
  })

  test('a pin wins, and recommend mode never changes the model', () => {
    expect(route(INPUT, reply(FLAT), { floor: 0.6, pin: 'opus-5.5', isApplied: true, source: 'jev' }).alias).toBe('opus')
    const rec = route(INPUT, reply(FLAT), { floor: 0.6, pin: undefined, isApplied: false, source: 'jev' })
    expect(rec.alias).toBeUndefined()
    expect(rec.decision.applied).toBe('haiku-4.5')
  })

  test('with Jev offline the heuristic still ranks, and says so', () => {
    const offline = route({ ...INPUT, role: 'orchestrator', current: 'opus-5.5' }, { ok: false, error: 'no answer within 3500ms', latencyMs: 3500 }, { floor: 0.6, pin: undefined, isApplied: true, source: 'heuristic' })
    expect(offline.decision.note).toContain('heuristic')
    expect(['opus-5.5', 'fable-5.1']).toContain(offline.decision.picked)
  })

  test('the role question is asked only when the spawn is not one of ours', () => {
    expect(questionsFor(INPUT).role).toBeUndefined()
    expect(questionsFor({ ...INPUT, role: null }).role).toBeDefined()
    expect(guessRole('generate a logo image for the landing page')).toBe('artist')
    expect(guessRole('review the auth changes')).toBe('reviewer')
  })
})

describe('catalog and cells', () => {
  test('costs come from list prices; unknown models cost null', () => {
    expect(Math.abs((costOf('claude-sonnet-5-5', 1_000_000, 100_000) ?? 0) - 3) < 1e-9).toBe(true)
    expect(costOf('gpt-something', 1, 1)).toBeNull()
    expect(labelOf('claude-haiku-4-5')).toBe('haiku-4.5')
  })

  test('cache writes are billed, and only exact model versions are priced', () => {
    // 1M Sonnet cache-write tokens at 1.25x the $2 input price.
    expect(Math.abs((costOf('claude-sonnet-5-5', 0, 0, 0, 1_000_000) ?? 0) - 2.5) < 1e-9).toBe(true)
    expect(costOf('claude-opus-4-6', 1, 1)).toBeNull()
    expect(labelOf('claude-opus-5-5[1m]')).toBe('opus-5.5')
  })

  test('secrets are scrubbed from error text', () => {
    const text = redact('401: key ts_test_fake0000ffff rejected (Authorization: Bearer abc.def-123)', ['ts_test_fake0000ffff'])
    expect(text).not.toContain('ts_test_fake0000ffff')
    expect(text).not.toContain('abc.def-123')
    expect(redact('sk-or-v1-0123456789abcdef0123 leaked')).not.toContain('0123456789abcdef')
  })

  test('packed rasters are columns * rows cells of 12 bytes', () => {
    const b64 = bar(10, 0.5, 0xff0000)
    expect(b64.length).toBe(Math.ceil((10 * 12) / 3) * 4)
    const g = new Grid(4, 2)
    g.line(0, 0, 7, 7, 0xffffff)
    expect(g.pack().length).toBe(Math.ceil((8 * 12) / 3) * 4)
  })
})
