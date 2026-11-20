// Reads ODW run folders into the views the panel draws. Pure Node, no Orca: the tests run it
// on folders they write themselves.
//
// A run is a folder `<runsRoot>/<workflow>/<runId>/` (older runs sit at `<runsRoot>/<runId>/`)
// holding `status.json` (mutable state), `meta.json` (what was run) and `events.jsonl`
// (append-only progress). ODW writes the JSON files atomically, so a read never sees half of
// one; events.jsonl is read from where the last read stopped.
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { uptime } from 'node:os'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentState, AgentView, LogLine, LogTone, Outcome, OutcomeTone, PhaseView, RunState, RunView } from './protocol'

/** Beads drawn per phase; a bigger fan-out keeps its running and failed agents first. */
export const MAX_AGENTS_PER_PHASE = 60
const LOG_KEEP = 40
const LOG_LIVE = 8
const LOG_ENDED = 3
const TEXT_MAX = 240

export type Json = Record<string, unknown>

const LIVE: ReadonlySet<RunState> = new Set(['running', 'waiting', 'paused'])

export function isLive(state: RunState): boolean {
  return LIVE.has(state)
}

export function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function clip(text: string, max = TEXT_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** ODW timestamps are epoch seconds with a fraction. */
export function ms(seconds: unknown): number | null {
  const value = num(seconds)
  return value === null ? null : Math.round(value * 1000)
}

/** `20261119-185440-6c126a` → its local start time, for a run with no events yet. */
export function timeFromRunId(runId: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(runId)
  if (!match) return null
  const [, y, mo, d, h, mi, s] = match.map(Number)
  return new Date(y, mo - 1, d, h, mi, s).getTime()
}

/** A run's JSON file larger than this is not read: nothing the panel shows needs that much. */
const JSON_MAX = 8 * 1024 * 1024
// Run files are read only as regular files, never through a symlink, and never blocking on a
// FIFO or a device: a run folder is data, and data does not get to point the worker elsewhere.
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)

function openRegular(path: string): number | null {
  let fd: number
  try {
    fd = openSync(path, OPEN_FLAGS)
  } catch {
    return null
  }
  try {
    if (fstatSync(fd).isFile()) return fd
  } catch {
    // Fall through: close it.
  }
  closeSync(fd)
  return null
}

function readRange(fd: number, start: number, length: number): Buffer {
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, start + read)
    if (n === 0) break
    read += n
  }
  return buffer.subarray(0, read)
}

/** A regular file's text, or null when it is not one, or larger than `max` bytes. */
export function readSmall(path: string, max: number): string | null {
  const fd = openRegular(path)
  if (fd === null) return null
  try {
    const size = fstatSync(fd).size
    return size > max ? null : readRange(fd, 0, size).toString('utf8')
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

export function readJson(path: string): Json | null {
  const text = readSmall(path, JSON_MAX)
  if (text === null) return null
  try {
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
  } catch {
    return null
  }
}

/** When a process started, as ODW records it (`linux:<boot>:<ticks>` or `ps:<lstart>`). */
const startCache = new Map<number, { at: number; start: string | null }>()
function processStartTime(pid: number): string | null {
  const hit = startCache.get(pid)
  if (hit && Date.now() - hit.at < 30_000) return hit.start
  let start: string | null = null
  if (process.platform === 'linux') {
    try {
      const boot = readSmall('/proc/sys/kernel/random/boot_id', 256)?.trim()
      const stat = readSmall(`/proc/${pid}/stat`, 8192)
      const ticks = stat ? stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] : null
      if (boot && ticks && /^\d+$/.test(ticks)) start = `linux:${boot}:${ticks}`
    } catch {
      start = null
    }
  }
  if (start === null && process.platform !== 'win32') {
    try {
      const out = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } })
      const line = out.status === 0 ? out.stdout.trim().replace(/\s+/g, ' ') : ''
      start = line ? `ps:${line}` : null
    } catch {
      start = null
    }
  }
  if (startCache.size > 256) startCache.clear()
  startCache.set(pid, { at: Date.now(), start })
  return start
}

/**
 * Whether a live pid is provably not the worker that wrote the status: it was written before
 * this machine booted, or the process now holding the pid started at another time. ODW's own
 * rule (runtime/process-identity.ts); false when nothing tells.
 */
export function pidReused(status: Json | null): boolean {
  const pid = status?.pid
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false
  const updatedAt = num(status?.updatedAt)
  if (updatedAt !== null && updatedAt * 1000 < Date.now() - uptime() * 1000 - 60_000) return true
  const recorded = str(status?.pidStart)
  if (!recorded) return false
  const now = processStartTime(pid)
  if (now === null) return false
  const scheme = (token: string) => token.slice(0, token.indexOf(':') + 1)
  return scheme(now) === scheme(recorded) && now !== recorded
}

/** Is the worker that owns a run still there? EPERM means it is, under another user. */
export function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface AgentRec extends AgentView {}

interface PhaseRec {
  title: string
  detail: string | null
  declared: boolean
  startedAt: number | null
  order: number
  commands: { running: number; done: number; failed: number }
}

/** Folds one run's events into its state, a few at a time as they arrive. */
export class RunAccumulator {
  startedAt: number | null = null
  endedAt: number | null = null
  ended: RunState | null = null
  error: string | null = null
  adapter: string | null = null
  currentPhase: string | null = null
  readonly agents = new Map<number, AgentRec>()
  readonly phases = new Map<string, PhaseRec>()
  private readonly commands = new Map<number, { phase: string; state: AgentState }>()
  readonly log: LogLine[] = []
  waiting: { title: string; since: number; checkpointId: number | null } | null = null
  lastTs: number | null = null
  private order = 0

  declarePhases(phases: unknown): void {
    if (!Array.isArray(phases)) return
    for (const phase of phases) {
      const title = str((phase as Json)?.title)
      if (!title) continue
      const known = this.phases.get(title)
      if (known) {
        known.declared = true
        known.detail ??= str((phase as Json).detail)
      } else {
        this.phases.set(title, {
          title,
          detail: str((phase as Json).detail),
          declared: true,
          startedAt: null,
          order: this.order++,
          commands: { running: 0, done: 0, failed: 0 },
        })
      }
    }
  }

  private phase(title: string | null): PhaseRec {
    const key = title ?? ''
    let phase = this.phases.get(key)
    if (!phase) {
      phase = { title: key, detail: null, declared: false, startedAt: null, order: this.order++, commands: { running: 0, done: 0, failed: 0 } }
      this.phases.set(key, phase)
    }
    return phase
  }

  private note(ts: number, text: string, tone: LogTone): void {
    this.log.push({ ts, text: clip(text), tone })
    if (this.log.length > LOG_KEEP) this.log.splice(0, this.log.length - LOG_KEEP)
  }

  feed(ev: Json): void {
    const ts = ms(ev.ts) ?? Date.now()
    this.lastTs = ts
    const phaseName = str(ev.phase)
    switch (ev.type) {
      case 'run_started': {
        this.startedAt ??= ts
        const settings = ((ev.setup as Json)?.settings ?? {}) as Json
        this.adapter ??= str(settings.defaultAdapter)
        break
      }
      case 'phase_started': {
        const phase = this.phase(phaseName)
        phase.startedAt ??= ts
        this.currentPhase = phase.title
        break
      }
      case 'agent_started': {
        const id = num(ev.agentId)
        if (id === null) break
        const phase = this.phase(phaseName ?? this.currentPhase)
        phase.startedAt ??= ts
        const known = this.agents.get(id)
        this.agents.set(id, {
          id,
          label: str(ev.label) ?? known?.label ?? `agent ${id}`,
          phase: phase.title,
          state: 'running',
          adapter: str(ev.adapter) ?? known?.adapter ?? null,
          model: str(ev.model) ?? known?.model ?? null,
          // A retry of an ended call times from its own start.
          startedAt: ev.restart === true ? ts : (known?.startedAt ?? ts),
          endedAt: null,
          tokens: known?.tokens ?? null,
          attempts: known?.attempts ?? null,
          error: null,
        })
        break
      }
      case 'agent_finished':
      case 'agent_failed': {
        const id = num(ev.agentId)
        if (id === null) break
        const failed = ev.type === 'agent_failed'
        const known = this.agents.get(id)
        const phase = this.phase(phaseName ?? known?.phase ?? this.currentPhase)
        const usage = (ev.usage ?? {}) as Json
        const error = failed ? str(ev.error) : null
        this.agents.set(id, {
          id,
          label: str(ev.label) ?? known?.label ?? `agent ${id}`,
          phase: phase.title,
          state: failed ? 'failed' : 'done',
          adapter: str(ev.adapter) ?? known?.adapter ?? null,
          model: str(ev.servedModel) ?? str(ev.model) ?? known?.model ?? null,
          startedAt: known?.startedAt ?? ts,
          endedAt: ts,
          tokens: num(usage.outputTokens) ?? known?.tokens ?? null,
          attempts: num(ev.attempts) ?? known?.attempts ?? null,
          error: error ? clip(error, 400) : null,
        })
        if (failed) this.note(ts, `${str(ev.label) ?? known?.label ?? `agent ${id}`} failed${error ? `: ${error}` : ''}`, 'error')
        break
      }
      case 'command_started':
      case 'command_finished':
      case 'command_failed': {
        const id = num(ev.commandId)
        if (id === null) break
        const before = this.commands.get(id)
        const phase = this.phase(phaseName ?? before?.phase ?? this.currentPhase)
        const state: AgentState = ev.type === 'command_started' ? 'running' : ev.type === 'command_failed' ? 'failed' : 'done'
        if (before) phase.commands[before.state]--
        phase.commands[state]++
        this.commands.set(id, { phase: phase.title, state })
        if (state === 'failed') this.note(ts, `${str(ev.label) ?? 'a command'} failed`, 'warn')
        break
      }
      case 'checkpoint_requested': {
        const title = str(ev.title) ?? 'a checkpoint'
        this.waiting = { title: clip(title, 160), since: ts, checkpointId: num(ev.checkpointId) }
        this.note(ts, `Waiting for you: ${title}`, 'warn')
        break
      }
      case 'checkpoint_resolved': {
        this.waiting = null
        const how = ev.approved === false || ev.action === 'reject' ? 'rejected' : 'answered'
        this.note(ts, `Checkpoint ${how}`, 'info')
        break
      }
      case 'log': {
        const message = ev.message
        const text = typeof message === 'string' ? message : JSON.stringify(message)
        if (text) this.note(ts, text, 'info')
        break
      }
      case 'model_substituted':
      case 'host_suspended':
      case 'egress_denied':
      case 'destructive_git':
        if (str(ev.message)) this.note(ts, str(ev.message)!, 'warn')
        break
      // An engine adapter's own line for the log, with its tone.
      case 'notice':
        if (str(ev.message)) this.note(ts, str(ev.message)!, ev.tone === 'warn' || ev.tone === 'error' || ev.tone === 'success' ? ev.tone : 'info')
        break
      case 'handoff':
        this.note(ts, `${str(ev.label) ?? 'an agent'} handed over to ${str(ev.to) ?? 'the next adapter'}`, 'info')
        break
      case 'run_finished':
        this.ended = 'done'
        this.endedAt = ts
        this.waiting = null
        break
      case 'run_failed':
        this.ended = 'failed'
        this.endedAt = ts
        this.error = str(ev.error) ? clip(str(ev.error)!, 400) : null
        this.waiting = null
        if (this.error) this.note(ts, this.error, 'error')
        break
      case 'run_stopped':
        this.ended = 'stopped'
        this.endedAt = ts
        this.waiting = null
        this.note(ts, str(ev.who) ? `Stopped by ${str(ev.who)}` : 'Stopped', 'warn')
        break
      default:
        break
    }
  }
}

/** Keeps a huge phase small: every running and failed agent, then the newest others. */
function pickAgents(agents: AgentView[]): { shown: AgentView[]; hidden: number } {
  if (agents.length <= MAX_AGENTS_PER_PHASE) return { shown: agents, hidden: 0 }
  const urgent = agents.filter((a) => a.state !== 'done')
  const rest = agents.filter((a) => a.state === 'done')
  const room = Math.max(0, MAX_AGENTS_PER_PHASE - urgent.length)
  const keep = new Set([...urgent.slice(0, MAX_AGENTS_PER_PHASE), ...(room > 0 ? rest.slice(-room) : [])].map((a) => a.id))
  const shown = agents.filter((a) => keep.has(a.id))
  return { shown, hidden: agents.length - shown.length }
}

export interface RunFiles {
  runId: string
  status: Json | null
  meta: Json | null
  /** result.json, once the run has ended. */
  result?: Json | null
  /** A run that waits with no process behind it (AgentPrism parks paused runs): never lost. */
  parked?: boolean
}

/** The args that name what a run is about, most specific first. */
const SUBJECT_KEYS = ['run_dir', 'plan_file', 'plan', 'spec', 'target', 'issue', 'task']
/** Which of them reads best for people: a plan's file name before its run folder. */
const LABEL_KEYS = ['plan_file', 'plan', 'spec', 'target', 'issue', 'task', 'run_dir']

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v))
}

/** What a run was about, from its args, so runs of one workflow on different plans stay apart. */
export function subjectOf(args: unknown): { subject: string; label: string | null } | null {
  if (args === null || args === undefined) return null
  const hash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 12)
  if (typeof args !== 'object' || Array.isArray(args)) return { subject: hash(canonical(args)), label: null }
  const fields = args as Json
  const keyName = SUBJECT_KEYS.find((k) => typeof fields[k] === 'string' && (fields[k] as string).trim())
  const labelName = LABEL_KEYS.find((k) => typeof fields[k] === 'string' && (fields[k] as string).trim())
  const label = labelName ? String(fields[labelName]).trim() : null
  const pretty = label ? (label.includes('/') ? basename(label.replace(/\/+$/, '')) : clip(label, 60)) : null
  if (keyName) return { subject: hash(`${keyName}=${String(fields[keyName]).trim()}`), label: pretty }
  return Object.keys(fields).length ? { subject: hash(canonical(fields)), label: null } : null
}

/** How a returned `status` word reads: done, needs the owner, went wrong, or neither. */
export function toneOf(status: string): OutcomeTone {
  if (/^(success|succeeded|ok|done|built|complete|completed|merged|passed|finished)$/i.test(status)) return 'ok'
  if (/wait|owner|blocked|needs?[-_ ]|question|input|approval/i.test(status)) return 'attention'
  if (/error|fail|abort|crash|broken/i.test(status)) return 'bad'
  return 'neutral'
}

export function outcomeOf(file: Json | null | undefined): Outcome | null {
  // ODW keeps the returned value as `{ "value": … }`.
  const value = file && 'value' in file ? file.value : file
  const result = value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null
  const status = str(result?.status)
  if (!status) return null
  const text = str(result?.question) ?? str(result?.reason) ?? str(result?.message) ?? str(result?.summary)
  return { status, tone: toneOf(status), text: text ? clip(text, 240) : null }
}

/** The view of one run: the accumulator's events plus what status.json and meta.json say. */
export function buildView(files: RunFiles, acc: RunAccumulator, alive: (pid: unknown) => boolean = pidAlive): RunView {
  const { runId, status, meta } = files
  acc.declarePhases(status?.phases)

  const statusState = str(status?.state)
  let state: RunState =
    acc.ended ??
    (statusState === 'done' || statusState === 'failed' || statusState === 'stopped' || statusState === 'paused' || statusState === 'waiting'
      ? statusState
      : 'running')
  // status.json is written last on a clean end, events.jsonl first: trust whichever has ended.
  if (!acc.ended && (statusState === 'done' || statusState === 'failed' || statusState === 'stopped')) state = statusState
  const statusWaiting = status?.waiting as Json | null | undefined
  const waiting =
    isLive(state) && (statusWaiting || acc.waiting)
      ? {
          title: clip(str(statusWaiting?.title) ?? acc.waiting?.title ?? 'a checkpoint', 160),
          since: ms(statusWaiting?.since) ?? acc.waiting?.since ?? Date.now(),
          checkpointId: num(statusWaiting?.checkpointId) ?? acc.waiting?.checkpointId ?? null,
        }
      : null
  if (waiting && state === 'running') state = 'waiting'
  // A run just created may not have its worker's pid yet: give it a minute before calling it lost.
  const since = num(status?.updatedAt) ?? num(meta?.createdAt)
  const starting = statusState === 'pending' && status?.pid == null && since !== null && Date.now() / 1000 - since < 60
  if (isLive(state) && status && !files.parked && !starting && (!alive(status.pid) || pidReused(status))) state = 'lost'
  // A lost run can no longer be answered.
  const shownWaiting = state === 'lost' ? null : waiting

  const allAgents = [...acc.agents.values()].sort((a, b) => a.id - b.id)
  const phases: PhaseView[] = []
  const ordered = [...acc.phases.values()].sort((a, b) => a.order - b.order)
  const currentIndex = ordered.findIndex((p) => p.title === acc.currentPhase)
  ordered.forEach((rec, index) => {
    const agents = allAgents.filter((a) => a.phase === rec.title)
    const commandCount = rec.commands.running + rec.commands.done + rec.commands.failed
    if (rec.title === '' && agents.length === 0 && commandCount === 0) return
    const started = rec.startedAt !== null || agents.length > 0 || commandCount > 0
    const running = agents.some((a) => a.state === 'running') || rec.commands.running > 0
    let phaseState: PhaseView['state'] = 'pending'
    if (running) phaseState = 'active'
    else if (started) {
      const isCurrent = index === currentIndex
      if (isCurrent && isLive(state)) phaseState = 'active'
      else if (isCurrent && (state === 'failed' || state === 'stopped' || state === 'lost')) phaseState = 'failed'
      else phaseState = 'done'
    } else if (currentIndex > index) {
      // Declared but never entered while a later phase ran: the script skipped it.
      phaseState = 'skipped'
    }
    const ends = agents.map((a) => a.endedAt).filter((t): t is number => t !== null)
    const { shown, hidden } = pickAgents(agents)
    phases.push({
      title: rec.title,
      detail: rec.detail,
      state: phaseState,
      startedAt: rec.startedAt ?? (agents[0]?.startedAt ?? null),
      endedAt: phaseState === 'done' || phaseState === 'failed' ? (ends.length ? Math.max(...ends) : rec.startedAt) : null,
      agents: shown,
      hiddenAgents: hidden,
      commands: { ...rec.commands },
    })
  })

  const startedAt = acc.startedAt ?? ms(meta?.createdAt) ?? timeFromRunId(runId) ?? Date.now()
  const updatedAt = Math.max(ms(status?.updatedAt) ?? 0, acc.lastTs ?? 0, startedAt)
  const endedAt = isLive(state) ? null : acc.endedAt ?? updatedAt
  const source = str(meta?.source)
  const about = subjectOf(meta?.args)
  const spent = num(status?.spentTokens) ?? allAgents.reduce((sum, a) => sum + (a.tokens ?? 0), 0)

  return {
    id: runId,
    engine: 'odw',
    host: null,
    hostName: null,
    workflow: str(status?.name) ?? str(meta?.workflowName) ?? 'workflow',
    description: str(status?.description) ? clip(str(status?.description)!, 200) : null,
    state,
    startedAt,
    updatedAt,
    endedAt,
    source: source ? basename(source) : null,
    subject: about?.subject ?? null,
    subjectLabel: about?.label ?? null,
    dry: meta?.dry === true,
    adapter: str(meta?.adapter) ?? acc.adapter,
    phases,
    agents: {
      total: allAgents.length,
      running: allAgents.filter((a) => a.state === 'running').length,
      done: allAgents.filter((a) => a.state === 'done').length,
      failed: allAgents.filter((a) => a.state === 'failed').length,
    },
    tokens: { spent, budget: num(meta?.budgetTotal) },
    log: acc.log.slice(isLive(state) ? -LOG_LIVE : -LOG_ENDED),
    waiting: shownWaiting,
    answer: null,
    error: acc.error ?? (state === 'lost' ? 'Its worker is gone: the run stopped without saying so.' : null),
    outcome: isLive(state) ? null : outcomeOf(files.result),
  }
}

/** Bytes read from an events file per call, and the longest line kept: a run is data. */
const TAIL_CALL_MAX = 64 * 1024 * 1024
const TAIL_CHUNK = 1024 * 1024
const LINE_MAX = 4 * 1024 * 1024

/** Reads events.jsonl from where the last read stopped; a line still being written waits. */
export class EventTail {
  private offset = 0
  private rest = ''
  // Inside a line longer than LINE_MAX: dropped up to its newline.
  private skipping = false
  private decoder = new StringDecoder('utf8')
  private ino: number | null = null
  private readonly path: string

  constructor(path: string) {
    this.path = path
  }

  /** New complete events since the last call, or `null` when the file was replaced (reset). */
  read(): Json[] | null {
    const fd = openRegular(this.path)
    if (fd === null) return []
    try {
      const stat = fstatSync(fd)
      if ((this.ino !== null && stat.ino !== this.ino) || stat.size < this.offset) {
        this.ino = stat.ino
        this.offset = 0
        this.rest = ''
        this.skipping = false
        this.decoder = new StringDecoder('utf8')
        return null
      }
      this.ino = stat.ino
      const out: Json[] = []
      // At most TAIL_CALL_MAX per call: a huge backlog is caught up over a few refreshes.
      const until = Math.min(stat.size, this.offset + TAIL_CALL_MAX)
      while (this.offset < until) {
        const chunk = readRange(fd, this.offset, Math.min(TAIL_CHUNK, until - this.offset))
        if (chunk.length === 0) break
        this.offset += chunk.length
        const lines = (this.rest + this.decoder.write(chunk)).split('\n')
        this.rest = lines.pop() ?? ''
        for (const line of lines) {
          if (this.skipping) {
            this.skipping = false
            continue
          }
          if (!line.trim()) continue
          try {
            const value = JSON.parse(line)
            if (value && typeof value === 'object') out.push(value as Json)
          } catch {
            // A torn or foreign line: skip it, the next ones still count.
          }
        }
        if (this.rest.length > LINE_MAX) {
          this.rest = ''
          this.skipping = true
        }
      }
      return out
    } catch {
      return []
    } finally {
      closeSync(fd)
    }
  }
}

/** One run being followed: its tail, its fold and the files read last. */
export class RunWatch {
  private tail: EventTail
  private acc = new RunAccumulator()
  private meta: Json | null = null
  private statusMtime = -1
  private status: Json | null = null
  private result: Json | null | undefined = undefined
  readonly runId: string
  readonly dir: string

  constructor(runId: string, dir: string) {
    this.runId = runId
    this.dir = dir
    this.tail = new EventTail(join(dir, 'events.jsonl'))
  }

  refresh(alive?: (pid: unknown) => boolean): RunView {
    if (!this.meta) this.meta = readJson(join(this.dir, 'meta.json'))
    try {
      const mtime = statSync(join(this.dir, 'status.json')).mtimeMs
      if (mtime !== this.statusMtime) {
        this.status = readJson(join(this.dir, 'status.json')) ?? this.status
        this.statusMtime = mtime
      }
    } catch {
      // No status.json yet: the events alone tell the story.
    }
    let events = this.tail.read()
    if (events === null) {
      this.acc = new RunAccumulator()
      events = this.tail.read() ?? []
    }
    // Declared phases first, so they keep the script's order; phases only events name follow.
    this.acc.declarePhases(this.status?.phases)
    for (const ev of events) this.acc.feed(ev)
    // result.json is written once, as the run ends: read it then, and keep it.
    if (this.result === undefined && (this.acc.ended || readState(this.dir) === 'done')) {
      const result = existsSync(join(this.dir, 'result.json')) ? readJson(join(this.dir, 'result.json')) : null
      if (result !== null || this.acc.ended) this.result = result
    }
    return buildView({ runId: this.runId, status: this.status, meta: this.meta, result: this.result }, this.acc, alive)
  }
}

function isRunDir(dir: string): boolean {
  return existsSync(join(dir, 'status.json')) || existsSync(join(dir, 'meta.json')) || existsSync(join(dir, 'events.jsonl'))
}

/** Every run folder under a runs root, newest first by run id. */
export function listRunDirs(root: string): { runId: string; dir: string }[] {
  const found: { runId: string; dir: string }[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(root, entry.name)
    if (isRunDir(dir)) {
      found.push({ runId: entry.name, dir })
      continue
    }
    let runs: import('node:fs').Dirent[]
    try {
      runs = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const run of runs) {
      if (run.isDirectory() && !run.name.startsWith('.') && isRunDir(join(dir, run.name))) found.push({ runId: run.name, dir: join(dir, run.name) })
    }
  }
  return found.sort((a, b) => (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0))
}

/** Reads a saved file's end, at most `max` characters, reading only that end. */
export function readTail(path: string, max: number): string | null {
  const fd = openRegular(path)
  if (fd === null) return null
  try {
    const size = fstatSync(fd).size
    const bytes = Math.min(size, max * 4)
    let text = readRange(fd, size - bytes, bytes).toString('utf8')
    if (bytes < size) text = text.replace(/^[\uFFFD]+/, '')
    return text.length > max || bytes < size ? `…${text.slice(-max)}` : text
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

/** An agent id as the panel sends it: a whole number, never a path. */
export function isAgentId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** What one agent was asked and answered, cut short, for the panel's detail sheet. */
export function readAgent(dir: string, runId: string, agentId: number) {
  if (!isAgentId(agentId)) throw Object.assign(new Error('an agent id is a whole number'), { code: 'invalid_params' })
  // The agents folder is the run's own, never a link out of it.
  let agents: string | null = join(dir, 'agents')
  try {
    if (!lstatSync(agents).isDirectory()) agents = null
  } catch {
    agents = null
  }
  const at = (name: string) => (agents ? join(agents, name) : join(dir, '.missing', name))
  const call = readJson(at(`${agentId}.call.json`))
  const result = readJson(at(`${agentId}.json`))
  const prompt = str(call?.prompt)
  let reply: string | null = null
  if (result && 'value' in result) {
    const value = result.value
    reply = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  } else {
    // Still running or failed: the last text its CLI printed.
    const transcript = readTail(at(`${agentId}.transcript.jsonl`), 6000)
    if (transcript) {
      const texts = transcript
        .split('\n')
        .map((line) => {
          try {
            const value = JSON.parse(line)
            return typeof value?.text === 'string' ? value.text : null
          } catch {
            return null
          }
        })
        .filter((t): t is string => Boolean(t))
      if (texts.length) reply = texts.slice(-3).join('\n')
    }
  }
  const cut = (text: string | null, max: number) => (text && text.length > max ? `${text.slice(0, max - 1)}…` : text)
  return {
    runId,
    agentId,
    label: str(call?.label) ?? str(result?.label) ?? `agent ${agentId}`,
    prompt: cut(prompt, 1600),
    reply: cut(reply, 4000),
    stderr: readTail(at(`${agentId}.stderr.txt`), 1200),
  }
}

/** A run's state as status.json says, without following it. */
export function readState(dir: string): string | null {
  return str(readJson(join(dir, 'status.json'))?.state)
}
