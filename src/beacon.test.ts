import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assembleRuns,
  assembleTail,
  assessBeacon,
  BEACON_INTERVAL_MS,
  BEACON_MAX_CHARS,
  BEACON_PREFIX,
  BeaconWriter,
  chunkLine,
  decodeRun,
  decodeTail,
  emptyTracker,
  encodeRun,
  encodeTail,
  newestRun,
  ORCA_LOG_LINES,
  ORCA_SPARE_LINES,
  pickRecords,
  readBeaconLog,
  REWRITE_LINES,
  RUN_CHUNKS_MAX,
  runKey,
  SET_CHUNKS_MAX,
  split,
  TAIL_CHUNKS_MAX,
  TAIL_EVENTS,
  tailLine,
} from './beacon'
import { OdwSource } from './sources/odw'
import { AgentPrismSource } from './sources/agentprism'
import type { AgentView, LogLine, RunView } from './protocol'

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

test('a manifest names at most 54 run pieces: the oldest finished runs are left out, live ones never', () => {
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

// ── The newest run's tail (0.4.1) ──────────────────────

/** `n` log events, each `width` characters long. */
const events = (n: number, width = 400, start = 1_795_000_000_000): LogLine[] =>
  Array.from({ length: n }, (_, i) => ({ ts: start + i * 250, text: `event ${i} `.padEnd(width, 'x'), tone: i % 9 === 0 ? 'warn' : 'info' }))

test('the budget: the newest manifest, its run records and the tail always fit in Orca’s 200 lines', () => {
  // A record the manifest names is under REWRITE_LINES old when a write starts; one write is every
  // run piece, every tail piece and the manifest. What is left stays free for Orca's own lines.
  const write = SET_CHUNKS_MAX + TAIL_CHUNKS_MAX + 1
  assert.ok(REWRITE_LINES + write <= ORCA_LOG_LINES - ORCA_SPARE_LINES, `${REWRITE_LINES} + ${write} lines leave ${ORCA_SPARE_LINES} spare`)
  assert.equal(REWRITE_LINES + write, 151, 'the same 151 lines as 0.4.0: the tail’s pieces came out of SET_CHUNKS_MAX')
  // And 50 plain events of 400 characters fit the tail's pieces whole.
  const tail = encodeTail({ ...realRuns()[0], logCount: 500 }, events(500))
  assert.ok(tail.pieces.length <= TAIL_CHUNKS_MAX)
  assert.equal(decodeTail(JSON.parse(tail.pieces.join('')))!.lines.length, TAIL_EVENTS)
})

test('a tail is the newest run’s last 50 events, each clipped at 400, and comes back as it went', () => {
  const run = { ...realRuns()[0], logCount: 873 }
  const log = events(500, 600)
  const record = encodeTail(run, log)
  assert.equal(record.key, runKey(run))
  assert.ok(record.pieces.length > 1 && record.pieces.length <= TAIL_CHUNKS_MAX, `${record.pieces.length} pieces`)
  for (const [i, piece] of record.pieces.entries()) assert.ok(tailLine(record.hash, i, record.pieces.length, piece).length < BEACON_MAX_CHARS)
  const back = decodeTail(JSON.parse(record.pieces.join('')))!
  assert.equal(back.key, runKey(run))
  assert.equal(back.total, 873, 'the total the run counted, not the 50')
  assert.deepEqual(back.lines, log.slice(-TAIL_EVENTS).map((l) => ({ ...l, text: l.text.slice(0, 400) })))
  // A short log is all there.
  const short = decodeTail(JSON.parse(encodeTail({ ...run, logCount: 3 }, events(3)).pieces.join('')))!
  assert.deepEqual([short.total, short.lines.length], [3, 3])
})

test('a tail that escapes badly is clipped harder to keep its 50 events within its pieces cap', () => {
  const run = { ...realRuns()[0], logCount: 50 }
  // Every character a JSON \u escape: 6 characters each.
  const nasty = events(50).map((l) => ({ ...l, text: '\u0001'.repeat(400) }))
  const record = encodeTail(run, nasty)
  assert.ok(record.pieces.length <= TAIL_CHUNKS_MAX)
  const back = decodeTail(JSON.parse(record.pieces.join('')))!
  assert.equal(back.lines.length, TAIL_EVENTS, 'clipped to 40 escaped characters, all 50 still fit')
  assert.ok(back.lines.every((l) => l.text.length === 40))
})

test('the newest run is the one started last, live or ended', () => {
  const [a, b] = realRuns()
  const live = { ...a, state: 'running' as const, startedAt: 1000 }
  const ended = { ...b, state: 'done' as const, startedAt: 2000 }
  assert.equal(newestRun([live, ended]), ended)
  assert.equal(newestRun([]), null)
})

test('a reader joins only whole tails, of their own line kind, and only the one the manifest names', () => {
  const writer = orcaLog()
  const runs = realRuns()
  const newest = newestRun(runs)!
  const log = events(80)
  new BeaconWriter({ write: writer.write, boot: 'feed1234' }).update(runs, 1_000_000, (r) => (r === newest ? log : null))
  const tailLines = writer.lines.filter((l) => l.line.startsWith(`${BEACON_PREFIX}t `))
  assert.ok(tailLines.length >= 2)
  const read = readBeaconLog(writer.lines)
  assert.equal(read.manifest?.tail?.[2], runKey(newest))
  assert.equal(read.records.has(read.manifest!.tail![0]), false, 'a tail is not a run record')
  const tail = assembleTail(read)!
  assert.deepEqual([tail.key, tail.lines.length, tail.lines.at(-1)!.text.slice(0, 9)], [runKey(newest), 50, 'event 79 '])
  // The runs come across as before.
  assert.deepEqual(assembleRuns(read, new Map()).runs, runs)
  // One piece missing: no tail, unless the last one shown was of the same run.
  const holed = writer.lines.filter((l) => l !== tailLines[0])
  assert.equal(assembleTail(readBeaconLog(holed)), null)
  assert.equal(assembleTail(readBeaconLog(holed), tail), tail)
  assert.equal(assembleTail(readBeaconLog(holed), { ...tail, key: 'odw:other' }), null)
  // Shuffled pieces still join.
  const isManifest = (l: { line: string }) => l.line.startsWith(`${BEACON_PREFIX}m `)
  const shuffled = [...writer.lines].reverse().filter((l) => !isManifest(l)).concat(writer.lines.filter(isManifest))
  assert.equal(assembleTail(readBeaconLog(shuffled))?.lines.length, 50)
})

test('the tail is written again when the newest run changes or its log grows, and not otherwise', () => {
  const out = orcaLog()
  const writer = new BeaconWriter({ write: out.write, boot: 'feed1234' })
  const runs = realRuns()
  const newest = newestRun(runs)!
  let log = events(10)
  let asked = 0
  const fullLog = (r: RunView) => {
    asked++
    return r === newest || runKey(r) === runKey(newest) ? log : null
  }
  let now = 1_000_000
  writer.update(runs, now, fullLog)
  // Tails written: their first pieces.
  const tails = () => out.lines.filter((l) => /^WWATCH1 t [0-9a-f]{16} 0 /.test(l.line)).length
  assert.equal(tails(), 1)
  for (let i = 0; i < 20; i++) writer.update(runs, (now += 1000), fullLog)
  assert.equal(tails(), 1, 'nothing changed: heartbeats only')
  assert.equal(asked, 1, 'the log is read again only when the run moved')
  // Its log grows: the run's record moves, and so does its tail.
  log = events(11)
  const grown = runs.map((r) => (r === newest ? { ...r, logCount: 11, updatedAt: r.updatedAt + 1, log: [...r.log, log[10]] } : r))
  writer.update(grown, (now += 3000), fullLog)
  assert.equal(tails(), 2)
  assert.equal(assembleTail(readBeaconLog(out.lines))!.lines.at(-1)!.text.slice(0, 9), 'event 10 ')
  // A newer run starts: the tail is its.
  const next: RunView = { ...newest, id: 'started-later', startedAt: newest.startedAt + 60_000, state: 'running', endedAt: null, logCount: 2, log: [] }
  writer.update([next, ...grown], (now += 3000), (r) => (r.id === 'started-later' ? events(2) : null))
  assert.equal(assembleTail(readBeaconLog(out.lines))!.key, runKey(next))
})

test('in Orca’s 200 lines a reader always finds every run and the newest run’s whole tail, however long the log churns', () => {
  const log = orcaLog()
  const writer = new BeaconWriter({ write: log.write, boot: 'feed1234' })
  const finished = [...realRuns(), bigRun(50), bigRun(60)]
  const full = events(500)
  let now = 1_000_000
  for (let step = 0; step < 2000; step++) {
    now += 1000
    // A live run, started last, whose log grows by a long event every second.
    const lines = full.slice(0, Math.min(500, step + 1)).map((l, i) => ({ ...l, text: `${step - i} ${l.text}` }))
    const live: RunView = { ...finished[0], id: 'live', state: 'running', startedAt: Math.max(...finished.map((r) => r.startedAt)) + 1000, endedAt: null, updatedAt: now, logCount: step + 1, log: lines.slice(-3) }
    writer.update([live, ...finished], now, (r) => (r.id === 'live' ? lines : null))
    if (step % 13 === 0) {
      writer.noteLine()
      log.write('a message of the worker')
    }
    if (step % 97 === 0) log.write('a line Orca added itself')
    if (step % 50 === 49) {
      const read = readBeaconLog(log.lines)
      const { runs, missing } = assembleRuns(read, new Map())
      assert.equal(missing, 0, `step ${step}: every record of the newest manifest is whole`)
      assert.equal(runs.length, finished.length + 1)
      const tail = assembleTail(read)
      assert.ok(tail, `step ${step}: the tail is whole`)
      assert.equal(tail.key, 'odw:live')
      assert.equal(tail.lines.length, step < TAIL_EVENTS ? tail.total : TAIL_EVENTS, 'every event while there are fewer than 50, then the last 50')
      assert.ok(tail.total >= step - 3, 'the tail is at most a couple of seconds old')
    }
  }
})
