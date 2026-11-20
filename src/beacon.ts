// The beacon: how a computer's runs reach its paired desktops. Each worker writes its own runs
// into its plugin log, and a desktop reads them back with
// `orca plugin logs <key> --environment <id> --json`, which, unlike `orca plugin dev request`,
// reaches a plugin installed from a catalog.
//
// What bounds the design (Orca 1.4.265): Orca keeps the newest 200 log lines of each plugin, cuts
// a line at 8192 characters without saying so, and `plugin logs` answers all 200 lines every
// time (the CLI passes no cursor). So:
//
// - every line stays under BEACON_MAX_CHARS (4096) and starts with BEACON_PREFIX;
// - each run is its own record, content-addressed: a hash of its encoded form names it, and a
//   record that does not fit one line is split into numbered pieces (`c <hash> <i> <n> <piece>`).
//   A reader joins only a record whose every piece it holds. Two copies of a record are the same
//   bytes, so pieces from either copy fit together;
// - a manifest line (`m`) lists the records that make up this computer's runs now, with a boot id
//   (one per worker start) and a sequence number. A heartbeat line (`h`) moves the sequence on
//   when nothing changed, at least every BEACON_INTERVAL_MS, so a reader can tell a quiet computer
//   from a stopped worker;
// - only what changed is written: a live run's update costs its own record and a manifest, not
//   the whole history. Every record and the manifest are written again before REWRITE_LINES of
//   this worker's lines have gone by, and the total a manifest names is capped at SET_CHUNKS_MAX,
//   so a reader always finds every record of the newest manifest inside the 200 lines.
//
// Not published: what an agent was asked and answered, and a run's full log (up to 500 lines).
// They are too big to keep in 200 lines, and no Orca CLI call carries a request to an installed
// plugin. A paired server whose copy is a development folder still answers them on demand
// through `orca plugin dev request`; any other shows where to read them.
import { createHash, randomBytes } from 'node:crypto'
import type { AgentView, LogLine, PhaseView, RunView } from './protocol'
import { isLive } from './model'
import { normalizeRun } from './wire'

export const BEACON_PREFIX = 'WWATCH1 '
export const BEACON_VERSION = 1
/** Orca cuts a worker log line at 8192 characters; stay well under that. */
export const BEACON_MAX_CHARS = 4096
/** A manifest or heartbeat at least this often. */
export const BEACON_INTERVAL_MS = 10_000
/** A beacon that has not moved on for this many intervals is stale. */
export const BEACON_STALE_INTERVALS = 3
/** Changes are written at most this often: a live run changes every second. */
export const BEACON_MIN_GAP_MS = 2_000
/** Orca keeps this many log lines per plugin (its `plugin logs` buffer). */
export const ORCA_LOG_LINES = 200
/**
 * A record or manifest is written again once this many of this worker's lines went by since it
 * was. With SET_CHUNKS_MAX more written in one go, that leaves room in the 200 for the lines
 * Orca adds to the log itself (a failed host call, say).
 */
export const REWRITE_LINES = 90
/** And at least this often, for the lines this worker cannot count. */
export const REWRITE_MS = 10 * 60_000
/** The most pieces one run may take; a bigger one is trimmed first (see encodeRun). */
export const RUN_CHUNKS_MAX = 8
/** The most pieces one manifest may name: the oldest finished runs are left out past it. */
export const SET_CHUNKS_MAX = 60
/** The most runs one manifest may name. */
export const SET_RUNS_MAX = 60
const PIECE_MAX = BEACON_MAX_CHARS - 64

// ── The run record ─────────────────────────────────────
// Short keys, times relative to the run's start (`a`), optional fields left out.

const RUN_STATES = ['running', 'waiting', 'paused', 'done', 'failed', 'stopped', 'lost'] as const
const PHASE_STATES = ['pending', 'active', 'done', 'failed', 'skipped'] as const
const AGENT_STATES = ['running', 'done', 'failed'] as const
const TONES = ['info', 'warn', 'error', 'success'] as const
const OUTCOME_TONES = ['ok', 'attention', 'bad', 'neutral'] as const

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const clip = (text: string | null, max: number): string | null => (text !== null && text.length > max ? text.slice(0, max) : text)
const rel = (t: number | null, base: number): number | null => (t === null ? null : t - base)
const abs = (t: unknown, base: number): number | null => (typeof t === 'number' && Number.isFinite(t) ? base + t : null)
const code = <T extends string>(values: readonly T[], v: T): number => Math.max(0, values.indexOf(v))
const fromCode = <T extends string>(values: readonly T[], v: unknown, fallback: T): T => (typeof v === 'number' && values[v] !== undefined ? values[v] : fallback)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** [id, label, state, adapter, model, start, end, tokens, attempts, error] */
function agentWire(a: AgentView, base: number): unknown[] {
  return [a.id, clip(a.label, 200), code(AGENT_STATES, a.state), a.adapter, a.model, a.startedAt - base, rel(a.endedAt, base), a.tokens, a.attempts, clip(a.error, 400)]
}

/** [title, detail, state, start, end, agents, hidden, [running, done, failed]] */
function phaseWire(p: PhaseView, base: number): unknown[] {
  const c = p.commands
  return [clip(p.title, 200), clip(p.detail, 400), code(PHASE_STATES, p.state), rel(p.startedAt, base), rel(p.endedAt, base), p.agents.map((a) => agentWire(a, base)), p.hiddenAgents, [c.running, c.done, c.failed]]
}

/** A run as its beacon record: the JSON object a reader decodes with decodeRun. */
export function runWire(run: RunView): Obj {
  const a = run.startedAt
  const w: Obj = {
    i: run.id,
    w: run.workflow,
    s: code(RUN_STATES, run.state),
    a,
    u: run.updatedAt - a,
    p: run.phases.map((p) => phaseWire(p, a)),
    ag: [run.agents.total, run.agents.running, run.agents.done, run.agents.failed],
    tk: [run.tokens.spent, run.tokens.budget],
    l: run.log.map((l: LogLine) => [l.ts - a, clip(l.text, 400), code(TONES, l.tone)]),
    lc: run.logCount,
  }
  if (run.engine !== 'odw') w.g = run.engine
  if (run.description) w.ds = clip(run.description, 400)
  if (run.endedAt !== null) w.e = run.endedAt - a
  if (run.source) w.sc = run.source
  if (run.subject) w.sj = run.subject
  if (run.subjectLabel) w.sl = clip(run.subjectLabel, 200)
  if (run.dry) w.dr = 1
  if (run.adapter) w.ad = run.adapter
  if (run.waiting) w.wt = [clip(run.waiting.title, 160), run.waiting.since - a, run.waiting.checkpointId]
  if (run.checkpoints.length) w.cp = run.checkpoints.slice(-24).map((c) => [clip(c.title, 160), c.since - a, rel(c.until, a)])
  if (run.answer) w.an = [clip(run.answer.copy, 2000), clip(run.answer.how, 600)]
  if (run.error) w.er = clip(run.error, 600)
  if (run.outcome) w.oc = [run.outcome.status.slice(0, 80), code(OUTCOME_TONES, run.outcome.tone), clip(run.outcome.text, 400)]
  return w
}

function agentFrom(v: unknown, base: number, phase: string): Obj | null {
  const a = arr(v)
  if (typeof a[0] !== 'number') return null
  return {
    id: a[0],
    label: a[1],
    phase,
    state: fromCode(AGENT_STATES, a[2], 'done'),
    adapter: a[3] ?? null,
    model: a[4] ?? null,
    startedAt: abs(a[5], base) ?? base,
    endedAt: abs(a[6], base),
    tokens: a[7] ?? null,
    attempts: a[8] ?? null,
    error: a[9] ?? null,
  }
}

/** A beacon record back into a RunView, checked like any peer's run; null when it is not one. */
export function decodeRun(v: unknown): RunView | null {
  if (!isObj(v) || typeof v.a !== 'number' || !Number.isFinite(v.a)) return null
  const a = v.a
  const tk = arr(v.tk)
  const ag = arr(v.ag)
  const wt = Array.isArray(v.wt) ? v.wt : null
  const an = Array.isArray(v.an) ? v.an : null
  const oc = Array.isArray(v.oc) ? v.oc : null
  return normalizeRun({
    id: v.i,
    engine: v.g ?? 'odw',
    host: null,
    hostName: null,
    workflow: v.w,
    description: v.ds ?? null,
    state: fromCode(RUN_STATES, v.s, 'done'),
    startedAt: a,
    updatedAt: abs(v.u, a) ?? a,
    endedAt: abs(v.e, a),
    source: v.sc ?? null,
    subject: v.sj ?? null,
    subjectLabel: v.sl ?? null,
    dry: v.dr === 1,
    adapter: v.ad ?? null,
    phases: arr(v.p).map((raw) => {
      const p = arr(raw)
      const title = typeof p[0] === 'string' ? p[0] : ''
      const c = arr(p[7])
      return {
        title,
        detail: p[1] ?? null,
        state: fromCode(PHASE_STATES, p[2], 'pending'),
        startedAt: abs(p[3], a),
        endedAt: abs(p[4], a),
        agents: arr(p[5]).map((x) => agentFrom(x, a, title)).filter(Boolean),
        hiddenAgents: p[6],
        commands: { running: c[0], done: c[1], failed: c[2] },
      }
    }),
    agents: { total: ag[0], running: ag[1], done: ag[2], failed: ag[3] },
    tokens: { spent: tk[0], budget: tk[1] ?? null },
    log: arr(v.l).map((raw) => {
      const l = arr(raw)
      return { ts: abs(l[0], a), text: l[1], tone: fromCode(TONES, l[2], 'info') }
    }),
    logCount: v.lc,
    waiting: wt ? { title: wt[0], since: abs(wt[1], a), checkpointId: typeof wt[2] === 'number' ? wt[2] : null } : null,
    checkpoints: arr(v.cp).map((raw) => {
      const c = arr(raw)
      return { title: c[0], since: abs(c[1], a), until: abs(c[2], a) }
    }),
    answer: an ? { copy: an[0], how: an[1] } : null,
    error: v.er ?? null,
    outcome: oc ? { status: oc[0], tone: fromCode(OUTCOME_TONES, oc[1], 'neutral'), text: oc[2] ?? null } : null,
  })
}

// ── Pieces ─────────────────────────────────────────────

export interface RunRecord {
  /** `<engine>:<run id>`, how the manifest names the run. */
  key: string
  hash: string
  pieces: string[]
}

/** Text cut into pieces of at most `max` characters, never between the halves of a surrogate pair. */
export function split(text: string, max = PIECE_MAX): string[] {
  const out: string[] = []
  let at = 0
  while (at < text.length) {
    let end = Math.min(text.length, at + max)
    const last = text.charCodeAt(end - 1)
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--
    out.push(text.slice(at, end))
    at = end
  }
  return out.length ? out : ['']
}

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)
export const runKey = (run: RunView) => `${run.engine ?? 'odw'}:${run.id}`

/** Agents kept in a trimmed record: the ones still at work or failed, first. */
function slimPhases(run: RunView, keep: (a: AgentView, p: PhaseView) => boolean): RunView {
  return {
    ...run,
    phases: run.phases.map((p) => {
      const agents = p.agents.filter((a) => keep(a, p))
      return { ...p, agents, hiddenAgents: p.hiddenAgents + p.agents.length - agents.length }
    }),
  }
}

/**
 * A run as one record of at most RUN_CHUNKS_MAX pieces. One too big loses detail in steps: the
 * agents of finished phases, then every finished agent and most of its log, then every agent.
 * The run's totals stay exact in every step.
 */
export function encodeRun(run: RunView): RunRecord {
  const steps: (() => RunView)[] = [
    () => run,
    () => slimPhases(run, (a, p) => a.state !== 'done' || p.state === 'active' || p.state === 'pending'),
    () => ({ ...slimPhases(run, (a) => a.state !== 'done'), log: run.log.slice(-3) }),
    () => ({ ...slimPhases(run, () => false), log: run.log.slice(-2), description: clip(run.description, 120), error: clip(run.error, 200) }),
  ]
  let text = ''
  for (const step of steps) {
    text = JSON.stringify(runWire(step()))
    if (Math.ceil(text.length / PIECE_MAX) <= RUN_CHUNKS_MAX) break
  }
  const pieces = split(text).slice(0, RUN_CHUNKS_MAX)
  return { key: runKey(run), hash: hashOf(text), pieces }
}

export function chunkLine(hash: string, index: number, count: number, piece: string): string {
  return `${BEACON_PREFIX}c ${hash} ${index} ${count} ${piece}`
}

// ── Writing ────────────────────────────────────────────

export interface Manifest {
  boot: string
  seq: number
  t: number
  intervalMs: number
  /** [hash, pieces, key] for each run, live ones first. */
  runs: [string, number, string][]
}

function manifestLine(m: Manifest): string {
  const base = { v: BEACON_VERSION, b: m.boot, q: m.seq, t: m.t, iv: m.intervalMs }
  const runs = [...m.runs]
  // Never longer than a line: the oldest entries go (the caller has already capped the count).
  let line = `${BEACON_PREFIX}m ${JSON.stringify({ ...base, r: runs })}`
  while (line.length > BEACON_MAX_CHARS && runs.length) {
    runs.pop()
    line = `${BEACON_PREFIX}m ${JSON.stringify({ ...base, r: runs })}`
  }
  return line
}

function heartbeatLine(boot: string, seq: number, t: number, intervalMs: number): string {
  return `${BEACON_PREFIX}h ${JSON.stringify({ v: BEACON_VERSION, b: boot, q: seq, t, iv: intervalMs })}`
}

/**
 * Which runs a manifest names: live ones first (they come first in `runs`), then the newest
 * finished ones, within SET_RUNS_MAX runs and SET_CHUNKS_MAX pieces.
 */
export function pickRecords(runs: RunView[]): RunRecord[] {
  const out: RunRecord[] = []
  let pieces = 0
  for (const run of runs) {
    if (out.length >= SET_RUNS_MAX) break
    const record = encodeRun(run)
    if (pieces + record.pieces.length > SET_CHUNKS_MAX && !isLive(run.state)) continue
    out.push(record)
    pieces += record.pieces.length
  }
  return out
}

/** Writes this computer's runs into its plugin log, as little as keeps a reader whole. */
export class BeaconWriter {
  readonly boot: string
  private seq = 0
  /** This worker's log lines so far, beacon or not (`noteLine` counts the others). */
  private lines = 0
  private written = new Map<string, { line: number; at: number }>()
  private manifest: { key: string; line: number; at: number } | null = null
  private lastBeat = 0
  private lastWrite = -Infinity
  private pending: RunRecord[] | null = null
  private readonly write: (line: string) => void
  private readonly intervalMs: number

  constructor(opts: { write: (line: string) => void; boot?: string; intervalMs?: number }) {
    this.write = opts.write
    this.boot = opts.boot ?? randomBytes(4).toString('hex')
    this.intervalMs = opts.intervalMs ?? BEACON_INTERVAL_MS
  }

  /** A line this worker logged that is not a beacon: it moves records toward Orca's cut-off too. */
  noteLine(): void {
    this.lines++
  }

  private emit(line: string): void {
    this.lines++
    this.write(line)
  }

  /** This computer's runs now (live first, then newest), as the worker scanned them. */
  update(runs: RunView[], now = Date.now()): void {
    this.pending = pickRecords(runs)
    this.tick(now)
  }

  /** Writes what is due: changes (at most every BEACON_MIN_GAP_MS), rewrites, the heartbeat. */
  tick(now = Date.now()): void {
    const records = this.pending
    if (!records) return
    const key = JSON.stringify(records.map((r) => r.hash))
    const old = (mark: { line: number; at: number }) => this.lines - mark.line >= REWRITE_LINES || now - mark.at >= REWRITE_MS
    const changed = !this.manifest || this.manifest.key !== key
    const rewrite = !changed && (old(this.manifest!) || records.some((r) => !this.written.has(r.hash) || old(this.written.get(r.hash)!)))
    if ((changed || rewrite) && now - this.lastWrite >= BEACON_MIN_GAP_MS) {
      for (const record of records) {
        const mark = this.written.get(record.hash)
        if (mark && !old(mark)) continue
        record.pieces.forEach((piece, i) => this.emit(chunkLine(record.hash, i, record.pieces.length, piece)))
        this.written.set(record.hash, { line: this.lines, at: now })
      }
      // Pieces first, then the manifest that names them.
      this.emit(manifestLine({ boot: this.boot, seq: ++this.seq, t: now, intervalMs: this.intervalMs, runs: records.map((r) => [r.hash, r.pieces.length, r.key]) }))
      this.manifest = { key, line: this.lines, at: now }
      this.lastBeat = now
      this.lastWrite = now
      // Forget what the manifest no longer names.
      const named = new Set(records.map((r) => r.hash))
      for (const hash of [...this.written.keys()]) if (!named.has(hash)) this.written.delete(hash)
      return
    }
    if (now - this.lastBeat >= this.intervalMs) {
      this.emit(heartbeatLine(this.boot, ++this.seq, now, this.intervalMs))
      this.lastBeat = now
    }
  }
}

// ── Reading ────────────────────────────────────────────

export interface BeaconLog {
  /** The newest manifest or heartbeat of the worker that wrote last: what says it is alive. */
  latest: { boot: string; seq: number; t: number; intervalMs: number } | null
  /** The newest manifest of that worker. */
  manifest: Manifest | null
  /** Every record held whole, by hash, as its joined text. */
  records: Map<string, string>
}

const HASH = /^[0-9a-f]{16}$/
const BOOT = /^[0-9a-f]{1,32}$/

function header(raw: unknown): { boot: string; seq: number; t: number; intervalMs: number } | null {
  if (!isObj(raw) || raw.v !== BEACON_VERSION) return null
  const { b, q, t, iv } = raw
  if (typeof b !== 'string' || !BOOT.test(b) || !Number.isSafeInteger(q) || typeof t !== 'number' || !Number.isFinite(t)) return null
  const intervalMs = typeof iv === 'number' && Number.isFinite(iv) && iv >= 1000 && iv <= 600_000 ? iv : BEACON_INTERVAL_MS
  return { boot: b, seq: q as number, t, intervalMs }
}

/**
 * The beacon in a `plugin logs` answer's lines ({ ts, level, line }). Orca keeps a plugin's lines
 * in the order they were written, so the last manifest or heartbeat is the newest whatever the
 * writer's clock says. Lines that are not beacons (the worker's own messages) are skipped.
 */
export function readBeaconLog(lines: readonly unknown[]): BeaconLog {
  const pieces = new Map<string, { count: number; parts: (string | undefined)[] }>()
  let latest: BeaconLog['latest'] = null
  let manifest: Manifest | null = null
  for (const entry of lines.slice(-ORCA_LOG_LINES * 2)) {
    const line = isObj(entry) ? entry.line : null
    if (typeof line !== 'string' || !line.startsWith(BEACON_PREFIX) || line.length > 8192) continue
    const body = line.slice(BEACON_PREFIX.length)
    const kind = body.slice(0, 2)
    if (kind === 'c ') {
      const m = /^c ([0-9a-f]{16}) (\d{1,3}) (\d{1,3}) /.exec(body)
      if (!m) continue
      const [, hash, i, n] = m
      const index = Number(i)
      const count = Number(n)
      if (count < 1 || count > RUN_CHUNKS_MAX || index >= count) continue
      let set = pieces.get(hash)
      if (!set || set.count !== count) {
        set = { count, parts: [] }
        pieces.set(hash, set)
      }
      set.parts[index] = body.slice(m[0].length)
      continue
    }
    if (kind !== 'm ' && kind !== 'h ') continue
    let raw: unknown
    try {
      raw = JSON.parse(body.slice(2))
    } catch {
      continue
    }
    const head = header(raw)
    if (!head) continue
    // A newer worker started: what the old one said no longer counts.
    if (latest && head.boot !== latest.boot) manifest = null
    latest = head
    if (kind === 'm ') {
      const runs: [string, number, string][] = []
      for (const r of arr((raw as Obj).r).slice(0, SET_RUNS_MAX)) {
        const [hash, count, key] = arr(r)
        if (typeof hash === 'string' && HASH.test(hash) && Number.isSafeInteger(count) && (count as number) >= 1 && typeof key === 'string' && key.length <= 240)
          runs.push([hash, count as number, key])
      }
      manifest = { ...head, runs }
    }
  }
  const records = new Map<string, string>()
  for (const [hash, set] of pieces) {
    let whole = true
    for (let i = 0; i < set.count; i++) if (set.parts[i] === undefined) whole = false
    if (whole) records.set(hash, set.parts.join(''))
  }
  return { latest, manifest, records }
}

/**
 * The runs a manifest names, from the records in the log or from `cache` (runs decoded before,
 * by hash). A record the log does not hold whole is taken from `previous` (the runs shown last
 * time, by key), so a run never blinks out while its record is being rewritten. `cache` is
 * left holding only what the manifest names.
 */
export function assembleRuns(log: BeaconLog, cache: Map<string, RunView>, previous: Map<string, RunView> = new Map()): { runs: RunView[]; missing: number } {
  const runs: RunView[] = []
  let missing = 0
  const named = new Set<string>()
  for (const [hash, , key] of log.manifest?.runs ?? []) {
    named.add(hash)
    let run = cache.get(hash) ?? null
    if (!run) {
      const text = log.records.get(hash)
      if (text !== undefined) {
        try {
          run = decodeRun(JSON.parse(text))
        } catch {
          run = null
        }
        if (run) cache.set(hash, run)
      }
    }
    if (!run) {
      missing++
      run = previous.get(key) ?? null
    }
    if (run) runs.push(run)
  }
  for (const hash of [...cache.keys()]) if (!named.has(hash)) cache.delete(hash)
  return { runs, missing }
}

export interface BeaconTracker {
  boot: string | null
  seq: number | null
  /** This computer's clock when the beacon last moved on. */
  advancedAt: number | null
  /** Seen moving, or current by the writer's clock when first seen. */
  confirmed: boolean
}

export const emptyTracker = (): BeaconTracker => ({ boot: null, seq: null, advancedAt: null, confirmed: false })

/**
 * Is the newest beacon current? Mostly judged by whether it keeps moving on this computer's clock,
 * so two clocks that disagree do not matter: stale once it has not moved for
 * BEACON_STALE_INTERVALS intervals, plus `allowanceMs` (how long the reader waits between reads).
 * The first sighting cannot show movement, so it is taken on the writer's clock; when that calls
 * it old, the next read that sees it move confirms it.
 */
export function assessBeacon(latest: BeaconLog['latest'], tracker: BeaconTracker, now: number, allowanceMs = 0): { fresh: boolean; tracker: BeaconTracker } {
  if (!latest) return { fresh: false, tracker }
  const limit = latest.intervalMs * BEACON_STALE_INTERVALS + Math.max(0, allowanceMs)
  const first = tracker.boot === null
  const restarted = !first && (tracker.boot !== latest.boot || (tracker.seq !== null && latest.seq < tracker.seq))
  const advanced = first || restarted || latest.seq > (tracker.seq ?? -1)
  let next = tracker
  if (first) next = { boot: latest.boot, seq: latest.seq, advancedAt: now, confirmed: Math.abs(now - latest.t) <= limit }
  else if (advanced) next = { boot: latest.boot, seq: latest.seq, advancedAt: now, confirmed: true }
  const fresh = next.confirmed && next.advancedAt !== null && now - next.advancedAt <= limit
  return { fresh, tracker: next }
}
