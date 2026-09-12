/**
 * The decision rule for `repeat-guard-escalation`, kept free of Cordis and of
 * the tools layer so it is testable as a pure function.
 *
 * The gap (Discussion #6370): the shipped `repeat-tool-reminder` guard detects
 * identical repeats correctly but only ever *advises*. Its own README records
 * this as a known, unimplemented limitation:
 *
 * > **Advisory only** — escalating to a blocking form at a high threshold is
 * > not implemented, though `PostToolDecision` already supports blocking.
 *
 * The reporter's log shows the consequence: the reminder is delivered, the
 * model continues anyway, and the loop repeats twice more. A second, less
 * obvious consequence is in the same README — **past the highest threshold a
 * chain goes silent** — so with the default `[3, 5, 8]` the 9th and 10th
 * identical calls draw no reminder at all and the tail of a loop is unguarded.
 *
 * This rule adds the enforcement tier. It never replaces the reminder: the
 * shipped guard still runs and still explains itself. Escalation happens only
 * after advice has already been delivered and demonstrably ignored.
 *
 * ## Which lever, and why
 *
 * The escalation is applied at `tools/pre-execute`, where a `deny` decision
 * **stops the call from being dispatched at all**: `ToolRuntime` materializes the
 * error result and never reaches the tool body (`tools/src/index.ts:1479-1489`
 * return a `post-result` before the `dispatch` branch). The alternative — a
 * `PostToolDecision` `block` — runs the body *and* buries the failure inside a
 * result the tool already returned, so the repeated action still happens each
 * time and a determined loop survives it. Deny is the only lever that removes
 * the repeated side effect itself.
 *
 * **One correction worth recording, because it changes what is observable:** a
 * denied call does *still* receive `tools/post-execute` (`:1479-1489` hands back
 * a `post-result`, and `:1345` routes every `post-result` through
 * `finalizeScheduledExecution` → `postExecute`, a claim documented at
 * `:420-421` and verified by probe on `0.1.2-rc.1`). That is what makes
 * {@link decide} able to see the outcome of the call it is about to count, and
 * it also means this plugin's own denials are visible to a post-execute
 * listener — so denial results must be recognised and never mistaken for a tool
 * failure. The `exec` object is shared by reference between the two seams,
 * which is what makes that recognition exact rather than heuristic.
 *
 * ## What "identical" means here
 *
 * The chain key is `[toolName, canonicalArguments]`, computed exactly as the
 * shipped guard computes it (deep key-sort, then stringify). Re-implementing it
 * rather than sharing state is deliberate: two independent plugins must not
 * have to agree on an internal API, and the canonicalization is a dozen lines
 * whose only contract is "arguments differing only in property order match".
 * A false negative here costs one missed escalation and is harmless; a false
 * *positive* — blocking a call the model legitimately repeats — is the one
 * outcome this rule must avoid.
 *
 * ## Why the guard steps aside
 *
 * Enforcement is **bounded**: a chain may be denied at most `maxDenials` times,
 * after which the guard goes quiet and lets calls through. An unbounded block
 * would turn a stuck model into a dead session with no way forward — strictly
 * worse than the loop it prevents — and a guard must never be the reason a
 * session cannot finish.
 */

/** The canonical form of a call's arguments: deep key-sort, then stringify. */
export function canonicalize(argumentsValue: unknown): string {
  return JSON.stringify(sortJsonValue(argumentsValue))
}

/** Deep key-sort so object key order cannot make identical calls look distinct. */
function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) sorted[key] = sortJsonValue(record[key])
    return sorted
  }
  return value
}

/** One agent's consecutive-repeat chain. */
export interface Chain {
  /** The identity of the repeated call: `[toolName, canonicalArguments]`. */
  readonly key: string
  /** How many consecutive times this call has been attempted. */
  readonly count: number
  /** How many times this chain has already been denied by this rule. */
  readonly denials: number
  /**
   * How many of those attempts ended in a failure. Reset by any success, and
   * by any different call. This is the evidence that repetition is useless:
   * a reminder can argue "try again differently", but a call already failing
   * deterministically cannot succeed by being issued again unchanged.
   */
  readonly failures: number
  /** The most recent failure message, quoted back in the failure escalation. */
  readonly lastFailure: string | undefined
}

/**
 * The chain key for one call. Identical to the shipped guard's key so both
 * plugins agree on what "the same call" means without sharing state.
 * @param toolName - the tool being called.
 * @param argumentsValue - the call's parsed arguments.
 * @returns the chain key.
 */
export function chainKey(toolName: string, argumentsValue: unknown): string {
  return JSON.stringify([toolName, canonicalize(argumentsValue)])
}

/**
 * The display name of the repeated tool, recovered from a chain key.
 * @param key - a key produced by {@link chainKey}.
 * @returns the tool name, or a neutral phrase if the key is not one of ours.
 */
export function toolNameOf(key: string): string {
  try {
    const parsed: unknown = JSON.parse(key)
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && parsed[0] !== '') return parsed[0]
  } catch {
    // A key this module did not produce; fall through to the neutral phrase.
  }
  return 'this tool'
}

/**
 * Advance a chain for one attempt.
 *
 * A different call replaces the chain outright — this is a *consecutive*
 * detector, matching the shipped guard, so an intervening different call is
 * progress and clears the count. A user message clears it too, but that is the
 * caller's job: it is not visible from the call alone.
 * @param previous - the chain before this attempt, if any.
 * @param key - this attempt's {@link chainKey}.
 * @returns the chain after counting this attempt.
 */
export function advance(previous: Chain | undefined, key: string): Chain {
  if (previous === undefined || previous.key !== key) return { key, count: 1, denials: 0, failures: 0, lastFailure: undefined }
  return { key: previous.key, count: previous.count + 1, denials: previous.denials, failures: previous.failures, lastFailure: previous.lastFailure }
}

/**
 * Apply the observed outcome of the attempt that {@link advance} counted.
 *
 * A success (no failure message) clears the streak — the call is working, so
 * repetition is legitimate and only the ordinary repeat threshold applies. A
 * failure extends it and records the message, which is what allows the
 * escalation to quote the deterministic error back instead of vaguely
 * asserting non-progress.
 * @param chain - the chain after {@link advance}.
 * @param failure - the failure message, or undefined when the attempt succeeded.
 * @returns the chain with the outcome folded in.
 */
export function observeOutcome(chain: Chain, failure: string | undefined): Chain {
  if (failure === undefined) return { ...chain, failures: 0, lastFailure: undefined }
  return { ...chain, failures: chain.failures + 1, lastFailure: failure }
}

/**
 * Whether a `tools/post-execute` result was produced by this plugin's own
 * denial rather than by a tool failure. A denial is not evidence about the
 * tool, so it must never extend the failure streak — counting it would let the
 * guard feed itself and quote its own text back as the tool's error.
 * @param result - a post-execute result.
 * @returns the failure message, or undefined when this is not a tool failure.
 */
export function failureOf(result: Readonly<ToolOutcome>): string | undefined {
  return result.isError ? result.error?.message : undefined
}

/** The minimal shape of a post-execute result this rule reads. */
export interface ToolOutcome {
  readonly isError: boolean
  readonly error?: { readonly message: string } | undefined
}

/** Thresholds and bounds the rule reads; all validated at plugin load. */
export interface EscalationPolicy {
  /** Consecutive identical attempts at which calls are denied before dispatch. */
  readonly escalateAt: number
  /** How many times one chain may be denied before the rule steps aside. */
  readonly maxDenials: number
  /**
   * Failing identical attempts at which calls are denied before dispatch.
   * Defaults to 3. Deliberately far below `escalateAt`: a deterministic failure
   * needs no grace period, because no amount of repetition changes the
   * arguments the error is complaining about.
   *
   * Unlike `escalateAt`, this counts *observed* failures — a call is denied
   * once the threshold number of identical failures has actually happened, so
   * the default of 3 lets three failing calls through and blocks the fourth.
   * The asymmetry is unavoidable: whether the in-flight attempt will fail is
   * not known before it runs, and assuming it would is exactly the false
   * positive this rule must avoid.
   */
  readonly escalateFailingAt: number
}

/** The corrective text shown in place of a denied call. */
export function escalationText(toolName: string, count: number, lastDenial: boolean): string {
  const head =
    `Blocked: \`${toolName}\` has now been called with identical arguments ${count} times in a row, `
    + 'and the reminder you were given did not change the outcome. The results of those calls are '
    + 'already in this session — do not issue this call again with these arguments.'
  const what =
    ' If the evidence you already have is enough, answer or make the change now. If it is not, the '
    + 'missing piece is specific: say what it is, then either use a different tool or narrow the '
    + 'arguments so they target exactly that piece.'
  const tail = lastDenial
    ? ' This was the final automatic block for this call; repeating it again will be allowed through.'
    : ' Further identical calls will be blocked automatically.'
  return head + what + tail
}

/**
 * The corrective text for a *failing* repeat. Different from
 * {@link escalationText} on purpose: the argument here is not "you already have
 * the evidence", it is "the error is deterministic and your arguments are what
 * it is complaining about", so the only move that can work is changing them.
 * @param toolName - the tool being called.
 * @param count - how many consecutive identical attempts were observed.
 * @param failures - how many of them failed.
 * @param message - the most recent failure message, quoted back verbatim.
 * @param lastDenial - whether this is the final denial the budget allows.
 * @returns the corrective text.
 */
export function failureEscalationText(
  toolName: string,
  count: number,
  failures: number,
  message: string,
  lastDenial: boolean,
): string {
  const head =
    `Blocked: \`${toolName}\` has now been called with identical arguments ${count} times in a row, `
    + `and the last ${failures} of them failed with the same error. Repeating it cannot succeed — `
    + 'the tool is not going to accept these arguments on the next attempt.'
  const quoted = ` The failure was: ${message.trim()}`
  const what =
    ' Change the arguments so they no longer trigger it, or use a different tool. If the change you '
    + 'intended may already have been applied, read the target back before editing it again.'
  const tail = lastDenial
    ? ' This was the final automatic block for this call; repeating it again will be allowed through.'
    : ' Further identical calls will be blocked automatically.'
  return head + quoted + what + tail
}

/**
 * Decide whether this attempt must be escalated.
 * @param chain - the chain after {@link advance}.
 * @param policy - the thresholds and bounds.
 * @returns the denial text, or undefined when the call proceeds untouched.
 */
export function decide(chain: Chain, policy: EscalationPolicy): string | undefined {
  if (chain.denials >= policy.maxDenials) return undefined
  const lastDenial = chain.denials + 1 >= policy.maxDenials
  // A deterministic failure is escalated far earlier: the same error on the
  // same arguments cannot be resolved by issuing them again.
  if (chain.failures >= policy.escalateFailingAt) {
    return failureEscalationText(
      toolNameOf(chain.key), chain.count, chain.failures,
      chain.lastFailure ?? 'the last attempt failed', lastDenial,
    )
  }
  if (chain.count < policy.escalateAt) return undefined
  return escalationText(toolNameOf(chain.key), chain.count, lastDenial)
}

/**
 * Record that a denial was applied, so the budget can bound it.
 * @param chain - the chain that was denied.
 * @returns the chain with one more denial spent.
 */
export function recordDenial(chain: Chain): Chain {
  return { ...chain, denials: chain.denials + 1 }
}
