import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildView, EventTail, MAX_AGENTS_PER_PHASE, readAgent, RunAccumulator } from './model'
import { OdwSource, shellArg, withAnswer } from './sources/odw'
import { AgentPrismSource, metaOf } from './sources/agentprism'
import { normalizeRun } from './wire'
import type { RunView } from './protocol'

const here = dirname(fileURLToPath(import.meta.url))
const temp = (name: string) => mkdtempSync(join(tmpdir(), `odw-watch-${name}-`))
const waitingView = (id: string, checkpointId: number | null) =>
  ({ id, waiting: { title: 'Ship it?', since: 0, checkpointId } }) as unknown as RunView

test('the approve command names the checkpoint shown, and the runs folder when it is not the default', () => {
  const home = process.env.HOME ?? ''
  assert.equal(withAnswer(waitingView('20261119-120000-abc123', 2), join(home, '.odw', 'runs')).answer?.copy, 'odw approve 20261119-120000-abc123 --checkpoint 2')
  assert.equal(
    withAnswer(waitingView('20261119-120000-abc123', 1), join(home, '.odw', 'runs-demo')).answer?.copy,
    'odw approve 20261119-120000-abc123 --checkpoint 1 --runs-root ~/.odw/runs-demo',
  )
  assert.equal(withAnswer(waitingView('20261119-120000-abc123', 1), '/tmp/my runs').answer?.copy, "odw approve 20261119-120000-abc123 --checkpoint 1 --runs-root '/tmp/my runs'")
})

test('a run id that is not one ODW issues gets no command to copy', () => {
  for (const id of ['x;rm -rf ~', '$(touch pwned)', '-rf', 'a b', '`id`']) {
    const answer = withAnswer(waitingView(id, 1), '/tmp/r').answer
    assert.equal(answer?.copy, '', id)
  }
  assert.equal(shellArg("it's"), `'it'\\''s'`)
  assert.equal(shellArg('--flag'), `'--flag'`)
})

test("an agent's detail reads only its own regular files, never a link out of the run", () => {
  const root = temp('agent')
  try {
    const dir = join(root, 'wf', '20261119-120000-abc123')
    mkdirSync(join(dir, 'agents'), { recursive: true })
    writeFileSync(join(root, 'secret.txt'), 'top secret')
    writeFileSync(join(dir, 'agents', '1.call.json'), JSON.stringify({ prompt: 'p', label: 'a' }))
    symlinkSync(join(root, 'secret.txt'), join(dir, 'agents', '1.stderr.txt'))
    const detail = readAgent(dir, '20261119-120000-abc123', 1)
    assert.equal(detail.prompt, 'p')
    assert.equal(detail.stderr, null, 'a symlinked stderr is not followed')
    assert.throws(() => readAgent(dir, 'r', '../../x' as unknown as number), /whole number/)
    assert.throws(() => readAgent(dir, 'r', 1.5), /whole number/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a line longer than the limit is dropped, and the lines after it still read', () => {
  const root = temp('tail')
  try {
    const path = join(root, 'events.jsonl')
    writeFileSync(path, '{"type":"a"}\n')
    appendFileSync(path, `{"type":"huge","x":"${'y'.repeat(5 * 1024 * 1024)}"}\n`)
    appendFileSync(path, '{"type":"b"}\n')
    const tail = new EventTail(path)
    const events = [...(tail.read() ?? []), ...(tail.read() ?? [])]
    assert.deepEqual(events.map((e) => e.type), ['a', 'b'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a phase full of urgent agents keeps no finished ones', () => {
  const acc = new RunAccumulator()
  for (let id = 1; id <= 100; id++) acc.feed({ type: 'agent_started', agentId: id, phase: 'P', ts: 1 })
  for (let id = 61; id <= 100; id++) acc.feed({ type: 'agent_finished', agentId: id, phase: 'P', ts: 2 })
  const view = buildView({ runId: 'r', status: { state: 'running', pid: 1 }, meta: null }, acc, () => true)
  assert.equal(view.phases[0].agents.length, MAX_AGENTS_PER_PHASE)
  assert.ok(view.phases[0].agents.every((a) => a.state === 'running'))
})

test('a lost run can no longer be answered', () => {
  const acc = new RunAccumulator()
  acc.feed({ type: 'checkpoint_requested', checkpointId: 1, title: 'Ship it?', ts: 1 })
  const view = buildView({ runId: 'r', status: { state: 'waiting', pid: 99999999 }, meta: null }, acc, () => false)
  assert.equal(view.state, 'lost')
  assert.equal(view.waiting, null)
})

test('live runs do not use up the finished runs the history shows', () => {
  const root = temp('history')
  try {
    const make = (runId: string, state: string) => {
      const dir = join(root, 'wf', runId)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'status.json'), JSON.stringify({ runId, state, pid: process.pid, name: 'wf' }))
      writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ ts: 1795000000, type: 'run_started' }) + '\n')
    }
    make('20261119-120005-aaaaaa', 'running')
    make('20261119-120004-aaaaaa', 'running')
    make('20261119-120003-aaaaaa', 'done')
    make('20261119-120002-aaaaaa', 'done')
    make('20261119-120001-aaaaaa', 'done')
    const runs = new OdwSource(root).scan(2, () => {})
    assert.deepEqual(
      runs.map((r) => r.state),
      ['running', 'running', 'done', 'done'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a paired server's malformed runs are dropped, and the rest get every field", () => {
  assert.equal(normalizeRun({ id: 'x' }), null)
  assert.equal(normalizeRun('nope'), null)
  const run = normalizeRun({ id: 'r1', workflow: 'wf', startedAt: 5, state: 'running', phases: [{ title: 'A' }] })!
  assert.deepEqual(run.agents, { total: 0, running: 0, done: 0, failed: 0 })
  assert.deepEqual(run.phases[0].commands, { running: 0, done: 0, failed: 0 })
  assert.equal(run.engine, 'odw', 'an older peer sends no engine')
  assert.equal(normalizeRun({ id: 'r1', workflow: 'wf', startedAt: 5, state: 'exploded' })!.state, 'lost')
})

test("a script's meta reads past braces and quotes inside its strings", () => {
  const meta = metaOf(`export const meta = {
    // a comment with a } brace
    name: 'wf',
    description: "Splits { and } and \\"quotes\\"",
    phases: [{ title: 'One' }, "Two", { title: \`Three \${x}\` }],
  }`)
  assert.deepEqual(meta, { name: 'wf', description: 'Splits { and } and "quotes"', phases: [{ title: 'One' }, { title: 'Two' }] })
})

test("a resume's journal replay does not stretch the calls it replays", () => {
  const run = new AgentPrismSource(join(here, '..', 'test', 'fixtures', 'agentprism')).scan(12, () => {}).find((r) => r.id === 'mwof4hgc-8kfg7f')!
  const count = run.phases[0].agents.find((a) => a.label === 'count')!
  assert.ok(count.endedAt! - count.startedAt < 100, `count took ${count.endedAt! - count.startedAt} ms`)
  assert.equal(count.tokens, 120, 'the original call keeps its tokens')
})

test("a question in one project is not taken over by a run of a same-named workflow in another", async () => {
  const { needsYou } = await import('./worker')
  const base = { workflow: 'review', host: null, engine: 'agentprism', subject: null, state: 'done' }
  const asking = { ...base, id: 'a', source: 'app-one', startedAt: 1, outcome: { status: 'waiting-for-owner', tone: 'attention', text: '?' } } as unknown as RunView
  const other = { ...base, id: 'b', source: 'app-two', startedAt: 2, outcome: null } as unknown as RunView
  assert.equal(needsYou(asking, [asking, other]), true)
})
