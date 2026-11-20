// Runs on paired Orca servers. A plugin worker always runs on the computer whose Orca loaded it,
// and the plugin host API does not reach a paired server (stablyai/orca#30852, #37788), so a
// laptop's worker cannot read the server's runs folder. What does reach it is the Orca CLI's
// `--environment`: it talks to a saved paired server over the same connection Orca's own window
// uses. Each server runs this plugin too; the laptop asks it for its own runs with
// `orca plugin dev request <key> watch.snapshot --data {"localOnly":true} --environment <id>`.
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentDetail, EngineId, HostStatus, RunLog, RunView, Snapshot } from './protocol'
import { normalizeLog, normalizeRun } from './wire'

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

const LIVE_MS = 2000
const IDLE_MS = 10000
const ENV_REFRESH_MS = 60000
const CALL_TIMEOUT_MS = 15000

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

interface CliEnvelope {
  ok?: boolean
  result?: unknown
  error?: { code?: string; message?: string; data?: { requestCode?: string } }
}

function parse(out: CliResult): CliEnvelope {
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
  // Orca reaches a paired server's plugin only when it is loaded there as a development plugin;
  // one installed from a catalog or Git answers plugin_not_found.
  if (
    /not.{0,4}(found|loaded|installed)|loaded development plugin|unknown plugin|no plugin|approval|consent|Plugin service is not available/i.test(message) ||
    code === 'approval_required' ||
    code === 'plugin_not_found' ||
    requestCode === 'unknown_method'
  )
    return { state: 'no-plugin', error: message }
  if (/unreachable|offline|connect|timed? ?out|ECONN|socket|closed|unavailable/i.test(`${code} ${message}`)) return { state: 'offline', error: message }
  return { state: 'error', error: message }
}

interface Source {
  env: Environment
  status: HostStatus
  snapshot: Snapshot | null
  next: number
  failures: number
  busy: boolean
}

/** Follows every paired server, each at its own pace. */
export class RemoteHosts {
  private sources = new Map<string, Source>()
  private envsAt = 0
  private envsBusy = false
  private readonly run: CliRunner
  private readonly pluginKey: () => string
  private readonly wanted: () => string
  private readonly onChange: () => void
  private readonly log: (message: string) => void

  constructor(opts: { run: CliRunner; pluginKey: () => string; wanted: () => string; onChange: () => void; log?: (message: string) => void }) {
    this.run = opts.run
    this.pluginKey = opts.pluginKey
    this.wanted = opts.wanted
    this.onChange = opts.onChange
    this.log = opts.log ?? (() => undefined)
  }

  /** Forget the list of servers, so the next tick reads it again (a setting changed). */
  reset(): void {
    this.sources.clear()
    this.envsAt = 0
  }

  hosts(): HostStatus[] {
    return [...this.sources.values()].map((s) => s.status)
  }

  snapshots(): { env: Environment; snapshot: Snapshot }[] {
    return [...this.sources.values()].filter((s) => s.snapshot && s.status.state === 'ok').map((s) => ({ env: s.env, snapshot: s.snapshot! }))
  }

  /** Reads the saved servers now and then, and asks each one that is due. */
  async tick(now = Date.now()): Promise<void> {
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
    this.log(`paired servers: ${list.length ? list.map((e) => String(e.name ?? e.id)).join(', ') : 'none'}`)
    const names = wanted === '' || wanted === 'auto' ? null : wanted.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean)
    const envs: Environment[] = []
    for (const raw of list) {
      const id = typeof raw.id === 'string' ? raw.id : null
      if (!id) continue
      const name = (typeof raw.name === 'string' && raw.name) || (typeof raw.label === 'string' && raw.label) || id
      if (names && !names.includes(id.toLowerCase()) && !names.includes(name.toLowerCase())) continue
      envs.push({ id, name })
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
        status: { id: env.id, name: env.name, state: 'connecting', error: null, lastSeen: null },
        snapshot: null,
        next: 0,
        failures: 0,
        busy: false,
      })
      changed = true
    }
    if (changed) this.onChange()
  }

  private async poll(source: Source): Promise<void> {
    source.busy = true
    try {
      const out = await this.run(
        ['plugin', 'dev', 'request', this.pluginKey(), 'watch.snapshot', '--data', '{"localOnly":true}', '--environment', source.env.id, '--timeout-ms', '10000', '--json'],
        CALL_TIMEOUT_MS,
      )
      const envelope = parse(out)
      const snapshot = (envelope.result as { result?: Snapshot } | undefined)?.result
      const before = JSON.stringify([source.status.state, source.snapshot?.runs])
      if (envelope.ok && snapshot && Array.isArray(snapshot.runs)) {
        // Every run checked: a malformed one is dropped, never handed to the worker or panel.
        const runs = snapshot.runs.map(normalizeRun).filter((r): r is RunView => r !== null)
        if (runs.length !== snapshot.runs.length) this.log(`${source.env.name}: dropped ${snapshot.runs.length - runs.length} malformed run(s)`)
        source.snapshot = { ...snapshot, runs }
        source.status = { ...source.status, state: 'ok', error: null, lastSeen: Date.now() }
        source.failures = 0
        source.next = Date.now() + (snapshot.runs.some((r) => r.state === 'running' || r.state === 'waiting' || r.state === 'paused') ? LIVE_MS : IDLE_MS)
      } else {
        const { state, error } = classify(envelope)
        if (source.status.state !== state) this.log(`${source.env.name}: ${state}: ${error}`)
        source.status = { ...source.status, state, error }
        source.failures++
        source.next = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(source.failures, 4))
      }
      if (JSON.stringify([source.status.state, source.snapshot?.runs]) !== before) this.onChange()
    } finally {
      source.busy = false
    }
  }

  /** One agent's detail from the server that ran it. */
  async agent(hostId: string, runId: string, agentId: number, engine: EngineId = 'odw'): Promise<AgentDetail> {
    const source = this.sources.get(hostId)
    if (!source) throw Object.assign(new Error(`no paired server ${hostId}`), { code: 'invalid_params' })
    const out = await this.run(
      ['plugin', 'dev', 'request', this.pluginKey(), 'watch.agent', '--data', JSON.stringify(engine === 'odw' ? { runId, agentId } : { runId, agentId, engine }), '--environment', hostId, '--timeout-ms', '10000', '--json'],
      CALL_TIMEOUT_MS,
    )
    const envelope = parse(out)
    const detail = (envelope.result as { result?: AgentDetail } | undefined)?.result
    if (!envelope.ok || !detail) throw Object.assign(new Error(classify(envelope).error), { code: 'action_failed' })
    return detail
  }

  /**
   * One run's full log from the server it runs on. A server on an older plugin has no
   * `watch.log`: that fails with code `not_supported`, and the panel keeps the short log.
   */
  async runLog(hostId: string, runId: string, engine: EngineId = 'odw'): Promise<RunLog> {
    const source = this.sources.get(hostId)
    if (!source) throw Object.assign(new Error(`no paired server ${hostId}`), { code: 'invalid_params' })
    const out = await this.run(
      ['plugin', 'dev', 'request', this.pluginKey(), 'watch.log', '--data', JSON.stringify(engine === 'odw' ? { runId } : { runId, engine }), '--environment', hostId, '--timeout-ms', '10000', '--json'],
      CALL_TIMEOUT_MS,
    )
    const envelope = parse(out)
    const log = envelope.ok ? normalizeLog((envelope.result as { result?: unknown } | undefined)?.result, runId) : null
    if (log) return log
    if (envelope.error?.data?.requestCode === 'unknown_method' || /no handler|unknown (method|request)/i.test(envelope.error?.message ?? ''))
      throw Object.assign(new Error(`${source.env.name} runs an older Workflow Watch, which sends only the latest lines`), { code: 'not_supported' })
    throw Object.assign(new Error(classify(envelope).error), { code: 'action_failed' })
  }
}
