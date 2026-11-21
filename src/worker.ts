// The plugin's worker: it follows each workflow engine's runs on this computer (one RunSource
// per engine: ./sources), asks every paired Orca server for its own runs, and tells the panel
// what changed.
//
// Both engines keep their runs as plain files, so watching needs no engine server: a file
// watcher wakes the worker, a slow poll catches what a watcher misses. The worker also writes
// this computer's runs into its plugin log as beacon lines (./beacon), and reads each paired
// server's the same way through the Orca CLI (./remote). The
// status bar item keeps the worker running while the plugin is enabled, so finished runs and
// checkpoints still notify with the panel closed.
import type { OrcaWorkerApi } from 'orca/worker'
import { existsSync, watch, type FSWatcher } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { hostname, platform } from 'node:os'
import { isAgentId, isLive } from './model'
import { cliRunner, findCopies, findOrcaCli, parse, RemoteHosts } from './remote'
import { BeaconWriter } from './beacon'
import type { EngineId, EngineInfo, RunState, RunView, Snapshot } from './protocol'
import { workflowStatus } from './status'
import type { RunSource } from './sources/types'
import { OdwSource } from './sources/odw'
import { AgentPrismSource } from './sources/agentprism'
import { expandHome } from './sources/paths'

export { needsYou } from './status'

const DEFAULT_ROOT = '~/.odw/runs'
const DEFAULT_AGENTPRISM_ROOT = '~/.agentprism/workflows'
/** The manifest's id: a server's copy is found by it, whatever its key (catalog or folder). */
const PLUGIN_ID = 'workflow-watch-orca'
const STATUS_ITEM = 'workflows'
const FAST_MS = 1000
const SLOW_MS = 5000
const REMOTE_TICK_MS = 1000
const DEBOUNCE_MS = 120
const POST_LIMIT = 240 * 1024
/** An unchanged snapshot is posted again this often, so the panel can tell a quiet run from a dead worker. */
const HEARTBEAT_MS = 10_000

function duration(msTotal: number): string {
  const s = Math.max(0, Math.round(msTotal / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

function failure(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const keyOf = (run: RunView) => `${run.host ?? 'local'}:${run.engine ?? 'odw'}:${run.id}`

const byLiveThenNewest = (a: RunView, b: RunView) => Number(isLive(b.state)) - Number(isLive(a.state)) || b.startedAt - a.startedAt

/** "Mac mini" on macOS (its Computer Name), else the host name's first label. */
function friendlyName(): string {
  if (platform() === 'darwin') {
    try {
      const name = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 2000 }).trim()
      if (name) return name
    } catch {
      // Fall back to the host name.
    }
  }
  return hostname().split('.')[0] || 'This computer'
}

let stop: (() => void) | null = null

export default function activate(orca: OrcaWorkerApi): void {
  const odw = new OdwSource(expandHome(DEFAULT_ROOT))
  const agentprism = new AgentPrismSource(expandHome(DEFAULT_AGENTPRISM_ROOT))
  const sources: RunSource[] = [odw, agentprism]
  const sourceOf = (engine: EngineId | null | undefined) => sources.find((s) => s.id === (engine ?? 'odw')) ?? odw
  let history = 12
  let notify = true
  let remotesWanted = 'auto'
  let cliSetting = ''
  const localName = friendlyName()
  const lastStates = new Map<string, RunState>()
  let primed = false
  // Hosts whose runs have been seen once: only their later changes are announced.
  const primedHosts = new Set<string>()
  let local: Snapshot = { rootExists: false, engines: [], runs: [], hosts: [], localName, scannedAt: 0, error: null }
  let snapshot: Snapshot = local
  let lastPosted = ''
  let lastPostAt = 0
  let lastStatus = ''
  let watchers: FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let remoteTimer: ReturnType<typeof setInterval> | null = null
  let debounce: ReturnType<typeof setTimeout> | null = null

  // Every line this worker logs goes through here, so the beacon can count them (./beacon).
  const beacon = new BeaconWriter({ write: (line) => orca.log(line) })
  const say = (message: string) => {
    beacon.noteLine()
    orca.log(message)
  }

  let run = cliRunner(findOrcaCli(null))
  orca.commands.register('workflowWatch.open', async () => {
    // The worker API doesn't expose panel opening. Orca's CLI explicitly supports it;
    // discover the key so development folders and catalog installs both work.
    const list = parse(await run(['plugin', 'list', '--environment', 'local', '--json'], 3000))
    const copies = findCopies(list, PLUGIN_ID)?.readable ?? []
    const copy = copies.find((candidate) => candidate.isDev) ?? copies[0]
    if (!copy) throw new Error('Workflow Watch is not available on this Orca host.')
    const opened = await run(['plugin', 'open', copy.key, '--panel', 'runs', '--environment', 'local', '--json'], 3000)
    if (!parse(opened).ok) throw new Error('Could not open the Workflows panel.')
  })
  const remote = new RemoteHosts({
    run: (args, timeoutMs) => run(args, timeoutMs),
    pluginId: PLUGIN_ID,
    wanted: () => remotesWanted,
    onChange: () => publish(),
    log: say,
  })

  // Each engine's last good scan: one that fails keeps its runs on screen, and says why.
  const lastGood = new Map<EngineId, RunView[]>()

  /** Every engine's runs on this computer, live first, then newest. */
  function scanLocal(): Snapshot {
    const runs: RunView[] = []
    const log = say
    const engines: EngineInfo[] = []
    for (const source of sources) {
      let error: string | null = null
      try {
        lastGood.set(source.id, source.scan(history, log))
      } catch (cause) {
        error = (cause as Error).message
        log(`${source.label}: ${error}`)
      }
      runs.push(...(lastGood.get(source.id) ?? []))
      engines.push({ ...source.info(), error })
    }
    runs.sort(byLiveThenNewest)
    return { rootExists: engines.some((e) => e.rootExists), engines, runs, hosts: [], localName, scannedAt: Date.now(), error: null }
  }

  function announce(view: RunView, before: RunState | undefined): void {
    if (!notify || !primed || before === view.state) return
    const where = view.hostName ? ` on ${view.hostName}` : ''
    const took = view.endedAt ? ` in ${duration(view.endedAt - view.startedAt)}` : ''
    const agents = `${view.agents.total} agent${view.agents.total === 1 ? '' : 's'}`
    let title: string | null = null
    let body = ''
    const outcome = view.state === 'done' ? view.outcome : null
    if (outcome && outcome.tone === 'attention') {
      title = `${view.workflow} needs you${where}`
      body = outcome.text ?? outcome.status
    } else if (outcome && outcome.tone !== 'ok') {
      title = `${view.workflow} ended: ${outcome.status}${where}`
      body = outcome.text ?? `${agents}${took}`
    } else if (view.state === 'done') {
      title = `${view.workflow} finished${where}`
      body = `${agents}${took}${view.agents.failed ? `, ${view.agents.failed} failed` : ''}`
    } else if (view.state === 'failed') {
      title = `${view.workflow} failed${where}`
      body = view.error ?? `${agents}${took}`
    } else if (view.state === 'waiting' && view.waiting) {
      title = `${view.workflow} is waiting for you${where}`
      body = view.waiting.title
    } else if (view.state === 'lost') {
      title = `${view.workflow} stopped answering${where}`
      body = 'Its worker is gone.'
    }
    if (title) void orca.host.call('notifications.show', { title, body }).catch(() => undefined)
  }

  function updateStatusBar(runs: RunView[]): void {
    const params = workflowStatus(runs, local.error, local.engines.filter((e) => e.error).map((e) => e.id))
    const key = JSON.stringify(params)
    if (key === lastStatus) return
    lastStatus = key
    void orca.host.call('statusBar.update', { id: STATUS_ITEM, ...params }).catch(() => {
      if (key === lastStatus) lastStatus = ''
    })
  }

  /**
   * The snapshot as it goes to a panel or a paired client: under Orca's message limit, which is
   * counted in UTF-8 bytes. Finished runs lose their beads first, then the oldest finished runs
   * go; live runs always stay, at worst as a summary (running and failed beads, a short log).
   */
  function trimmed(next: Snapshot): string {
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8')
    if (size(next) <= POST_LIMIT) return JSON.stringify(next)
    const bare = (r: RunView): RunView => ({ ...r, phases: r.phases.map((p) => ({ ...p, agents: [], hiddenAgents: p.agents.length + p.hiddenAgents })) })
    const slim: Snapshot = { ...next, runs: next.runs.map((r) => (isLive(r.state) ? r : bare(r))) }
    while (size(slim) > POST_LIMIT) {
      let last = slim.runs.length - 1
      while (last >= 0 && isLive(slim.runs[last].state)) last--
      if (last < 0) break
      slim.runs.splice(last, 1)
    }
    if (size(slim) > POST_LIMIT) {
      slim.runs = slim.runs.map((r) => ({
        ...r,
        log: r.log.slice(-3),
        phases: r.phases.map((p) => {
          const kept = p.agents.filter((a) => a.state !== 'done').slice(0, 20)
          return { ...p, agents: kept, hiddenAgents: p.hiddenAgents + p.agents.length - kept.length }
        }),
      }))
    }
    while (size(slim) > POST_LIMIT && slim.runs.length > 1) slim.runs.pop()
    return JSON.stringify(slim)
  }

  /** This computer's runs and every paired server's, as one snapshot for the panel. */
  function publish(): Snapshot {
    const remoteRuns = remote.snapshots().flatMap(({ env, runs }) => runs.map((r) => ({ ...r, host: env.id, hostName: env.name })))
    // Live runs from every host, then the newest finished ones across all of them.
    const all = [...local.runs, ...remoteRuns].sort(byLiveThenNewest)
    let finished = 0
    const runs = all.filter((r) => isLive(r.state) || finished++ < history)
    const hosts = remote.hosts()
    const next: Snapshot = { ...local, runs, hosts }
    // Changes are found before the history limit, so a long job that ends below it still
    // announces. Each host gets its own baseline: the first time its runs arrive they are
    // recorded, not announced, and an outage keeps that host's states for when it is back.
    const reporting = new Set(['local', ...hosts.filter((h) => h.state === 'ok').map((h) => h.id)])
    const seen = new Set<string>()
    for (const view of all) {
      const host = view.host ?? 'local'
      const key = keyOf(view)
      seen.add(key)
      if (primedHosts.has(host)) announce(view, lastStates.get(key))
      lastStates.set(key, view.state)
    }
    for (const host of reporting) primedHosts.add(host)
    for (const key of [...lastStates.keys()]) {
      const host = key.slice(0, key.indexOf(':'))
      if (!seen.has(key) && reporting.has(host)) lastStates.delete(key)
    }
    primed = true
    snapshot = next
    const text = trimmed(next)
    // scannedAt changes every time; post when a run or a host did, and now and then anyway.
    const comparable = text.replace(/"scannedAt":\d+/, '')
    if (comparable !== lastPosted || Date.now() - lastPostAt >= HEARTBEAT_MS) {
      lastPosted = comparable
      lastPostAt = Date.now()
      orca.panels.post('watch.changed', JSON.parse(text) as Snapshot)
    }
    updateStatusBar(all)
    return next
  }

  function refresh(): Snapshot {
    try {
      local = scanLocal()
    } catch (error) {
      local = { ...local, scannedAt: Date.now(), error: (error as Error).message }
    }
    try {
      // This computer's own runs, for the desktops it is paired to, with the newest one's last
      // events (its kept log, read from what the source already holds).
      beacon.update(local.runs, Date.now(), (run) => {
        try {
          return sourceOf(run.engine).log(run.id).lines
        } catch {
          return null
        }
      })
    } catch (error) {
      say(`publishing to paired desktops failed: ${(error as Error).message}`)
    }
    try {
      return publish()
    } catch (error) {
      say(`publishing failed: ${(error as Error).message}`)
      return snapshot ?? local
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    const live = local.runs.some((r) => isLive(r.state))
    timer = setTimeout(() => {
      // The next refresh is set first: nothing a refresh throws can stop the watching.
      schedule()
      refresh()
    }, live ? FAST_MS : SLOW_MS)
  }

  function rewatch(): void {
    for (const w of watchers) w.close()
    watchers = []
    for (const source of sources) {
      if (!existsSync(source.root)) continue
      try {
        // FSEvents on macOS, inotify on Linux: recursive watching is cheap on both.
        const w = watch(source.root, { recursive: true }, () => {
          if (debounce) clearTimeout(debounce)
          debounce = setTimeout(() => {
            debounce = null
            refresh()
            schedule()
          }, DEBOUNCE_MS)
        })
        w.on('error', () => {
          w.close()
          watchers = watchers.filter((x) => x !== w)
        })
        watchers.push(w)
      } catch (error) {
        say(`watching ${source.root} fell back to polling: ${(error as Error).message}`)
      }
    }
  }

  async function loadSettings(): Promise<void> {
    const all = await orca.settings.get().catch(() => ({}) as Record<string, unknown>)
    const nextRoot = expandHome(typeof all.runsRoot === 'string' && all.runsRoot.trim() ? all.runsRoot.trim() : DEFAULT_ROOT)
    const nextPrism = expandHome(typeof all.agentprismRoot === 'string' && all.agentprismRoot.trim() ? all.agentprismRoot.trim() : DEFAULT_AGENTPRISM_ROOT)
    history = typeof all.history === 'number' ? Math.min(50, Math.max(1, Math.round(all.history))) : 12
    notify = all.notifications !== false
    const nextRemotes = typeof all.remotes === 'string' ? all.remotes.trim() : 'auto'
    const nextCli = typeof all.orcaCli === 'string' ? all.orcaCli.trim() : ''
    if (nextRemotes !== remotesWanted || nextCli !== cliSetting) {
      remotesWanted = nextRemotes
      cliSetting = nextCli
      run = cliRunner(findOrcaCli(cliSetting || null))
      remote.reset()
    }
    let moved = false
    for (const [source, next] of [
      [odw, nextRoot],
      [agentprism, nextPrism],
    ] as const) {
      if (source.root === next) continue
      source.root = next
      source.reset()
      moved = true
    }
    if (moved) {
      lastStates.clear()
      primedHosts.delete('local')
      primed = false
      lastPosted = ''
    }
  }

  stop = () => {
    for (const w of watchers) w.close()
    watchers = []
    if (timer) clearTimeout(timer)
    if (debounce) clearTimeout(debounce)
    if (remoteTimer) clearInterval(remoteTimer)
    timer = debounce = remoteTimer = null
  }

  const ready = (async () => {
    await loadSettings()
    rewatch()
    refresh()
    schedule()
    // Each server keeps its own pace inside RemoteHosts; this only wakes it.
    remoteTimer = setInterval(() => {
      // A change held back by the beacon's pace goes out here, and so does its heartbeat.
      try {
        beacon.tick()
      } catch (error) {
        say(`publishing to paired desktops failed: ${(error as Error).message}`)
      }
      void remote.tick().catch((error) => say(`paired servers: ${(error as Error).message}`))
    }, REMOTE_TICK_MS)
  })()

  orca.settings.onDidChange(() => {
    void loadSettings().then(() => {
      rewatch()
      refresh()
      schedule()
    })
  })

  orca.panels.handle('watch.snapshot', async (input) => {
    await ready
    const merged = refresh()
    // A client asking this computer as its paired server gets this computer's runs only,
    // so two Orcas paired both ways never relay each other's runs back and forth.
    const answer = input && typeof input === 'object' && (input as { localOnly?: unknown }).localOnly === true ? local : merged
    return JSON.parse(trimmed(answer)) as Snapshot
  })

  orca.panels.handle('watch.agent', async ({ runId, agentId, host, engine }) => {
    await ready
    // The request is data from a panel or a paired client: checked before it names a file.
    if (typeof runId !== 'string' || !runId || runId.length > 200) throw failure('invalid_params', 'name a run')
    if (!isAgentId(agentId)) throw failure('invalid_params', 'an agent id is a whole number')
    if (engine != null && engine !== 'odw' && engine !== 'agentprism') throw failure('invalid_params', `no engine ${String(engine)}`)
    if (host != null && typeof host !== 'string') throw failure('invalid_params', 'a host is a server id')
    if (host) return remote.agent(host, runId, agentId, engine ?? 'odw')
    return sourceOf(engine).agent(runId, agentId)
  })

  orca.panels.handle('watch.log', async ({ runId, host, engine }) => {
    await ready
    if (typeof runId !== 'string' || !runId || runId.length > 200) throw failure('invalid_params', 'name a run')
    if (engine != null && engine !== 'odw' && engine !== 'agentprism') throw failure('invalid_params', `no engine ${String(engine)}`)
    if (host != null && typeof host !== 'string') throw failure('invalid_params', 'a host is a server id')
    if (host) return remote.runLog(host, runId, engine ?? 'odw')
    return sourceOf(engine).log(runId)
  })

  // The panel's frame has no clipboard of its own: the worker, on the same computer, copies.
  orca.panels.handle('watch.copy', async ({ text }) => {
    if (typeof text !== 'string' || !text || text.length > 2000) throw failure('invalid_params', 'nothing to copy')
    copyToClipboard(text)
    return { copied: true }
  })

  orca.panels.handle('watch.setRoot', async ({ root: wanted, engine }) => {
    const path = typeof wanted === 'string' ? wanted.trim() : ''
    if (!path) throw failure('invalid_params', 'name a folder')
    if (!existsSync(expandHome(path))) throw failure('invalid_params', `${path} does not exist`)
    await orca.settings.set(engine === 'agentprism' ? 'agentprismRoot' : 'runsRoot', path)
    await loadSettings()
    rewatch()
    return refresh()
  })
}

/** Puts text on this computer's clipboard with the platform's own tool. */
function copyToClipboard(text: string): void {
  const os = platform()
  const tries: [string, string[]][] =
    os === 'darwin' ? [['pbcopy', []]] : os === 'win32' ? [['clip', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]
  for (const [command, args] of tries) {
    try {
      execFileSync(command, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 })
      return
    } catch {
      // try the next tool
    }
  }
  throw failure('action_failed', 'no clipboard tool answered on this computer')
}

export function deactivate(): void {
  stop?.()
  stop = null
}
