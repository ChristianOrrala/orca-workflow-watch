import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { buildView, RunAccumulator } from './model'
import { FAIL_HIGHLIGHT_MINUTES, highlightMinutes, PASS_HIGHLIGHT_MINUTES, workflowStatus } from './status'
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

const MIN = 60_000

test('shows the latest completed result; a workflow-returned error is a visible failure', () => {
  const success = run('Build', 'done', sourcePath, 2)
  const failure = { ...run('Review', 'done', '/remote/app', 3, 'error'), host: 'paired-id', hostName: 'Mac mini' }
  const now = failure.endedAt! + MIN
  assert.equal(workflowStatus([success, failure], null, [], { now }).tone, 'danger')
  assert.equal(workflowStatus([success, failure], null, [], { now }).text, 'Workflows · Last failed')
  assert.equal(workflowStatus([success], null, [], { now }).tone, 'success')
  assert.equal(workflowStatus([success], null, [], { now }).text, 'Workflows · Passed')
  const check = run('Check', 'failed')
  assert.equal(workflowStatus([check], null, [], { now: check.endedAt! }).tone, 'danger')
})

test('a pass is green for 15 minutes after its run ended, then calm with the result in the tooltip', () => {
  const pass = run('Build', 'done', sourcePath, 2, undefined, 'main')
  const ended = pass.endedAt!
  const fresh = workflowStatus([pass], null, [], { now: ended + 14 * MIN })
  assert.deepEqual([fresh.text, fresh.tone, fresh.icon, fresh.until], ['Workflows · Passed', 'success', 'check', ended + 15 * MIN])
  assert.equal(fresh.tooltip, 'Last passed: Build (main) · 14m ago')
  const calm = workflowStatus([pass], null, [], { now: ended + 15 * MIN })
  assert.deepEqual([calm.text, calm.tone, calm.icon, calm.until], ['Workflows', 'neutral', 'activity', null])
  assert.equal(workflowStatus([pass], null, [], { now: ended + 2 * 60 * MIN }).tooltip, 'Last passed: Build (main) · 2h ago')
})

test('a failure stays red for 24 hours, or until a newer run passes', () => {
  const fail = run('Review', 'failed', sourcePath, 2, undefined, 'main')
  const ended = fail.endedAt!
  const red = workflowStatus([fail], null, [], { now: ended + 23 * 60 * MIN })
  assert.deepEqual([red.text, red.tone, red.icon, red.until], ['Workflows · Last failed', 'danger', 'error', ended + 24 * 60 * MIN])
  const calm = workflowStatus([fail], null, [], { now: ended + 24 * 60 * MIN })
  assert.deepEqual([calm.text, calm.tone, calm.until], ['Workflows', 'neutral', null])
  assert.equal(calm.tooltip, 'Last failed: Review (main) · 24h ago')
  // A newer run of another workflow passes: the failure is old news at once.
  const pass = { ...run('Build', 'done', sourcePath, 3), startedAt: fail.startedAt + 1 }
  assert.equal(workflowStatus([fail, pass], null, [], { now: ended + MIN }).text, 'Workflows · Passed')
})

test('the windows follow the settings: 0 never highlights, values are clamped to a week', () => {
  const pass = run('Build', 'done', sourcePath, 2)
  const fail = run('Review', 'failed', sourcePath, 2)
  const at = (r: typeof pass, opts: object) => workflowStatus([r], null, [], { now: r.endedAt!, ...opts })
  assert.equal(at(pass, { passMinutes: 0 }).tone, 'neutral')
  assert.equal(at(fail, { failMinutes: 0 }).tone, 'neutral')
  assert.equal(at(pass, { passMinutes: 60 }).until, pass.endedAt! + 60 * MIN)
  assert.equal(at(fail, { failMinutes: 5 }).until, fail.endedAt! + 5 * MIN)
  assert.equal(at(fail, { failMinutes: 99_999 }).until, fail.endedAt! + 10_080 * MIN)
  assert.equal(highlightMinutes(-3, 15), 0)
  assert.equal(highlightMinutes('x', 15), 15)
  assert.equal(highlightMinutes(undefined, PASS_HIGHLIGHT_MINUTES), 15)
  assert.equal(highlightMinutes(undefined, FAIL_HIGHLIGHT_MINUTES), 1440)
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

test('the worker reads the window settings: a pass with a 0-minute window is calm at once', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'watch-status-'))
  t.after(() => { deactivate(); rmSync(root, { recursive: true, force: true }) })
  const dir = join(root, 'build', 'test-run')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ source: sourcePath, workflowName: 'Build' }))
  writeFileSync(join(dir, 'status.json'), JSON.stringify({ state: 'done', updatedAt: Date.now() / 1000 }))
  const statuses: { text: string; tone: string }[] = []
  const handlers = new Map<string, (input: null) => Promise<unknown>>()
  let passHighlightMinutes = 0
  let changed = () => {}
  activate({
    commands: { register() {} },
    host: { async call(method: string, params: { text: string; tone: string }) { if (method === 'statusBar.update') statuses.push(params) } },
    log() {},
    panels: { handle: (name: string, handler: (input: null) => Promise<unknown>) => handlers.set(name, handler), post() {} },
    settings: { get: async () => ({ runsRoot: root, agentprismRoot: join(root, 'absent'), remotes: 'off', notifications: false, passHighlightMinutes }), onDidChange(fn: () => void) { changed = fn } },
  } as unknown as OrcaWorkerApi)
  await handlers.get('watch.snapshot')!(null)
  assert.deepEqual([statuses.at(-1)?.text, statuses.at(-1)?.tone], ['Workflows', 'neutral'])
  passHighlightMinutes = 15
  changed()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual([statuses.at(-1)?.text, statuses.at(-1)?.tone], ['Workflows · Passed', 'success'])
})
