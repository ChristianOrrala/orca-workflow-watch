// AgentPrism Workflows (@automatalabs/workflows): every project's runs sit flat in
// `<root>/projects/<slug>-<hash>/runs/` as `<runId>.json` (the snapshot), `<runId>.events.jsonl`
// (versioned records in seq order), `<runId>.script.js` and, while a process owns the run,
// `<runId>.lock` with its pid. The root is `~/.agentprism/workflows` unless the engine was given
// another (AGENTPRISM_PERSISTENCE_ROOT, or persistenceRoot in code).
//
// The events are translated into the ODW-shaped events ../model folds, so a run reads the same
// in the panel whichever engine ran it. Nothing here writes: AgentPrism's own WorkflowManager
// would reconcile and rewrite runs, so this reads the files directly.
import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { AgentDetail, RunLog, RunView } from '../protocol'
import { buildView, clip, EventTail, isLive, num, pidAlive, readJson, readSmall, RunAccumulator, str, type Json } from '../model'

/** The saved script read for its meta, and the events read again for one agent's detail. */
const SCRIPT_MAX = 1024 * 1024
const DETAIL_EVENTS_MAX = 32 * 1024 * 1024
import type { RunSource } from './types'
import { shortHome } from './paths'

const PREVIEW_MAX = 4000

export interface RunFile {
  runId: string
  runsDir: string
  /** The project the run worked in, from project.json. */
  projectDir: string | null
  /** From the run id's base-36 time prefix, else the snapshot file's mtime. */
  startedAt: number
}

/** `mwof4hgc-8kfg7f` → the epoch milliseconds AgentPrism minted it at. */
export function timeFromAgentPrismId(runId: string): number | null {
  const head = runId.split('-')[0]
  if (!/^[0-9a-z]{6,10}$/.test(head)) return null
  const value = parseInt(head, 36)
  return value > 1.5e12 && value < 4e12 ? value : null
}

/** Every run of every project under the root, newest first. */
export function listAgentPrismRuns(root: string): RunFile[] {
  const projects = join(root, 'projects')
  const runs: RunFile[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(projects, { withFileTypes: true })
  } catch {
    return []
  }
  for (const project of entries) {
    if (!project.isDirectory()) continue
    const runsDir = join(projects, project.name, 'runs')
    // One unreadable project (or a file where its runs folder should be) skips that project only.
    let names: string[]
    try {
      if (!lstatSync(runsDir).isDirectory()) continue
      names = readdirSync(runsDir)
    } catch {
      continue
    }
    const projectDir = str(readJson(join(projects, project.name, 'project.json'))?.projectDir)
    for (const name of names) {
      if (!name.endsWith('.json') || name.endsWith('.events.json')) continue
      const runId = name.slice(0, -'.json'.length)
      let startedAt = timeFromAgentPrismId(runId)
      if (startedAt === null) {
        try {
          startedAt = statSync(join(runsDir, name)).mtimeMs
        } catch {
          continue
        }
      }
      runs.push({ runId, runsDir, projectDir, startedAt })
    }
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt)
}

/**
 * The script's `meta` (name, description, declared phases), read from its source without
 * running it. Best effort: a meta built at run time gives nothing, and the run still reads.
 */
export function metaOf(script: string | null): { name: string | null; description: string | null; phases: { title: string }[] } {
  const empty = { name: null, description: null, phases: [] }
  if (!script) return empty
  const start = script.search(/\bmeta\s*=\s*\{/)
  if (start < 0) return empty
  const toks = tokensOf(script, script.indexOf('{', start))
  let name: string | null = null
  let description: string | null = null
  const phases: { title: string }[] = []
  const opens = (tok: Tok | undefined) => tok?.t === 'p' && (tok.v === '{' || tok.v === '[')
  const closes = (tok: Tok | undefined) => tok?.t === 'p' && (tok.v === '}' || tok.v === ']')
  const colon = (tok: Tok | undefined) => tok?.t === 'p' && tok.v === ':'
  let depth = 0
  for (let k = 0; k < toks.length; k++) {
    const tok = toks[k]
    if (opens(tok)) depth++
    else if (closes(tok)) depth--
    if (tok.t === 'p' || depth !== 1 || !colon(toks[k + 1])) continue
    const value = toks[k + 2]
    if (tok.v === 'name' && value?.t === 's') name = value.v
    else if (tok.v === 'description' && value?.t === 's') description = value.v
    else if (tok.v === 'phases' && value?.t === 'p' && value.v === '[') {
      // A phase is a bare string, or an object with a string title.
      let d = 0
      for (let m = k + 2; m < toks.length; m++) {
        const x = toks[m]
        if (opens(x)) d++
        else if (closes(x)) {
          d--
          if (d === 0) break
        } else if (d === 1 && x.t === 's' && x.v !== null) phases.push({ title: x.v })
        else if (d === 2 && x.t !== 'p' && x.v === 'title' && colon(toks[m + 1]) && toks[m + 2]?.t === 's' && toks[m + 2].v !== null) {
          phases.push({ title: toks[m + 2].v as string })
        }
      }
    }
  }
  return { name, description, phases }
}

/** A token of a JavaScript object literal: punctuation, a word, or a string (null when built at run time). */
interface Tok {
  t: 'p' | 'w' | 's'
  v: string | null
}

/**
 * The tokens of the object literal opening at `from`, up to its closing brace: one pass, aware of
 * strings, escapes and comments, so a brace in a description never ends it early.
 */
function tokensOf(src: string, from: number): Tok[] {
  const out: Tok[] = []
  let depth = 0
  let i = from
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      const n = src.indexOf('\n', i)
      i = n < 0 ? src.length : n
    } else if (c === '/' && src[i + 1] === '*') {
      const n = src.indexOf('*/', i + 2)
      i = n < 0 ? src.length : n + 2
    } else if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      let text = ''
      let dynamic = false
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          text += src[j + 1]
          j += 2
          continue
        }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') dynamic = true
        text += src[j]
        j++
      }
      out.push({ t: 's', v: dynamic ? null : text })
      i = j + 1
    } else if ('{}[]:,'.includes(c)) {
      out.push({ t: 'p', v: c })
      if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') {
        depth--
        if (depth === 0) return out
      }
      i++
    } else if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[\w$]/.test(src[j])) j++
      out.push({ t: 'w', v: src.slice(i, j) })
      i = j
    } else i++
  }
  return out
}

const seconds = (iso: unknown): number | null => {
  const value = typeof iso === 'string' ? Date.parse(iso) : NaN
  return Number.isFinite(value) ? value / 1000 : null
}
/** `claude/sonnet` → `claude`: the backend a requested model names. */
const backendOf = (model: unknown): string | null => {
  const text = str(model)
  return text && text.includes('/') ? text.split('/')[0] : null
}

const PAUSE_WORDS: Record<string, string> = {
  usage_limit: 'Paused for a usage limit',
  auth_required: 'Paused for a sign-in',
  requested: 'Paused on request',
  interrupted: 'Paused when its process ended',
}
/** Why a run is parked, in words: "Paused for a usage limit · Resets in ~3h". */
function pauseText(reason: string | null, hint: string | null): string {
  const why = reason && PAUSE_WORDS[reason] ? PAUSE_WORDS[reason] : reason ? `Paused for ${reason.replace(/_/g, ' ')}` : 'Paused'
  return `${why}${hint ? ` · ${hint}` : ''}`
}

/** How long a run may go without its lock before it reads as ended: a run starting writes it. */
const LOCK_GRACE_MS = 30_000

/** One agent() call's key across nested workflows: its scope and its call index. */
const callKey = (ev: Json) => `${str(ev.scope) ?? ''}#${num(ev.callIndex) ?? str(ev.label) ?? ''}`

/** Follows one run: the snapshot when it changes, the event log as it grows. */
export class AgentPrismWatch {
  readonly runId: string
  readonly file: RunFile
  private acc = new RunAccumulator()
  private ids = new Map<string, number>()
  // A resume replays the run from its journal: calls that already ended start and end again,
  // instantly, with their saved result. Those replays are not new work, and are not folded.
  private ended = new Set<string>()
  private restarts = new Map<string, { ev: Json; ts: number | undefined }>()
  private replayed = new Set<string>()
  private readonly tail: EventTail
  private snapshot: Json | null = null
  private snapshotAt = -1
  private meta: ReturnType<typeof metaOf> | null = null
  private kind: string | null = null
  private spent: number | null = null
  private backend: string | null = null

  constructor(file: RunFile) {
    this.file = file
    this.runId = file.runId
    this.tail = new EventTail(join(file.runsDir, `${file.runId}.events.jsonl`))
  }

  private path(ext: string): string {
    return join(this.file.runsDir, `${this.runId}${ext}`)
  }

  private agentId(ev: Json): number {
    const key = callKey(ev)
    let id = this.ids.get(key)
    if (id === undefined) {
      id = this.ids.size + 1
      this.ids.set(key, id)
    }
    return id
  }

  /** One AgentPrism record as the ODW-shaped events the accumulator folds. */
  private start(ev: Json, ts: number | undefined, restart: boolean): void {
    this.acc.feed({ type: 'agent_started', agentId: this.agentId(ev), label: str(ev.label), phase: str(ev.phase), model: str(ev.model), adapter: backendOf(ev.model), restart, ts })
  }

  private feed(record: Json): void {
    const ev = record.event as Json | undefined
    if (!ev || typeof ev !== 'object') return
    const ts = seconds(record.timestamp) ?? undefined
    const label = str(ev.label)
    const phase = str(ev.phase)
    switch (ev.type) {
      case 'phase':
        this.acc.feed({ type: 'phase_started', phase: str(ev.title), ts })
        break
      case 'log':
        this.acc.feed({ type: 'log', message: ev.message, ts })
        break
      case 'agentStart': {
        this.backend ??= backendOf(ev.model)
        const key = callKey(ev)
        // A call that already ended starts again: a replay or a real retry, which its call record tells.
        if (this.ended.has(key)) this.restarts.set(key, { ev, ts })
        else this.start(ev, ts, false)
        break
      }
      case 'callRecord': {
        const rec = (ev.record ?? {}) as Json
        const key = `${str(rec.scope) ?? str(ev.scope) ?? ''}#${num(rec.index) ?? ''}`
        const restart = this.restarts.get(key)
        if (!restart) break
        this.restarts.delete(key)
        if (str(rec.origin) === 'journal-replay') this.replayed.add(key)
        else this.start(restart.ev, restart.ts, true)
        break
      }
      case 'agentEnd': {
        const key = callKey(ev)
        if (this.replayed.delete(key)) break
        const restart = this.restarts.get(key)
        if (restart) {
          this.restarts.delete(key)
          this.start(restart.ev, restart.ts, true)
        }
        this.ended.add(key)
        const usage = (ev.usage ?? {}) as Json
        const failed = Boolean(str(ev.error))
        this.acc.feed({
          type: failed ? 'agent_failed' : 'agent_finished',
          agentId: this.agentId(ev),
          label,
          phase,
          error: str(ev.error),
          servedModel: str(ev.modelResolved) ?? str(ev.model),
          adapter: str(ev.backendId) ?? backendOf(ev.model),
          usage: { outputTokens: num(usage.total) ?? num(ev.tokens) },
          ts,
        })
        break
      }
      case 'tokenUsage':
        this.spent = num((ev.usage as Json | undefined)?.total) ?? this.spent
        break
      case 'paused': {
        const context = ev.checkpointContext as Json | undefined
        if (str(ev.reason) === 'checkpoint_required' && context) {
          this.kind = str(context.kind)
          this.acc.feed({ type: 'checkpoint_requested', checkpointId: num(context.callIndex), title: str(context.prompt) ?? 'a checkpoint', ts })
        } else {
          this.acc.feed({ type: 'notice', tone: 'warn', message: pauseText(str(ev.reason), str(ev.resetHint)), ts })
        }
        break
      }
      case 'resumed':
        if (this.acc.waiting) this.acc.feed({ type: 'checkpoint_resolved', ts })
        else this.acc.feed({ type: 'notice', tone: 'info', message: 'Resumed', ts })
        break
      case 'error': {
        const why = (ev.errorRecord as Json | undefined)?.message ?? ev.message
        this.acc.feed({ type: 'run_failed', error: str(why), ts })
        break
      }
      case 'stopped':
        this.acc.feed({ type: 'run_stopped', ts })
        break
      case 'complete':
        this.acc.feed({ type: 'run_finished', ts })
        break
      default:
        break
    }
  }

  refresh(alive: (pid: unknown) => boolean = pidAlive): RunView {
    try {
      const at = statSync(this.path('.json')).mtimeMs
      if (at !== this.snapshotAt) {
        this.snapshot = readJson(this.path('.json')) ?? this.snapshot
        this.snapshotAt = at
      }
    } catch {
      // Not written yet: the events alone tell the story.
    }
    const snap = this.snapshot ?? {}
    if (!this.meta) {
      // The script the run saved, and nothing outside the store: a run record never points the
      // worker at another file.
      const script = str(snap.script) ?? readSmall(this.path('.script.js'), SCRIPT_MAX)
      this.meta = metaOf(script)
    }
    const fresh = this.tail.read()
    if (fresh === null) {
      this.acc = new RunAccumulator()
      this.ids = new Map()
      this.ended = new Set()
      this.restarts = new Map()
      this.replayed = new Set()
      this.kind = null
      // Declared phases first, so they keep the script's order whatever the events skipped.
      this.acc.declarePhases(this.meta.phases)
      for (const record of this.tail.read() ?? []) this.feed(record)
    } else {
      this.acc.declarePhases(this.meta.phases)
      for (const record of fresh) this.feed(record)
    }

    const status = str(snap.status) ?? 'running'
    const pauseReason = str(snap.pauseReason)
    const lock = readJson(this.path('.lock'))
    const context = snap.checkpointContext as Json | undefined
    if (context && str(context.kind)) this.kind = str(context.kind)
    // A run whose process died is never lost in AgentPrism: the next manager to load it saves
    // it as an interrupted pause, and a resume picks it up where it stopped. So a running record
    // with no live process behind its lock already reads as that pause.
    const started = seconds(snap.updatedAt) ?? this.file.startedAt / 1000
    const orphaned =
      (status === 'running' || status === 'pending') && (lock ? !alive(lock.pid) : Date.now() - started * 1000 > LOCK_GRACE_MS)
    const reasonNow = orphaned ? 'interrupted' : pauseReason
    const checkpoint = status === 'paused' && pauseReason === 'checkpoint_required'
    // A parked run has no process behind it and is not lost: it waits for a person, a reset
    // or a resume.
    const parked = status === 'paused' || orphaned
    const state =
      status === 'completed' ? 'done' : status === 'failed' ? 'failed' : status === 'aborted' ? 'stopped' : checkpoint ? 'waiting' : parked ? 'paused' : 'running'
    const waiting =
      checkpoint && context
        ? { title: str(context.prompt) ?? 'a checkpoint', since: seconds(snap.updatedAt), checkpointId: num(context.callIndex) }
        : null
    const phases = [...this.meta.phases, ...(Array.isArray(snap.phases) ? snap.phases : []).map((title) => ({ title: String(title) }))]
    const tokens = snap.tokenUsage as Json | undefined
    const view = buildView(
      {
        runId: this.runId,
        status: {
          state,
          pid: num(lock?.pid),
          name: str(snap.workflowName) ?? this.meta.name,
          description: this.meta.description,
          phases,
          updatedAt: seconds(snap.updatedAt),
          spentTokens: num(tokens?.total) ?? this.spent,
          waiting,
        },
        meta: {
          workflowName: str(snap.workflowName) ?? this.meta.name,
          createdAt: seconds(snap.startedAt) ?? this.file.startedAt / 1000,
          args: snap.args,
          source: this.file.projectDir ?? str(snap.effectiveCwd),
          adapter: this.backend,
          budgetTotal: null,
        },
        result: status === 'completed' ? { value: snap.result } : null,
        // Never lost: whether a process is behind the run was settled above (`orphaned`).
        parked: true,
      },
      this.acc,
      alive,
    )
    const reason = str(snap.reason)
    const error =
      view.state === 'paused' ? pauseText(reasonNow, str(snap.resetHint)) : view.error
    return {
      ...view,
      engine: 'agentprism',
      error: view.state === 'failed' && !view.error && reason ? clip(reason, 400) : error,
      answer: view.waiting
        ? answerFor(this.runId, view.waiting.checkpointId, this.kind, this.file.projectDir)
        : view.state === 'paused'
          ? resumeFor(this.runId, this.file.projectDir)
          : null,
    }
  }

  /** Every log line kept, as of the last refresh. */
  log(): RunLog {
    return this.acc.fullLog(this.runId)
  }

  /** The nth agent call (in the order the log first names them): its prompt and its reply. */
  agent(agentId: number): AgentDetail {
    const ids = new Map<string, number>()
    let start: Json | null = null
    let end: Json | null = null
    const text = readSmall(this.path('.events.jsonl'), DETAIL_EVENTS_MAX) ?? ''
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let ev: Json
      try {
        ev = (JSON.parse(line) as Json).event as Json
      } catch {
        continue
      }
      if (!ev || (ev.type !== 'agentStart' && ev.type !== 'agentEnd')) continue
      const key = callKey(ev)
      if (!ids.has(key)) ids.set(key, ids.size + 1)
      if (ids.get(key) !== agentId) continue
      if (ev.type === 'agentStart') start = ev
      else end = ev
    }
    const preview = str((end?.result as Json | undefined)?.preview)
    let reply = preview
    if (preview) {
      try {
        reply = JSON.stringify(JSON.parse(preview), null, 2)
      } catch {
        // Plain text.
      }
    }
    return {
      runId: this.runId,
      agentId,
      label: str(start?.label) ?? str(end?.label) ?? `agent ${agentId}`,
      prompt: str(start?.prompt) ? clip(str(start?.prompt)!, 1600) : null,
      reply: reply ? clip(reply, PREVIEW_MAX) : null,
      stderr: str(end?.error) ? clip(str(end?.error)!, 1200) : null,
    }
  }
}

/** AgentPrism takes a checkpoint's answer through its MCP `workflow` tool, as a resume. */
/** The workflow tool call that takes a paused run up where it stopped. */
export function resumeFor(runId: string, projectDir: string | null) {
  const where = projectDir ? ` in ${basename(projectDir)}` : ''
  return {
    copy: JSON.stringify({ action: 'resume', runId }),
    how: `Give it to AgentPrism's workflow tool from an agent working${where}{where}. The run picks up where it stopped; what already finished is not done again.`,
  }
}

export function answerFor(runId: string, callIndex: number | null, kind: string | null, projectDir: string | null) {
  const reply = kind === 'confirm' || kind === null ? true : '…'
  const call = { action: 'resume', runId, checkpointReplies: { [String(callIndex ?? 0)]: reply } }
  const where = projectDir ? ` in ${basename(projectDir)}` : ''
  return {
    copy: JSON.stringify(call),
    how:
      reply === true
        ? `Give it to AgentPrism's workflow tool from an agent working${where}{where}. true goes on; false refuses.`
        : `Put your answer in place of …, then give it to AgentPrism's workflow tool from an agent working${where}{where}.`,
  }
}

export class AgentPrismSource implements RunSource {
  readonly id = 'agentprism' as const
  readonly label = 'AgentPrism'
  root: string
  private readonly watches = new Map<string, AgentPrismWatch>()
  private readonly settled = new Set<string>()
  private readonly live = new Set<string>()

  constructor(root: string) {
    this.root = root
  }

  info() {
    return {
      id: this.id,
      label: this.label,
      root: shortHome(this.root),
      rootExists: existsSync(this.root),
      hint: { text: 'Ask an agent to run a workflow with AgentPrism’s workflow tool.', copy: null },
    }
  }

  reset(): void {
    this.watches.clear()
    this.settled.clear()
    this.live.clear()
  }

  scan(history: number, log: (message: string) => void): RunView[] {
    const runs: RunView[] = []
    const keep = new Set<string>()
    // History counts finished runs only: live ones always show, on top of it.
    let finished = 0
    for (const file of existsSync(this.root) ? listAgentPrismRuns(this.root) : []) {
      // One id in two projects (a copied store): the newest listed is the one followed.
      if (keep.has(file.runId)) {
        log(`AgentPrism run ${file.runId} is in more than one project; showing ${this.watches.get(file.runId)?.file.runsDir}`)
        continue
      }
      if (finished >= history) {
        if (this.settled.has(file.runId)) continue
        if (!this.live.has(file.runId)) {
          // Past the history limit: only a run that is still going is worth reading on.
          const status = str(readJson(join(file.runsDir, `${file.runId}.json`))?.status)
          if (status === 'completed' || status === 'failed' || status === 'aborted') {
            this.settled.add(file.runId)
            continue
          }
          if (status !== 'running' && status !== 'pending' && status !== 'paused') continue
        }
      }
      const known = this.watches.get(file.runId)
      const runWatch = known && known.file.runsDir === file.runsDir ? known : new AgentPrismWatch(file)
      this.watches.set(file.runId, runWatch)
      keep.add(file.runId)
      try {
        const view = runWatch.refresh()
        runs.push(view)
        if (isLive(view.state)) this.live.add(file.runId)
        else {
          this.live.delete(file.runId)
          finished++
        }
      } catch (error) {
        log(`could not read AgentPrism run ${file.runId}: ${(error as Error).message}`)
      }
    }
    for (const runId of [...this.watches.keys()]) if (!keep.has(runId)) this.watches.delete(runId)
    return runs
  }

  agent(runId: string, agentId: number): AgentDetail {
    const runWatch = this.watches.get(runId)
    if (!runWatch) throw Object.assign(new Error(`no AgentPrism run ${runId} is being watched`), { code: 'invalid_params' })
    return runWatch.agent(agentId)
  }

  log(runId: string): RunLog {
    const runWatch = this.watches.get(runId)
    if (!runWatch) throw Object.assign(new Error(`no AgentPrism run ${runId} is being watched`), { code: 'invalid_params' })
    return runWatch.log()
  }
}
