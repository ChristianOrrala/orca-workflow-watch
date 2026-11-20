import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentPrismSource, answerFor, metaOf, timeFromAgentPrismId } from './sources/agentprism'
import type { RunView } from './protocol'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'test', 'fixtures', 'agentprism')
const runsDir = (root: string) => join(root, 'projects', 'demo-60f890a3a987', 'runs')
const quiet = () => {}
const scan = (root: string) => Object.fromEntries(new AgentPrismSource(root).scan(12, quiet).map((v) => [v.id, v])) as Record<string, RunView>

/** Keeps the run's events up to the first of `type` (included), as they were then. */
function cutEvents(runs: string, type: string, keep = true) {
  const events = join(runs, 'mwof4hgc-8kfg7f.events.jsonl')
  const lines = readFileSync(events, 'utf8').split('\n')
  const at = lines.findIndex((l) => l.includes(`"type":"${type}"`))
  writeFileSync(events, lines.slice(0, keep ? at + 1 : at).join('\n') + '\n')
}

/** A copy of the fixture store whose demo-review run is rewritten by `edit`. */
function variant(edit: (runs: string, json: Record<string, unknown>) => Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-watch-orca-ap-'))
  cpSync(fixtures, root, { recursive: true })
  const path = join(runsDir(root), 'mwof4hgc-8kfg7f.json')
  writeFileSync(path, JSON.stringify(edit(runsDir(root), JSON.parse(readFileSync(path, 'utf8')))))
  return root
}

test('real AgentPrism runs read in every ending: done, failed, stopped, paused', () => {
  const runs = scan(fixtures)
  assert.deepEqual(
    Object.values(runs).map((v) => [v.workflow, v.state]),
    [
      ['stop-demo', 'stopped'],
      ['fail-demo', 'failed'],
      ['crash-demo', 'paused'],
      ['limit-demo', 'paused'],
      ['demo-review', 'done'],
    ],
    'newest first, by the time in the run id',
  )
  for (const run of Object.values(runs)) assert.equal(run.engine, 'agentprism')

  const done = runs['mwof4hgc-8kfg7f']
  assert.equal(done.description, 'Stub demo with phases, agents and a checkpoint', "the script's meta")
  assert.equal(done.source, 'demo', 'the project the run worked in')
  assert.deepEqual(
    done.phases.map((p) => [p.title, p.state, p.agents.length]),
    [
      ['Scan', 'done', 3],
      ['Review', 'done', 0],
    ],
  )
  assert.equal(done.agents.total, 3)
  assert.equal(done.tokens.spent, 372)
  assert.equal(done.answer, null)
  assert.ok(done.endedAt && done.endedAt >= done.startedAt)

  assert.equal(runs['mwof5s0r-fka77p'].error, 'boom in script')
  assert.match(runs['mwof4xwn-nry4kn'].error ?? '', /^Paused for a usage limit · Resets in/)
  const crashed = runs['mwof592z-d2irva']
  assert.equal(crashed.error, 'Paused when its process ended', 'a run whose process died is resumable, not lost')
  assert.deepEqual(JSON.parse(crashed.answer!.copy), { action: 'resume', runId: 'mwof592z-d2irva' })
  assert.match(crashed.answer!.how, /picks up where it stopped/)
  assert.deepEqual(JSON.parse(runs['mwof4xwn-nry4kn'].answer!.copy), { action: 'resume', runId: 'mwof4xwn-nry4kn' })
})

test("an agent's detail comes from the run's events", () => {
  const source = new AgentPrismSource(fixtures)
  source.scan(12, quiet)
  const detail = source.agent('mwof4hgc-8kfg7f', 1)
  assert.equal(detail.label, 'count')
  assert.equal(detail.prompt, 'Count files in demo')
  assert.match(detail.reply ?? '', /"files": 3/)
  assert.throws(() => source.agent('nope', 1), /no AgentPrism run nope/)
})

test('a run at a checkpoint waits, with the tool call that answers it', () => {
  const root = variant((runs, json) => {
    // The events up to the pause, and the record as it was then.
    cutEvents(runs, 'paused')
    return { ...json, status: 'paused', pauseReason: 'checkpoint_required', result: null, completedAt: null, checkpointContext: { callIndex: 3, prompt: 'Ship the review for demo?', kind: 'confirm' } }
  })
  try {
    const run = scan(root)['mwof4hgc-8kfg7f']
    assert.equal(run.state, 'waiting')
    assert.equal(run.waiting?.title, 'Ship the review for demo?')
    assert.deepEqual(JSON.parse(run.answer!.copy), { action: 'resume', runId: 'mwof4hgc-8kfg7f', checkpointReplies: { '3': true } })
    assert.match(run.answer!.how, /working in demo\{where\}/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a running run is live while its lock names a live process; without one it reads as the pause AgentPrism saves it as', () => {
  const running = (lock: unknown, updatedAt: string) =>
    variant((runs, json) => {
      if (lock) writeFileSync(join(runs, 'mwof4hgc-8kfg7f.lock'), JSON.stringify(lock))
      cutEvents(runs, 'paused', false)
      return { ...json, status: 'running', result: null, completedAt: null, updatedAt }
    })
  const old = '2026-11-01T00:00:00.000Z'
  for (const [lock, updatedAt, state] of [
    [{ pid: process.pid }, old, 'running'],
    [{ pid: 999999 }, old, 'paused'],
    [null, old, 'paused'],
    [null, new Date().toISOString(), 'running'], // just started: its lock is on its way
  ] as const) {
    const root = running(lock, updatedAt)
    try {
      const run = scan(root)['mwof4hgc-8kfg7f']
      assert.equal(run.state, state, JSON.stringify([lock, updatedAt]))
      if (state === 'paused') assert.equal(run.error, 'Paused when its process ended')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test("a script's meta and a run id's time are read without running anything", () => {
  assert.deepEqual(metaOf('export const meta = {\n  name: "x-y",\n  description: \'Does { things }\',\n  phases: [{ title: "A" }, { title: `B` }],\n};\nphase("A")'), {
    name: 'x-y',
    description: 'Does { things }',
    phases: [{ title: 'A' }, { title: 'B' }],
  })
  assert.deepEqual(metaOf(null), { name: null, description: null, phases: [] })
  assert.equal(timeFromAgentPrismId('mwof4hgc-8kfg7f'), parseInt('mwof4hgc', 36))
  assert.equal(timeFromAgentPrismId('not an id'), null)
  assert.equal(JSON.parse(answerFor('r', 2, 'choice', null).copy).checkpointReplies['2'], '…', 'a choice needs the answer filled in')
})

test('runs of two engines never share a key, nor take over each other\'s question', async () => {
  const { needsYou } = await import('./worker')
  const base = { workflow: 'review', host: null, subject: null, state: 'done', outcome: { status: 'waiting-for-owner', tone: 'attention', text: 'which?' } }
  const asking = { ...base, id: 'a', engine: 'odw', startedAt: 1 } as unknown as RunView
  const other = { ...base, id: 'b', engine: 'agentprism', startedAt: 2, outcome: null } as unknown as RunView
  assert.equal(needsYou(asking, [asking, other]), true, 'a newer AgentPrism run of a same-named workflow is another workflow')
})
