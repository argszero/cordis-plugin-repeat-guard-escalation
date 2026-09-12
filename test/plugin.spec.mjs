import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import toolsPlugin from '@deepseek-ai/dsh-tools'
import systemPromptPlugin from '@deepseek-ai/dsh-system-prompt'

/**
 * Integration: mount the plugin on a REAL Cordis context together with the REAL
 * `dsh-tools` registry and a real tool, then drive repeated calls through the
 * actual `tools/pre-execute` waterfall. This is the only shape that proves two
 * things at once: that the listener is wired to the seam, and that a `deny`
 * decision really stops the tool body from running (`ToolRuntime` short-circuits
 * on a denial reason, so the counter must not move).
 */

/** Counts how many times a tool body actually ran. */
const calls = { n: 0 }

/** A registry-legal tool whose body counts executions. */
function countingFixture(name) {
  return {
    name,
    description: 'integration fixture',
    parameters: { pattern: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      calls.n += 1
      return `ran ${calls.n}`
    },
  }
}

/** A tool whose body always fails the way the second #6370 report describes. */
function failingFixture(name, message) {
  return {
    name,
    description: 'always-failing integration fixture',
    parameters: { pattern: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute() {
      calls.n += 1
      throw new Error(message)
    },
  }
}

const signal = () => new AbortController().signal
const agent = { id: 's1', session: { id: 's1' } }

/**
 * Mount the real registry plus this plugin.
 * @param config - plugin config to forward.
 * @returns the context and the tool name.
 */
async function mount(config = {}) {
  calls.n = 0
  const ctx = new Context()
  ctx.logger = { info() {}, debug() {}, warn() {}, error() {} }
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolsPlugin)
  await ctx.plugin({ name: 'repeat-guard-escalation', apply: c => plugin.apply(c, config) })
  ctx.tools.register(countingFixture('grep'))
  return ctx
}

/** One call through the real pipeline. */
function call(ctx, args, who = agent) {
  return ctx.tools.execute({ name: 'grep', arguments: args, signal: signal(), agent: who })
}

/** Mount a registry whose tool always fails. */
async function mountFailing(config = {}) {
  calls.n = 0
  const ctx = new Context()
  ctx.logger = { info() {}, debug() {}, warn() {}, error() {} }
  await ctx.plugin(systemPromptPlugin)
  await ctx.plugin(toolsPlugin)
  await ctx.plugin({ name: 'repeat-guard-escalation', apply: c => plugin.apply(c, config) })
  ctx.tools.register(failingFixture('edit', 'old_string and new_string must differ'))
  return ctx
}

/** One call of the failing tool through the real pipeline. */
function callFailing(ctx, args, who = agent) {
  return ctx.tools.execute({ name: 'edit', arguments: args, signal: signal(), agent: who })
}

test('exposes the documented plugin surface', () => {
  assert.equal(plugin.name, 'repeat-guard-escalation')
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['tools'])
})

test('below the threshold every call really executes', async () => {
  const ctx = await mount({ escalateAt: 3, maxDenials: 2 })
  for (let i = 0; i < 2; i += 1) {
    const r = await call(ctx, { pattern: 'def test_' })
    assert.equal(r.isError, false)
  }
  assert.equal(calls.n, 2, 'the first two calls must reach the tool body')
})

test('the escalated call is denied before dispatch, so the body never runs', async () => {
  const ctx = await mount({ escalateAt: 3, maxDenials: 2 })
  await call(ctx, { pattern: 'def test_' })
  await call(ctx, { pattern: 'def test_' })
  const third = await call(ctx, { pattern: 'def test_' })
  assert.equal(third.isError, true)
  assert.equal(calls.n, 2, 'the denied call must NOT have executed')
  const text = third.content.map(b => b.text).join('\n')
  assert.match(text, /Blocked/)
  assert.match(text, /`grep`/)
  assert.match(text, /3 times/)
})

test('a different call is progress and resets the chain', async () => {
  const ctx = await mount({ escalateAt: 3, maxDenials: 2 })
  await call(ctx, { pattern: 'a' })
  await call(ctx, { pattern: 'a' })
  // A different argument is not a repeat, so the chain restarts.
  const other = await call(ctx, { pattern: 'b' })
  assert.equal(other.isError, false)
  // Two more identical calls: still below three consecutive.
  await call(ctx, { pattern: 'b' })
  assert.equal(calls.n, 4)
  const third = await call(ctx, { pattern: 'b' })
  assert.equal(third.isError, true)
  assert.equal(calls.n, 4)
})

test('the denial budget is bounded and then calls proceed again', async () => {
  const ctx = await mount({ escalateAt: 2, maxDenials: 2 })
  const first = await call(ctx, { pattern: 'x' })
  assert.equal(first.isError, false)
  // Denials 1 and 2 are granted...
  for (let i = 0; i < 2; i += 1) {
    const denied = await call(ctx, { pattern: 'x' })
    assert.equal(denied.isError, true, `denial ${i + 1} must be enforced`)
  }
  const ranBefore = calls.n
  // ...and the third identical attempt is allowed through, because the guard
  // must never make a session unfinishable.
  const allowed = await call(ctx, { pattern: 'x' })
  assert.equal(allowed.isError, false, 'past the budget the call must proceed')
  assert.equal(calls.n, ranBefore + 1)
})

test('the final denial says so, so the model knows the block is ending', async () => {
  const ctx = await mount({ escalateAt: 2, maxDenials: 2 })
  await call(ctx, { pattern: 'x' })
  await call(ctx, { pattern: 'x' })
  const last = await call(ctx, { pattern: 'x' })
  const text = last.content.map(b => b.text).join('\n')
  assert.match(text, /final automatic block/)
})

test('another agent has its own chain', async () => {
  const ctx = await mount({ escalateAt: 2, maxDenials: 1 })
  await call(ctx, { pattern: 'x' }, { id: 'a1', session: { id: 'a1' } })
  // A second agent's first call is not a repeat of the first agent's.
  const other = await call(ctx, { pattern: 'x' }, { id: 'a2', session: { id: 'a2' } })
  assert.equal(other.isError, false)
  assert.equal(calls.n, 2)
})

test('a call without an agent is never denied', async () => {
  const ctx = await mount({ escalateAt: 2, maxDenials: 1 })
  // Direct execute() callers have no model to correct and no key to chain on.
  for (let i = 0; i < 4; i += 1) {
    const r = await ctx.tools.execute({ name: 'grep', arguments: { pattern: 'x' }, signal: signal() })
    assert.equal(r.isError, false)
  }
  assert.equal(calls.n, 4)
})

test('excluded tools are transparent and are never denied', async () => {
  const ctx = await mount({ escalateAt: 2, maxDenials: 1, exclude: ['grep'] })
  for (let i = 0; i < 5; i += 1) {
    const r = await call(ctx, { pattern: 'x' })
    assert.equal(r.isError, false)
  }
  assert.equal(calls.n, 5)
})

test('an include list narrows tracking to the named patterns', async () => {
  const ctx = await mount({ escalateAt: 2, maxDenials: 1, include: ['other_*'] })
  for (let i = 0; i < 4; i += 1) {
    const r = await call(ctx, { pattern: 'x' })
    assert.equal(r.isError, false, 'grep is not in include, so it is never tracked')
  }
  assert.equal(calls.n, 4)
})

test('invalid configuration fails loud instead of silently disabling the guard', () => {
  const ctxStub = { logger: { info() {}, debug() {}, warn() {}, error() {} } }
  for (const bad of [{ escalateAt: 1 }, { escalateAt: 2.5 }, { escalateAt: 'x' }, { maxDenials: 0 }]) {
    assert.throws(() => plugin.apply(ctxStub, bad), /repeat-guard-escalation/)
  }
})

test('a deterministic failure is denied far earlier than a successful repeat', async () => {
  // The second #6370 report: identical failing Edit calls retried many times.
  const ctx = await mountFailing({ escalateFailingAt: 3, escalateAt: 9, maxDenials: 1 })
  // Three failures are observed; the fourth attempt is refused before dispatch.
  for (let i = 0; i < 3; i += 1) {
    const r = await callFailing(ctx, { pattern: 'x' })
    assert.equal(r.isError, true, 'the tool really failed')
    assert.match(r.content.map(b => b.text).join('\n'), /must differ/, 'a real failure reaches the model')
  }
  assert.equal(calls.n, 3)
  const third = await callFailing(ctx, { pattern: 'x' })
  assert.equal(third.isError, true)
  assert.equal(calls.n, 3, 'the denied call must not have executed')
  const text = third.content.map(b => b.text).join('\n')
  assert.match(text, /Blocked/)
  assert.match(text, /`edit`/)
  assert.match(text, /the last 3 of them failed/)
  assert.match(text, /old_string and new_string must differ/, 'the error is quoted back')
})

test('the guard never counts its own denial as a tool failure', async () => {
  // The discriminating case needs a second denial: if a denial were counted as
  // a tool failure, the NEXT denial would quote this plugin's own text back to
  // the model as "the failure".
  const ctx = await mountFailing({ escalateFailingAt: 2, escalateAt: 9, maxDenials: 2 })
  await callFailing(ctx, { pattern: 'x' })
  await callFailing(ctx, { pattern: 'x' })
  const firstDenial = await callFailing(ctx, { pattern: 'x' })
  assert.match(firstDenial.content.map(b => b.text).join('\n'), /The failure was: old_string and new_string must differ/)
  assert.equal(calls.n, 2, 'the first denial must not reach the body')
  // The second denial is the one that reveals self-feeding.
  const secondDenial = await callFailing(ctx, { pattern: 'x' })
  const text = secondDenial.content.map(b => b.text).join('\n')
  assert.equal(secondDenial.isError, true)
  assert.equal(calls.n, 2, 'the second denial must not reach the body either')
  assert.match(text, /The failure was: old_string and new_string must differ/,
    'the second denial must still quote the TOOL error')
  assert.doesNotMatch(text, /The failure was: Blocked/,
    'the guard must never quote its own denial back as the tool failure')
})

test('a failing chain resets when the call finally changes', async () => {
  const ctx = await mountFailing({ escalateFailingAt: 3, escalateAt: 9, maxDenials: 2 })
  await callFailing(ctx, { pattern: 'x' })
  await callFailing(ctx, { pattern: 'x' })
  // A different argument is a new attempt, not a repeat of the failing one:
  // without the reset the third identical call would have been denied instead.
  const other = await callFailing(ctx, { pattern: 'y' })
  assert.equal(other.isError, true, 'the tool still fails')
  assert.equal(calls.n, 3, 'a changed call must reach the body instead of being denied')
  const still = await callFailing(ctx, { pattern: 'x' })
  assert.equal(still.isError, true, 'x is back to one failing attempt, not three')
  assert.equal(calls.n, 4)
})

test('successful repeats still get the slow, advice-first threshold', async () => {
  const ctx = await mount({ escalateFailingAt: 3, escalateAt: 4, maxDenials: 1 })
  for (let i = 0; i < 3; i += 1) {
    const r = await call(ctx, { pattern: 'a' })
    assert.equal(r.isError, false, 'a successful poll loop is not a failure loop')
  }
  assert.equal(calls.n, 3)
  const fourth = await call(ctx, { pattern: 'a' })
  assert.equal(fourth.isError, true)
  assert.equal(calls.n, 3)
  assert.match(fourth.content.map(b => b.text).join('\n'), /identical arguments 4 times/)
})
