// What the worker needs from a workflow engine: where its runs live, and its runs read as the
// panel's RunView. Each engine keeps its own file layout and vocabulary behind this; the worker
// merges every source's runs, follows paired servers and notifies, the same for all of them.
import type { AgentDetail, EngineId, EngineInfo, RunLog, RunView } from '../protocol'

export interface RunSource {
  readonly id: EngineId
  readonly label: string
  /** The runs folder, absolute. A folder that does not exist yet is fine: it shows no runs. */
  root: string
  /** Its state for the footer and the empty state. */
  info(): EngineInfo
  /**
   * This computer's runs, newest first: every live one, and finished ones up to `history`.
   * Called every second while a run is live; a source keeps what it read and reads only what
   * changed since.
   */
  scan(history: number, log: (message: string) => void): RunView[]
  /** What one agent was asked and answered, cut short. Throws when the run is unknown. */
  agent(runId: string, agentId: number): AgentDetail
  /** Every log line the run keeps (the newest LOG_KEEP), for "Show all". Throws when the run is unknown. */
  log(runId: string): RunLog
  /** Forget every cached read: the root moved. */
  reset(): void
}
