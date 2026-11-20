import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, pluginMissing, RemoteHosts, type CliResult } from './remote'

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
    pluginKeys: () => ['local.orca-workflow-watch', 'local.odw-watch'],
    wanted: () => wanted,
    onChange: () => changes++,
  })
  return { remote, calls, changes: () => changes }
}

test('every saved server is asked for its own runs only, by id, over --environment', async () => {
  const { remote, calls, changes } = hostsWith((args) => {
    if (args[0] === 'environment') return ok({ environments: [{ id: 'env-mini', name: 'Mac mini' }, { id: 'env-pc', name: 'Studio PC' }] })
    const env = args[args.indexOf('--environment') + 1]
    if (env === 'env-mini') return ok({ pluginKey: 'local.orca-workflow-watch', name: 'watch.snapshot', result: { runs: [run('r1')], hosts: [], root: '~/.odw/runs' } })
    return fail('runtime_unreachable', 'could not connect to Studio PC')
  })
  await remote.tick(1_000_000)
  const asked = calls.filter((c) => c[0] === 'plugin')
  assert.equal(asked.length, 2)
  for (const args of asked) {
    assert.deepEqual(args.slice(0, 5), ['plugin', 'dev', 'request', 'local.orca-workflow-watch', 'watch.snapshot'])
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
      : fail('plugin_request_failed', 'the plugin is not loaded on this Orca', { requestCode: 'unavailable' }),
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

test('a server whose plugin is installed rather than loaded for development reads as not set up', () => {
  const answer = { ok: false, error: { code: 'plugin_not_found', message: 'That is not a loaded development plugin.' } }
  assert.equal(classify(answer as never).state, 'no-plugin')
})

test('a server still on the old name (odw-watch) is asked under its old key, and keeps it', async () => {
  const keyOf = (args: string[]) => args[3]
  const { remote, calls } = hostsWith((args) => {
    if (args[0] === 'environment') return ok({ environments: [{ id: 'work', name: 'Work' }, { id: 'mini', name: 'Mac mini' }] })
    const env = args[args.indexOf('--environment') + 1]
    // Work runs 0.1.0, named odw-watch; Mac mini runs the renamed plugin.
    const has = env === 'work' ? 'local.odw-watch' : 'local.orca-workflow-watch'
    if (keyOf(args) !== has) return fail('plugin_not_found', `${keyOf(args)} is not loaded on this Orca`)
    if (args[4] === 'watch.agent') return ok({ result: { runId: 'r1', agentId: 1, label: 'a', prompt: null, reply: 'hi', stderr: null } })
    return ok({ result: { runs: [run(`${env}-r1`)], hosts: [], root: '~/.odw/runs' } })
  })
  await remote.tick(1_000_000)
  assert.deepEqual(Object.fromEntries(remote.hosts().map((h) => [h.name, h.state])), { Work: 'ok', 'Mac mini': 'ok' })
  assert.deepEqual(remote.snapshots().map((s) => s.snapshot.runs[0].id).sort(), ['mini-r1', 'work-r1'])
  const asked = (env: string) => calls.filter((c) => c[0] === 'plugin' && c[c.indexOf('--environment') + 1] === env).map(keyOf)
  assert.deepEqual(asked('work'), ['local.orca-workflow-watch', 'local.odw-watch'], 'the new key first, then the old one')
  assert.deepEqual(asked('mini'), ['local.orca-workflow-watch'], 'a renamed server is never asked the old key')
  // Later calls go straight to the key that answered.
  const before = calls.length
  const detail = await remote.agent('work', 'r1', 1)
  assert.equal(detail.reply, 'hi')
  assert.deepEqual(calls.slice(before).map(keyOf), ['local.odw-watch'])
})

test('a server with neither key reads as not set up, from the answer to the new key', async () => {
  const { remote, calls } = hostsWith((args) =>
    args[0] === 'environment' ? ok({ environments: [{ id: 'e1', name: 'Box' }] }) : fail('plugin_not_found', `${args[3]} is not loaded on this Orca`),
  )
  await remote.tick(1_000_000)
  assert.equal(remote.hosts()[0].state, 'no-plugin')
  assert.match(remote.hosts()[0].error ?? '', /local\.orca-workflow-watch/)
  assert.equal(calls.filter((c) => c[0] === 'plugin').length, 2)
})

test('only a missing plugin is asked again under the old key; approval, offline and run errors are not', () => {
  assert.equal(pluginMissing({ ok: false, error: { code: 'plugin_not_found', message: 'x' } }), true)
  assert.equal(pluginMissing({ ok: false, error: { code: 'plugin_request_failed', message: 'local.orca-workflow-watch is not loaded on this Orca' } }), true)
  assert.equal(pluginMissing({ ok: false, error: { code: 'approval_required', message: 'the plugin is not approved' } }), false)
  assert.equal(pluginMissing({ ok: false, error: { code: 'runtime_unreachable', message: 'could not connect to Work' } }), false)
  assert.equal(pluginMissing({ ok: false, error: { code: 'action_failed', message: 'no ODW run r1 is being watched' } }), false)
  assert.equal(pluginMissing({ ok: true, result: {} }), false)
})
