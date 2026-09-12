# @argszero/cordis-plugin-repeat-guard-escalation

Give dsh's `repeat-tool-reminder` guard **teeth**.

`dsh` plugin (bundle patch). When a model repeats an identical tool call past
the advisory thresholds and ignores the reminder, this plugin **denies the call
before dispatch**, so the repeated action cannot execute again. A call that is
repeated *and failing* is denied much earlier (`escalateFailingAt`, default 3),
because retrying unchanged arguments against a deterministic error cannot work.

## The problem

The shipped `@deepseek-ai/dsh-repeat-tool-reminder` guard does its detection job
correctly: it tracks consecutive identical calls and injects a reminder at 3, 5,
and 8 repeats. But the reminder is **advisory only** — the guard's own README
records this as a known, unimplemented limitation:

> **Advisory only** — escalating to a blocking form at a high threshold is not
> implemented, though `PostToolDecision` already supports blocking.

Discussion [#6370](https://github.com/deepseek-ai/deepseek-harness/discussions/6370)
is the field evidence. With a local OpenAI-compatible provider, the same broad
search repeats well past all three reminders:

```
Grep def test_
Grep def test_
Grep def test_
Context injection repeat-tool-reminder grep × 3
Grep def test_          ← ignored the reminder
...
Context injection repeat-tool-reminder grep × 5
Grep def test_          ← ignored it again
```

A second consequence is easy to miss, and it is in the same README:

> **Past the highest threshold a chain goes silent** — reminders fire only at
> exact configured counts, never beyond them.

So with the default `[3, 5, 8]`, the 9th, 10th, and 11th identical calls draw
**no reminder at all**. The tail of a loop is unguarded — precisely where the
model has proved it is not responding to advice.

## What the plugin does

It counts the same chains the shipped guard counts, and from `escalateAt`
(default **9** — one past the highest reminder threshold) it denies the call
before it is dispatched:

```
Blocked: `grep` has now been called with identical arguments 9 times in a row,
and the reminder you were given did not change the outcome. The results of those
calls are already in this session — do not issue this call again with these
arguments. If the evidence you already have is enough, answer or make the change
now. If it is not, the missing piece is specific: say what it is, then either use
a different tool or narrow the arguments so they target exactly that piece.
Further identical calls will be blocked automatically.
```

**Why deny rather than block.** A `PostToolDecision` block still *runs* the tool
and still burns a full model turn before the model sees a failure, so a
determined loop survives it. A `pre-execute` denial means the call is never
dispatched: the repeated action stops producing a result to react to, which is
what actually breaks the cycle.

The reminder is not replaced. The shipped guard still runs and still explains
itself; this plugin only adds the consequence after advice has been ignored.

## Failing repeats: the second #6370 report

The same discussion reports a variant with a different shape. An `edit` whose
`old_string` and `new_string` were identical failed deterministically —

```
old_string and new_string must differ
```

— and the model re-sent the same failing call many times instead of re-reading
the target or reconstructing the patch. The shipped reminder is **failure-blind**:
it counts calls and never inspects their results, so this case gets the same
gentle advice as a successful poll loop, at the same late thresholds.

A successful repeat may be legitimate (polling a job); a failing repeat with
unchanged arguments is not, because the arguments it keeps sending are the ones
the error is complaining about. So this plugin escalates the two separately:

```
Blocked: `edit` has now been called with identical arguments 4 times in a row,
and the last 3 of them failed with the same error. Repeating it cannot succeed —
the tool is not going to accept these arguments on the next attempt. The failure
was: old_string and new_string must differ. Change the arguments so they no
longer trigger it, or use a different tool. If the change you intended may
already have been applied, read the target back before editing it again.
Further identical calls will be blocked automatically.
```

The error is quoted back verbatim, because the model's next move has to be
against that specific complaint. A success clears the failure streak, so a poll
loop is never escalated early; a changed call resets both.

One deployment note: `escalateFailingAt` counts **observed** failures, so the
default of 3 lets three failing calls through and refuses the fourth. Whether an
in-flight call will fail is not knowable before it runs, and assuming it would be
exactly the false positive this rule exists to avoid.

## Install

```sh
npm install @argszero/cordis-plugin-repeat-guard-escalation
```

The package ships a `dsh.bundle` patch:

```sh
dsh plugin add @argszero/cordis-plugin-repeat-guard-escalation
```

or directly:

```yaml
- insert:
    - id: repeat-guard-escalation
      name: '@argszero/cordis-plugin-repeat-guard-escalation'
```

## Config

| key | default | meaning |
|---|---|---|
| `escalateAt` | `9` | Consecutive identical attempts at which the call is denied before dispatch |
| `escalateFailingAt` | `3` | Identical *failing* attempts observed before the call is denied (the next attempt is refused) |
| `maxDenials` | `3` | How many times one chain may be denied before the guard steps aside |
| `include` | `[]` | Only these tools are tracked; empty means every tool |
| `exclude` | `[]` | Never track these tools (they neither count nor clear a chain) |

```yaml
- set:
    - id: repeat-guard-escalation
      config:
        escalateAt: 9
        escalateFailingAt: 3
        maxDenials: 3
        exclude: ['todo_write']
```

Invalid configuration fails at load with a clear error — a threshold below 2, a
non-integer, or a `maxDenials` below 1 — never a silent change of behaviour.

## Design: bounds and refusals

- **Enforcement is bounded.** After `maxDenials`, the guard steps aside
  permanently for that chain and calls proceed. Denying forever would turn a
  stuck model into a dead session with no way forward — strictly worse than the
  loop it prevents. The final denial says so, so the model knows the block is
  ending.
- **A different call is progress and resets the chain.** Only *consecutive*
  identical calls escalate, matching the shipped guard. A user message clears
  every chain as well.
- **Only exact repeats.** The key is `[toolName, canonicalArguments]` with a
  deep key-sort, so argument property order cannot disguise a repeat — and,
  just as important, a genuinely different call cannot be mistaken for one. A
  false negative costs one missed escalation; this rule is built so a false
  positive is structurally hard.
- **A denial is never counted as a failure.** A denied call still reaches
  `tools/post-execute` (that is a documented property of the seam, not an
  accident), so the plugin tags its own refusals; otherwise it would read its own
  text as the tool's error and escalate against itself.
- **Chains are per agent.** A parent and its subagent repeating the same call
  never combine their counts.
- **Never breaks the pipeline.** The listener is total: any internal error is
  logged and the call is allowed. A broken guard must not become a broken tool.
- **Direct `ctx.tools.execute()` callers are never denied** — there is no model
  to correct and no agent to key on.

## Compatibility

Mounts against the published dsh line `0.1.2-rc.1` and the `0.1.3`/`0.1.5`
lines. It uses only the public `tools/pre-execute`, `tools/post-execute` and
`agent/pre-step` seam signatures and the `ctx.tools` service.

## Source

Discussion [#6370](https://github.com/deepseek-ai/deepseek-harness/discussions/6370).

## License

MIT
