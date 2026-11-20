// Phase times and the full event log (0.1.3): what the worker keeps and sends, what a paired
// server on an older plugin still gets, and the panel's own helpers (panel/lib.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { buildView, LOG_KEEP, RunAccumulator } from './model'
import { RemoteHosts, type CliResult } from './remote'
import { normalizeLog, normalizeRun } from './wire'

const lib = createRequire(import.meta.url)('../panel/lib.js') as {
  duration(ms: number): string
  phaseTimes(run: unknown, now: number): ({ ms: number; live: boolean; approx: boolean; from: number; to: number | null } | null)[]
  phaseLabel(t: unknown): string
  mergeLog(full: unknown[], tail: unknown[]): { ts: number; text: string }[]
  atBottom(scrollTop: number, clientHeight: number, scrollHeight: number): boolean
  logNote(o: { total: number; shown: number; dropped: number; loading: boolean; error: string | null }): string
}

const alive = () => true
const T = 1_795_000_000 // epoch seconds, as ODW writes them
const at = (s: number) => T + s

/** A run's events, folded and viewed the way a RunWatch does. */
function viewOf(events: Record<string, unknown>[], status: Record<string, unknown> = { state: 'running', pid: 1 }) {
  const acc = new RunAccumulator()
  for (const ev of events) acc.feed(ev)
  return { acc, view: buildView({ runId: 'r1', status, meta: null }, acc, alive) }
}

test('durations read as a clock: h:mm:ss from an hour, m:ss under it, <1s under a second', () => {
  assert.equal(lib.duration(5_802_000), '1:36:42')
  assert.equal(lib.duration(3_600_000), '1:00:00')
  assert.equal(lib.duration(245_000), '4:05')
  assert.equal(lib.duration(59_999), '0:59')
  assert.equal(lib.duration(1000), '0:01')
  assert.equal(lib.duration(999), '<1s')
  assert.equal(lib.duration(0), '<1s')
  assert.equal(lib.duration(Number.NaN), '<1s')
})

test('a command-only phase spans its commands, even when ODW marks the phase after they ran', () => {
  // ODW's Preflight: the gate commands run, then the phase is marked, then Tasks starts.
  const { view } = viewOf([
    { ts: at(0), type: 'run_started' },
    { ts: at(1), type: 'command_started', commandId: 1, phase: 'Preflight', label: 'gate' },
    { ts: at(41), type: 'command_finished', commandId: 1, phase: 'Preflight', label: 'gate' },
    { ts: at(42), type: 'command_started', commandId: 2, phase: 'Preflight', label: 'lint' },
    { ts: at(96), type: 'command_finished', commandId: 2, phase: 'Preflight', label: 'lint' },
    { ts: at(96), type: 'phase_started', phase: 'Preflight' },
    { ts: at(97), type: 'phase_started', phase: 'Tasks' },
    { ts: at(98), type: 'agent_started', agentId: 1, label: 'implement:1', phase: 'Tasks' },
  ])
  const [preflight, tasks] = view.phases
  assert.equal(preflight.title, 'Preflight')
  assert.equal(preflight.state, 'done')
  assert.equal(preflight.startedAt, at(1) * 1000, 'from its first command, not the phase mark')
  assert.equal(preflight.endedAt, at(96) * 1000, 'to its last command')
  assert.equal(tasks.state, 'active')
  const times = lib.phaseTimes(view, at(160) * 1000)
  assert.equal(lib.phaseLabel(times[0]), '1:35')
  assert.equal(times[0]?.approx, false)
  assert.deepEqual([lib.phaseLabel(times[1]), times[1]?.live], ['1:03', true], 'the active phase ticks from its start')
})

test('an older peer sends Preflight as one instant: the panel reads the gap it sits in, marked ~', () => {
  const ms = (s: number) => at(s) * 1000
  const phase = (title: string, state: string, startedAt: number | null, endedAt: number | null, commands = 0) => ({
    title,
    state,
    startedAt,
    endedAt,
    agents: [],
    hiddenAgents: 0,
    commands: { running: 0, done: commands, failed: 0 },
  })
  const run = {
    state: 'done',
    startedAt: ms(0),
    updatedAt: ms(4000),
    endedAt: ms(4000),
    phases: [
      phase('Preflight', 'done', ms(96), ms(96), 3),
      phase('Tasks', 'done', ms(100), ms(3900)),
      phase('Notes', 'done', ms(3900), ms(3900)),
      phase('Merge', 'skipped', null, null),
      phase('Ship', 'pending', null, null),
    ],
  }
  const times = lib.phaseTimes(run, ms(5000))
  // From the run's start (no phase before it) to Tasks' start: 100 s, not 0:00.
  assert.deepEqual([times[0]?.ms, times[0]?.approx, lib.phaseLabel(times[0])], [100_000, true, '~1:40'])
  assert.equal(lib.phaseLabel(times[1]), '1:03:20')
  // No commands, no agents, one instant: it really took no time.
  assert.equal(lib.phaseLabel(times[2]), '<1s')
  assert.equal(times[3], null, 'skipped phases show nothing')
  assert.equal(times[4], null, 'pending phases show nothing')

  // A gap under a second stays the instant it was; a live run with nothing after it yet too.
  const tight = { ...run, phases: [phase('Preflight', 'done', ms(0.2), ms(0.2), 1), phase('Tasks', 'active', ms(0.5), null)], state: 'running', endedAt: null }
  assert.equal(lib.phaseLabel(lib.phaseTimes(tight, ms(10))[0]), '<1s')
  const alone = { ...tight, phases: [phase('Preflight', 'done', ms(5), ms(5), 1)] }
  assert.equal(lib.phaseLabel(lib.phaseTimes(alone, ms(10))[0]), '<1s')
})

test('a paused run’s active phase stops where it paused; a live one counts up to now', () => {
  const run = (state: string) => ({
    state,
    startedAt: 0,
    updatedAt: 60_000,
    endedAt: null,
    phases: [{ title: 'Tasks', state: 'active', startedAt: 10_000, endedAt: null, agents: [], hiddenAgents: 0, commands: { running: 0, done: 0, failed: 0 } }],
  })
  assert.deepEqual(lib.phaseTimes(run('paused'), 600_000).map((t) => [t?.ms, t?.live]), [[50_000, false]])
  assert.deepEqual(lib.phaseTimes(run('waiting'), 600_000).map((t) => [t?.ms, t?.live]), [[590_000, true]])
})

test('the worker keeps the newest LOG_KEEP lines and counts the rest; the snapshot sends a few', () => {
  const events: Record<string, unknown>[] = [{ ts: at(0), type: 'run_started' }]
  for (let i = 0; i < LOG_KEEP + 120; i++) events.push({ ts: at(1 + i / 100), type: 'log', message: `line ${i}` })
  const { acc, view } = viewOf(events)
  assert.equal(view.log.length, 8, 'a live card still gets its short ticker')
  assert.equal(view.logCount, LOG_KEEP + 120)
  const full = acc.fullLog('r1')
  assert.equal(full.lines.length, LOG_KEEP)
  assert.equal(full.dropped, 120)
  assert.equal(full.lines[0].text, 'line 120')
  assert.equal(full.lines.at(-1)?.text, `line ${LOG_KEEP + 119}`, 'oldest first, newest at the bottom')
})

test('a peer’s run without logCount (older plugin) still reads, with its short log', () => {
  const old = normalizeRun({ id: 'r1', workflow: 'wf', state: 'running', startedAt: 1, log: [{ ts: 1, text: 'hello', tone: 'info' }] })
  assert.equal(old?.logCount, null)
  assert.deepEqual(old?.log.map((l) => l.text), ['hello'])
  assert.equal(normalizeRun({ id: 'r1', workflow: 'wf', state: 'running', startedAt: 1, logCount: 42 })?.logCount, 42)
})

test('a peer’s full log is checked line by line and capped at the newest 500', () => {
  const lines = Array.from({ length: 520 }, (_, i) => ({ ts: i, text: `l${i}`, tone: 'info' }))
  const log = normalizeLog({ lines: [...lines, { ts: 1, text: 42 }, 'junk'], dropped: 3 }, 'r1')
  assert.equal(log?.lines.length, 500)
  assert.equal(log?.lines[0].text, 'l20')
  assert.equal(log?.dropped, 3 + 20, 'the lines cut are counted as dropped; junk is not')
  assert.equal(normalizeLog({ nope: true }, 'r1'), null)
})

test('the full log of a run on a paired server is asked of that server; an older one says it cannot', async () => {
  const ok = (result: unknown): CliResult => ({ code: 0, stdout: JSON.stringify({ ok: true, result }), stderr: '' })
  const calls: string[][] = []
  let old = false
  const remote = new RemoteHosts({
    run: async (args) => {
      calls.push(args)
      if (args[0] === 'environment') return ok({ environments: [{ id: 'env-mini', name: 'Mac mini' }] })
      if (args[4] === 'watch.log') {
        if (old) return { code: 1, stdout: JSON.stringify({ ok: false, error: { code: 'plugin_request_failed', message: 'no handler', data: { requestCode: 'unknown_method' } } }), stderr: '' }
        return ok({ result: { runId: 'r1', lines: [{ ts: 1, text: 'a', tone: 'warn' }], dropped: 0 } })
      }
      return ok({ result: { runs: [] } })
    },
    pluginKey: () => 'local.odw-watch',
    wanted: () => 'auto',
    onChange: () => undefined,
  })
  await remote.tick(1_000_000)
  const log = await remote.runLog('env-mini', 'r1', 'agentprism')
  assert.deepEqual(log.lines, [{ ts: 1, text: 'a', tone: 'warn' }])
  const asked = calls.find((c) => c[4] === 'watch.log')!
  assert.equal(asked[asked.indexOf('--data') + 1], '{"runId":"r1","engine":"agentprism"}')
  assert.equal(asked[asked.indexOf('--environment') + 1], 'env-mini')
  old = true
  await assert.rejects(remote.runLog('env-mini', 'r1'), (e: Error & { code?: string }) => e.code === 'not_supported' && /older Workflow Watch/.test(e.message))
  await assert.rejects(remote.runLog('nowhere', 'r1'), (e: Error & { code?: string }) => e.code === 'invalid_params')
})

test('the open log takes the snapshot’s newer lines after the fetched ones, without doubling any', () => {
  const l = (ts: number, text: string) => ({ ts, text, tone: 'info' })
  const full = [l(1, 'a'), l(2, 'b'), l(3, 'c'), l(3, 'c')]
  assert.deepEqual(
    lib.mergeLog(full, [l(2, 'b'), l(3, 'c'), l(3, 'c'), l(3, 'c'), l(4, 'd')]).map((x) => `${x.ts}${x.text}`),
    ['1a', '2b', '3c', '3c', '3c', '4d'],
    'a third equal line in the same millisecond is a new line',
  )
  assert.deepEqual(lib.mergeLog([], [l(1, 'a')]).map((x) => x.text), ['a'])
  assert.equal(lib.mergeLog(full, [l(1, 'a')]).length, 4)
})

test('the open log follows new lines only while it is left at the bottom', () => {
  assert.equal(lib.atBottom(760, 240, 1000), true)
  assert.equal(lib.atBottom(754, 240, 1000), true, 'within a few pixels counts')
  assert.equal(lib.atBottom(600, 240, 1000), false, 'scrolled up: it stays put')
  assert.equal(lib.atBottom(0, 240, 120), true, 'a log shorter than its box')
})

test('the log dialog says what it shows: every line, the last 500 of more, loading, or why not', () => {
  const note = (o: Partial<Parameters<typeof lib.logNote>[0]>) => lib.logNote({ total: 0, shown: 0, dropped: 0, loading: false, error: null, ...o })
  assert.equal(note({ total: 42, shown: 42 }), 'All 42 events')
  assert.equal(note({ total: 1, shown: 1 }), 'All 1 event')
  assert.equal(note({ total: 642, shown: 500, dropped: 142 }), 'The last 500 · 142 older not kept')
  // The snapshot's newer lines can grow the count past what the worker said it dropped.
  assert.equal(note({ total: 1650, shown: 500, dropped: 1100 }), 'The last 500 · 1,150 older not kept')
  assert.equal(note({ total: 642, shown: 3, loading: true }), 'Loading…')
  assert.equal(note({ total: 642, shown: 3, error: 'Mac mini runs an older Workflow Watch, which sends only the latest lines' }), 'Mac mini runs an older Workflow Watch, which sends only the latest lines')
})
