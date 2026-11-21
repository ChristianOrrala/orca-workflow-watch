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

/** A pass is news for this long after its run ended; then the bar goes calm. */
export const PASS_HIGHLIGHT_MINUTES = 15
/** A failure keeps the danger tone this long after its run ended, unless a newer run passes first. */
export const FAIL_HIGHLIGHT_MINUTES = 24 * 60
/** The most either window can be set to: a week. */
export const MAX_HIGHLIGHT_MINUTES = 7 * 24 * 60

export interface StatusOptions {
  now?: number
  /** Minutes a pass stays green; 0 never highlights it. */
  passMinutes?: number
  /** Minutes a failure stays red; 0 never highlights it. */
  failMinutes?: number
}

/** A window setting as minutes: a whole number from 0 to a week, else the default. */
export function highlightMinutes(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(MAX_HIGHLIGHT_MINUTES, Math.max(0, Math.round(value))) : fallback
}

function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

const item = <T extends string, I extends string>(label: string, tone: T, icon: I, tooltip: string, until: number | null = null) =>
  ({ text: label ? `Workflows · ${label}` : 'Workflows', tone, icon, tooltip, until })

/**
 * The status bar item for these runs. `until` is when it would change on its own (a pass or a
 * failure going calm), so the worker can redraw it then without reading any run again.
 */
export function workflowStatus(runs: RunView[], error?: string | null, failedEngines: EngineId[] = [], options: StatusOptions = {}) {
  const now = options.now ?? Date.now()
  const passMs = highlightMinutes(options.passMinutes, PASS_HIGHLIGHT_MINUTES) * 60_000
  const failMs = highlightMinutes(options.failMinutes, FAIL_HIGHLIGHT_MINUTES) * 60_000
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
  const ended = latest.endedAt ?? latest.updatedAt
  const last = (label: string) => `${label}: ${rows(latest, '').slice(0, -2)} · ${ago(now - ended)}`
  // A failure needs attention until a newer run passes (it is then not the latest) or its window ends.
  if (latest.state === 'failed' || latest.state === 'lost' || latest.outcome?.tone === 'bad') {
    const tooltip = last(latest.state === 'lost' ? 'Last lost' : 'Last failed')
    return now < ended + failMs ? item('Last failed', 'danger', 'error', tooltip, ended + failMs) : item('', 'neutral', 'activity', tooltip)
  }
  if (latest.state === 'done' && (!latest.outcome || latest.outcome.tone === 'ok')) {
    const tooltip = last('Last passed')
    return now < ended + passMs ? item('Passed', 'success', 'check', tooltip, ended + passMs) : item('', 'neutral', 'activity', tooltip)
  }
  return item('Idle', 'neutral', 'activity', rows(latest, field(latest.outcome?.status ?? latest.state, 48)))
}
