import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { buildView, RunAccumulator } from './model'
import { workflowStatus } from './status'
import { decodeRun, runWire } from './beacon'
import type { RunState } from './protocol'
import activate, { deactivate } from './worker'

const sourcePath = '/work/app'

function run(workflow: string, state: RunState, source = sourcePath, updatedAt = 1, result?: string, branch?: string) {
  return buildView({ runId: workflow, meta: { source, createdAt: 1, branch }, status: { name: workflow, state, updatedAt }, result: result ? { status: result } : null }, new RunAccumulator(), () => true)
}

test('counts runs across local workspaces and paired servers, and lists active run details', () => {
  const paired = { ...decodeRun(runWire(run('Deploy', 'running', '/remote/app', 1, undefined, 'release')))!, host: 'paired-id', hostName: 'Mac mini' }
  const runs = [run('Build', 'running', sourcePath, 1, undefined, 'refs/heads/feature/task'), run('Review', 'running', '/elsewhere/app'), paired, run('Plan', 'waiting')]
  const status = workflowStatus(runs)
  assert.equal(status.text, 'Workflows · 3 running')
  assert.equal(status.tone, 'warning')
  assert.equal(status.tooltip, 'Build (feature/task): running; Review (branch unavailable): running; Deploy (release · Mac mini): running; Plan (branch unavailable): waiting')
})

test('shows the latest completed result; a workflow-returned error is a visible failure', () => {
  const success = run('Build', 'done', sourcePath, 2)
  const failure = { ...run('Review', 'done', '/remote/app', 3, 'error'), host: 'paired-id', hostName: 'Mac mini' }
  assert.equal(workflowStatus([success, failure]).tone, 'danger')
  assert.equal(workflowStatus([success, failure]).text, 'Workflows · Last failed')
  assert.equal(workflowStatus([success]).tone, 'success')
  assert.equal(workflowStatus([run('Check', 'failed')]).tone, 'danger')
})

test('keeps paused and waiting states distinct, and is quiet for missing or unavailable data', () => {
  assert.equal(workflowStatus([run('Plan', 'waiting')]).tone, 'warning')
  assert.equal(workflowStatus([run('Plan', 'paused')]).text, 'Workflows · 1 paused')
  const local = run('Build', 'running')
  for (const status of [workflowStatus([]), workflowStatus([local], 'unavailable')]) {
    assert.equal(status.text, 'Workflows · Idle')
    assert.equal(status.tone, 'neutral')
  }
  const failedSource = workflowStatus([local], null, ['odw'])
  assert.equal(failedSource.tooltip, 'Workflow activity unavailable')
  const paired = { ...local, host: 'paired-id', hostName: 'Mac mini' }
  assert.equal(workflowStatus([local, paired], 'unavailable', ['odw']).text, 'Workflows · 1 running')
})

test('fits Orca’s 256-character tooltip limit without cutting a status off', () => {
  const runs = Array.from({ length: 20 }, (_, i) => ({ ...run(`${i}${'x'.repeat(200)}`, 'running', sourcePath, 1, undefined, 'x'.repeat(400)), host: 'paired-id', hostName: 'h'.repeat(200) }))
  const status = workflowStatus(runs)
  assert.equal(status.text, 'Workflows · 20 running')
  assert.ok(status.tooltip.length <= 256)
  assert.match(status.tooltip, /: running; \+\d+ more$/)
})

test('the worker publishes status on refresh without a workspace lookup or opening the panel', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'watch-status-'))
  t.after(() => { deactivate(); rmSync(root, { recursive: true, force: true }) })
  const dir = join(root, 'build', 'test-run')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ source: sourcePath, workflowName: 'Build' }))
  const setState = (state: RunState) => writeFileSync(join(dir, 'status.json'), JSON.stringify({ state, pid: process.pid, updatedAt: Date.now() / 1000 }))
  setState('running')
  const statuses: { text: string; tone: string }[] = []
  const handlers = new Map<string, (input: null) => Promise<unknown>>()
  const methods: string[] = []
  activate({
    commands: { register() {} },
    host: { async call(method: string, params: { text: string; tone: string }) {
      methods.push(method)
      if (method === 'statusBar.update') statuses.push(params)
    } },
    log() {},
    panels: { handle: (name: string, handler: (input: null) => Promise<unknown>) => handlers.set(name, handler), post() {} },
    settings: { get: async () => ({ runsRoot: root, agentprismRoot: join(root, 'absent'), remotes: 'off', notifications: false }), onDidChange() {} },
  } as unknown as OrcaWorkerApi)
  const refresh = handlers.get('watch.snapshot')!
  await refresh(null)
  assert.equal(statuses.at(-1)?.text, 'Workflows · 1 running')
  setState('failed')
  await refresh(null)
  assert.equal(statuses.at(-1)?.tone, 'danger')
  rmSync(dir, { recursive: true })
  await refresh(null)
  assert.equal(statuses.at(-1)?.text, 'Workflows · Idle')
  assert.ok(methods.every((method) => method === 'statusBar.update'))
})
