import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, RemoteHosts, type CliResult } from './remote'

const ok = (result: unknown): CliResult => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })
const fail = (code: string, message: string, data?: unknown): CliResult => ({ code: 1, stdout: JSON.stringify({ ok: false, error: { code, message, data } }), stderr: '' })

const run = (id: string, state = 'running') => ({ id, host: null, hostName: null, workflow: 'wf', state, startedAt: 1, runs: [] })

function hostsWith(answers: (args: string[]) => CliResult, wanted = 'auto') {
  const calls: string[][] = []
  let changes = 0
  const remote = new RemoteHosts({
    run: async (args) => {
      calls.push(args)
      return answers(args)
    },
    pluginKey: () => 'local.odw-watch',
    wanted: () => wanted,
    onChange: () => changes++,
  })
  return { remote, calls, changes: () => changes }
}

test('every saved server is asked for its own runs only, by id, over --environment', async () => {
  const { remote, calls, changes } = hostsWith((args) => {
    if (args[0] === 'environment') return ok({ environments: [{ id: 'env-mini', name: 'Mac mini' }, { id: 'env-pc', name: 'Studio PC' }] })
    const env = args[args.indexOf('--environment') + 1]
    if (env === 'env-mini') return ok({ pluginKey: 'local.odw-watch', name: 'watch.snapshot', result: { runs: [run('r1')], hosts: [], root: '~/.odw/runs' } })
    return fail('runtime_unreachable', 'could not connect to Studio PC')
  })
  await remote.tick(1_000_000)
  const asked = calls.filter((c) => c[0] === 'plugin')
  assert.equal(asked.length, 2)
  for (const args of asked) {
    assert.deepEqual(args.slice(0, 5), ['plugin', 'dev', 'request', 'local.odw-watch', 'watch.snapshot'])
    assert.equal(args[args.indexOf('--data') + 1], '{"localOnly":true}', 'a server never relays its own paired servers back')
  }
  const states = Object.fromEntries(remote.hosts().map((h) => [h.name, h.state]))
  assert.deepEqual(states, { 'Mac mini': 'ok', 'Studio PC': 'offline' })
  const [only] = remote.snapshots()
  assert.equal(only.env.name, 'Mac mini')
  assert.equal(only.snapshot.runs[0].id, 'r1')
  assert.ok(changes() > 0)
})

test('a server that answers without the plugin says so, and backs off', async () => {
  const { remote, calls } = hostsWith((args) =>
    args[0] === 'environment'
      ? ok({ environments: [{ id: 'e1', name: 'Box' }] })
      : fail('plugin_request_failed', 'local.odw-watch is not loaded on this Orca', { requestCode: 'unavailable' }),
  )
  await remote.tick(1_000_000)
  assert.equal(remote.hosts()[0].state, 'no-plugin')
  const before = calls.length
  await remote.tick(1_000_000) // not due again yet
  assert.equal(calls.length, before)
})

test('the setting picks servers by name or id, and off watches none', async () => {
  const envs = ok({ environments: [{ id: 'a', name: 'Mac mini' }, { id: 'b', name: 'Studio PC' }] })
  const picked = hostsWith((args) => (args[0] === 'environment' ? envs : ok({ result: { runs: [] } })), 'mac mini')
  await picked.remote.tick(1_000_000)
  assert.deepEqual(picked.remote.hosts().map((h) => h.name), ['Mac mini'])
  const off = hostsWith(() => envs, 'off')
  await off.remote.tick(1_000_000)
  assert.equal(off.calls.length, 0)
  assert.deepEqual(off.remote.hosts(), [])
})

test('failures are sorted into what the panel can say', () => {
  assert.equal(classify({ error: { code: 'runtime_unreachable', message: 'connect ECONNREFUSED' } }).state, 'offline')
  assert.equal(classify({ error: { code: 'runtime_error', message: 'Plugin service is not available on this runtime' } }).state, 'no-plugin')
  assert.equal(classify({ error: { code: 'plugin_request_failed', message: 'x', data: { requestCode: 'unknown_method' } } }).state, 'no-plugin')
  assert.equal(classify({ error: { code: 'weird', message: 'something else' } }).state, 'error')
})
