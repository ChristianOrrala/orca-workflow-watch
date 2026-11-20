// A stand-in for the Orca CLI with one paired server, for dev/preview.mjs. It answers the two
// calls the worker makes (environment list, plugin dev request … --environment) from a runs
// folder on this computer, read with the plugin's own model: the real CLI path, minus Orca.
//
//   FAKE_ORCA_ROOT=<runs folder> FAKE_ORCA_NAME="Mac mini" dev/fake-orca environment list --json
import { join } from 'node:path'
import { listRunDirs, readAgent, RunWatch } from '../src/model.ts'

const args = process.argv.slice(2)
const root = process.env.FAKE_ORCA_ROOT
const name = process.env.FAKE_ORCA_NAME ?? 'Mac mini'
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n')

if (args[0] === 'environment' && args[1] === 'list') {
  out({ ok: true, result: { environments: root ? [{ id: 'fake-server', name }] : [] } })
} else if (args[0] === 'plugin' && args[1] === 'dev' && args[2] === 'request') {
  const what = args[4]
  const data = JSON.parse(args[args.indexOf('--data') + 1] ?? 'null')
  if (process.env.FAKE_ORCA_OFFLINE) {
    out({ ok: false, error: { code: 'runtime_unreachable', message: `could not connect to ${name}` } })
    process.exit(1)
  }
  const dirs = listRunDirs(root).slice(0, 12)
  if (what === 'watch.snapshot') {
    const runs = dirs.map((d) => new RunWatch(d.runId, d.dir).refresh())
    out({ ok: true, result: { pluginKey: args[3], name: what, result: { root: '~/.odw/runs', rootExists: true, runs, hosts: [], localName: name, scannedAt: Date.now(), error: null } } })
  } else if (what === 'watch.log' && !process.env.FAKE_ORCA_OLD) {
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
