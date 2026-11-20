// Workflow Watch — the panel's pure helpers: how long each phase took, and the full log's
// window. No DOM here, so the tests load this file as it is (src/panel.test.ts); the panel
// reads it as window.WorkflowWatch before app.js.
;((root) => {
  'use strict'

  const LIVE = new Set(['running', 'waiting', 'paused'])
  const commandsOf = (p) => p.commands.running + p.commands.done + p.commands.failed

  /** A span as a clock: `1:36:42` from an hour, `4:05` under it, `<1s` under a second. */
  function duration(ms) {
    if (!(ms >= 1000)) return '<1s'
    const s = Math.floor(ms / 1000)
    const hh = Math.floor(s / 3600)
    const mm = Math.floor((s % 3600) / 60)
    const ss = String(s % 60).padStart(2, '0')
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
  }

  /**
   * How long each phase of `run` took, in its order: null for a phase that has not run (pending
   * or skipped), `{ ms, live, approx, from, to }` for the others. The active phase of a live run
   * counts up to `now` (`live`); a paused run's stops where it paused.
   *
   * A phase whose start and end are one instant though it ran commands (ODW marks Preflight
   * only once its commands have run, and a worker before 0.1.3 sent no command times) did take
   * time: that phase reads the gap it sits in, from the end of the phase before (or the run's
   * start) to the start of the next one (or the run's end), as `approx`, never a made-up 0:00.
   * A gap under a second, or no next phase yet, reads as the instant it was: `<1s`.
   */
  function phaseTimes(run, now) {
    const phases = run.phases || []
    const moving = LIVE.has(run.state) && run.state !== 'paused'
    const runEnd = run.endedAt != null ? run.endedAt : moving ? null : run.updatedAt
    return phases.map((p, i) => {
      if (p.state === 'pending' || p.state === 'skipped' || p.startedAt == null) return null
      if (p.state === 'active') {
        const end = moving ? now : runEnd != null ? runEnd : now
        return { ms: Math.max(0, end - p.startedAt), live: moving, approx: false, from: p.startedAt, to: moving ? null : end }
      }
      const end = p.endedAt != null ? p.endedAt : p.startedAt
      const exact = { ms: Math.max(0, end - p.startedAt), live: false, approx: false, from: p.startedAt, to: end }
      if (exact.ms >= 1000 || !commandsOf(p)) return exact
      let from = run.startedAt
      for (let k = i - 1; k >= 0; k--) {
        const q = phases[k]
        if (q.state === 'pending' || q.state === 'skipped' || q.startedAt == null) continue
        from = q.endedAt != null ? q.endedAt : q.startedAt
        break
      }
      let to = null
      for (let k = i + 1; k < phases.length; k++) {
        if (phases[k].startedAt != null) {
          to = phases[k].startedAt
          break
        }
      }
      if (to == null) to = runEnd
      if (to == null) return exact
      from = Math.min(from, p.startedAt)
      to = Math.max(to, end)
      return to - from >= 1000 ? { ms: to - from, live: false, approx: true, from, to } : exact
    })
  }

  /** A phase's time as its band shows it: `~` marks one read from the phases around it. */
  function phaseLabel(t) {
    if (!t) return ''
    return `${t.approx ? '~' : ''}${duration(t.ms)}`
  }

  const lineKey = (l) => `${l.ts}:${l.text}`

  /**
   * The full log as fetched, with the snapshot's newer lines after it: the worker's every-second
   * snapshot carries the last few lines, so the open log grows without asking again each time.
   * A snapshot line is new when it comes after the last fetched one in time, or in the same
   * millisecond when the fetched lines of that millisecond do not hold it already.
   */
  function mergeLog(full, tail) {
    if (!full.length) return tail.slice()
    const last = full[full.length - 1].ts
    const sameMs = new Map()
    for (let k = full.length - 1; k >= 0 && full[k].ts === last; k--) sameMs.set(lineKey(full[k]), (sameMs.get(lineKey(full[k])) || 0) + 1)
    const out = full.slice()
    for (const l of tail) {
      if (l.ts < last) continue
      if (l.ts === last) {
        const n = sameMs.get(lineKey(l)) || 0
        if (n > 0) {
          sameMs.set(lineKey(l), n - 1)
          continue
        }
      }
      out.push(l)
    }
    return out
  }

  /** A scroll box the person has left at its bottom (within a few pixels): new lines keep it there. */
  function atBottom(scrollTop, clientHeight, scrollHeight) {
    return scrollHeight - scrollTop - clientHeight <= 8
  }

  const api = { duration, phaseTimes, phaseLabel, mergeLog, atBottom }
  root.WorkflowWatch = api
  if (typeof module === 'object' && module && module.exports) module.exports = api
})(typeof window !== 'undefined' ? window : globalThis)
