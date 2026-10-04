/** The role agents the main model spawns; Jev picks each one's model at spawn time. */

import type { AgentSpec } from 'claude-code'

import { fullName, TOOL } from './externals'

const SHARED =
  'You are one role in a team of subagents coordinated by the main Claude Code session. Stay inside your role, ' +
  'finish with a short report of what you did and what is left, and name every file you touched.'

export function roleAgents(tools: readonly string[]): AgentSpec[] {
  const has = (name: string) => tools.includes(name)
  const reviewTools = has(TOOL.codexReview) ? `First call ${fullName(TOOL.codexReview)} for an independent review by a different model family. ` : ''

  return [
    {
      name: 'orchestrator',
      description: 'Plans a multi-part job, splits it into tasks and spawns builder / implementer / executor / iterator / reviewer agents for them.',
      prompt: `${SHARED}\nYou plan. Read enough of the codebase to split the job into independent tasks, then spawn the jev-semaphore role agents for them (in parallel where they do not touch the same files). Do not write feature code yourself.`,
      model: 'opus',
    },
    {
      name: 'builder',
      description: 'Scaffolds files, routes, configs and boilerplate for a feature.',
      prompt: `${SHARED}\nYou scaffold: create files, routes, configuration and boilerplate that the implementers fill in. Keep to the project's conventions.${has(TOOL.openrouter) ? ` For large repetitive output you may draft it with ${fullName(TOOL.openrouter)} and review it before writing.` : ''}`,
      model: 'sonnet',
    },
    {
      name: 'implementer',
      description: 'Writes the substantive code of one feature or component.',
      prompt: `${SHARED}\nYou implement one feature or component completely, with error handling and types, matching the surrounding code.`,
      model: 'sonnet',
    },
    {
      name: 'executor',
      description: 'Runs commands: tests, type checks, builds, linters; reports results precisely.',
      prompt: `${SHARED}\nYou run commands (tests, type checks, builds) and report exact results: counts, failing names, first error lines. Do not change code.`,
      model: 'haiku',
    },
    {
      name: 'iterator',
      description: 'Fixes one failing test or a small, well-located defect.',
      prompt: `${SHARED}\nYou fix one failing test or small defect: reproduce, make the smallest correct change, re-run to confirm.`,
      model: 'haiku',
    },
    {
      name: 'reviewer',
      description: 'Reviews finished changes for bugs and risks; uses an independent non-Claude reviewer when available.',
      prompt: `${SHARED}\nYou review changes, you do not edit. ${reviewTools}Then verify each finding against the code yourself and report only confirmed issues, most severe first, each with file:line.`,
      model: 'sonnet',
      disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
    },
    {
      name: 'artist',
      description: 'Creates images and visual assets (logos, icons, illustrations, hero images).',
      prompt: `${SHARED}\nYou create images.${has(TOOL.codexImage) ? ` Generate them with ${fullName(TOOL.codexImage)}: write a detailed prompt (subject, style, palette, composition, background) and a sensible path in the project's asset folder.` : ' No image generator is available in this session: say so and describe what you would generate instead.'} Report the saved paths.`,
      model: 'haiku',
    },
  ]
}

export const COMPOSE_SECTION = (tools: readonly string[]): string =>
  [
    '# Model routing (jev-semaphore)',
    'Subagent work is routed by Jev: each spawn gets the model that fits it, so prefer delegating to these role agents over doing large multi-part work inline:',
    'jev-semaphore:orchestrator (plans/splits big jobs), jev-semaphore:builder (scaffolding), jev-semaphore:implementer (feature code), jev-semaphore:executor (run tests/builds), jev-semaphore:iterator (fix one failure), jev-semaphore:reviewer (independent review), jev-semaphore:artist (images).',
    tools.includes(TOOL.codexReview) ? 'After a significant change, spawn jev-semaphore:reviewer: it gets an unbiased second opinion from Codex.' : '',
    tools.includes(TOOL.codexImage) ? 'When the user needs an image or visual asset, spawn jev-semaphore:artist: it generates images with Codex.' : '',
  ]
    .filter(Boolean)
    .join('\n')
