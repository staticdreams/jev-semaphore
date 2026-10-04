/**
 * What the library files need from the engine. `$` itself never leaves register.tsx (the validator
 * follows it only within that file), so register.tsx builds one of these from it.
 */

import type { HttpInit, HttpResponse, ProcessRunInit, ProcessRunResult, ToolSpec, UiBlitArgs, UiBlitResult } from 'claude-code'

export type Timer = { cancel: () => void }

export type Host = {
  now: () => Promise<number>
  sleep: (ms: number) => Promise<void>
  every: (ms: number, fn: () => void) => Timer
  fetch: (url: string, init?: HttpInit) => Promise<HttpResponse>
  run: (argv: readonly string[], init?: ProcessRunInit) => Promise<ProcessRunResult>
  /** Whether a path exists (relative paths are under the session's directory). */
  exists: (path: string) => Promise<boolean>
  home: () => Promise<string>
  registerTool: (spec: Required<ToolSpec>) => Promise<unknown>
  blit: (args: UiBlitArgs) => Promise<UiBlitResult>
  debug: (text: string) => void
}
