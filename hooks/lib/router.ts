/**
 * Turns a subagent spawn into a decision: which role it plays and which model runs it.
 *
 * Two signals are shown side by side, as in the pane: `score` is this mod's transparent feature fit
 * (capability, cost, latency, context weighted per role) and `p` is Jev's probability for that option.
 * The pick is the best blend of the two; a downgrade below the current model needs p >= the floor.
 */

import type { Candidate, Decision, DecisionSource } from '../../types'
import { ANTHROPIC, describe, labelOf, type Model, modelFor } from './catalog'
import type { Answer, JevReply, Question } from './jev-client'
import { ROLE_BLURB, ROLES } from './theme'

type Weights = { capability: number; cost: number; latency: number; context: number }

const WEIGHTS: Record<string, Weights> = {
  orchestrator: { capability: 0.6, cost: 0.1, latency: 0.1, context: 0.2 },
  builder: { capability: 0.35, cost: 0.35, latency: 0.2, context: 0.1 },
  implementer: { capability: 0.5, cost: 0.25, latency: 0.15, context: 0.1 },
  executor: { capability: 0.15, cost: 0.45, latency: 0.35, context: 0.05 },
  iterator: { capability: 0.3, cost: 0.35, latency: 0.3, context: 0.05 },
  reviewer: { capability: 0.6, cost: 0.15, latency: 0.1, context: 0.15 },
  artist: { capability: 0.2, cost: 0.45, latency: 0.3, context: 0.05 },
}

/** What each role runs on when nothing else decides. */
export const DEFAULT_MODEL: Record<string, string> = {
  orchestrator: 'opus-5.5',
  builder: 'sonnet-5.5',
  implementer: 'sonnet-5.5',
  executor: 'haiku-4.5',
  iterator: 'haiku-4.5',
  reviewer: 'sonnet-5.5',
  artist: 'haiku-4.5',
}

const MAX_OUT = Math.log(1 + Math.max(...ANTHROPIC.map(m => m.outputUsd ?? 0)))

export function featureScore(m: Model, role: string): number {
  const w = WEIGHTS[role] ?? WEIGHTS.implementer!
  const cost = 1 - Math.log(1 + (m.outputUsd ?? 20)) / MAX_OUT
  const context = m.contextK === null ? 0.5 : Math.min(1, m.contextK / 1000)

  return w.capability * m.capability + w.cost * cost + w.latency * (1 - m.latency) + w.context * context
}

/** Roles by keyword, for a spawn that is not one of ours and when Jev is not there to ask. */
export function guessRole(text: string): string {
  const t = text.toLowerCase()

  if (/\b(image|logo|icon|illustrat|artwork|picture|banner|mockup png)\b/.test(t)) return 'artist'
  if (/\b(review|audit|second opinion|critique)\b/.test(t)) return 'reviewer'
  if (/\b(plan|orchestrat|break down|architect|design the)\b/.test(t)) return 'orchestrator'
  if (/\b(run|test|type-?check|lint|build|execute|tsc|npm|bun)\b/.test(t)) return 'executor'
  if (/\b(fix|failing|retry|repair|flaky)\b/.test(t)) return 'iterator'
  if (/\b(scaffold|boilerplate|stub|route|skeleton|setup)\b/.test(t)) return 'builder'

  return 'implementer'
}

export type RouteInput = {
  /** The role when the spawn named one of ours; null to have Jev (or keywords) decide. */
  role: string | null
  description: string
  prompt: string
  parentModel: string
  /** The model the spawn would run on with no routing, as a catalog label. */
  current: string
  budgetLeftUsd: number | null
  history: readonly string[]
  canOffload: boolean
}

export function questionsFor(input: RouteInput): Record<string, Question> {
  const questions: Record<string, Question> = {
    model: {
      type: 'choice',
      instructions:
        'Pick the model that should run this subagent task: the cheapest and fastest model that will still do it well. ' +
        'Reserve the strongest models for planning, hard reasoning and risky changes.',
      criteria: Object.fromEntries(ANTHROPIC.map(m => [m.label, describe(m)])),
    },
    risky: {
      type: 'noul',
      instructions: 'Could a mistake in this task cause security problems, data loss or a broken build that is hard to notice?',
    },
  }

  if (input.role === null) {
    questions.role = {
      type: 'choice',
      instructions: 'Which role does this subagent task play in the larger job?',
      criteria: Object.fromEntries(ROLES.map(r => [r, ROLE_BLURB[r] ?? null])),
    }
  }

  if (input.canOffload) {
    questions.offload = {
      type: 'noul',
      instructions: 'Is most of this task bulk code generation (boilerplate, fixtures, repetitive edits) that a cheaper non-Claude model could draft for review?',
    }
  }

  return questions
}

export function stateFor(input: RouteInput): Record<string, unknown> {
  return {
    task: input.description,
    instructions: input.prompt.slice(0, 6000),
    parent_model: labelOf(input.parentModel),
    default_model: input.current,
    ...(input.budgetLeftUsd !== null && { budget_left_usd: Number(input.budgetLeftUsd.toFixed(2)) }),
    ...(input.history.length > 0 && { recent_outcomes: input.history.slice(-6) }),
  }
}

// An unknown or unpriced model ranks as the most expensive, so moving off it still has to clear the floor.
const priceRank = (label: string): number => modelFor(label)?.outputUsd ?? Number.POSITIVE_INFINITY

export type Routed = { decision: Omit<Decision, 'id' | 'at' | 'task'>; alias: string | undefined; offload: boolean }

/** Ranks the catalog for a role from Jev's answers (or features alone) and applies floor, risk and pin. */
export function route(input: RouteInput, reply: JevReply | null, opts: { floor: number; pin: string | undefined; isApplied: boolean; source: DecisionSource }): Routed {
  const answers: Record<string, Answer> = reply?.ok === true ? reply.answers : {}
  const roleAnswer = answers.role?.choice
  const role = input.role ?? (roleAnswer !== undefined && ROLES.includes(roleAnswer) ? roleAnswer : guessRole(`${input.description} ${input.prompt.slice(0, 600)}`))
  const probabilities = answers.model?.probabilities
  const scores = ANTHROPIC.map(m => featureScore(m, role))
  const hi = Math.max(...scores)
  const lo = Math.min(...scores)

  // Without Jev, p is a softmax over the feature scores, so the bars still mean "how sure".
  const soft = ANTHROPIC.map((_, i) => Math.exp(((scores[i] ?? 0) - hi) * 12))
  const softSum = soft.reduce((a, b) => a + b, 0)

  // Jev's probabilities are only used when they are finite numbers; anything else falls back to the softmax.
  const jevP = (label: string): number | undefined => {
    const v = probabilities?.[label]

    return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined
  }
  const usesJev = ANTHROPIC.some(m => jevP(m.label) !== undefined)
  // Raw values decide the guards; the rounded ones are only for display (0.596 must not pass a 0.60 floor).
  const rawP = new Map(ANTHROPIC.map((m, i) => [m.label, jevP(m.label) ?? (usesJev ? 0 : (soft[i] ?? 0) / softSum)]))

  const candidates: Candidate[] = ANTHROPIC.map((m, i) => ({
    model: m.label,
    score: Number((0.55 + 0.4 * (hi === lo ? 1 : ((scores[i] ?? 0) - lo) / (hi - lo))).toFixed(2)),
    p: Number((rawP.get(m.label) ?? 0).toFixed(2)),
  })).sort((a, b) => b.score * 0.5 + (rawP.get(b.model) ?? 0) * 0.5 - (a.score * 0.5 + (rawP.get(a.model) ?? 0) * 0.5))

  const top = candidates[0]!
  const topP = rawP.get(top.model) ?? 0
  const riskyRaw = answers.risky?.noul
  const risky = typeof riskyRaw === 'number' && Number.isFinite(riskyRaw) ? Math.min(1, Math.max(0, riskyRaw)) : null
  const isHeuristic = reply === null || !reply.ok || !usesJev
  let applied = top.model
  let note = reply === null ? 'heuristic · feature fit' : !reply.ok ? `heuristic · ${reply.error}` : usesJev ? 'host validated' : 'heuristic · Jev sent no usable probabilities'

  if (priceRank(top.model) < priceRank(input.current) && topP < opts.floor) {
    applied = input.current
    note = `${isHeuristic ? 'heuristic · ' : ''}kept ${input.current}: p ${topP.toFixed(3)} < floor ${opts.floor.toFixed(2)}`
  }

  if (risky !== null && risky >= 0.7 && (modelFor(applied)?.capability ?? 1) < 0.75) {
    applied = 'sonnet-5.5'
    note = `raised to sonnet-5.5: risky ${risky.toFixed(2)}`
  }

  if (opts.pin !== undefined) {
    applied = opts.pin
    note = `pinned to ${opts.pin}`
  }

  if (!opts.isApplied) {
    note = `recommend only · ran ${input.current}`
  }

  const ranOn = opts.isApplied ? applied : input.current

  return {
    decision: {
      role,
      picked: top.model,
      applied: ranOn,
      candidates: candidates.slice(0, 4),
      source: opts.pin !== undefined ? 'pin' : opts.source,
      note,
      latencyMs: reply?.latencyMs ?? 0,
      risky,
    },
    alias: opts.isApplied ? modelFor(ranOn)?.alias : undefined,
    offload: (answers.offload?.noul ?? 0) >= 0.6,
  }
}
