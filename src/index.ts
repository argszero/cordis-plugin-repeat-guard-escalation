/**
 * `repeat-guard-escalation`: give the shipped `repeat-tool-reminder` guard teeth.
 *
 * The shipped guard detects identical consecutive tool calls and injects an
 * advisory reminder. It does not enforce anything, and its own README records
 * that as a known limitation ("escalating to a blocking form at a high
 * threshold is not implemented"). Discussion #6370 is the field evidence: the
 * reminder fires three times, the model keeps issuing the same call, and the
 * loop only ends when the user intervenes.
 *
 * This plugin adds the enforcement tier. It counts the same chains the shipped
 * guard counts and, once a call has been repeated `escalateAt` times, **denies
 * it before dispatch** so the repeated action cannot execute again. The model
 * receives corrective text that says what to do instead, and the loop loses its
 * fuel: the repeated call no longer produces a result to react to.
 *
 * Design constraints, in priority order:
 *
 * - **Never trap the session.** Enforcement is bounded by `maxDenials`; after
 *   that the guard steps aside permanently for that chain and calls proceed.
 *   Denying forever would turn a stuck model into a dead session.
 * - **Never deny a call that is not a repeat.** The chain advances on every
 *   tracked attempt, and only an exact repeat — same tool, same canonical
 *   arguments — can reach the threshold. A different call clears the chain.
 * - **Never explain nothing.** The denial names the tool and the count and
 *   gives a concrete alternative; a bare refusal invites the next loop.
 * - **Never break the pipeline.** The listener is total: any internal error is
 *   logged and the call is allowed, because a broken guard must not become a
 *   broken tool.
 *
 * Ordering note: this listener counts at `tools/pre-execute`, the only seam
 * that can stop dispatch. A denied call therefore never reaches
 * `tools/post-execute`, which is why the chain is owned here rather than
 * shared with the reminder plugin.
 *
 * @module @argszero/cordis-plugin-repeat-guard-escalation
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { advance, chainKey, decide, recordDenial } from './escalate.js'
import type { Chain } from './escalate.js'

export const name = 'repeat-guard-escalation'

/** The tool pipeline this rule gates. */
export const inject = ['tools']

/** Configures when a repeated call is denied and for how long. */
export interface Config {
  /**
   * Consecutive identical attempts at which the call is denied before dispatch.
   * Defaults to 9 — deliberately above the shipped guard's highest reminder
   * threshold (8), so every escalation is preceded by the reminder at 8 having
   * been ignored. Raising it weakens the guard; lowering it denies calls the
   * reminder never had a chance to fix.
   */
  escalateAt?: number
  /**
   * How many times one chain may be denied before the guard steps aside.
   * Defaults to 3. Bounded on purpose: an unbounded block makes a looping
   * session unfinishable, which is worse than the loop.
   */
  maxDenials?: number
  /** Tool-name wildcard patterns to track; empty means every tool. */
  include?: string[]
  /** Tool-name wildcard patterns never tracked (they neither count nor reset). */
  exclude?: string[]
}

/** Compile one `*`-wildcard pattern to an anchored RegExp; all else is literal. */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, String.raw`\$&`)
  return new RegExp(`^${escaped.replaceAll('*', '.*')}$`)
}

/**
 * Validate a count-like option fail-loud, so a typo cannot silently disable or
 * over-apply the guard — the package's contract is that misconfiguration is
 * reported at load, never swallowed.
 * @param label - the option name, for the message.
 * @param value - the resolved value.
 * @param minimum - the smallest legal value.
 * @returns the value, once validated.
 */
function positiveInteger(label: string, value: number | undefined, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new Error(`repeat-guard-escalation: \`${label}\` must be an integer >= ${minimum} (got ${String(value)})`)
  }
  return value as number
}

/**
 * Install the guard.
 * @param ctx - context carrying the tool pipeline.
 * @param config - resolved options.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const escalateAt = positiveInteger('escalateAt', config.escalateAt ?? 9, 2)
  const maxDenials = positiveInteger('maxDenials', config.maxDenials ?? 3, 1)
  const policy = { escalateAt, maxDenials }
  const includePatterns = (config.include ?? []).map(wildcardToRegExp)
  const excludePatterns = (config.exclude ?? []).map(wildcardToRegExp)

  /** One chain per agent; a WeakMap keeps a finished agent's state collectable. */
  const chains = new WeakMap<Agent, Chain>()

  /** Whether a tool participates; untracked calls are transparent (neither count nor reset). */
  function tracked(toolName: string): boolean {
    if (includePatterns.length > 0 && !includePatterns.some(pattern => pattern.test(toolName))) return false
    return !excludePatterns.some(pattern => pattern.test(toolName))
  }

  ctx.on('tools/pre-execute', (exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision> => {
    try {
      // A direct `ctx.tools.execute()` caller has no model to correct and no
      // agent to key on; only agent-loop calls participate (same rule as the
      // shipped reminder guard).
      if (exec.agent === undefined || !tracked(exec.name)) return next()

      const key = chainKey(exec.name, exec.arguments)
      const chain = advance(chains.get(exec.agent), key)
      const denial = decide(chain, policy)
      if (denial === undefined) {
        chains.set(exec.agent, chain)
        return next()
      }
      // Spend the denial before delegating: the budget must advance even if a
      // downstream listener turns this deny into something else.
      chains.set(exec.agent, recordDenial(chain))
      return Promise.resolve({ kind: 'deny', reason: denial })
    } catch (error: unknown) {
      // A broken guard must not become a broken tool.
      ctx.logger.warn(`repeat-guard-escalation: call allowed after internal error: ${String(error)}`)
      return next()
    }
  })

  // A user interjection changes the context; repetition across it is not a
  // loop. Pure reset hook: attaches nothing, vetoes nothing.
  ctx.on('agent/pre-step', ({ agent, messages }, next): Promise<PreStepDecision> => {
    if (messages.some(message => message.source.kind === 'user')) chains.delete(agent)
    return next()
  })
}
