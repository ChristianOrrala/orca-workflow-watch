import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventTail, listRunDirs, MAX_AGENTS_PER_PHASE, RunAccumulator, RunWatch, buildView, readAgent } from './model'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'test', 'fixtures')
const alive = () => true
const dead = () => false

test('a real ODW dry run reads as a finished run with its phases and agents', () => {
  const [run] = listRunDirs(join(fixtures, 'odw-dry'))
  assert.ok(run, 'the fixture run is found inside its workflow bucket')
  const view = new RunWatch(run.runId, run.dir).refresh(dead)
  assert.equal(view.workflow, 'review-swarm')
  assert.equal(view.state, 'done', 'an ended run is never lost, whatever its pid')
  assert.equal(view.dry, true)
  assert.equal(view.source, 'demo')
  assert.deepEqual(
    view.phases.map((p) => [p.title, p.state, p.agents.length]),
    [
      ['Map', 'done', 1],
      ['Review', 'done', 5],
      ['Verify', 'done', 0],
      ['Summarize', 'done', 0],
    ],
  )
  assert.deepEqual(view.agents, { total: 6, running: 0, done: 6, failed: 0 })
  assert.equal(view.tokens.spent, 25)
  assert.ok(view.endedAt && view.endedAt >= view.startedAt)
  assert.match(view.log.at(-1)!.text, /findings survived verification/)
  const detail = readAgent(run.dir, run.runId, 2)
  assert.equal(detail.label, 'review:correctness')
  assert.match(detail.prompt ?? '', /lens of correctness/)
  assert.match(detail.reply ?? '', /findings/)
})

test('the simulator writes runs the model reads: done, failed, newest first', () => {
  const root = mkdtempSync(join(tmpdir(), 'odw-watch-sim-'))
  try {
    execFileSync(process.execPath, [join(here, '..', 'scripts', 'simulate-run.mjs'), '--root', root, '--history-only'], { stdio: 'ignore' })
    const views = listRunDirs(root).map((r) => new RunWatch(r.runId, r.dir).refresh(dead))
    assert.deepEqual(
      views.map((v) => [v.workflow, v.state]).sort(),
      [
        ['deep-research', 'done'],
        ['fix-until-green', 'failed'],
        ['review-swarm', 'done'],
      ],
    )
    const fix = views.find((v) => v.workflow === 'fix-until-green')!
    assert.match(fix.error ?? '', /usage limit/)
    assert.deepEqual(fix.phases.find((p) => p.title === 'Test')!.commands, { running: 0, done: 0, failed: 3 })
    assert.equal(fix.phases.find((p) => p.title === 'Fix')!.state, 'failed', 'the phase the run died in')
    assert.equal(fix.agents.failed, 1)
    const review = views.find((v) => v.workflow === 'review-swarm')!
    assert.equal(review.phases.find((p) => p.title === 'Apply')!.state, 'skipped', 'a declared phase the script skipped is not left pending')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function liveRun(root: string) {
  const dir = join(root, 'wf', '20261119-120000-abc123')
  mkdirSync(join(dir, 'agents'), { recursive: true })
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ workflowName: 'wf', createdAt: 1795000000, budgetTotal: 10000 }))
  const status = (fields: Record<string, unknown>) =>
    writeFileSync(join(dir, 'status.json'), JSON.stringify({ runId: '20261119-120000-abc123', state: 'running', pid: 4242, name: 'wf', phases: [{ title: 'One' }, { title: 'Two' }], ...fields }))
  const emit = (ev: Record<string, unknown>) => appendFileSync(join(dir, 'events.jsonl'), JSON.stringify({ ts: 1795000001, ...ev }) + '\n')
  status({})
  return { dir, status, emit }
}

test('a live run follows its events as they land, a torn last line waits', () => {
  const root = mkdtempSync(join(tmpdir(), 'odw-watch-live-'))
  try {
    const { dir, status, emit } = liveRun(root)
    const watch = new RunWatch('20261119-120000-abc123', dir)
    emit({ type: 'run_started' })
    emit({ type: 'phase_started', phase: 'One' })
    emit({ type: 'agent_started', agentId: 1, label: 'a', phase: 'One', adapter: 'claude' })
    let view = watch.refresh(alive)
    assert.equal(view.state, 'running')
    assert.deepEqual(view.phases.map((p) => p.state), ['active', 'pending'])
    assert.equal(view.agents.running, 1)

    // Half a line: not read yet, and not lost.
    appendFileSync(join(dir, 'events.jsonl'), '{"ts":1795000002,"type":"agent_fin')
    view = watch.refresh(alive)
    assert.equal(view.agents.running, 1)
    appendFileSync(join(dir, 'events.jsonl'), 'ished","agentId":1,"label":"a","phase":"One","usage":{"outputTokens":120}}\n')
    view = watch.refresh(alive)
    assert.deepEqual(view.agents, { total: 1, running: 0, done: 1, failed: 0 })
    assert.equal(view.phases[0].state, 'active', 'still the current phase of a live run')

    emit({ type: 'phase_started', phase: 'Two' })
    emit({ type: 'checkpoint_requested', checkpointId: 1, title: 'Ship it?', phase: 'Two' })
    status({ state: 'waiting', waiting: { checkpointId: 1, title: 'Ship it?', since: 1795000003 } })
    view = watch.refresh(alive)
    assert.equal(view.state, 'waiting')
    assert.equal(view.waiting?.title, 'Ship it?')
    assert.deepEqual(view.phases.map((p) => p.state), ['done', 'active'])

    view = watch.refresh(dead)
    assert.equal(view.state, 'lost', 'a live run whose worker is gone')
    assert.match(view.error ?? '', /worker is gone/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a replaced events file starts the fold again', () => {
  const root = mkdtempSync(join(tmpdir(), 'odw-watch-tail-'))
  try {
    const path = join(root, 'events.jsonl')
    writeFileSync(path, '{"type":"a"}\n{"type":"b"}\n')
    const tail = new EventTail(path)
    assert.equal(tail.read()!.length, 2)
    writeFileSync(path, '{"type":"c"}\n')
    assert.equal(tail.read(), null, 'shorter than what was read: a reset')
    assert.deepEqual(tail.read(), [{ type: 'c' }])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a huge fan-out keeps every running and failed agent among its beads', () => {
  const acc = new RunAccumulator()
  acc.feed({ type: 'phase_started', phase: 'Fan', ts: 1 })
  for (let id = 1; id <= 200; id++) acc.feed({ type: 'agent_started', agentId: id, label: `a${id}`, phase: 'Fan', ts: 1 })
  for (let id = 1; id <= 190; id++) acc.feed({ type: id === 7 ? 'agent_failed' : 'agent_finished', agentId: id, phase: 'Fan', ts: 2, error: 'boom' })
  const view = buildView({ runId: 'r', status: { state: 'running', pid: 1 }, meta: null }, acc, alive)
  const fan = view.phases[0]
  assert.equal(fan.agents.length, MAX_AGENTS_PER_PHASE)
  assert.equal(fan.hiddenAgents, 200 - MAX_AGENTS_PER_PHASE)
  assert.equal(fan.agents.filter((a) => a.state === 'running').length, 10)
  assert.ok(fan.agents.some((a) => a.id === 7 && a.state === 'failed'))
  assert.deepEqual(view.agents, { total: 200, running: 10, done: 189, failed: 1 })
})

test('a real plan-flow run: a halt that asks or errs is not read as plain done', async () => {
  const { needsYou } = await import('./worker')
  const views = listRunDirs(join(fixtures, 'plan-flow')).map((r) => new RunWatch(r.runId, r.dir).refresh(dead))
  const byId = Object.fromEntries(views.map((v) => [v.id, v]))
  const merged = byId['20261119-195538-d72739']
  assert.equal(merged.state, 'done')
  assert.deepEqual(merged.outcome, { status: 'success', tone: 'ok', text: null })
  assert.deepEqual(
    merged.phases.map((p) => [p.title, p.state]),
    [
      ['Preflight', 'done'],
      ['Tasks', 'done'],
      ['Deferred fixes', 'skipped'],
      ['Integration review', 'done'],
      ['Merge', 'done'],
    ],
  )
  assert.deepEqual(merged.phases[1].agents.map((a) => a.label).slice(0, 3), ['implement:1:1', 'review:conformance:1:1', 'review:adversarial:1:1'])
  const halted = byId['20261119-195515-ac9e5c']
  assert.equal(halted.state, 'done', 'ODW calls a run that returned done')
  assert.equal(halted.outcome?.tone, 'bad')
  assert.match(halted.outcome?.text ?? '', /env-status\.json is missing/)
  const asking = byId['20261119-195000-aaaaaa']
  assert.equal(asking.outcome?.tone, 'attention')
  assert.match(asking.outcome?.text ?? '', /which date format/)
  assert.equal(needsYou(asking, views), false, 'newer runs of the workflow followed it')
  assert.equal(needsYou(asking, [asking]), true)
})

test('a question stays open until a newer run of the same plan follows, whatever other plans start', async () => {
  const { needsYou } = await import('./worker')
  const root = mkdtempSync(join(tmpdir(), 'odw-watch-subject-'))
  try {
    let second = 0
    const make = (args: unknown, status: string | null) => {
      const runId = `20261119-1200${String(second++).padStart(2, '0')}-aaaaaa`
      const dir = join(root, 'plan-flow', runId)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'meta.json'), JSON.stringify({ workflowName: 'plan-flow', args }))
      writeFileSync(join(dir, 'status.json'), JSON.stringify({ runId, state: 'done', name: 'plan-flow', pid: 0 }))
      writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ ts: 1795000000 + second, type: 'run_started' }) + '\n' + JSON.stringify({ ts: 1795000000 + second + 0.5, type: 'run_finished' }) + '\n')
      if (status) writeFileSync(join(dir, 'result.json'), JSON.stringify({ value: { status, question: `about ${JSON.stringify(args)}` } }))
      return runId
    }
    const planA = { plan_file: '/plans/invoices.md', run_dir: '/runs/invoices', stage: 'build' }
    const planB = { plan_file: '/plans/exports.md', run_dir: '/runs/exports' }
    const askA = make(planA, 'waiting-for-owner')
    make(planB, 'built') // plan B starts and ends after A asked
    const views = () => listRunDirs(root).map((r) => new RunWatch(r.runId, r.dir).refresh(dead))
    let runs = views()
    const a = runs.find((r) => r.id === askA)!
    assert.equal(a.subjectLabel, 'invoices.md')
    assert.notEqual(a.subject, runs.find((r) => r.id !== askA)!.subject)
    assert.equal(needsYou(a, runs), true, 'plan B does not hide plan A\'s question')
    make({ ...planA, stage: 'merge' }, 'success') // plan A again: same run dir, another stage
    runs = views()
    assert.equal(needsYou(runs.find((r) => r.id === askA)!, runs), false, 'a newer run of plan A takes the question over')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
