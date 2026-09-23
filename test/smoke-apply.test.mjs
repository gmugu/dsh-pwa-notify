/**
 * Throwaway boot smoke for the 0.1.7 migration: apply() against a stub cordis
 * ctx, then drive one `settled` job event through the new
 * jobs.events.subscribe wiring (DSH ≥ 0.1.7 replaced onJobDone). Not part of
 * the shipped suite's guarantees beyond "the wrapper boots and wires".
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate the plugin's state file from the REAL $DSSH_HOME storages.
const smokeHome = mkdtempSync(join(tmpdir(), 'dsh-pwa-notify-smoke-'))
process.env.DSH_HOME = smokeHome
const { apply } = await import('../src/index.js')
test.after(() => rmSync(smokeHome, { recursive: true, force: true }))

function stubCtx() {
  const services = {}
  const ctx = {
    on: () => () => {},
    effect: (fn) => {
      const c = fn()
      return typeof c === 'function' ? c : () => {}
    },
    inject: (names, fn) => {
      if (names.some((n) => !(n in services))) return
      const sub = Object.create(ctx)
      for (const n of names) sub[n] = services[n]
      sub.effect = ctx.effect
      fn(sub)
    },
  }
  return { ctx, services }
}

test('apply boots against 0.1.7-shaped services and reacts to a settled job', () => {
  const { ctx, services } = stubCtx()
  let jobListener = null
  services.jobs = {
    events: {
      subscribe: (filter, listener) => {
        assert.deepEqual(filter, { owners: 'all' })
        jobListener = listener
        return () => {}
      },
    },
  }
  services.sessions = {
    get: (id) => (id === 's1' ? { header: { cwd: 'D:/ws/x' } } : undefined),
  }
  services.webServer = {
    register: () => () => {},
    tapIndex: () => () => {},
  }
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(typeof jobListener, 'function', 'jobs.events.subscribe wired')
  // completed job of a known owner must not throw through the new owner->session lookup
  assert.doesNotThrow(() =>
    jobListener({ type: 'settled', job: { id: 'bash-1', label: '构建', status: 'completed', owner: 's1' }, awaited: true }))
  // killed is ignored by policy
  jobListener({ type: 'settled', job: { id: 'bash-2', label: 'x', status: 'killed' }, awaited: false })
})
