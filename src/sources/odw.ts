// Open Dynamic Workflows: `<root>/<workflow>/<runId>/` with status.json, meta.json,
// events.jsonl and result.json, read by ../model.
import { existsSync } from 'node:fs'
import type { RunView } from '../protocol'
import { isLive, listRunDirs, readAgent, readState, RunWatch } from '../model'
import type { RunSource } from './types'
import { expandHome, shortHome } from './paths'

const ENDED = new Set(['done', 'failed', 'stopped'])

export class OdwSource implements RunSource {
  readonly id = 'odw' as const
  readonly label = 'ODW'
  root: string
  private readonly watches = new Map<string, RunWatch>()
  private readonly live = new Set<string>()
  // Runs past the history limit that status.json says have ended: never read again.
  private readonly settled = new Set<string>()

  constructor(root: string) {
    this.root = root
  }

  info() {
    return {
      id: this.id,
      label: this.label,
      root: shortHome(this.root),
      rootExists: existsSync(this.root),
      hint: { text: 'A free dry run:', copy: 'odw run hello --dry' },
    }
  }

  reset(): void {
    this.watches.clear()
    this.live.clear()
    this.settled.clear()
  }

  scan(history: number, log: (message: string) => void): RunView[] {
    const dirs = existsSync(this.root) ? listRunDirs(this.root) : []
    const keep = new Set<string>()
    const runs: RunView[] = []
    // History counts finished runs only: live ones always show, on top of it.
    let finished = 0
    for (const { runId, dir } of dirs) {
      // One id in two workflow buckets (a copied store): the newest listed is the one followed.
      if (keep.has(runId)) {
        log(`ODW run ${runId} is in more than one folder; showing ${this.watches.get(runId)?.dir}`)
        continue
      }
      const known = this.watches.get(runId)
      if (finished >= history) {
        if (this.settled.has(runId)) continue
        if (!this.live.has(runId)) {
          const state = readState(dir)
          if (state !== null && ENDED.has(state)) {
            this.settled.add(runId)
            continue
          }
          // pending, unreadable or live: read it, and look again next time.
          if (state !== 'running' && state !== 'waiting' && state !== 'paused') continue
        }
      }
      const runWatch = known && known.dir === dir ? known : new RunWatch(runId, dir)
      this.watches.set(runId, runWatch)
      keep.add(runId)
      try {
        const view = runWatch.refresh()
        runs.push(withAnswer(view, this.root))
        if (isLive(view.state)) this.live.add(runId)
        else {
          this.live.delete(runId)
          finished++
        }
      } catch (error) {
        log(`could not read ODW run ${runId}: ${(error as Error).message}`)
      }
    }
    for (const runId of [...this.watches.keys()]) if (!keep.has(runId)) this.watches.delete(runId)
    for (const runId of [...this.live]) if (!keep.has(runId)) this.live.delete(runId)
    return runs
  }

  agent(runId: string, agentId: number) {
    const runWatch = this.watches.get(runId)
    if (!runWatch) throw Object.assign(new Error(`no ODW run ${runId} is being watched`), { code: 'invalid_params' })
    return readAgent(runWatch.dir, runId, agentId)
  }
}

/** A run id as ODW issues it, safe on a command line as it is: nothing a shell reads. */
export const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** One argument for a POSIX shell: bare when it is plain, else single-quoted. */
export function shellArg(value: string): string {
  const plain = /^[A-Za-z0-9_@%+=:,./-]+$/
  if (plain.test(value) && !value.startsWith('-')) return value
  if (value.startsWith('~/') && plain.test(value.slice(2))) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * ODW answers a checkpoint from a terminal: `odw approve <run> --checkpoint <n>`, so the
 * command answers the checkpoint shown and no later one, plus `--runs-root` when the runs are
 * not in ODW's default folder. A run id ODW would not issue gets no command at all.
 */
export function withAnswer(view: RunView, root: string): RunView {
  if (!view.waiting) return view
  if (!SAFE_RUN_ID.test(view.id)) return { ...view, answer: { copy: '', how: "This run's id is not one ODW issues, so no command is offered. Answer it with odw approve in a terminal{where}." } }
  const parts = ['odw', 'approve', view.id]
  const checkpoint = view.waiting.checkpointId
  if (typeof checkpoint === 'number' && Number.isSafeInteger(checkpoint) && checkpoint > 0) parts.push('--checkpoint', String(checkpoint))
  if (root !== expandHome('~/.odw/runs')) parts.push('--runs-root', shellArg(shortHome(root)))
  return {
    ...view,
    answer: { copy: parts.join(' '), how: 'Run it in a terminal{where} to go on. To refuse, run it with reject instead of approve.' },
  }
}
