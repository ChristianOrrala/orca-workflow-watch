import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify, findCopies, isOurKey, LIVE_READ_MS, RemoteHosts, type CliResult } from './remote'
import { BeaconWriter, ORCA_LOG_LINES } from './beacon'
import { OdwSource } from './sources/odw'
import type { RunView } from './protocol'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string) => readFileSync(join(here, '..', 'test', 'fixtures', 'cli', name), 'utf8')
const answer = (name: string): CliResult => ({ code: 0, stdout: fixture(name), stderr: '' })
const ok = (result: unknown): CliResult => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })

const WORK = 'd0a01276-6b3a-4e18-b63f-bcb2c419100f'
const STUDIO = '7c1f0e52-2a4b-4c1e-9d55-2b1d8e0f6a31'
const ID = 'workflow-watch-orca'
const realRuns = () => new OdwSource(join(here, '..', 'test', 'fixtures', 'plan-flow')).scan(12, () => {})

/** A server's Workflow Watch writing its beacon into Orca's 200-line plugin log. */
function server(boot = 'cafe0001') {
  const lines: { ts: number; level: string; line: string }[] = []
  const writer = new BeaconWriter({
    boot,
    write: (line) => {
      lines.push({ ts: 0, level: 'info', line })
      if (lines.length > ORCA_LOG_LINES) lines.splice(0, lines.length - ORCA_LOG_LINES)
    },
  })
  return { writer, logs: () => ok({ pluginKey: 'christianorrala.workflow-watch-orca', lines, cursor: 'x:1' }) }
}

function hostsWith(answers: (args: string[]) => CliResult, opts: { wanted?: string; now?: () => number } = {}) {
  const calls: string[][] = []
  let changes = 0
  const remote = new RemoteHosts({
    run: async (args) => {
      calls.push(args)
      return answers(args)
    },
    pluginId: ID,
    wanted: () => opts.wanted ?? 'auto',
    onChange: () => changes++,
    now: opts.now,
  })
  return { remote, calls, changes: () => changes }
}

const env = (args: string[]) => args[args.indexOf('--environment') + 1]

test('a server’s copy is found by its id, from a catalog or a folder, running first', () => {
  const found = findCopies(JSON.parse(fixture('plugins.json')), ID)
  assert.deepEqual(found, { readable: [{ key: 'christianorrala.workflow-watch-orca', isDev: false, status: 'running' }], any: true })
  const dev = findCopies(JSON.parse(fixture('plugins-dev.json')), ID)
  assert.deepEqual(dev?.readable.map((c) => [c.key, c.isDev]), [['local.workflow-watch-orca', true]], 'a disabled install is not read')
  assert.deepEqual(findCopies(JSON.parse(fixture('plugins-none.json')), ID), { readable: [], any: false })
  assert.deepEqual(findCopies(JSON.parse(fixture('plugins-off.json')), ID), { readable: [], any: true })
  assert.equal(findCopies(JSON.parse(fixture('error-unreachable.json')), ID), null)
  assert.equal(isOurKey('christianorrala.workflow-watch-orca', ID), true)
  assert.equal(isOurKey('local.workflow-watch-orca', ID), true)
  for (const bad of ['workflow-watch-orca', '.workflow-watch-orca', '-x.workflow-watch-orca', 'a b.workflow-watch-orca', 'x.workflow-watch-orca-extra', 42])
    assert.equal(isOurKey(bad, ID), false, String(bad))
})

test('each server’s runs come from its plugin log, read by the key its plugin list gives', async () => {
  const work = server()
  const runs = realRuns()
  let now = 2_000_000
  work.writer.update(runs, now)
  const { remote, calls, changes } = hostsWith(
    (args) => {
      if (args[0] === 'environment') return answer('environments.json')
      if (env(args) === STUDIO) return answer('error-unreachable.json')
      if (args[1] === 'list') return answer('plugins.json')
      if (args[1] === 'logs') return work.logs()
      throw new Error(`unexpected call ${args.join(' ')}`)
    },
    { now: () => now },
  )
  await remote.tick(now)
  const work_ = calls.filter((c) => env(c) === WORK)
  assert.deepEqual(work_.map((c) => c.slice(0, 3)), [['plugin', 'list', '--environment'], ['plugin', 'logs', 'christianorrala.workflow-watch-orca']])
  assert.deepEqual(work_[1], ['plugin', 'logs', 'christianorrala.workflow-watch-orca', '--environment', WORK, '--json'])
  assert.equal(calls.some((c) => c.includes('dev')), false, 'no development request for an installed copy')
  const states = Object.fromEntries(remote.hosts().map((h) => [h.name, [h.state, h.details]]))
  assert.deepEqual(states, { Work: ['ok', false], 'Studio PC': ['offline', false] })
  const [only] = remote.snapshots()
  assert.equal(only.env.name, 'Work')
  assert.deepEqual(only.runs, runs)
  assert.ok(changes() > 0)
})

test('a server keeps answering at its pace: its log is read again, its plugin list each minute', async () => {
  const work = server()
  let now = 2_000_000
  const live: RunView = { ...realRuns()[0], state: 'running', endedAt: null }
  work.writer.update([live], now)
  const { remote, calls } = hostsWith(
    (args) => (args[0] === 'environment' ? ok({ environments: [{ id: 'w', name: 'Work' }] }) : args[1] === 'list' ? answer('plugins.json') : work.logs()),
    { now: () => now },
  )
  await remote.tick(now)
  const reads = () => calls.filter((c) => c[1] === 'logs').length
  assert.equal(reads(), 1)
  now += 1000
  await remote.tick(now)
  assert.equal(reads(), 1, 'not due yet')
  now += LIVE_READ_MS
  work.writer.tick(now)
  await remote.tick(now)
  assert.equal(reads(), 2, 'a live run is read every 3 s')
  assert.equal(calls.filter((c) => c[0] === 'plugin' && c[1] === 'list').length, 1, 'the plugin list is not read every time')
})

test('a beacon that stops moving makes the server stale, and its runs leave the list', async () => {
  const work = server()
  let now = 2_000_000
  work.writer.update(realRuns(), now)
  const { remote } = hostsWith(
    (args) => (args[0] === 'environment' ? ok({ environments: [{ id: 'w', name: 'Work' }] }) : args[1] === 'list' ? answer('plugins.json') : work.logs()),
    { now: () => now },
  )
  await remote.tick(now)
  assert.equal(remote.hosts()[0].state, 'ok')
  // Its worker stops writing: nothing moves for over 3 intervals (plus a read's wait).
  for (let i = 0; i < 5; i++) {
    now += 10_000
    await remote.tick(now)
  }
  const [host] = remote.hosts()
  assert.equal(host.state, 'stale')
  assert.match(host.error ?? '', /No word from its Workflow Watch since/)
  assert.deepEqual(remote.snapshots(), [])
  // It comes back.
  work.writer.tick(now)
  now += 10_000
  await remote.tick(now)
  assert.equal(remote.hosts()[0].state, 'ok')
})

test('an older Workflow Watch there, with no beacon, reads as stale and says to update', async () => {
  let now = 2_000_000
  const { remote } = hostsWith(
    (args) => (args[0] === 'environment' ? ok({ environments: [{ id: 'w', name: 'Work' }] }) : args[1] === 'list' ? answer('plugins.json') : answer('logs-0.3.json')),
    { now: () => now },
  )
  await remote.tick(now)
  const [host] = remote.hosts()
  assert.equal(host.state, 'stale')
  assert.match(host.error ?? '', /0\.4\.0 or newer/)
})

test('a server without the plugin, or with it turned off, reads as not set up, and is asked less often', async () => {
  for (const [file, says] of [
    ['plugins-none.json', /not installed there/],
    ['plugins-off.json', /turned off/],
  ] as const) {
    let now = 2_000_000
    const { remote, calls } = hostsWith((args) => (args[0] === 'environment' ? ok({ environments: [{ id: 'w', name: 'Box' }] }) : answer(file)), { now: () => now })
    await remote.tick(now)
    const [host] = remote.hosts()
    assert.equal(host.state, 'no-plugin')
    assert.match(host.error ?? '', says)
    assert.equal(calls.some((c) => c[1] === 'logs'), false)
    const before = calls.length
    now += 30_000
    await remote.tick(now)
    assert.equal(calls.length, before, 'asked again after a minute, not before')
  }
})

test('the setting picks servers by name or id, and off watches none', async () => {
  const picked = hostsWith((args) => (args[0] === 'environment' ? answer('environments.json') : answer('plugins-none.json')), { wanted: 'work' })
  await picked.remote.tick(1_000_000)
  assert.deepEqual(picked.remote.hosts().map((h) => h.name), ['Work'])
  const off = hostsWith(() => answer('environments.json'), { wanted: 'off' })
  await off.remote.tick(1_000_000)
  assert.equal(off.calls.length, 0)
  assert.deepEqual(off.remote.hosts(), [])
})

test('an agent’s prompt or a full log is asked of a development copy, and an installed one says where it is', async () => {
  const work = server()
  work.writer.update(realRuns(), 2_000_000)
  const make = (plugins: string) =>
    hostsWith(
      (args) => {
        if (args[0] === 'environment') return ok({ environments: [{ id: 'w', name: 'Work' }] })
        if (args[1] === 'list') return answer(plugins)
        if (args[1] === 'logs') return work.logs()
        if (args[4] === 'watch.agent') return ok({ result: { runId: 'r1', agentId: 3, label: 'a', prompt: 'p', reply: 'r', stderr: null } })
        if (args[4] === 'watch.log') return ok({ result: { runId: 'r1', lines: [{ ts: 1, text: 'a', tone: 'warn' }], dropped: 0 } })
        throw new Error(`unexpected call ${args.join(' ')}`)
      },
      { now: () => 2_000_000 },
    )
  const dev = make('plugins-dev.json')
  await dev.remote.tick(2_000_000)
  assert.equal(dev.remote.hosts()[0].details, true)
  const detail = await dev.remote.agent('w', 'r1', 3, 'agentprism')
  assert.equal(detail.prompt, 'p')
  const log = await dev.remote.runLog('w', 'r1')
  assert.deepEqual(log.lines, [{ ts: 1, text: 'a', tone: 'warn' }])
  const asked = dev.calls.find((c) => c[4] === 'watch.agent')!
  assert.deepEqual(asked.slice(0, 4), ['plugin', 'dev', 'request', 'local.workflow-watch-orca'])
  assert.equal(asked[asked.indexOf('--data') + 1], '{"runId":"r1","agentId":3,"engine":"agentprism"}')
  assert.equal(asked[asked.indexOf('--environment') + 1], 'w')

  const installed = make('plugins.json')
  await installed.remote.tick(2_000_000)
  assert.equal(installed.remote.hosts()[0].details, false)
  await assert.rejects(installed.remote.agent('w', 'r1', 3), /stays on Work: open Workflows there/)
  await assert.rejects(installed.remote.runLog('w', 'r1'), /stays on Work/)
  assert.equal(installed.calls.some((c) => c[1] === 'dev'), false)
  await assert.rejects(installed.remote.runLog('nowhere', 'r1'), (e: Error & { code?: string }) => e.code === 'invalid_params')
})

test('failures are sorted into what the panel can say', () => {
  assert.equal(classify(JSON.parse(fixture('error-unreachable.json'))).state, 'offline')
  assert.equal(classify({ error: { code: 'runtime_error', message: 'Plugin service is not available on this runtime' } }).state, 'no-plugin')
  assert.equal(classify({ error: { code: 'plugin_request_failed', message: 'x', data: { requestCode: 'unknown_method' } } }).state, 'no-plugin')
  assert.equal(classify({ error: { code: 'weird', message: 'something else' } }).state, 'error')
})
