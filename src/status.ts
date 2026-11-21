import type { EngineId, RunView } from './protocol'

/** An owner question stays until a newer run of the same engine, workflow and subject takes over. */
export function needsYou(run: RunView, runs: RunView[]): boolean {
  if (run.outcome?.tone !== 'attention') return false
  return !runs.some((r) =>
    r !== run && (r.engine ?? 'odw') === (run.engine ?? 'odw') && r.workflow === run.workflow &&
    r.host === run.host && (r.source ?? null) === (run.source ?? null) &&
    r.subject === run.subject && r.startedAt > run.startedAt,
  )
}

// Orca accepts a single line of at most 256 characters. Keep whole rows and say what didn't fit.
function tooltipFor(rows: string[]): string {
  const visible: string[] = []
  for (const row of rows) {
    const left = rows.length - visible.length - 1
    if ([...visible, row, ...(left ? [`+${left} more`] : [])].join('; ').length > 256) break
    visible.push(row)
  }
  if (visible.length < rows.length) visible.push(`+${rows.length - visible.length} more`)
  return visible.join('; ')
}

function field(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`
}

const item = <T extends string, I extends string>(label: string, tone: T, icon: I, tooltip: string) =>
  ({ text: `Workflows · ${label}`, tone, icon, tooltip })

export function workflowStatus(runs: RunView[], error?: string | null, failedEngines: EngineId[] = []) {
  const available = runs.filter((r) => r.host || (!error && !failedEngines.includes(r.engine)))
  const rows = (run: RunView, state: string) => {
    const branch = field(run.branch?.replace(/^refs\/heads\//, '') || 'branch unavailable', 52)
    const host = run.hostName ? ` · ${field(run.hostName, 48)}` : ''
    return `${field(run.workflow, 64)} (${branch}${host}): ${state}`
  }
  const active = available.flatMap((run) =>
    run.state === 'running' || run.state === 'paused' || run.state === 'waiting' ? [{ run, state: run.state }]
      : needsYou(run, available) ? [{ run, state: 'waiting' }] : [],
  )
  const tooltip = tooltipFor(active.map(({ run, state }) => rows(run, state)))
  const count = (state: string) => active.filter((r) => r.state === state).length
  const running = count('running')
  const waiting = count('waiting')
  if (running) return item(`${running} running`, waiting ? 'warning' : 'accent', 'activity', tooltip)
  if (waiting) return item(`${waiting} waiting`, 'warning', 'bell', tooltip)
  if (active.length) return item(`${active.length} paused`, 'neutral', 'pause', tooltip)
  const latest = available.reduce<RunView | null>((best, run) => !best || run.startedAt > best.startedAt ||
    (run.startedAt === best.startedAt && run.updatedAt > best.updatedAt) ? run : best, null)
  if (!latest) return item('Idle', 'neutral', 'activity', error || failedEngines.length ? 'Workflow activity unavailable' : 'No workflow runs')
  if (latest.state === 'failed' || latest.state === 'lost' || latest.outcome?.tone === 'bad') {
    return item('Last failed', 'danger', 'error', rows(latest, latest.state === 'lost' ? 'lost' : 'failed'))
  }
  if (latest.state === 'done' && (!latest.outcome || latest.outcome.tone === 'ok')) return item('Last passed', 'success', 'check', rows(latest, 'passed'))
  return item('Idle', 'neutral', 'activity', rows(latest, field(latest.outcome?.status ?? latest.state, 48)))
}
