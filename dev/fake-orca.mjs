// A stand-in for the Orca CLI with one paired server, for dev/preview.mjs. It answers the calls
// the worker makes (environment list; plugin list, plugin logs and plugin dev request with
// --environment) from a runs folder on this computer, read with the plugin's own model and
// published through the plugin's own beacon: the real CLI path, minus Orca.
//
//   FAKE_ORCA_ROOT=<runs folder> FAKE_ORCA_NAME="Mac mini" [FAKE_ORCA_KEY=none|local.workflow-watch-orca] dev/fake-orca environment list --json
import { join } from 'node:path'
import { listRunDirs, readAgent, RunWatch } from '../src/model.ts'
import { BeaconWriter } from '../src/beacon.ts'

const args = process.argv.slice(2)
const root = process.env.FAKE_ORCA_ROOT
const name = process.env.FAKE_ORCA_NAME ?? 'Mac mini'
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n')

if (args[0] === 'environment' && args[1] === 'list') {
  out({ ok: true, result: { environments: root ? [{ id: 'fake-server', name }] : [] } })
} else if (args[0] === 'plugin' && (args[1] === 'list' || args[1] === 'logs') && process.env.FAKE_ORCA_OFFLINE) {
  out({ ok: false, error: { code: 'runtime_unreachable', message: `could not connect to ${name}` } })
  process.exit(1)
} else if (args[0] === 'plugin' && args[1] === 'list') {
  // The server's copy: installed from the catalog unless FAKE_ORCA_KEY says otherwise; none plays a
  // server without the plugin, a local.* key a development folder.
  const key = process.env.FAKE_ORCA_KEY ?? 'christianorrala.workflow-watch-orca'
  const plugins = key === 'none' ? [] : [{ pluginKey: key, name: 'Workflow Watch for Orca', publisher: key.split('.')[0], status: 'running', isDev: key.startsWith('local.') }]
  out({ ok: true, result: { plugins } })
} else if (args[0] === 'plugin' && args[1] === 'logs') {
  // The server's beacon as its worker writes it. Each call is a new process, so the boot id moves
  // every 10 s: the reader takes that for a worker that keeps writing.
  const lines = []
  const writer = new BeaconWriter({ boot: Math.floor(Date.now() / 10000).toString(16), write: (line) => lines.push({ ts: Date.now(), level: 'info', line }) })
  const watches = listRunDirs(root).slice(0, 12).map((d) => new RunWatch(d.runId, d.dir))
  const runs = watches.map((w) => w.refresh())
  // The newest run's last events go out as its tail, as the real worker sends them.
  writer.update(runs, Date.now(), (run) => watches[runs.indexOf(run)]?.log().lines ?? null)
  out({ ok: true, result: { pluginKey: args[2], lines, cursor: 'fake:1' } })
} else if (args[0] === 'plugin' && args[1] === 'dev' && args[2] === 'request') {
  const what = args[4]
  const data = JSON.parse(args[args.indexOf('--data') + 1] ?? 'null')
  if (process.env.FAKE_ORCA_OFFLINE) {
    out({ ok: false, error: { code: 'runtime_unreachable', message: `could not connect to ${name}` } })
    process.exit(1)
  }
  // The plugin key the fake server's copy answers to: none plays a server without the plugin.
  const key = process.env.FAKE_ORCA_KEY ?? 'christianorrala.workflow-watch-orca'
  if (args[3] !== key || !key.startsWith('local.')) {
    out({ ok: false, error: { code: 'plugin_not_found', message: `${args[3]} is not loaded on ${name}` } })
    process.exit(1)
  }
  const dirs = listRunDirs(root).slice(0, 12)
  if (what === 'watch.snapshot') {
    const runs = dirs.map((d) => new RunWatch(d.runId, d.dir).refresh())
    out({ ok: true, result: { pluginKey: args[3], name: what, result: { rootExists: true, engines: [{ id: 'odw', label: 'ODW', root: '~/.odw/runs', rootExists: true, hint: null }], runs, hosts: [], localName: name, scannedAt: Date.now(), error: null } } })
  } else if (what === 'watch.log') {
    const found = dirs.find((d) => d.runId === data.runId)
    const watch = found ? new RunWatch(found.runId, found.dir) : null
    watch?.refresh()
    out({ ok: true, result: { pluginKey: args[3], name: what, result: watch ? watch.log() : { runId: data.runId, lines: [], dropped: 0 } } })
  } else if (what === 'watch.agent') {
    const dir = dirs.find((d) => d.runId === data.runId)?.dir ?? join(root, 'missing')
    out({ ok: true, result: { pluginKey: args[3], name: what, result: readAgent(dir, data.runId, data.agentId) } })
  } else {
    out({ ok: false, error: { code: 'plugin_request_failed', message: 'no handler', data: { requestCode: 'unknown_method' } } })
    process.exit(1)
  }
} else {
  out({ ok: false, error: { code: 'unknown_command', message: args.join(' ') } })
  process.exit(1)
}
