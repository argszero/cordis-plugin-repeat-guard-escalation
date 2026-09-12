import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  advance, canonicalize, chainKey, decide, escalationText, recordDenial, toolNameOf,
} from '../lib/escalate.js'

const POLICY = { escalateAt: 9, maxDenials: 3 }

/** Drive a chain n times with the same call and return the final chain. */
const run = (key, times, start) => {
  let chain = start
  let denial
  for (let i = 0; i < times; i += 1) {
    chain = advance(chain, key)
    denial = decide(chain, POLICY)
    if (denial !== undefined) chain = recordDenial(chain)
  }
  return { chain, denial }
}

test('canonicalization ignores object key order but not values', () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }))
  assert.notEqual(canonicalize({ a: 1 }), canonicalize({ a: 2 }))
  // Nested objects sort too, so ordering cannot fake a different call.
  assert.equal(canonicalize({ o: { x: 1, y: 2 } }), canonicalize({ o: { y: 2, x: 1 } }))
  // Arrays are order-sensitive: a different order is a different call.
  assert.notEqual(canonicalize([1, 2]), canonicalize([2, 1]))
})

test('the chain key matches only the same tool with the same arguments', () => {
  const a = chainKey('grep', { pattern: 'def test_' })
  assert.equal(a, chainKey('grep', { pattern: 'def test_' }))
  assert.notEqual(a, chainKey('read', { pattern: 'def test_' }))
  assert.notEqual(a, chainKey('grep', { pattern: 'def test' }))
})

test('a different call resets the chain, because it is progress', () => {
  const first = chainKey('grep', { pattern: 'a' })
  const other = chainKey('grep', { pattern: 'b' })
  let chain = advance(undefined, first)
  chain = advance(chain, first)
  assert.equal(chain.count, 2)
  chain = advance(chain, other)
  assert.equal(chain.count, 1, 'an intervening different call must clear the count')
  assert.equal(chain.key, other)
})

test('nothing is denied below the escalation threshold', () => {
  const key = chainKey('grep', { pattern: 'def test_' })
  const { denial, chain } = run(key, 8)
  assert.equal(denial, undefined)
  assert.equal(chain.count, 8)
  assert.equal(chain.denials, 0)
})

test('the ninth identical call is denied, and the count keeps climbing', () => {
  const key = chainKey('grep', { pattern: 'def test_' })
  const ninth = run(key, 9)
  assert.ok(ninth.denial, 'the ninth identical call must be denied')
  assert.match(ninth.denial, /identical arguments 9 times/)
  const tenth = run(key, 1, ninth.chain)
  assert.ok(tenth.denial, 'the tenth must be denied too')
  assert.match(tenth.denial, /identical arguments 10 times/)
})

test('denials are bounded, so a session can always finish', () => {
  const key = chainKey('grep', { pattern: 'def test_' })
  const { chain } = run(key, 9 + POLICY.maxDenials)
  assert.equal(chain.denials, POLICY.maxDenials)
  // The guard now steps aside permanently for this chain.
  assert.equal(decide(advance(chain, key), POLICY), undefined)
  const after = run(key, 5, chain)
  assert.equal(after.denial, undefined, 'past the denial budget the call must be allowed through')
  assert.equal(after.chain.denials, POLICY.maxDenials)
})

test('the denial text names the tool, the count, and a way forward', () => {
  const text = escalationText('grep', 9, false)
  assert.match(text, /`grep`/)
  assert.match(text, /9 times/)
  // It must tell the model what the results are worth, and where to go next.
  assert.match(text, /already in this session/)
  assert.match(text, /different tool|narrow/)
  assert.match(text, /blocked automatically/)
})

test('the final denial announces that the guard is stepping aside', () => {
  const last = escalationText('grep', 11, true)
  assert.match(last, /final automatic block/)
  assert.match(last, /allowed through/)
})

test('a denial is spendable exactly maxDenials times', () => {
  let chain = { key: chainKey('read', { path: 'x' }), count: 9, denials: 0 }
  for (let i = 0; i < POLICY.maxDenials; i += 1) {
    assert.ok(decide(chain, POLICY), `denial ${i + 1} must be granted`)
    chain = recordDenial(chain)
  }
  assert.equal(decide(chain, POLICY), undefined)
})

test('the tool name survives a key that cannot be parsed', () => {
  assert.equal(toolNameOf(chainKey('grep', {})), 'grep')
  assert.equal(toolNameOf('not json'), 'this tool')
  assert.equal(toolNameOf('[]'), 'this tool')
})

test('custom thresholds move the escalation point', () => {
  const key = chainKey('bash', { command: 'ls' })
  const policy = { escalateAt: 3, maxDenials: 1 }
  let chain = advance(undefined, key)
  assert.equal(decide(chain, policy), undefined)
  chain = advance(chain, key)
  assert.equal(decide(chain, policy), undefined)
  chain = advance(chain, key)
  assert.ok(decide(chain, policy), 'the third repeat must deny under escalateAt:3')
})
