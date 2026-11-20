// Runs on paired Orca servers. A plugin worker always runs on the computer whose Orca loaded it,
// and the plugin host API does not reach a paired server (stablyai/orca#30852, #37788), so a
// laptop's worker cannot read the server's runs folder. What does reach it is the Orca CLI's
// `--environment`: it talks to a saved paired server over the same connection Orca's own window
// uses. Each server runs this plugin too and writes its runs into its plugin log as beacon lines
// (./beacon); this computer finds that copy's key with `orca plugin list --environment <id>` and
// reads the lines with `orca plugin logs <key> --environment <id>`, which reaches a copy installed
// from a catalog as well as a development folder.
//
// `orca plugin dev request` reaches development folders only. It stays for the two things a
// beacon cannot hold, an agent's prompt and answer and a run's full log, and is used only when
// the server's copy is a development folder.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentDetail, EngineId, HostStatus, RunLog, RunView } from './protocol'
import { normalizeLog } from './wire'
import { assembleRuns, assessBeacon, BEACON_INTERVAL_MS, emptyTracker, readBeaconLog, runKey, type BeaconTracker } from './beacon'
import { isLive } from './model'

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs the Orca CLI with arguments, never through a shell. */
export type CliRunner = (args: string[], timeoutMs: number) => Promise<CliResult>

export interface Environment {
  id: string
  name: string
}

/** Reads of a server's log while it has a live run, and while it has none. */
export const LIVE_READ_MS = 3000
export const IDLE_READ_MS = BEACON_INTERVAL_MS
/** The server's plugin list is read again this often (a copy installed, removed or restarted). */
const KEYS_REFRESH_MS = 60_000
const ENV_REFRESH_MS = 60_000
const CALL_TIMEOUT_MS = 15_000
/** Reads with nothing current before the next copy of the plugin is tried, when there are several. */
const QUIET_READS_BEFORE_NEXT_COPY = 3

/** The Orca CLI on this computer: the setting, then the app bundle, then PATH. */
export function findOrcaCli(setting: string | null): string {
  if (setting && setting.trim()) return setting.trim()
  const candidates = [
    '/Applications/Orca.app/Contents/Resources/bin/orca',
    join(homedir(), 'Applications', 'Orca.app', 'Contents', 'Resources', 'bin', 'orca'),
    join(homedir(), '.orca', 'cli', 'bin', 'orca'),
    '/usr/local/bin/orca',
  ]
  return candidates.find((path) => existsSync(path)) ?? 'orca'
}

export function cliRunner(cli: string): CliRunner {
  return (args, timeoutMs) =>
    new Promise((resolve) => {
      execFile(cli, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
        const exit = (error as { code?: unknown } | null)?.code
        const code = !error ? 0 : typeof exit === 'number' ? exit : 1
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      })
    })
}

export interface CliEnvelope {
  ok?: boolean
  result?: unknown
  error?: { code?: string; message?: string; data?: { requestCode?: string } }
}

export function parse(out: CliResult): CliEnvelope {
  try {
    return JSON.parse(out.stdout) as CliEnvelope
  } catch {
    return { ok: false, error: { code: 'bad_output', message: (out.stderr || out.stdout).trim().slice(0, 300) || `exit ${out.code}` } }
  }
}

/** A failed call, sorted into what the panel tells the person. */
export function classify(envelope: CliEnvelope): { state: HostStatus['state']; error: string } {
  const code = envelope.error?.code ?? 'error'
  const message = envelope.error?.message ?? 'no answer'
  const requestCode = envelope.error?.data?.requestCode
  if (
    /not.{0,4}(found|loaded|installed)|loaded development plugin|unknown plugin|no plugin|approval|consent|Plugin service is not available|plugins are off/i.test(message) ||
    code === 'approval_required' ||
    code === 'plugin_not_found' ||
    requestCode === 'unknown_method'
  )
    return { state: 'no-plugin', error: message }
  if (/unreachable|offline|connect|timed? ?out|ECONN|socket|closed|unavailable/i.test(`${code} ${message}`)) return { state: 'offline', error: message }
  return { state: 'error', error: message }
}

/** A copy of this plugin on a server: its key, and whether it is a development folder. */
export interface PluginCopy {
  key: string
  isDev: boolean
  status: string
}

const KEY_PREFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** A plugin key that names this plugin (`<publisher>.<id>`), safe to pass to the CLI. */
export function isOurKey(key: unknown, pluginId: string): key is string {
  if (typeof key !== 'string' || key.length > 200 || !key.endsWith(`.${pluginId}`)) return false
  return KEY_PREFIX.test(key.slice(0, key.length - pluginId.length - 1))
}

/**
 * The copies of this plugin on a server, from `orca plugin list --json`: any key whose id is
 * ours, from a catalog (`christianorrala.<id>`) or a folder (`local.<id>`). Copies that can run
 * come first, a running one before an idle one. Null when the answer is not a plugin list.
 */
export function findCopies(envelope: CliEnvelope, pluginId: string): { readable: PluginCopy[]; any: boolean } | null {
  if (!envelope.ok) return null
  const list = (envelope.result as { plugins?: unknown } | undefined)?.plugins
  if (!Array.isArray(list)) return null
  const copies: PluginCopy[] = []
  for (const raw of list.slice(0, 500)) {
    const p = (raw ?? {}) as Record<string, unknown>
    if (!isOurKey(p.pluginKey, pluginId)) continue
    copies.push({ key: p.pluginKey, isDev: p.isDev === true, status: typeof p.status === 'string' ? p.status.slice(0, 40) : '' })
  }
  const rank = (s: string) => (s === 'running' ? 0 : s === 'idle' ? 1 : 2)
  const readable = copies.filter((c) => rank(c.status) < 2).sort((a, b) => rank(a.status) - rank(b.status))
  return { readable, any: copies.length > 0 }
}

interface Source {
  env: Environment
  status: HostStatus
  runs: RunView[]
  next: number
  failures: number
  busy: boolean
  copies: PluginCopy[]
  copyIndex: number
  keysAt: number
  tracker: BeaconTracker
  /** Runs decoded from the server's records, by record hash. */
  cache: Map<string, RunView>
  quietReads: number
}

/** Follows every paired server, each at its own pace. */
export class RemoteHosts {
  private sources = new Map<string, Source>()
  private envsAt = 0
  private envsBusy = false
  private lastEnvNames = ''
  private readonly run: CliRunner
  private readonly pluginId: string
  private readonly wanted: () => string
  private readonly onChange: () => void
  private readonly log: (message: string) => void
  private readonly now: () => number

  /** `pluginId`: the manifest id every copy of this plugin shares, whatever its publisher. */
  constructor(opts: { run: CliRunner; pluginId: string; wanted: () => string; onChange: () => void; log?: (message: string) => void; now?: () => number }) {
    this.run = opts.run
    this.pluginId = opts.pluginId
    this.wanted = opts.wanted
    this.onChange = opts.onChange
    this.log = opts.log ?? (() => undefined)
    this.now = opts.now ?? Date.now
  }

  /** Forget the list of servers, so the next tick reads it again (a setting changed). */
  reset(): void {
    this.sources.clear()
    this.envsAt = 0
  }

  hosts(): HostStatus[] {
    return [...this.sources.values()].map((s) => s.status)
  }

  /** The runs of every server whose beacon is current. */
  snapshots(): { env: Environment; runs: RunView[] }[] {
    return [...this.sources.values()].filter((s) => s.status.state === 'ok').map((s) => ({ env: s.env, runs: s.runs }))
  }

  /** Reads the saved servers now and then, and reads each one that is due. */
  async tick(now = this.now()): Promise<void> {
    const wanted = this.wanted().trim()
    if (wanted === 'off') {
      if (this.sources.size) {
        this.sources.clear()
        this.onChange()
      }
      return
    }
    if (now - this.envsAt > ENV_REFRESH_MS && !this.envsBusy) {
      this.envsBusy = true
      try {
        await this.refreshEnvironments(wanted)
        this.envsAt = now
      } finally {
        this.envsBusy = false
      }
    }
    await Promise.all([...this.sources.values()].filter((s) => !s.busy && s.next <= now).map((s) => this.poll(s)))
  }

  private async refreshEnvironments(wanted: string): Promise<void> {
    const out = await this.run(['environment', 'list', '--json'], CALL_TIMEOUT_MS)
    const envelope = parse(out)
    if (!envelope.ok) {
      this.log(`orca environment list failed: ${envelope.error?.message ?? `exit ${out.code}`}`)
      return
    }
    const list = ((envelope.result as { environments?: unknown[] } | undefined)?.environments ?? []) as Record<string, unknown>[]
    const names = wanted === '' || wanted === 'auto' ? null : wanted.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean)
    const envs: Environment[] = []
    for (const raw of list) {
      const id = typeof raw.id === 'string' ? raw.id : null
      // Orca makes the id when a server is paired; anything else could not be passed to the CLI.
      if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue
      const name = (typeof raw.name === 'string' && raw.name.slice(0, 128)) || (typeof raw.label === 'string' && raw.label.slice(0, 128)) || id
      if (names && !names.includes(id.toLowerCase()) && !names.includes(name.toLowerCase())) continue
      envs.push({ id, name })
    }
    // Said once per change, not every minute: the log is also where the beacon lives.
    const seen = envs.map((e) => e.name).join(', ')
    if (seen !== this.lastEnvNames) {
      this.lastEnvNames = seen
      this.log(`paired servers watched: ${seen || 'none'}`)
    }
    let changed = false
    const keep = new Set(envs.map((e) => e.id))
    for (const id of [...this.sources.keys()]) {
      if (!keep.has(id)) {
        this.sources.delete(id)
        changed = true
      }
    }
    for (const env of envs) {
      const known = this.sources.get(env.id)
      if (known) {
        known.env = env
        known.status.name = env.name
        continue
      }
      this.sources.set(env.id, {
        env,
        status: { id: env.id, name: env.name, state: 'connecting', error: null, lastSeen: null, details: false },
        runs: [],
        next: 0,
        failures: 0,
        busy: false,
        copies: [],
        copyIndex: 0,
        keysAt: 0,
        tracker: emptyTracker(),
        cache: new Map(),
        quietReads: 0,
      })
      changed = true
    }
    if (changed) this.onChange()
  }

  private setStatus(source: Source, patch: Partial<HostStatus>): void {
    const next = { ...source.status, ...patch }
    if (next.state !== source.status.state && next.state !== 'ok') this.log(`${source.env.name}: ${next.state}${next.error ? `: ${next.error}` : ''}`)
    source.status = next
  }

  private backoff(source: Source): number {
    source.failures++
    return this.now() + Math.min(60_000, 5000 * 2 ** Math.min(source.failures, 4))
  }

  /** Which copies of this plugin the server has. False when that could not be read. */
  private async readCopies(source: Source): Promise<boolean> {
    const envelope = parse(await this.run(['plugin', 'list', '--environment', source.env.id, '--json'], CALL_TIMEOUT_MS))
    const found = findCopies(envelope, this.pluginId)
    if (!found) {
      const { state, error } = envelope.ok ? { state: 'error' as const, error: 'its plugin list could not be read' } : classify(envelope)
      this.setStatus(source, { state, error, details: false })
      return false
    }
    source.keysAt = this.now()
    if (JSON.stringify(found.readable) !== JSON.stringify(source.copies)) {
      source.copies = found.readable
      source.copyIndex = 0
      source.tracker = emptyTracker()
      source.quietReads = 0
    }
    if (!found.readable.length) {
      this.setStatus(source, {
        state: 'no-plugin',
        error: found.any ? 'Workflow Watch for Orca is installed there but turned off.' : 'Workflow Watch for Orca is not installed there.',
        details: false,
      })
      return false
    }
    return true
  }

  private async poll(source: Source): Promise<void> {
    source.busy = true
    const before = JSON.stringify([source.status, source.runs])
    try {
      const now = this.now()
      if (!source.copies.length || now - source.keysAt > KEYS_REFRESH_MS) {
        if (!(await this.readCopies(source))) {
          source.runs = []
          source.next = source.status.state === 'no-plugin' ? this.now() + KEYS_REFRESH_MS : this.backoff(source)
          return
        }
      }
      const copy = source.copies[source.copyIndex % source.copies.length]
      const envelope = parse(await this.run(['plugin', 'logs', copy.key, '--environment', source.env.id, '--json'], CALL_TIMEOUT_MS))
      const lines = (envelope.result as { lines?: unknown } | undefined)?.lines
      if (!envelope.ok || !Array.isArray(lines)) {
        const { state, error } = envelope.ok ? { state: 'error' as const, error: 'its plugin log could not be read' } : classify(envelope)
        this.setStatus(source, { state, error })
        source.runs = []
        // The copy may have gone: read the plugin list again before the next try.
        source.keysAt = 0
        source.next = this.backoff(source)
        return
      }
      source.failures = 0
      const read = this.now()
      const log = readBeaconLog(lines)
      const allowance = source.runs.some((r) => isLive(r.state)) ? LIVE_READ_MS : IDLE_READ_MS
      const judged = assessBeacon(log.latest, source.tracker, read, allowance)
      source.tracker = judged.tracker
      if (judged.fresh && log.manifest) {
        const previous = new Map(source.runs.map((r) => [runKey(r), r]))
        const { runs, missing } = assembleRuns(log, source.cache, previous)
        if (missing) this.log(`${source.env.name}: ${missing} run record(s) not whole yet; showing the last ones`)
        source.runs = runs
        source.quietReads = 0
        this.setStatus(source, { state: 'ok', error: null, lastSeen: read, details: copy.isDev })
      } else {
        source.quietReads++
        const waitingForProof = log.latest !== null && !source.tracker.confirmed && source.quietReads < 2
        if (waitingForProof) {
          this.setStatus(source, { state: 'connecting', error: null, details: copy.isDev })
        } else {
          source.runs = []
          this.setStatus(source, {
            state: 'stale',
            error: log.latest
              ? `No word from its Workflow Watch since ${new Date(log.latest.t).toLocaleTimeString('en-GB')}: its worker may have stopped.`
              : 'Its Workflow Watch publishes no runs: update it there to 0.4.0 or newer.',
            details: copy.isDev,
          })
        }
        if (source.quietReads >= QUIET_READS_BEFORE_NEXT_COPY) {
          // Read the plugin list again (its worker may have restarted under another key) and, with a
          // development folder and an install, say, try the other copy.
          source.quietReads = 0
          source.keysAt = 0
          if (source.copies.length > 1) {
            source.copyIndex = (source.copyIndex + 1) % source.copies.length
            source.tracker = emptyTracker()
          }
        }
      }
      source.next = this.now() + (source.runs.some((r) => isLive(r.state)) ? LIVE_READ_MS : IDLE_READ_MS)
    } finally {
      source.busy = false
      if (JSON.stringify([source.status, source.runs]) !== before) this.onChange()
    }
  }

  /** The development folder on a server that can answer a request, or a reason it cannot. */
  private devCopy(hostId: string): { source: Source; key: string } {
    const source = this.sources.get(hostId)
    if (!source) throw Object.assign(new Error(`no paired server ${hostId}`), { code: 'invalid_params' })
    const copy = source.copies[source.copyIndex % Math.max(1, source.copies.length)]
    if (!copy || !copy.isDev)
      throw Object.assign(new Error(`This stays on ${source.env.name}: open Workflows there to read it.`), { code: 'action_failed' })
    return { source, key: copy.key }
  }

  /** Asks a server's development copy of this plugin. */
  private async request(source: Source, key: string, method: string, data: unknown): Promise<CliEnvelope> {
    const out = await this.run(
      ['plugin', 'dev', 'request', key, method, '--data', JSON.stringify(data), '--environment', source.env.id, '--timeout-ms', '10000', '--json'],
      CALL_TIMEOUT_MS,
    )
    return parse(out)
  }

  /** One agent's detail from the server that ran it (a development folder there only). */
  async agent(hostId: string, runId: string, agentId: number, engine: EngineId = 'odw'): Promise<AgentDetail> {
    const { source, key } = this.devCopy(hostId)
    const envelope = await this.request(source, key, 'watch.agent', engine === 'odw' ? { runId, agentId } : { runId, agentId, engine })
    const detail = (envelope.result as { result?: AgentDetail } | undefined)?.result
    if (!envelope.ok || !detail) throw Object.assign(new Error(classify(envelope).error), { code: 'action_failed' })
    return detail
  }

  /** One run's full log from the server it runs on (a development folder there only). */
  async runLog(hostId: string, runId: string, engine: EngineId = 'odw'): Promise<RunLog> {
    const { source, key } = this.devCopy(hostId)
    const envelope = await this.request(source, key, 'watch.log', engine === 'odw' ? { runId } : { runId, engine })
    const log = envelope.ok ? normalizeLog((envelope.result as { result?: unknown } | undefined)?.result, runId) : null
    if (log) return log
    throw Object.assign(new Error(classify(envelope).error), { code: 'action_failed' })
  }
}
