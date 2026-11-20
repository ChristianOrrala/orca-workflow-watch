import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assembleRuns,
  assessBeacon,
  BEACON_INTERVAL_MS,
  BEACON_MAX_CHARS,
  BEACON_PREFIX,
  BeaconWriter,
  chunkLine,
  decodeRun,
  emptyTracker,
  encodeRun,
  ORCA_LOG_LINES,
  pickRecords,
  readBeaconLog,
  REWRITE_LINES,
  RUN_CHUNKS_MAX,
  runKey,
  SET_CHUNKS_MAX,
  split,
} from './beacon'
import { OdwSource } from './sources/odw'
import { AgentPrismSource } from './sources/agentprism'
import type { AgentView, RunView } from './protocol'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, '..', 'test', 'fixtures')
const quiet = () => {}
/** Real runs: an ODW dry run, ODW plan-flow runs, and AgentPrism runs in every ending. */
const realRuns = (): RunView[] => [
  ...new OdwSource(join(fixtures, 'odw-dry')).scan(12, quiet),
  ...new OdwSource(join(fixtures, 'plan-flow')).scan(12, quiet),
  ...new AgentPrismSource(join(fixtures, 'agentprism')).scan(12, quiet),
]

/** Orca's log as `plugin logs` answers it: the newest 200 lines, each { ts, level, line }. */
function orcaLog() {
  const lines: { ts: number; level: string; line: string }[] = []
  return {
    write: (line: string) => {
      // What Orca does to a worker's line: cut at 8192 characters, keep the newest 200.
      lines.push({ ts: Date.now(), level: 'info', line: line.slice(0, 8192) })
      if (lines.length > ORCA_LOG_LINES) lines.splice(0, lines.length - ORCA_LOG_LINES)
    },
    lines,
  }
}

/** A run with `n` agents in one phase, each with a long label, to force pieces. */
function bigRun(n: number, state: RunView['state'] = 'done'): RunView {
  const base = realRuns()[0]
  const agents: AgentView[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    label: `reviewer ${i + 1} · ${'checks the diff for correctness and style '.repeat(3)}`,
    phase: base.phases[0].title,
    state: i % 7 === 0 ? 'failed' : 'done',
    adapter: 'claude',
    model: 'claude-opus-5-5',
    startedAt: base.startedAt + i * 1000,
    endedAt: base.startedAt + i * 1000 + 60_000,
    tokens: 12_345 + i,
    attempts: 1,
    error: i % 7 === 0 ? 'exit 1: the reviewer timed out' : null,
  }))
  return { ...base, id: `big-${n}`, state, phases: [{ ...base.phases[0], agents, hiddenAgents: 0 }, ...base.phases.slice(1)], agents: { ...base.agents, total: n } }
}

test('every real run survives the record intact: what goes in comes out', () => {
  const runs = realRuns()
  assert.ok(runs.length >= 8, 'the fixtures hold ODW and AgentPrism runs')
  for (const run of runs) {
    const record = encodeRun(run)
    const back = decodeRun(JSON.parse(record.pieces.join('')))
    assert.deepEqual(back, run, `${run.engine}:${run.workflow}:${run.id}`)
    assert.equal(record.key, runKey(run))
  }
})

test('a record is compact: well under the size of the run as the panel gets it', () => {
  for (const run of realRuns()) {
    const record = encodeRun(run)
    const compact = record.pieces.join('').length
    assert.ok(compact < JSON.stringify(run).length * 0.75, `${run.workflow}: ${compact} vs ${JSON.stringify(run).length}`)
  }
})

test('a record that does not fit a line is cut into numbered pieces, each line under 4096', () => {
  const run = bigRun(50)
  const record = encodeRun(run)
  assert.ok(record.pieces.length > 1, 'a big run takes several pieces')
  assert.ok(record.pieces.length <= RUN_CHUNKS_MAX)
  record.pieces.forEach((piece, i) => assert.ok(chunkLine(record.hash, i, record.pieces.length, piece).length <= BEACON_MAX_CHARS))
  assert.deepEqual(decodeRun(JSON.parse(record.pieces.join(''))), run, 'joined in order, the pieces are the run')
})

test('a run too big for its pieces loses agent detail, never its totals', () => {
  const run = bigRun(400)
  const record = encodeRun(run)
  assert.ok(record.pieces.length <= RUN_CHUNKS_MAX)
  const back = decodeRun(JSON.parse(record.pieces.join('')))!
  assert.deepEqual(back.agents, run.agents)
  const kept = back.phases[0].agents.length
  assert.ok(kept < 400)
  assert.equal(kept + back.phases[0].hiddenAgents, 400, 'what is dropped is counted as hidden')
})

test('pieces never split a surrogate pair', () => {
  const text = 'a'.repeat(9) + '😀'.repeat(20)
  for (const max of [4, 5, 10, 11]) {
    const parts = split(text, max)
    assert.equal(parts.join(''), text)
    for (const p of parts) assert.ok(!/[\ud800-\udbff]$/.test(p), `max ${max}`)
  }
})

test('a reader joins only whole records, in any order, and skips what is not a beacon', () => {
  const record = encodeRun(bigRun(50))
  const n = record.pieces.length
  const line = (i: number) => ({ ts: 1, level: 'info', line: chunkLine(record.hash, i, n, record.pieces[i]) })
  const manifest = { ts: 1, level: 'info', line: `${BEACON_PREFIX}m ${JSON.stringify({ v: 1, b: 'abcd1234', q: 1, t: 1, iv: 10000, r: [[record.hash, n, record.key]] })}` }
  const pieces = Array.from({ length: n }, (_, i) => line(i))
  const shuffled = [...pieces].reverse()
  const whole = readBeaconLog([{ ts: 0, level: 'info', line: 'paired servers watched: Work' }, ...shuffled, manifest])
  assert.equal(whole.records.size, 1)
  assert.equal(assembleRuns(whole, new Map()).runs[0].id, 'big-50')
  // One piece scrolled out of Orca's 200 lines: the record is not whole, and nothing half-read shows.
  const partial = readBeaconLog([...pieces.slice(1), manifest])
  assert.equal(partial.records.size, 0)
  const { runs, missing } = assembleRuns(partial, new Map())
  assert.deepEqual([runs.length, missing], [0, 1])
})

test('a run whose record is not whole keeps its last version on screen, and the cache keeps only named runs', () => {
  const [a, b] = realRuns()
  const ra = encodeRun(a)
  const rb = encodeRun(b)
  const lines = [
    ...ra.pieces.map((p, i) => ({ line: chunkLine(ra.hash, i, ra.pieces.length, p) })),
    { line: `${BEACON_PREFIX}m ${JSON.stringify({ v: 1, b: 'ab', q: 2, t: 1, iv: 10000, r: [[ra.hash, ra.pieces.length, ra.key], [rb.hash, rb.pieces.length, rb.key]] })}` },
  ]
  const cache = new Map<string, RunView>([['0123456789abcdef', a]])
  const previous = new Map([[rb.key, b]])
  const { runs, missing } = assembleRuns(readBeaconLog(lines), cache, previous)
  assert.deepEqual(runs.map((r) => r.id), [a.id, b.id])
  assert.equal(missing, 1)
  assert.deepEqual([...cache.keys()], [ra.hash], 'a hash no manifest names is forgotten')
})

test('junk lines, wrong versions, bad hashes and lines Orca cut are ignored', () => {
  const good = encodeRun(realRuns()[0])
  const cut = chunkLine(good.hash, 0, 1, good.pieces[0]).slice(0, 50)
  const log = readBeaconLog([
    null,
    42,
    { line: 7 },
    { line: `${BEACON_PREFIX}m {not json` },
    { line: `${BEACON_PREFIX}m ${JSON.stringify({ v: 2, b: 'ab', q: 1, t: 1, r: [] })}` },
    { line: `${BEACON_PREFIX}c XYZ 0 1 {}` },
    { line: `${BEACON_PREFIX}c ${good.hash} 3 2 {}` },
    { line: cut },
    { line: `${BEACON_PREFIX}m ${JSON.stringify({ v: 1, b: 'ab', q: 1, t: 1, iv: 10000, r: [['nothex', 1, 'odw:x'], [good.hash, 1, 'odw:x']] })}` },
  ])
  assert.equal(log.manifest?.runs.length, 1)
  const { runs } = assembleRuns(log, new Map())
  assert.equal(runs.length, 0, 'a record cut short does not parse, so it does not show')
})

test('a newer worker’s beacon replaces the old one’s manifest', () => {
  const m = (b: string, q: number, r: unknown[]) => ({ line: `${BEACON_PREFIX}m ${JSON.stringify({ v: 1, b, q, t: 1, iv: 10000, r })}` })
  const h = (b: string, q: number) => ({ line: `${BEACON_PREFIX}h ${JSON.stringify({ v: 1, b, q, t: 2, iv: 10000 })}` })
  const log = readBeaconLog([m('aa', 5, [['0123456789abcdef', 1, 'odw:x']]), h('bb', 1)])
  assert.equal(log.latest?.boot, 'bb')
  assert.equal(log.manifest, null, 'the restarted worker has not said what it has yet')
})

test('the writer writes a change once, and only a heartbeat while nothing changes', () => {
  const log = orcaLog()
  const writer = new BeaconWriter({ write: log.write, boot: 'feed1234' })
  const runs = realRuns()
  let now = 1_000_000
  writer.update(runs, now)
  const first = log.lines.length
  const pieces = pickRecords(runs).reduce((n, r) => n + r.pieces.length, 0)
  assert.equal(first, pieces + 1, 'every record, then the manifest')
  assert.match(log.lines.at(-1)!.line, /^WWATCH1 m /)
  for (let i = 0; i < 30; i++) writer.update(runs, (now += 1000))
  const beats = log.lines.slice(first).map((l) => l.line.slice(0, 10))
  assert.deepEqual(beats, ['WWATCH1 h ', 'WWATCH1 h ', 'WWATCH1 h '], 'one heartbeat every 10 s')
  const all = readBeaconLog(log.lines)
  assert.equal(all.latest?.seq, 4)
  assert.deepEqual(assembleRuns(all, new Map()).runs, runs)
})

test('a live run’s change costs its own record and a manifest, at most every 2 s', () => {
  const log = orcaLog()
  const writer = new BeaconWriter({ write: log.write, boot: 'feed1234' })
  const runs = realRuns()
  let now = 1_000_000
  writer.update(runs, now)
  const before = log.lines.length
  const live = { ...runs[0], state: 'running' as const, endedAt: null, updatedAt: runs[0].updatedAt + 1 }
  writer.update([live, ...runs.slice(1)], (now += 500))
  assert.equal(log.lines.length, before, 'held back: the last write was 0.5 s ago')
  writer.tick((now += 1600))
  const added = log.lines.slice(before).map((l) => l.line.slice(0, 10))
  assert.deepEqual(added, [...encodeRun(live).pieces.map(() => 'WWATCH1 c '), 'WWATCH1 m '])
  assert.equal(assembleRuns(readBeaconLog(log.lines), new Map()).runs[0].state, 'running')
})

test('in Orca’s 200 lines a reader always finds every run, however long the log churns', () => {
  const log = orcaLog()
  const writer = new BeaconWriter({ write: log.write, boot: 'feed1234' })
  const finished = [...realRuns(), bigRun(50), bigRun(60)]
  let now = 1_000_000
  for (let step = 0; step < 2000; step++) {
    now += 1000
    // A live run that changes every second, and the worker's own messages now and then.
    const live: RunView = { ...finished[0], id: 'live', state: 'running', endedAt: null, updatedAt: now, logCount: step }
    writer.update([live, ...finished], now)
    if (step % 13 === 0) {
      writer.noteLine()
      log.write('a message of the worker')
    }
    if (step % 97 === 0) log.write('a line Orca added itself') // not counted by the writer
    if (step % 50 === 49) {
      const read = readBeaconLog(log.lines)
      const { runs, missing } = assembleRuns(read, new Map())
      assert.equal(missing, 0, `step ${step}: every record of the newest manifest is whole`)
      assert.equal(runs.length, finished.length + 1)
      assert.equal(runs[0].logCount >= step - 3, true, 'the live run is at most a couple of seconds old')
    }
  }
})

test('records are written again before the log’s cut-off reaches them', () => {
  const log = orcaLog()
  const writer = new BeaconWriter({ write: log.write, boot: 'feed1234' })
  const runs = realRuns()
  let now = 1_000_000
  writer.update(runs, now)
  for (let i = 0; i < REWRITE_LINES; i++) {
    writer.noteLine()
    log.write(`message ${i}`)
  }
  writer.update(runs, (now += 3000))
  const firstHash = pickRecords(runs)[0].hash
  const copies = log.lines.filter((l) => l.line.startsWith(`${BEACON_PREFIX}c ${firstHash}`)).length
  assert.equal(copies, 2, 'written again in the same 200 lines')
})

test('a manifest names at most 60 pieces: the oldest finished runs are left out, live ones never', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...bigRun(50), id: `big-${i}` }))
  const live = { ...bigRun(50, 'running'), id: 'live' }
  const records = pickRecords([live, ...many])
  assert.equal(records[0].key, runKey(live))
  assert.ok(records.reduce((n, r) => n + r.pieces.length, 0) <= SET_CHUNKS_MAX)
  assert.ok(records.length < 31)
})

test('a beacon is fresh while it moves; stale after 3 intervals still', () => {
  const at = (seq: number, t: number) => ({ boot: 'aa', seq, t, intervalMs: BEACON_INTERVAL_MS })
  let tracker = emptyTracker()
  let now = 5_000_000
  let r = assessBeacon(at(1, now - 2000), tracker, now)
  assert.equal(r.fresh, true, 'first seen, current by its own clock')
  tracker = r.tracker
  now += 10_000
  r = assessBeacon(at(2, now), tracker, now)
  assert.equal(r.fresh, true)
  tracker = r.tracker
  now += 29_000
  assert.equal(assessBeacon(at(2, 0), tracker, now).fresh, true, 'not yet 3 intervals')
  now += 2_000
  assert.equal(assessBeacon(at(2, 0), tracker, now).fresh, false, 'over 30 s without moving')
  assert.equal(assessBeacon(at(2, 0), tracker, now, 3000).fresh, true, 'a reader that waits 3 s between reads allows for it')
  assert.equal(assessBeacon(null, tracker, now).fresh, false)
})

test('a server clock that disagrees does not matter once the beacon is seen moving', () => {
  let now = 5_000_000
  const skewed = (seq: number) => ({ boot: 'aa', seq, t: now - 3_600_000, intervalMs: BEACON_INTERVAL_MS })
  let r = assessBeacon(skewed(1), emptyTracker(), now)
  assert.equal(r.fresh, false, 'an hour old by its clock: not taken on trust')
  now += 10_000
  r = assessBeacon(skewed(1), r.tracker, now)
  assert.equal(r.fresh, false, 'and it has not moved: a stopped worker')
  now += 10_000
  r = assessBeacon(skewed(2), r.tracker, now)
  assert.equal(r.fresh, true, 'it moved: alive, whatever its clock says')
  // A restarted worker (another boot, or its sequence back at 1) counts as moving.
  now += 10_000
  assert.equal(assessBeacon({ ...skewed(1), boot: 'bb' }, r.tracker, now).fresh, true)
})
