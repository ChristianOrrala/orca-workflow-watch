// The panel <-> worker contract, declared once. The worker reads each workflow engine's run
// store through a RunSource (src/sources) and the panel draws what it sends: the panel never
// touches the file system, and knows no engine's file layout.
export {}

export type RunState = 'running' | 'waiting' | 'paused' | 'done' | 'failed' | 'stopped' | 'lost'
export type AgentState = 'running' | 'done' | 'failed'
/** `skipped`: declared, never entered, while a later phase ran. */
export type PhaseState = 'pending' | 'active' | 'done' | 'failed' | 'skipped'
export type LogTone = 'info' | 'warn' | 'error' | 'success'

/** One agent() call. Times are epoch milliseconds. */
export interface AgentView {
  id: number
  label: string
  phase: string
  state: AgentState
  adapter: string | null
  model: string | null
  startedAt: number
  endedAt: number | null
  tokens: number | null
  attempts: number | null
  error: string | null
}

export interface PhaseView {
  title: string
  detail: string | null
  state: PhaseState
  startedAt: number | null
  endedAt: number | null
  agents: AgentView[]
  /** Agents left out of `agents` to keep a huge fan-out small; counted in the run totals. */
  hiddenAgents: number
  commands: { running: number; done: number; failed: number }
}

export interface LogLine {
  ts: number
  text: string
  tone: LogTone
}

/** The workflow engines the plugin reads. A run id is unique within its engine only. */
export type EngineId = 'odw' | 'agentprism'

/** How a person answers a run that waits for them: a line to copy, and what to do with it. */
export interface Answer {
  /** The text to copy: a command line, or a tool call's JSON. */
  copy: string
  /** One sentence on where it goes. `{where}` stands for " on <server>" or nothing. */
  how: string
}

export interface RunView {
  id: string
  /** Which engine ran it. */
  engine: EngineId
  /** The paired Orca server the run lives on; null for this computer. */
  host: string | null
  hostName: string | null
  workflow: string
  description: string | null
  state: RunState
  startedAt: number
  updatedAt: number
  endedAt: number | null
  /** Folder name of the repository the run worked in. */
  source: string | null
  /** Branch when recorded by the workflow engine; older paired servers can omit it. */
  branch?: string
  /**
   * What the run was about, from its args: a short hash of `run_dir`, `plan_file`, `plan`,
   * `spec`, `target`, `issue` or `task` (the first one set), else of all its args. Two runs of
   * one workflow on different plans have different subjects.
   */
  subject: string | null
  /** That subject for people: the plan file's name, say. */
  subjectLabel: string | null
  dry: boolean
  adapter: string | null
  phases: PhaseView[]
  agents: { total: number; running: number; done: number; failed: number }
  tokens: { spent: number; budget: number | null }
  /** The last few log lines; the rest come from `watch.log`. */
  log: LogLine[]
  /** Every line the run logged, the dropped ones included. */
  logCount: number
  waiting: { title: string; since: number; checkpointId: number | null } | null
  /**
   * Every checkpoint the run stopped at, oldest first: when it asked and when it was answered
   * (null while it still waits).
   */
  checkpoints: Checkpoint[]
  /** How to answer `waiting`, in the engine's own terms; null when the run is not waiting. */
  answer: Answer | null
  error: string | null
  /**
   * What the workflow itself said it ended with: the `status` of the object it returned
   * (result.json). A script that stops to ask the owner returns normally, so ODW calls the run
   * done; this keeps "waiting-for-owner" or "error" visible. Null while live or when the
   * result has no status.
   */
  outcome: Outcome | null
}

export interface Checkpoint {
  title: string
  since: number
  until: number | null
}

export type OutcomeTone = 'ok' | 'attention' | 'bad' | 'neutral'

export interface Outcome {
  status: string
  tone: OutcomeTone
  /** The question or the reason it gave, cut short. */
  text: string | null
}

/** A paired Orca server this computer also watches. */
export interface HostStatus {
  id: string
  name: string
  /**
   * `no-plugin`: the server answers but has no Workflow Watch for Orca running.
   * `stale`: it has one, but its runs stopped coming (its worker stopped, or it is older than 0.4).
   */
  state: 'connecting' | 'ok' | 'stale' | 'offline' | 'no-plugin' | 'error'
  error: string | null
  /** When its runs last came in (this computer's clock), or null. */
  lastSeen: number | null
  /**
   * True when the server's copy can be asked for an agent's prompt and answer or a run's full log
   * (a development folder there, reached through `orca plugin dev request`). An installed copy
   * publishes its runs only: those stay on the server.
   */
  details: boolean
  /**
   * `<engine>:<run id>` of the run whose last events (up to 50) the server publishes, its newest;
   * "Show all" on it reads those. Null or absent when there is none (a server older than 0.4.1).
   */
  tail?: string | null
}

/** One engine this computer watches, for the footer and the empty state. */
export interface EngineInfo {
  id: EngineId
  label: string
  /** Its runs folder, with the home folder written as `~`. */
  root: string
  rootExists: boolean
  /** How to start a first run, as a line to copy, or null. */
  hint: { text: string; copy: string | null } | null
  /** Why its last scan failed, or null: the other engines still show. */
  error?: string | null
}

export interface Snapshot {
  /** True when any engine's folder exists. */
  rootExists: boolean
  engines: EngineInfo[]
  runs: RunView[]
  /** Paired servers watched besides this computer; empty when there are none. */
  hosts: HostStatus[]
  /** This computer's name, for labelling its runs next to a paired server's. */
  localName: string
  scannedAt: number
  error: string | null
}

/** Every log line a run keeps, oldest first, for "Show all"; `dropped` older ones are gone. */
export interface RunLog {
  runId: string
  lines: LogLine[]
  dropped: number
}

export interface AgentDetail {
  runId: string
  agentId: number
  label: string
  prompt: string | null
  reply: string | null
  stderr: string | null
}

declare module 'orca' {
  interface PluginRequests {
    /** The runs as they are now; `localOnly` leaves out paired servers (what a client asks a server). */
    'watch.snapshot': { input: { localOnly?: boolean } | null; output: Snapshot }
    /** What one agent was asked and answered, cut short; `host` names the paired server it ran on. */
    'watch.agent': { input: { runId: string; agentId: number; host?: string | null; engine?: EngineId }; output: AgentDetail }
    /** Puts text (a command the panel shows) on this computer's clipboard. */
    /** Every log line one run keeps (its newest 500); `host` names the paired server it ran on. */
    'watch.log': { input: { runId: string; host?: string | null; engine?: EngineId }; output: RunLog }
    'watch.copy': { input: { text: string }; output: { copied: boolean } }
    /** Watch another runs folder for an engine (ODW when none is named); answers the new snapshot. */
    'watch.setRoot': { input: { root: string; engine?: EngineId }; output: Snapshot }
  }
  interface PluginPanelEvents {
    /** Posted to every open panel whenever a run changes. */
    'watch.changed': Snapshot
  }
}
