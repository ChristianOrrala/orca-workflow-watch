// Workflow Watch for Orca — the Workflows panel. It draws what the worker sends (see src/protocol.ts) and
// updates the page in place, keyed by run, phase and agent, so animations run on instead of
// restarting at every update. Text only ever goes in through textContent.
;(() => {
  'use strict'

  const orca = window.orca
  const WW = window.WorkflowWatch // panel/lib.js: phase times and the log window
  const LINGER_MS = 6000
  /** Lines the open log shows at most: what the worker keeps (LOG_KEEP in src/model.ts). */
  const LOG_MAX = 500
  // Nothing performs on the first paint: entrances play only for what arrives later.
  document.documentElement.classList.add('boot')
  const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const booting = () => document.documentElement.classList.contains('boot')

  const ui = {
    snap: null,
    open: new Set(), // finished runs the person expanded
    sheet: null, // { key, runId, host, agentId, data, loading, error }
    editing: null,
    rootError: null,
    seen: new Map(), // run key -> last state seen here
    lingering: new Map(), // run key -> until (a run that just ended stays a card a moment)
    celebrate: new Set(), // ended well just now: a sheen
    mourn: new Set(), // ended badly just now: one red wash
    pending: new Map(), // run key -> 'celebrate' | 'mourn', for an ending that came while the window was hidden
    openGroups: new Set(), // folds of repeated runs the person opened
    copied: null, // { text, until }: a Copy button that just worked
    lastHeard: 0, // when the worker last posted
    stale: false,
    shape: null, // the list's shape at the last paint: a change morphs instead of jumping
    morphing: null, // the view transition in flight
    counts: new Map(), // tally word -> last count, so a change can ping
    prevCards: new Set(), // run keys that were live cards at the last paint: a row for one is filing
    observed: new Set(), // cards watched for scrolling out of view
    log: null, // the open full-log dialog: { key, lines, dropped, count, loading, error, again, stick, opener }
  }

  // ── Small helpers ──────────────────────────────────────
  function h(tag, cls, text) {
    const node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }
  function setText(node, text) {
    const value = text == null ? '' : String(text)
    if (node.textContent !== value) node.textContent = value
  }
  function toggle(node, cls, on) {
    if (node.classList.contains(cls) !== Boolean(on)) node.classList.toggle(cls, Boolean(on))
  }
  function setState(node, prefix, value) {
    for (const c of [...node.classList]) if (c.startsWith(prefix) && c !== prefix + value) node.classList.remove(c)
    node.classList.add(prefix + value)
  }
  const SVG = 'http://www.w3.org/2000/svg'
  function icon(name) {
    const paths = {
      running: 'M8 1.5a6.5 6.5 0 1 0 6.5 6.5',
      waiting: 'M8 2a4 4 0 0 0-4 4v2.5L2.5 11h11L12 8.5V6a4 4 0 0 0-4-4zM6.5 13a1.5 1.5 0 0 0 3 0',
      paused: 'M5.5 3v10M10.5 3v10',
      done: 'M3 8.5l3.2 3L13 4.5',
      failed: 'M4 4l8 8M12 4l-8 8',
      stopped: 'M4.5 4.5h7v7h-7z',
      lost: 'M8 4v5M8 11.5v.5',
      asked: 'M8 2a4 4 0 0 0-4 4v2.5L2.5 11h11L12 8.5V6a4 4 0 0 0-4-4zM6.5 13a1.5 1.5 0 0 0 3 0',
      skipped: 'M3 10.5a5 5 0 0 1 9.2-3.2M12.5 3.5v4h-4',
      remote: 'M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13',
      close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
      copy: 'M5.5 5V3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H11M3.5 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z',
      warn: 'M8 2.5l6 11H2zM8 6.5v3M8 11.5v.2',
      chev: 'M6 3.5l4.5 4.5L6 12.5',
    }
    const svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    const path = document.createElementNS(SVG, 'path')
    path.setAttribute('d', paths[name] || paths.running)
    svg.appendChild(path)
    return svg
  }
  /** Puts the named icon in `holder`, or empties it for no name. */
  function setIcon(holder, name) {
    const want = name || ''
    if (holder.dataset.icon === want) return
    holder.dataset.icon = want
    const svg = want ? icon(want) : null
    if (svg && !booting() && !ui.inMorph) svg.classList.add('enter')
    holder.replaceChildren(...(svg ? [svg] : []))
  }
  /**
   * Marks a new element as arriving, so it plays its entrance. The first paint plays none, and
   * neither does a paint inside a view transition: the morph already carries the arrival.
   */
  function enter(node) {
    if (ui.inMorph) node._fresh = true // arrives inside a morph: stacked under what moves
    else if (!booting()) node.classList.add('enter')
    return node
  }
  function iconSpan(name) {
    const span = h('span', 'ico')
    span.setAttribute('aria-hidden', 'true')
    setIcon(span, name)
    return span
  }
  /** Adds `cls` for `ms`, for a one-shot animation the class carries. */
  function flash(node, cls, ms) {
    node.classList.add(cls)
    clearTimeout(node._flash)
    node._flash = setTimeout(() => node.classList.remove(cls), ms)
  }
  /** A view-transition name from a run key: an identifier, unique per element on the page. */
  const vtName = (prefix, key) => `${prefix}-${String(key).replace(/[^a-zA-Z0-9_-]/g, '_')}`
  function setMorph(node, name, cls) {
    if (node.style.viewTransitionName !== name) node.style.viewTransitionName = name
    node.style.setProperty('view-transition-class', node._fresh ? `${cls} vt-fresh` : cls)
    node._fresh = false
  }
  /** Rolls a number up (or down) to its new value instead of jumping there. */
  function countTo(el, to, format) {
    const from = el.dataset.value == null ? to : Number(el.dataset.value)
    el.dataset.value = String(to)
    cancelAnimationFrame(el._roll || 0)
    if (from === to || calm() || document.hidden || booting()) {
      setText(el, format(to))
      return
    }
    const start = performance.now()
    const dur = 700
    const step = (t) => {
      const k = Math.min(1, (t - start) / dur)
      setText(el, format(Math.round(from + (to - from) * (1 - Math.pow(1 - k, 4)))))
      if (k < 1) el._roll = requestAnimationFrame(step)
    }
    el._roll = requestAnimationFrame(step)
  }
  /** The elapsed clock, with its colons as their own elements so they can tick. */
  function setClock(node, ms) {
    const text = clock(ms)
    if (node.dataset.t === text) return
    node.dataset.t = text
    const kids = []
    text.split(':').forEach((part, i) => {
      if (i) kids.push(h('span', 'colon', ':'))
      kids.push(document.createTextNode(part))
    })
    node.replaceChildren(...kids)
  }

  /** A run id is unique within one engine on one machine only: both come with it. */
  const engineOf = (run) => run.engine || 'odw'
  const runKey = (run) => `${run.host || 'local'}:${engineOf(run)}:${run.id}`
  const engineLabel = (id) => ((ui.snap && ui.snap.engines) || []).find((e) => e.id === id)?.label || (id === 'agentprism' ? 'AgentPrism' : 'ODW')
  /** More than one engine among the runs shown: each run then names its engine. */
  /** No process behind the run (lost, or a paused AgentPrism run): an agent shown mid-call is not working. */
  const held = (run) => run.state === 'lost' || (run.state === 'paused' && engineOf(run) === 'agentprism')
  const multiEngine = () => new Set((ui.snap ? ui.snap.runs : []).map(engineOf)).size > 1
  const findRun = (key) => (ui.snap ? ui.snap.runs.find((r) => runKey(r) === key) : null)
  const multiHost = () => Boolean(ui.snap && ui.snap.hosts && ui.snap.hosts.length)
  const hostLabel = (run) => run.hostName || (ui.snap && ui.snap.localName) || 'This computer'
  /**
   * What stays on the server a run ran on: an installed copy there publishes its runs only, so an
   * agent's prompt and answer and the full log are read there. Null when they can be fetched.
   */
  const staysOn = (run) => {
    if (!run || !run.host) return null
    const host = ((ui.snap && ui.snap.hosts) || []).find((x) => x.id === run.host)
    return host && !host.details ? hostLabel(run) : null
  }
  /** A paired server's newest run, whose last events its beacon carries (0.4.1): "Show all" reads those. */
  const hasTail = (run) => {
    if (!run || !run.host) return false
    const host = ((ui.snap && ui.snap.hosts) || []).find((x) => x.id === run.host)
    return Boolean(host && host.tail && host.tail === `${engineOf(run)}:${run.id}`)
  }

  const LIVE = new Set(['running', 'waiting', 'paused'])
  const isLive = (state) => LIVE.has(state)
  const WORDS = { running: 'Running', waiting: 'Waiting', paused: 'Paused', done: 'Done', failed: 'Failed', stopped: 'Stopped', lost: 'Lost' }
  /** A returned status as a word: `waiting-for-owner` → Needs you, `not-merged` → Not merged. */
  function outcomeWord(o) {
    if (o.tone === 'attention') return 'Needs you'
    if (/^(success|succeeded|ok|done|complete|completed|finished)$/i.test(o.status)) return 'Done'
    const w = o.status.replace(/[-_]+/g, ' ').trim()
    return w.charAt(0).toUpperCase() + w.slice(1)
  }
  /**
   * What a card or row shows: the run's state, or for an ended run what it said it ended with.
   * A question a newer run of the same plan took over reads "Asked", not "Needs you".
   */
  function look(run) {
    const o = run.state === 'done' ? run.outcome : null
    if (!o || o.tone === 'ok') return { cls: run.state, icon: run.state, word: o ? outcomeWord(o) : WORDS[run.state] || run.state }
    if (o.tone === 'attention' && !needsYou(run)) return { cls: 'asked', icon: 'asked', word: 'Asked' }
    const cls = o.tone === 'attention' ? 'asking' : o.tone === 'bad' ? 'failed' : 'stopped'
    return { cls, icon: o.tone === 'attention' ? 'waiting' : o.tone === 'bad' ? 'failed' : 'stopped', word: outcomeWord(o) }
  }
  /** Ended asking the owner, and no newer run of its workflow followed. */
  const needsYou = (run) =>
    Boolean(run.outcome && run.outcome.tone === 'attention' && run.state === 'done') &&
    !(ui.snap ? ui.snap.runs : []).some(
      (r) =>
        r !== run &&
        engineOf(r) === engineOf(run) &&
        r.workflow === run.workflow &&
        (r.host || null) === (run.host || null) &&
        (r.source || null) === (run.source || null) &&
        (r.subject || null) === (run.subject || null) &&
        r.startedAt > run.startedAt,
    )

  function clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000))
    const hh = Math.floor(s / 3600)
    const mm = Math.floor((s % 3600) / 60)
    const ss = String(s % 60).padStart(2, '0')
    return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
  }
  function span(ms) {
    const s = Math.max(0, Math.round(ms / 1000))
    if (s < 60) return `${s}s`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
  }
  function ago(t) {
    const s = Math.max(0, Math.round((Date.now() - t) / 1000))
    if (s < 45) return 'just now'
    const m = Math.round(s / 60)
    if (m < 60) return `${m}m ago`
    const hr = Math.round(m / 60)
    if (hr < 36) return `${hr}h ago`
    return `${Math.round(hr / 24)}d ago`
  }
  function hhmm(t) {
    const d = new Date(t)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  }
  function tokens(n) {
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
    if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`
    return String(n)
  }
  /**
   * A label for an agent. `review:correctness` → `correctness`: the phase already says what it
   * is. Longer ones read as words: `review:conformance:3:1` → `conformance 3`, the attempt
   * or round shown only past the first (`implement:3:2` → `implement 3 #2`).
   */
  function shortLabel(label) {
    const parts = label.split(':').filter(Boolean)
    if (parts.length <= 1) return label
    if (parts.length === 2) return /^\d+$/.test(parts[1]) ? `${parts[0]} #${parts[1]}` : parts[1]
    const words = parts[0] === 'review' ? parts.slice(1) : parts.slice()
    const tail = []
    while (words.length > 1 && /^(again|repair|retry)$/.test(words[words.length - 1])) tail.unshift(words.pop())
    if (words.length > 1 && /^\d+$/.test(words[words.length - 1])) {
      const attempt = words.pop()
      if (attempt !== '1') tail.unshift(`#${attempt}`)
    }
    return [...words, ...tail].join(' ')
  }

  /** Keeps `parent`'s children in the order of `items`, reusing each by key. */
  function reconcile(parent, items, key, create, update) {
    const byKey = new Map()
    for (const child of [...parent.children]) {
      if (child.dataset.key) byKey.set(child.dataset.key, child)
      else child.remove() // a one-off message, such as a connection error
    }
    let cursor = parent.firstElementChild
    const keep = new Set()
    for (const item of items) {
      const k = key(item)
      keep.add(k)
      let node = byKey.get(k)
      if (!node) {
        node = create(item)
        node.dataset.key = k
      }
      update(node, item)
      if (node !== cursor) parent.insertBefore(node, cursor)
      else cursor = cursor.nextElementSibling
    }
    for (const [k, node] of byKey) if (!keep.has(k)) node.remove()
  }

  // ── Copying and announcing ────────────────────────────
  /** 'done' or 'failed' while a Copy button for `text` shows how it went, else ''. */
  function copiedState(text) {
    const c = ui.copied
    return text && c && c.text === text && c.until > Date.now() ? (c.ok ? 'done' : 'failed') : ''
  }
  function copyButton(text) {
    const state = copiedState(text)
    const button = h('button', state === 'done' ? 'copy done' : 'copy')
    button.type = 'button'
    button.dataset.copy = text
    button.append(iconSpan(state === 'done' ? 'done' : 'copy'), h('span', null, state === 'done' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy'))
    button.setAttribute('aria-label', state === 'done' ? 'Copied' : `Copy ${text}`)
    return button
  }
  /** Redraws every Copy button whose look is out of date, keeping the keyboard where it was. */
  function paintCopies() {
    for (const button of document.querySelectorAll('button.copy')) {
      const fresh = copyButton(button.dataset.copy)
      if (fresh.textContent === button.textContent) continue
      const focused = document.activeElement === button
      button.replaceWith(fresh)
      if (focused) fresh.focus()
    }
  }
  /**
   * The frame's own clipboard first. In a frame without the permission it can hang instead of
   * refusing, so it gets 600 ms; then the worker, on the same computer, copies.
   */
  async function copy(text) {
    const inFrame = navigator.clipboard
      ? Promise.race([navigator.clipboard.writeText(text).then(() => true, () => false), new Promise((done) => setTimeout(() => done(false), 600))])
      : Promise.resolve(false)
    let ok = await inFrame
    if (!ok) {
      try {
        await orca.plugin.request('watch.copy', { text }, { timeoutMs: 5000 })
        ok = true
      } catch {
        ok = false
      }
    }
    ui.copied = { text, until: Date.now() + 1600, ok }
    announce(ok ? 'Copied' : 'Could not copy')
    paintCopies()
    setTimeout(paintCopies, 1650)
  }
  /** Tells a screen reader what changed, once, without reading the whole list again. */
  function announce(text) {
    const live = document.getElementById('announce')
    if (!live) return
    live.textContent = ''
    requestAnimationFrame(() => {
      live.textContent = text
    })
  }

  // ── The flow: a run as a timeline ─────────────────────
  // Time runs left to right. Each phase is a band and each agent a bar in a lane. A phase that
  // repeats a few roles (implement, review:spec, fix) gets a lane per role, so a loop reads as a
  // loop; a phase of different agents gets a lane each; a crowd shares packed lanes. The time a
  // checkpoint waited for you is an amber band across every phase.
  const LANES_MAX = 8
  const roleOf = (label) => label.replace(/(:\d+)+$/, '')
  /** A role's short name: its last part when no other role ends the same, else its first part. */
  function roleNames(roles) {
    const parts = roles.map((r) => r.split(':'))
    return parts.map((p, i) => {
      if (parts.filter((q) => q[q.length - 1] === p[p.length - 1]).length === 1) return p[p.length - 1]
      if (parts.filter((q) => q[0] === p[0]).length === 1) return p[0]
      return roles[i]
    })
  }
  const commandsOf = (p) => p.commands.running + p.commands.done + p.commands.failed
  /** Where a phase's agents sit: its lanes, and each agent's lane. */
  function lanesOf(p) {
    const agents = p.agents
    const laneOf = new Map()
    if (!agents.length) {
      return commandsOf(p) && p.startedAt ? { lanes: [{ key: 'cmd', name: 'commands' }], laneOf, commands: true } : { lanes: [], laneOf }
    }
    const roles = [...new Set(agents.map((a) => roleOf(a.label)))]
    if (agents.length > 4 && roles.length <= 6 && roles.length <= Math.max(2, agents.length / 2)) {
      for (const a of agents) laneOf.set(a.id, roles.indexOf(roleOf(a.label)))
      const names = roleNames(roles)
      return { lanes: roles.map((r, i) => ({ key: `r:${r}`, name: names[i] })), laneOf }
    }
    if (agents.length <= LANES_MAX) {
      agents.forEach((a, i) => laneOf.set(a.id, i))
      return { lanes: agents.map((a) => ({ key: `a:${a.id}`, name: shortLabel(a.label) })), laneOf }
    }
    // A crowd: each agent takes the first lane free since its last agent ended.
    const ends = []
    for (const a of [...agents].sort((x, y) => x.startedAt - y.startedAt)) {
      let k = ends.findIndex((end) => end <= a.startedAt)
      if (k < 0 && ends.length < LANES_MAX) k = ends.push(0) - 1
      if (k < 0) k = ends.indexOf(Math.min(...ends))
      ends[k] = a.endedAt ?? Infinity
      laneOf.set(a.id, k)
    }
    return { lanes: ends.map((_, k) => ({ key: `p:${k}`, name: '' })), laneOf }
  }
  /** Every checkpoint the run stopped at, with the one it waits at now even when only the run's status names it. */
  function checkpointsOf(run) {
    const list = [...(run.checkpoints || [])]
    if (run.waiting && !list.some((c) => c.until === null)) list.push({ title: run.waiting.title, since: run.waiting.since, until: null })
    return list
  }

  function createFlow() {
    const flow = h('div', 'flow')
    flow.setAttribute('role', 'group')
    flow.setAttribute('aria-label', 'Timeline of the run')
    const body = h('div', 'fbody')
    const over = h('div', 'fover')
    over.setAttribute('aria-hidden', 'true')
    over.append(h('div', 'gates'), h('i', 'now'))
    body.append(h('div', 'bands'), over)
    const axis = h('div', 'faxis')
    axis.setAttribute('aria-hidden', 'true')
    axis.append(h('span', 't0', '0:00'), h('div', 'gls'), h('span', 't1'))
    flow.append(body, axis, h('p', 'fnext'))
    return flow
  }
  function createBand() {
    const band = h('div', 'band')
    band.setAttribute('role', 'group')
    const bh = h('div', 'bh')
    bh.append(h('span', 't'), h('span', 'n'), h('span', 'cmd'), h('span', 'dur'))
    band.append(bh, h('div', 'lanes'))
    return band
  }
  function createLane() {
    const lane = h('div', 'lane')
    lane.append(h('span', 'ln'), h('div', 'tr'))
    return lane
  }

  function updateFlow(flow, run, key) {
    const live = isLive(run.state)
    const shown = run.phases.filter((p) => p.state !== 'pending' || p.agents.length || commandsOf(p))
    const next = run.phases.filter((p) => !shown.includes(p) && p.title)
    flow.hidden = shown.length === 0
    if (flow.hidden) return
    flow.dataset.run = key
    flow.dataset.t0 = String(run.startedAt)
    // A live run's flow runs up to now; a paused or ended one stops where it stopped.
    flow.dataset.t1 = live && run.state !== 'paused' ? '' : String(run.endedAt ?? run.updatedAt)
    const selected = ui.sheet && ui.sheet.key === key ? ui.sheet.agentId : null
    const cut = held(run) || !live
    const times = WW.phaseTimes(run, Date.now())
    reconcile(
      flow.querySelector('.bands'),
      shown,
      (p) => `b:${p.title}`,
      createBand,
      (band, p) => {
        setState(band, 'p-', p.state)
        const [t, n, cmd, dur] = band.firstChild.children
        setText(t, p.title || 'Agents')
        const total = p.agents.length + p.hiddenAgents
        const settled = p.agents.filter((a) => a.state !== 'running').length + p.hiddenAgents
        setText(n, p.state === 'skipped' ? 'skipped' : total === 0 ? '' : p.state === 'active' ? `${settled} of ${total}` : `${total} agent${total === 1 ? '' : 's'}`)
        const c = p.commands
        const cmds = commandsOf(p)
        setText(cmd, cmds ? `${cmds} command${cmds === 1 ? '' : 's'}${c.failed ? ` · ${c.failed} failed` : c.running ? ' · running' : ' · passed'}` : '')
        toggle(cmd, 'bad', c.failed > 0)
        // How long it took; the active phase's ticks with the clocks (data-tick).
        const time = times[run.phases.indexOf(p)]
        dur.dataset.tick = time && time.live ? String(time.from) : ''
        setText(dur, WW.phaseLabel(time))
        dur.title = !time ? '' : time.live ? `Running for ${WW.duration(time.ms)}` : `Took ${WW.duration(time.ms)}`
        band.setAttribute('aria-label', [p.title || 'Agents', n.textContent, cmd.textContent, time ? `${time.live ? 'running for' : 'took'} ${WW.duration(time.ms)}` : ''].filter(Boolean).join(', '))
        band.title = p.detail || ''
        const { lanes, laneOf, commands } = lanesOf(p)
        reconcile(
          band.lastChild,
          lanes,
          (l) => l.key,
          createLane,
          (lane, l) => {
            const index = lanes.indexOf(l)
            setText(lane.firstChild, l.name)
            lane.firstChild.title = l.name
            const track = lane.lastChild
            if (commands) {
              if (!track.firstChild) track.append(h('i', 'bar cmdbar'))
              const bar = track.firstChild
              bar.dataset.s = String(p.startedAt)
              bar.dataset.e = p.endedAt != null ? String(p.endedAt) : ''
              setState(bar, 'a-', p.state === 'active' && !cut ? 'running' : c.failed ? 'failed' : 'done')
              return
            }
            reconcile(
              track,
              p.agents.filter((a) => laneOf.get(a.id) === index),
              (a) => `a${a.id}`,
              () => {
                const bar = enter(h('button', 'bar'))
                bar.type = 'button'
                return bar
              },
              (bar, a) => {
                if (bar.dataset.state === 'running' && a.state === 'done') flash(bar, 'just-done', 800)
                bar.dataset.state = a.state
                bar.dataset.agent = String(a.id)
                // An agent still "running" in a run with no process behind it was cut off.
                setState(bar, 'a-', a.state === 'running' && cut ? 'cut' : a.state)
                toggle(bar, 'sel', selected === a.id)
                bar.dataset.s = String(a.startedAt)
                bar.dataset.e = a.endedAt != null ? String(a.endedAt) : ''
                const took = a.endedAt ? span(a.endedAt - a.startedAt) : null
                const word = a.state === 'running' && cut ? 'cut off' : WORDS[a.state] || a.state
                bar.title = `${a.label} — ${word}${took ? ` · ${took}` : ''}${a.adapter ? ` · ${a.adapter}` : ''}${a.error ? `\n${a.error}` : ''}`
                bar.setAttribute('aria-label', `${shortLabel(a.label)}, ${word}${took ? `, took ${took}` : ''}`)
              },
            )
          },
        )
      },
    )
    const gates = checkpointsOf(run)
    reconcile(
      flow.querySelector('.gates'),
      gates,
      (g) => `g:${g.since}`,
      () => h('i', 'gate'),
      (gate, g) => {
        gate.dataset.s = String(g.since)
        gate.dataset.e = g.until != null ? String(g.until) : ''
        toggle(gate, 'open', g.until == null && Boolean(run.waiting))
      },
    )
    reconcile(
      flow.querySelector('.gls'),
      gates,
      (g) => `l:${g.since}`,
      () => h('span', 'gl'),
      (label, g) => {
        label.dataset.s = String(g.since)
        label.dataset.e = g.until != null ? String(g.until) : ''
        setText(label, g.until == null && run.waiting ? 'waiting for you' : g.until != null ? `waited ${span(g.until - g.since)}` : '')
      },
    )
    const nextText = next.length ? `Next: ${next.map((p) => p.title).join(' → ')}` : ''
    setText(flow.querySelector('.fnext'), nextText)
    flow.querySelector('.fnext').hidden = !nextText
    placeFlow(flow, Date.now())
  }

  /**
   * Puts every bar, checkpoint and label where its time falls. A live flow keeps a little room
   * past now and refits every second, so the run grows to the right without leaving the card.
   */
  function placeFlow(flow, now) {
    if (flow.hidden) return
    const t0 = Number(flow.dataset.t0)
    const open = !flow.dataset.t1
    const end = open ? now : Number(flow.dataset.t1)
    const span = open ? Math.max(10000, end - t0) * 1.04 : Math.max(1000, end - t0)
    const frac = (t) => Math.min(1, Math.max(0, (t - t0) / span))
    const place = (node) => {
      const s = frac(Number(node.dataset.s))
      const e = frac(node.dataset.e ? Number(node.dataset.e) : end)
      const left = `${(s * 100).toFixed(3)}%`
      const width = `${(Math.max(0, e - s) * 100).toFixed(3)}%`
      if (node.style.left !== left) node.style.left = left
      if (node.style.width !== width) node.style.width = width
    }
    for (const node of flow.querySelectorAll('.bar, .gate')) place(node)
    const nowLine = flow.querySelector('.now')
    nowLine.hidden = !open
    if (open) nowLine.style.left = `${(frac(now) * 100).toFixed(3)}%`
    setText(flow.querySelector('.t1'), clock(span))
    // A checkpoint's label sits under its middle, when it clears the axis ends and the others.
    const width = flow.querySelector('.gls').clientWidth || 200
    // The axis ends hold 0:00 and the span; a label slides inward rather than cover them.
    const lo = 34, hi = width - 48
    const taken = []
    // The open wait first, then the longest: the time that mattered most keeps its label.
    const waited = (l) => (l.dataset.e ? Number(l.dataset.e) : Infinity) - Number(l.dataset.s)
    const labels = [...flow.querySelectorAll('.gl')].sort((a, b) => waited(b) - waited(a))
    for (const label of labels) {
      const s = frac(Number(label.dataset.s))
      const e = frac(label.dataset.e ? Number(label.dataset.e) : end)
      const mid = ((s + e) / 2) * width
      const half = label.textContent.length * 2.9 + 4
      const x0 = Math.max(lo, Math.min(hi - half * 2, mid - half))
      const fits = label.textContent && x0 + half * 2 <= hi && !taken.some(([a, b]) => x0 < b && x0 + half * 2 > a)
      label.hidden = !fits
      if (fits) {
        taken.push([x0, x0 + half * 2])
        label.style.left = `${x0}px`
      }
    }
  }
  function placeFlows(all) {
    const now = Date.now()
    for (const flow of document.querySelectorAll('.flow')) if (all || !flow.dataset.t1) placeFlow(flow, now)
  }

  // ── The metro line: a finished run in one line ────────
  /** A history row's run as stations and tracks: a phase of a few agents splits into tracks, a big one is a strip. */
  function drawMetro(el, run) {
    const shown = run.phases.filter((p) => p.title !== '' || p.agents.length)
    el.hidden = shown.length === 0
    const times = WW.phaseTimes(run, Date.now())
    const timeOf = (p) => WW.phaseLabel(times[run.phases.indexOf(p)])
    const sig = JSON.stringify([run.state, shown.map((p) => [p.state, p.agents.map((a) => a.state[0]).join(''), isLive(run.state) ? '' : timeOf(p)])])
    if (el.dataset.sig === sig) return
    el.dataset.sig = sig
    const ran = (p) => p.state !== 'pending' && p.state !== 'skipped'
    const lastRan = shown.map(ran).lastIndexOf(true)
    const halted = run.state === 'stopped' || run.state === 'failed' || run.state === 'lost'
    const kids = []
    const live = isLive(run.state)
    const agentCls = (a) => `a-${a.state === 'running' && !live ? 'cut' : a.state}`
    shown.forEach((p, i) => {
      kids.push(h('i', i === 0 || ran(shown[i - 1]) ? 'st on' : 'st'))
      const state = p.state === 'active' && !live ? 'failed' : p.state
      const seg = h('span', `ms m-${state}`)
      // Each phase's time on hover: the row's own line stays as it was.
      const took = timeOf(p)
      seg.title = `${p.title || 'Agents'}${p.state === 'skipped' ? ' · skipped' : took ? ` · ${took}` : ''}`
      const n = p.agents.length
      // A busy phase takes more of the line, so 48 agents read as a long busy stretch.
      if (n > 4) seg.style.flexGrow = String(1 + Math.min(3, (n - 4) / 10))
      if (n >= 2 && n <= 4) {
        seg.classList.add('split')
        const tracks = h('span', 'tks')
        for (const a of p.agents) tracks.append(h('i', agentCls(a)))
        seg.append(tracks)
      } else if (n > 4) {
        // Many agents: a block of cells, one per agent, in up to three bands.
        seg.classList.add('split')
        const rows = n > 32 ? 3 : n > 12 ? 2 : 1
        const strip = h('span', rows > 1 ? 'tcs banded' : 'tcs')
        strip.style.setProperty('--cols', String(Math.ceil(n / rows)))
        strip.style.setProperty('--rows', String(rows))
        for (const a of p.agents) strip.append(h('i', agentCls(a)))
        seg.append(strip)
      }
      kids.push(seg)
    })
    // A run that got to the end arrives at a filled terminus.
    kids.push(h('i', lastRan === shown.length - 1 && !halted ? 'st on end' : 'st'))
    // Where a stopped or failed run ended: the station after the last phase that ran.
    if (halted && lastRan >= 0) kids[(lastRan + 1) * 2].className = 'st halt'
    el.replaceChildren(...kids)
  }

  // ── Run card ───────────────────────────────────────────
  function createCard() {
    const card = enter(h('article', 'run'))
    const head = h('div', 'head')
    const glyph = h('div', 'glyph')
    const titles = h('div', 'titles')
    titles.append(h('h2'), h('p', 'sub'))
    const clk = h('div', 'clock')
    clk.append(h('span', 'elapsed'), h('span', 'word'))
    head.append(glyph, titles, clk)
    const desc = h('p', 'desc')
    const ask = h('div', 'ask')
    ask.setAttribute('role', 'group')
    ask.setAttribute('aria-label', 'The run is asking you')
    ask.append(icon('waiting'), h('div', 'ask-text'))
    const lost = h('div', 'lost-note')
    const flow = createFlow()
    const sheet = h('div', 'sheet-slot')
    const ticker = h('ul', 'ticker')
    const logbar = h('div', 'logbar')
    const logToggle = h('button', 'link log-toggle')
    logToggle.type = 'button'
    logToggle.setAttribute('aria-haspopup', 'dialog')
    logbar.append(logToggle)
    const meter = h('div', 'meter')
    const track = h('div', 'track')
    track.append(h('div', 'fill'))
    const txt = h('span', 'txt')
    txt.append(document.createTextNode(''), h('b'), document.createTextNode(''))
    meter.append(track, txt)
    card.append(head, desc, ask, lost, flow, sheet, ticker, logbar, meter)
    card.addEventListener('click', (event) => {
      const opener = event.target.closest('.log-toggle')
      if (opener) {
        openLog(card.dataset.run, opener)
        return
      }
      const bar = event.target.closest('button.bar, .show-agent')
      if (bar) {
        openSheet(card.dataset.run, Number(bar.dataset.agent))
        return
      }
      if (event.target.closest('.x')) closeSheet(true)
    })
    return card
  }

  function updateCard(card, run, expanded) {
    const key = runKey(run)
    const seen = look(run)
    card.dataset.run = key
    card.id = `card-${key}`
    // A live card and its history row share a name, so a run that ends files into its row.
    setMorph(card, vtName(expanded ? 'c' : 'r', key), 'vt-run')
    setState(card, 's-', seen.cls)
    toggle(card, 'held', held(run))
    toggle(card, 'expanded', Boolean(expanded))
    toggle(card, 'celebrate', ui.celebrate.has(key))
    toggle(card, 'mourn', ui.mourn.has(key))
    const live = isLive(run.state)
    const [head, desc, ask, lost, flow, sheetSlot, ticker, logbar, meter] = card.children
    setIcon(head.children[0], seen.icon)
    setText(head.querySelector('h2'), run.workflow)
    const sub = head.querySelector('.sub')
    const bits = [multiEngine() ? engineLabel(engineOf(run)) : null, run.subjectLabel, run.source, run.adapter].filter(Boolean)
    sub.replaceChildren()
    if (multiHost()) {
      const where = h('span', run.host ? 'where remote' : 'where')
      if (run.host) {
        where.append(iconSpan('remote'))
        where.title = `Runs on the paired Orca server ${hostLabel(run)}`
      }
      where.append(document.createTextNode(hostLabel(run)))
      sub.append(where)
      if (bits.length) sub.append(document.createTextNode(' · '))
    }
    sub.append(document.createTextNode(bits.join(' · ')))
    if (run.dry) sub.append(document.createTextNode(bits.length ? ' · ' : ''), h('span', 'dry', 'dry run'))
    const elapsed = head.querySelector('.elapsed')
    // A paused run's clock stops where it paused: nothing is running.
    const stopped = run.state === 'paused'
    elapsed.dataset.since = live && !stopped ? String(run.startedAt) : ''
    setClock(elapsed, (run.endedAt ?? (stopped ? run.updatedAt : Date.now())) - run.startedAt)
    setText(head.querySelector('.word'), seen.word)

    setText(desc, run.description ?? '')
    desc.hidden = !run.description || !live

    const asking = !run.waiting && seen.cls === 'asking' && run.outcome
    // A paused run its engine can resume (AgentPrism's) shows the call that resumes it.
    const resume = run.state === 'paused' && run.answer ? run.answer : null
    ask.hidden = !run.waiting && !asking && !resume
    toggle(ask, 'calm', Boolean(resume))
    const askText = ask.querySelector('.ask-text')
    // How to answer a checkpoint is the engine's: a command for ODW, a tool call for AgentPrism.
    const answer = resume || (run.waiting ? run.answer : null)
    const command = answer ? answer.copy : null
    const askSig = JSON.stringify([asking && run.outcome.text, run.waiting && run.waiting.title, resume && run.error, command, run.host])
    if (!ask.hidden && askText.dataset.sig !== askSig) {
      askText.dataset.sig = askSig
      ask.firstChild.replaceWith(icon(resume ? 'paused' : 'waiting'))
      ask.setAttribute('aria-label', resume ? 'The run is paused' : 'The run is asking you')
      if (asking) {
        askText.replaceChildren(
          h('div', 'q', run.outcome.text || 'The run stopped to ask you something.'),
          h('div', 'how', 'The run stopped to ask. Answer the way its workflow says, then start it again.'),
        )
      } else {
        const line = command ? h('div', 'cmd-line') : null
        if (line) {
          const code = h('code', null, command)
          code.title = command
          line.append(code, copyButton(command))
        }
        askText.replaceChildren(
          h('div', 'q', resume ? run.error || 'Paused' : run.waiting.title),
          ...(line ? [line] : []),
          h('div', 'how', answer.how.replace('{where}', run.host ? ` on ${hostLabel(run)}` : '')),
        )
      }
    }
    // Why it stopped, with a way to the agent that failed.
    const why = run.state === 'lost' || run.state === 'failed' ? run.error : seen.cls === 'failed' || seen.cls === 'stopped' ? run.outcome && run.outcome.text : null
    // A paused run says why it paused (a usage limit, a sign-in), quietly.
    const paused = run.state === 'paused' && run.error && !resume ? run.error : null
    const asked = seen.cls === 'asked' && run.outcome && run.outcome.text ? `It asked: ${run.outcome.text}` : null
    const failedAgent = why ? run.phases.flatMap((p) => p.agents).find((a) => a.state === 'failed') : null
    const lostSig = JSON.stringify([why, asked, paused, failedAgent && failedAgent.id])
    lost.hidden = !why && !asked && !paused
    toggle(lost, 'quiet', !why && Boolean(asked || paused))
    if (lost.dataset.sig !== lostSig) {
      lost.dataset.sig = lostSig
      lost.replaceChildren(document.createTextNode(why || asked || paused || ''))
      if (failedAgent) {
        const show = h('button', 'link show-agent', `Show ${shortLabel(failedAgent.label)}`)
        show.type = 'button'
        show.dataset.agent = String(failedAgent.id)
        lost.append(show)
      }
    }

    updateFlow(flow, run, key)

    renderSheet(sheetSlot, run)

    // Ticker: the last lines the run logged; a new one slides in and the rest glide up.
    const lines = keyedLines(run.log)
    const glide = !ticker.hidden && !calm() && !booting() ? new Map([...ticker.children].map((li) => [li.dataset.key, li.getBoundingClientRect().top])) : null
    reconcile(ticker, lines, (l) => l.key, () => createLogLine(true), updateLogLine)
    ticker.hidden = lines.length === 0
    // Show all: when the run logged more than the ticker shows.
    const total = run.logCount
    logbar.hidden = !(total > run.log.length)
    if (!logbar.hidden) {
      const button = logbar.firstChild
      setText(button, `Show all ${total.toLocaleString()} events`)
      button.setAttribute('aria-expanded', ui.log && ui.log.key === key ? 'true' : 'false')
    }
    if (glide) {
      for (const li of ticker.children) {
        const was = glide.get(li.dataset.key)
        const dy = was == null ? 0 : was - li.getBoundingClientRect().top
        if (Math.abs(dy) > 0.5) li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.16,1,.3,1)' })
      }
    }

    // Meter: tokens against the budget when there is one.
    const { spent, budget } = run.tokens
    const fill = meter.querySelector('.fill')
    const track = meter.querySelector('.track')
    track.hidden = !budget
    if (budget) {
      const pct = Math.min(100, (spent / budget) * 100)
      fill.style.width = `${pct.toFixed(1)}%`
      toggle(fill, 'hot', pct > 85)
    }
    const [lead, count, tail] = meter.querySelector('.txt').childNodes
    const agents = run.agents
    const parts = [`${agents.total} agent${agents.total === 1 ? '' : 's'}`]
    // In a paused run, an agent cut off mid-call is not working: it starts again on resume.
    if (agents.running) parts.push(held(run) ? `${agents.running} cut off` : `${agents.running} working`)
    if (agents.failed) parts.push(`${agents.failed} failed`)
    const leadText = `${parts.join(' · ')} · `
    if (lead.nodeValue !== leadText) lead.nodeValue = leadText
    countTo(count, spent, tokens)
    const tailText = budget ? ` / ${tokens(budget)} tokens` : ' tokens'
    if (tail.nodeValue !== tailText) tail.nodeValue = tailText
  }

  // ── Log lines ──────────────────────────────────────────
  /** Keyed by time, text and occurrence: two equal lines in one millisecond are two rows. */
  function keyedLines(log) {
    const seen = new Map()
    return log.map((l) => {
      const base = `${l.ts}:${l.text}`
      const n = (seen.get(base) || 0) + 1
      seen.set(base, n)
      return { ...l, key: `${base}#${n}` }
    })
  }
  function createLogLine(animate) {
    const li = animate ? enter(h('li')) : h('li')
    li.append(h('time'), iconSpan(null), h('span', 'tx'))
    return li
  }
  function updateLogLine(li, l) {
    setState(li, 't-', l.tone)
    setText(li.firstChild, hhmm(l.ts))
    // Warnings and errors carry a shape as well as a colour.
    setIcon(li.children[1], l.tone === 'warn' ? 'warn' : l.tone === 'error' ? 'failed' : null)
    setText(li.lastChild, l.text)
    li.title = l.text
  }

  // ── The full log, in a dialog ──────────────────────────
  /** The one dialog, made the first time it opens: a title, a note, every line, and Close. */
  function logDialog() {
    let dlg = document.getElementById('logdlg')
    if (dlg) return dlg
    dlg = h('dialog', 'logdlg')
    dlg.id = 'logdlg'
    dlg.setAttribute('aria-modal', 'true')
    dlg.setAttribute('aria-labelledby', 'logdlg-title')
    dlg.setAttribute('aria-describedby', 'logdlg-note')
    const top = h('div', 'ld-head')
    const titles = h('div', 'ld-titles')
    const title = h('h2', 'ld-title')
    title.id = 'logdlg-title'
    titles.append(title, h('p', 'ld-sub'))
    const x = h('button', 'x')
    x.type = 'button'
    x.append(iconSpan('close'))
    x.setAttribute('aria-label', 'Close the log')
    x.title = 'Close (Esc)'
    top.append(titles, x)
    const note = h('p', 'ld-note')
    note.id = 'logdlg-note'
    const list = h('ul', 'ticker full')
    list.tabIndex = 0
    list.setAttribute('aria-label', 'Every event the run kept, oldest first')
    list.addEventListener('scroll', () => {
      if (ui.log) ui.log.stick = WW.atBottom(list.scrollTop, list.clientHeight, list.scrollHeight)
    })
    dlg.append(top, note, list)
    x.addEventListener('click', () => closeLog())
    // A click on the backdrop lands on the dialog itself, outside its box.
    dlg.addEventListener('click', (event) => {
      if (event.target !== dlg) return
      const r = dlg.getBoundingClientRect()
      const inside = event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom
      if (!inside) closeLog()
    })
    // Esc: the browser closes a modal dialog; this keeps the state in step.
    dlg.addEventListener('cancel', (event) => {
      event.preventDefault()
      closeLog()
    })
    document.body.append(dlg)
    return dlg
  }
  /** Opens a run's whole log (every line its worker keeps) over the panel. */
  function openLog(key, opener) {
    ui.log = { key, lines: [], dropped: 0, count: null, loading: false, error: null, again: false, stick: true, opener }
    const dlg = logDialog()
    dlg.querySelector('.ticker').replaceChildren()
    renderLog()
    if (!dlg.open) dlg.showModal()
    dlg.querySelector('.ticker').focus()
    render()
    void loadLog(key)
  }
  function closeLog() {
    const was = ui.log
    ui.log = null
    const dlg = document.getElementById('logdlg')
    if (dlg && dlg.open) dlg.close()
    render()
    // Back to the button it came from; redrawn since, it is found again by its run.
    const back = was && was.opener && was.opener.isConnected ? was.opener : was && document.getElementById(`card-${was.key}`)?.querySelector('.log-toggle')
    if (back) back.focus()
  }
  /** Draws the open dialog from the fetched lines and the snapshot's newer ones. */
  function renderLog() {
    const st = ui.log
    const dlg = document.getElementById('logdlg')
    if (!st || !dlg) return
    const run = findRun(st.key)
    // A run that left the snapshot keeps what was fetched.
    const tail = run ? run.log : []
    if (run) st.run = run
    const shown = st.run || run
    if (!shown) return
    // A gap the snapshot cannot fill (more new lines than it carries) asks the worker again.
    if (run && st.count != null && run.logCount - st.count > run.log.length && !st.error && !st.note) {
      if (st.loading) st.again = true
      else queueMicrotask(() => loadLog(st.key))
    }
    const lines = keyedLines(WW.mergeLog(st.lines, tail).slice(-LOG_MAX))
    setText(dlg.querySelector('.ld-title'), shown.workflow)
    setText(dlg.querySelector('.ld-sub'), [hostLabel(shown), shown.subjectLabel, look(shown).word].filter(Boolean).join(' · '))
    const note = dlg.querySelector('.ld-note')
    const total = Math.max(shown.logCount, lines.length)
    setText(note, st.note || WW.logNote({ total, shown: lines.length, dropped: st.dropped, loading: st.loading && !st.lines.length, error: st.error, stays: st.stays || null }))
    toggle(note, 'bad', Boolean(st.error))
    const list = dlg.querySelector('.ticker')
    // Opening adds hundreds of lines at once: those arrive still; later ones slide in.
    const bulk = lines.length - list.children.length > 8
    reconcile(list, lines, (l) => l.key, () => createLogLine(!bulk), updateLogLine)
    // Left at the bottom, the log follows new lines; scrolled up, it stays put.
    if (st.stick !== false) list.scrollTop = list.scrollHeight
  }
  async function loadLog(key) {
    const st = ui.log
    const run = findRun(key)
    if (!st || st.key !== key || !run) return
    if (st.loading) {
      st.again = true
      return
    }
    const where = staysOn(run)
    // The newest run there is read from the last events its beacon carries; the rest stay there.
    if (where && hasTail(run)) st.stays = where
    else if (where) {
      // Nothing to fetch: the dialog shows the lines the snapshot carries, and says where the rest are.
      Object.assign(st, { lines: [], dropped: 0, count: run.logCount, error: null, stays: null, note: `The last ${run.log.length} of ${run.logCount.toLocaleString('en-US')} events. The rest stay on ${where}: open Workflows there to read them all.` })
      renderLog()
      return
    }
    st.loading = true
    const count = run.logCount
    try {
      const data = await orca.plugin.request('watch.log', { runId: run.id, host: run.host || null, engine: engineOf(run) }, { timeoutMs: run.host ? 20000 : 8000 })
      if (ui.log === st) Object.assign(st, { lines: Array.isArray(data.lines) ? data.lines : [], dropped: data.dropped || 0, count, error: null })
    } catch (error) {
      // No full log to give (a server out of reach, say): the short one stays, with why.
      if (ui.log === st) Object.assign(st, { error: error.message || String(error), count })
    }
    st.loading = false
    if (ui.log === st && st.again) {
      st.again = false
      return loadLog(key)
    }
    renderLog()
  }

  // ── Agent sheet ────────────────────────────────────────
  async function openSheet(key, agentId) {
    if (ui.sheet && ui.sheet.key === key && ui.sheet.agentId === agentId) return closeSheet(true)
    const run = findRun(key)
    if (!run) return
    ui.sheet = { key, runId: run.id, host: run.host || null, engine: engineOf(run), agentId, data: null, loading: true, error: null }
    await render()
    document.getElementById(`card-${key}`)?.querySelector('.sheet')?.focus()
    await loadSheet()
  }
  async function loadSheet() {
    const sheet = ui.sheet
    if (!sheet) return
    const where = staysOn(findRun(sheet.key))
    if (where) {
      Object.assign(sheet, { data: null, error: null, loading: false, note: `What it was asked and answered stays on ${where}: open Workflows there to read it.` })
      return render()
    }
    try {
      const data = await orca.plugin.request('watch.agent', { runId: sheet.runId, agentId: sheet.agentId, host: sheet.host, engine: sheet.engine }, { timeoutMs: sheet.host ? 20000 : 8000 })
      if (ui.sheet === sheet) Object.assign(sheet, { data, error: null, loading: false })
    } catch (error) {
      if (ui.sheet === sheet) Object.assign(sheet, { error: error.message || String(error), loading: false })
    }
    if (ui.sheet === sheet && sheet.again) {
      sheet.again = false
      sheet.loading = true
      return loadSheet()
    }
    render()
  }
  /** Closes the agent sheet; `refocus` puts the keyboard back on the bar it came from. */
  function closeSheet(refocus) {
    const was = ui.sheet
    ui.sheet = null
    void render().then(() => {
      if (refocus && was) document.getElementById(`card-${was.key}`)?.querySelector(`button.bar[data-agent="${was.agentId}"]`)?.focus()
    })
  }
  function findAgent(run, id) {
    for (const p of run.phases) for (const a of p.agents) if (a.id === id) return a
    return null
  }
  function renderSheet(slot, run) {
    const sheet = ui.sheet && ui.sheet.key === runKey(run) ? ui.sheet : null
    const agent = sheet ? findAgent(run, sheet.agentId) : null
    if (!sheet || !agent) {
      slot.replaceChildren()
      slot.hidden = true
      return
    }
    slot.hidden = false
    // Re-ask once the agent's state moved on while the sheet was open.
    if (sheet.seenState && sheet.seenState !== agent.state) {
      // Mid-request, the reply on its way may predate the change: ask again when it lands.
      if (sheet.loading) sheet.again = true
      else {
        sheet.loading = true
        queueMicrotask(loadSheet)
      }
    }
    sheet.seenState = agent.state
    const key = JSON.stringify([agent, sheet.loading, sheet.error, sheet.note, sheet.data && sheet.data.reply && sheet.data.reply.length])
    if (slot.dataset.key === key) return
    slot.dataset.key = key
    const hadFocus = slot.contains(document.activeElement)
    const box = h('div', 'sheet')
    box.tabIndex = -1
    box.setAttribute('role', 'region')
    box.setAttribute('aria-label', `Agent ${shortLabel(agent.label)}`)
    const sh = h('div', 'sh')
    const dot = h('span', `dot a-${agent.state}`)
    dot.style.setProperty('--b', agent.state === 'running' ? 'var(--run)' : agent.state === 'failed' ? 'var(--bad)' : 'var(--ok)')
    dot.append(h('i'))
    const x = h('button', 'x')
    x.type = 'button'
    x.append(iconSpan('close'))
    x.setAttribute('aria-label', 'Close the agent')
    x.title = 'Close (Esc)'
    sh.append(dot, h('b', null, agent.label), x)
    const facts = h('div', 'facts')
    const fact = (label, value) => {
      if (value == null || value === '') return
      const f = h('span')
      f.append(document.createTextNode(`${label} `), h('b', null, value))
      facts.append(f)
    }
    fact('state', WORDS[agent.state] ?? agent.state)
    fact('via', [agent.adapter, agent.model].filter(Boolean).join(' · '))
    fact('took', agent.endedAt ? span(agent.endedAt - agent.startedAt) : `${span(Date.now() - agent.startedAt)} so far`)
    fact('tokens', agent.tokens != null ? tokens(agent.tokens) : null)
    fact('attempts', agent.attempts && agent.attempts > 1 ? String(agent.attempts) : null)
    box.append(sh, facts)
    if (agent.error) box.append(h('div', 'err', agent.error))
    if (sheet.note) box.append(h('div', 'note', sheet.note))
    else if (sheet.loading && !sheet.data) box.append(h('div', 'skeleton'))
    else if (sheet.error) box.append(h('div', 'err', sheet.error))
    else if (sheet.data) {
      if (sheet.data.prompt) box.append(h('div', 'lbl', 'Asked'), h('pre', null, sheet.data.prompt))
      if (sheet.data.reply) box.append(h('div', 'lbl', agent.state === 'running' ? 'Latest output' : 'Answered'), h('pre', null, sheet.data.reply))
      if (sheet.data.stderr) box.append(h('div', 'lbl', 'stderr'), h('pre', null, sheet.data.stderr))
    }
    slot.replaceChildren(box)
    if (hadFocus) box.focus()
  }

  // ── Recent rows ────────────────────────────────────────
  /** At most 16 bars, each a slice of `items` ({ took, failed }) in order, as tall as its slowest. */
  function drawBarcode(el, items, sig) {
    if (el.dataset.sig === sig) return
    el.dataset.sig = sig
    const per = Math.max(1, Math.ceil(items.length / 16))
    const slices = []
    for (let i = 0; i < items.length; i += per) slices.push(items.slice(i, i + per))
    const longest = Math.max(1, ...items.map((x) => x.took))
    el.replaceChildren(
      ...slices.map((slice) => {
        const bar = h('i', slice.some((x) => x.failed) ? 'f' : '')
        // Its share of the slowest run; the stylesheet turns it into a height for the metro size.
        bar.style.setProperty('--f', (Math.max(...slice.map((x) => x.took)) / longest).toFixed(3))
        return bar
      }),
    )
  }

  function createRow() {
    const row = enter(h('button', 'row'))
    row.type = 'button'
    const glyph = h('div', 'glyph')
    const main = h('div', 'rm')
    const rt = h('div', 'rt')
    rt.append(h('b'), h('span', 'ago'))
    const metro = h('div', 'metro')
    metro.setAttribute('aria-hidden', 'true')
    main.append(rt, h('div', 'rs'), metro)
    row.append(glyph, main)
    row.addEventListener('click', () => {
      const id = row.dataset.run
      if (ui.open.has(id)) ui.open.delete(id)
      else ui.open.add(id)
      if (ui.sheet && ui.sheet.key === id) ui.sheet = null
      render()
    })
    return row
  }
  function updateRow(row, run, member) {
    const key = runKey(run)
    row.dataset.run = key
    const seen = look(run)
    setState(row, 's-', seen.cls)
    toggle(row, 'open', ui.open.has(key))
    toggle(row, 'member', Boolean(member))
    row.setAttribute('aria-expanded', ui.open.has(key) ? 'true' : 'false')
    row.setAttribute('aria-controls', `card-${key}`)
    setMorph(row, vtName('r', key), ui.prevCards.has(key) ? 'vt-row vt-filing' : 'vt-row')
    const [glyph, main] = row.children
    setIcon(glyph, seen.icon)
    setText(main.querySelector('b'), run.workflow)
    const agoEl = main.querySelector('.ago')
    agoEl.dataset.ago = String(run.endedAt ?? run.updatedAt)
    setText(agoEl, ago(run.endedAt ?? run.updatedAt))
    const parts = []
    if (multiHost()) parts.push(hostLabel(run))
    if (multiEngine()) parts.push(engineLabel(engineOf(run)))
    if (run.subjectLabel) parts.push(run.subjectLabel)
    if (seen.word !== 'Done') parts.push(seen.word)
    parts.push(`${run.agents.total} agent${run.agents.total === 1 ? '' : 's'}`)
    if (run.endedAt) parts.push(span(run.endedAt - run.startedAt))
    if (run.tokens.spent) parts.push(`${tokens(run.tokens.spent)} tokens`)
    if (run.dry) parts.push('dry')
    setText(main.querySelector('.rs'), parts.join(' · '))
    row.title = `${run.workflow} · ${run.id}${run.hostName ? ` · ${run.hostName}` : ''}${run.error ? `\n${run.error}` : run.outcome && run.outcome.text ? `\n${run.outcome.text}` : ''}`
    // The whole run as a metro line: its phases as stations, its agents as tracks.
    drawMetro(main.querySelector('.metro'), run)
  }

  /** A fold: back-to-back runs of one workflow that all ended well, as one row that opens. */
  function createGroup() {
    const row = enter(h('button', 'row group'))
    row.type = 'button'
    const glyph = h('div', 'glyph')
    const main = h('div', 'rm')
    const rt = h('div', 'rt')
    const chev = iconSpan('chev')
    chev.classList.add('chev')
    rt.append(h('b'), h('span', 'count'), chev, h('span', 'ago'))
    main.append(rt, h('div', 'rs'))
    const barcode = h('div', 'barcode')
    barcode.setAttribute('aria-hidden', 'true')
    row.append(glyph, main, barcode)
    row.addEventListener('click', () => {
      const id = row.dataset.group
      if (ui.openGroups.has(id)) ui.openGroups.delete(id)
      else ui.openGroups.add(id)
      render()
    })
    return row
  }
  function updateGroup(row, { id, runs }) {
    row.dataset.group = id
    setState(row, 's-', 'done')
    row.setAttribute('aria-expanded', ui.openGroups.has(id) ? 'true' : 'false')
    const [glyph, main, barcode] = row.children
    setIcon(glyph, 'done')
    const newest = runs[0]
    // A closed fold takes the name of a run that just ended, so that run files into it.
    const filing = !ui.openGroups.has(id) && ui.prevCards.has(runKey(newest))
    setMorph(row, filing ? vtName('r', runKey(newest)) : vtName('g', id), filing ? 'vt-row vt-filing' : 'vt-row')
    setText(main.querySelector('b'), newest.workflow)
    setText(main.querySelector('.count'), `×${runs.length}`)
    const agoEl = main.querySelector('.ago')
    agoEl.dataset.ago = String(newest.endedAt ?? newest.updatedAt)
    setText(agoEl, ago(newest.endedAt ?? newest.updatedAt))
    const took = runs.filter((r) => r.endedAt).map((r) => r.endedAt - r.startedAt)
    const spent = runs.reduce((sum, r) => sum + r.tokens.spent, 0)
    const parts = []
    if (multiHost()) parts.push(hostLabel(newest))
    parts.push('all done')
    if (took.length) parts.push(`about ${span(took.reduce((a, b) => a + b, 0) / took.length)} each`)
    if (spent) parts.push(`${tokens(spent)} tokens`)
    setText(main.querySelector('.rs'), parts.join(' · '))
    row.title = `${runs.length} ${newest.workflow} runs in a row, all done. Open to see each one.`
    // One bar per run, oldest first.
    drawBarcode(
      barcode,
      [...runs].reverse().map((r) => ({ took: (r.endedAt ?? r.updatedAt) - r.startedAt, failed: false })),
      runs.map((r) => r.id).join(','),
    )
  }

  // ── Empty state and footer ─────────────────────────────
  function emptyState(snap) {
    const box = h('div', 'empty')
    const svg = document.createElementNS(SVG, 'svg')
    for (const [k, v] of [['viewBox', '0 0 132 56'], ['fill', 'none'], ['stroke', 'currentColor'], ['stroke-width', '1.6'], ['aria-hidden', 'true']]) svg.setAttribute(k, v)
    const flow = document.createElementNS(SVG, 'path')
    flow.setAttribute('class', 'flow')
    flow.setAttribute('stroke-opacity', '.55')
    flow.setAttribute('d', 'M14 28 C 34 28, 34 12, 54 12 M14 28 C 34 28, 34 44, 54 44 M54 12 C 74 12, 78 28, 96 28 M54 44 C 74 44, 78 28, 96 28 M96 28 L 118 28')
    svg.append(flow)
    for (const [cx, cy, r] of [[14, 28, 5], [54, 12, 5], [54, 44, 5], [96, 28, 5], [118, 28, 4]]) {
      const node = document.createElementNS(SVG, 'circle')
      for (const [k, v] of [['class', 'node'], ['cx', cx], ['cy', cy], ['r', r], ['fill', 'currentColor']]) node.setAttribute(k, String(v))
      svg.append(node)
    }
    box.append(svg, h('h3', null, snap && !snap.rootExists ? 'No runs folder yet' : 'No workflow runs yet'))
    box.append(h('p', null, 'Start one and it shows up here as it runs.'))
    const engines = snap && snap.engines && snap.engines.length ? snap.engines : [{ id: 'odw', label: 'ODW', hint: { text: 'A free dry run:', copy: 'odw run hello --dry' } }]
    for (const engine of engines) {
      if (!engine.hint) continue
      const hint = h('div', 'hint')
      hint.append(h('b', null, engine.label), document.createTextNode(` ${engine.hint.text}`))
      box.append(hint)
      if (engine.hint.copy) {
        const line = h('div', 'cmd-line')
        line.append(h('code', null, engine.hint.copy), copyButton(engine.hint.copy))
        box.append(line)
      }
    }
    return box
  }

  const HOST_WORDS = {
    ok: 'connected',
    connecting: 'connecting…',
    stale: 'no updates',
    offline: 'unreachable',
    'no-plugin': 'Workflow Watch for Orca not set up there',
    error: 'error',
  }
  /** What a host chip's tooltip adds about getting its runs. */
  const hostHelp = (item) =>
    item.state === 'no-plugin'
      ? `\nInstall Workflow Watch for Orca there from the ChristianOrrala/agents catalog: orca plugin install christianorrala.workflow-watch-orca --environment "${item.name}"`
      : item.state === 'ok' && !item.details
        ? '\nIts agents’ prompts and answers and its full logs stay there.'
        : ''
  function renderHosts() {
    const bar = document.getElementById('hosts')
    if (!bar) return
    const snap = ui.snap
    const hosts = snap && snap.hosts ? snap.hosts : []
    bar.hidden = hosts.length === 0
    const items = hosts.length ? [{ id: 'local', name: snap.localName || 'This computer', state: 'ok', error: null, lastSeen: snap.scannedAt, local: true }, ...hosts] : []
    reconcile(
      bar,
      items,
      (item) => `host:${item.id}`,
      () => {
        const chip = h('span', 'host')
        chip.append(h('i'), h('span'))
        return chip
      },
      (chip, item) => {
        setState(chip, 'h-', item.state)
        setText(chip.lastChild, item.name)
        const count = snap.runs.filter((r) => (r.host || 'local') === item.id).length
        chip.title = item.local
          ? `${item.name} (this computer) · ${count} run${count === 1 ? '' : 's'}`
          : `${item.name} · ${HOST_WORDS[item.state] || item.state}${item.state === 'ok' ? ` · ${count} run${count === 1 ? '' : 's'}` : ''}${item.error ? `\n${item.error}` : ''}${hostHelp(item)}`
      },
    )
  }

  /** One line per engine: the folder it watches, and a way to change it. */
  function renderFoot() {
    renderHosts()
    const foot = document.getElementById('foot')
    const snap = ui.snap
    const engines = snap && snap.engines.length ? snap.engines : [{ id: 'odw', label: 'ODW', root: '~/.odw/runs', rootExists: false }]
    const named = engines.length > 1
    if (ui.editing) {
      if (foot.querySelector('input')) return
      const engine = engines.find((e) => e.id === ui.editing) || engines[0]
      foot.replaceChildren()
      const line = h('div', 'fl')
      const input = h('input')
      input.value = engine.root
      input.setAttribute('aria-label', `${engine.label} runs folder`)
      input.spellcheck = false
      const save = h('button', 'link', 'Watch')
      save.type = 'button'
      const cancel = h('button', 'link', 'Cancel')
      cancel.type = 'button'
      cancel.style.marginLeft = '0'
      const submit = async () => {
        try {
          const next = await orca.plugin.request('watch.setRoot', { root: input.value, engine: engine.id }, { timeoutMs: 10000 })
          ui.editing = null
          ui.rootError = null
          accept(next)
        } catch (error) {
          ui.rootError = { engine: engine.id, text: error.message || String(error) }
          ui.editing = null
          render()
        }
      }
      save.addEventListener('click', submit)
      cancel.addEventListener('click', () => {
        ui.editing = null
        render()
      })
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') submit()
        if (event.key === 'Escape') cancel.click()
      })
      if (named) line.append(h('span', 'eng', engine.label))
      line.append(input, save, cancel)
      foot.append(line)
      input.focus()
      input.select()
      return
    }
    foot.replaceChildren()
    for (const engine of engines) {
      const line = h('div', 'fl')
      const error = ui.rootError && ui.rootError.engine === engine.id ? ui.rootError.text : null
      if (named) line.append(h('span', 'eng', engine.label))
      if (error) {
        line.append(h('span', 'bad', error))
      } else {
        const code = h('code')
        code.append(h('bdi', null, engine.root))
        code.title = engine.rootExists ? engine.root : `${engine.root} does not exist yet`
        toggle(code, 'absent', !engine.rootExists)
        if (!named) line.append(document.createTextNode('Watching '))
        line.append(code)
        // Its last scan failed: the runs shown are from the scan before.
        if (engine.error) {
          const bad = h('span', 'bad', 'not read')
          bad.title = `${engine.error}\nThe runs shown are from the last scan that worked.`
          line.append(bad)
        }
      }
      const change = h('button', 'link', 'Change')
      change.type = 'button'
      change.setAttribute('aria-label', `Change the ${engine.label} runs folder`)
      change.addEventListener('click', () => {
        ui.editing = engine.id
        ui.rootError = null
        render()
      })
      line.append(change)
      foot.append(line)
    }
  }

  // ── The page ───────────────────────────────────────────
  /** What the list shows, in order: live cards, then history (folds, rows, expanded cards). */
  function plan() {
    const snap = ui.snap
    const runs = snap ? snap.runs : []
    const now = Date.now()
    for (const [id, until] of ui.lingering) if (until < now) ui.lingering.delete(id)
    const asCard = (r) => isLive(r.state) || needsYou(r) || ui.lingering.has(runKey(r))
    const cards = runs.filter(asCard)
    const recent = runs.filter((r) => !asCard(r))
    // History: back-to-back runs of one workflow on one computer that all ended well fold into
    // one row; a failure or a question always keeps a row of its own.
    const folds = []
    for (const r of recent) {
      const last = folds[folds.length - 1]
      const plain = look(r).cls === 'done'
      const head = last && last.runs[0]
      if (head && plain && last.plain && engineOf(head) === engineOf(r) && head.workflow === r.workflow && (head.host || null) === (r.host || null)) last.runs.push(r)
      else folds.push({ plain, runs: [r] })
    }
    const items = []
    for (const r of cards) items.push({ kind: 'card', run: r })
    if (recent.length) items.push({ kind: 'head', text: cards.length ? 'Earlier' : 'Recent', count: recent.length })
    for (const f of folds) {
      const folded = f.runs.length > 1
      if (folded) {
        const id = `fold:${runKey(f.runs[f.runs.length - 1])}`
        items.push({ kind: 'group', id, runs: f.runs })
        if (!ui.openGroups.has(id)) continue
      }
      for (const r of f.runs) {
        items.push({ kind: 'row', run: r, member: folded })
        if (ui.open.has(runKey(r))) items.push({ kind: 'card', run: r, expanded: true })
      }
    }
    if (snap && runs.length === 0) items.push({ kind: 'empty' })
    return { snap, runs, now, items }
  }
  const itemKey = (it) =>
    it.kind === 'head' ? `head:${it.text}` : it.kind === 'empty' ? `empty:${ui.snap && ui.snap.rootExists}` : it.kind === 'group' ? it.id : `${it.kind}:${runKey(it.run)}`
  /** The list's shape: which items, the open sheet, and which cards are asking. */
  function shapeOf(items) {
    const asking = items
      .filter((it) => it.kind === 'card')
      .map((it) => Boolean(it.run.waiting) || look(it.run).cls === 'asking' || (it.run.state === 'paused' && Boolean(it.run.answer)))
    return JSON.stringify([items.map(itemKey), ui.sheet ? `${ui.sheet.key}#${ui.sheet.agentId}` : '', asking])
  }

  /**
   * Draws the page. When the list changes shape, the change runs as a view transition: each
   * named card and row morphs to where it lands, so the eye follows a run from card to row.
   * Answers once the page is drawn.
   */
  function render() {
    const shape = shapeOf(plan().items)
    const changed = ui.shape !== null && shape !== ui.shape
    ui.shape = shape
    const canMorph = changed && typeof document.startViewTransition === 'function' && !calm() && !document.hidden && !booting() && !ui.morphing
    if (!canMorph) {
      paint()
      return Promise.resolve()
    }
    const vt = document.startViewTransition(() => {
      ui.inMorph = true
      try {
        paint()
      } finally {
        ui.inMorph = false
      }
    })
    ui.morphing = vt
    vt.finished.finally(() => {
      if (ui.morphing === vt) ui.morphing = null
    })
    return vt.updateCallbackDone.catch(() => paint())
  }

  function paint() {
    const { snap, runs, now, items } = plan()
    const list = document.getElementById('list')

    // Paused is not working: nothing moves until the run is resumed, so it has a chip of its own.
    const running = runs.filter((r) => r.state === 'running').length
    const paused = runs.filter((r) => r.state === 'paused').length
    const waiting = runs.filter((r) => r.state === 'waiting' || needsYou(r)).length
    const beacon = document.getElementById('beacon')
    toggle(beacon, 'on', running > 0 && waiting === 0)
    toggle(beacon, 'waiting', waiting > 0)
    // The tally: what needs a look, in the cards' own words. Redrawn only when it changes, so a
    // screen reader is not told the same thing every second.
    const hosts = snap && snap.hosts ? snap.hosts : []
    const unreachable = hosts.filter((x) => x.state === 'offline' || x.state === 'error')
    const unset = hosts.filter((x) => x.state === 'no-plugin')
    const quietHosts = hosts.filter((x) => x.state === 'stale')
    const today = runs.filter((r) => !isLive(r.state) && r.endedAt && now - r.endedAt < 864e5).length
    const chips = []
    if (running) chips.push(['c-run', running, ' running', ''])
    if (waiting) chips.push(['c-warn', waiting, ' waiting on you', ''])
    if (paused) chips.push(['', paused, ' paused', 'Nothing moves in a paused run until it is resumed.'])
    if (today && !running && !waiting && !paused) chips.push(['', today, ' today', ''])
    if (unreachable.length) chips.push(['c-quiet', unreachable.length, ' unreachable', unreachable.map((x) => x.name).join(', ')])
    if (unset.length) chips.push(['c-quiet', unset.length, ' not set up', `Workflow Watch for Orca is not installed or not turned on on ${unset.map((x) => x.name).join(', ')}`])
    if (quietHosts.length) chips.push(['c-quiet', quietHosts.length, ' not updating', quietHosts.map((x) => `${x.name}: ${x.error || 'no updates'}`).join('\n')])
    if (ui.stale) chips.push(['c-warn c-quiet', null, 'no updates', 'The watcher has not posted for over 30 seconds, so these runs may have moved on.'])
    const tally = document.getElementById('tally')
    const tallySig = JSON.stringify(chips)
    if (tally.dataset.sig !== tallySig) {
      tally.dataset.sig = tallySig
      const before = ui.counts
      ui.counts = new Map(chips.map(([, n, word]) => [word, n]))
      tally.replaceChildren(
        ...chips.map(([cls, n, word, title]) => {
          const c = h('span', `chip ${cls}`)
          if (n != null) c.append(h('b', null, String(n)))
          c.append(document.createTextNode(word))
          if (title) c.title = title
          // A count that changed, or a chip that just appeared, pings once.
          if (!booting() && before.get(word) !== n) flash(c, 'bump', 1000)
          return c
        }),
      )
    }

    reconcile(
      list,
      items,
      itemKey,
      (it) => {
        if (it.kind === 'card') return createCard()
        if (it.kind === 'row') return createRow()
        if (it.kind === 'group') return createGroup()
        if (it.kind === 'empty') return emptyState(snap)
        const head = h('div', 'section')
        head.append(h('span', null, it.text), h('span', 'n'))
        return head
      },
      (node, it) => {
        if (it.kind === 'card') updateCard(node, it.run, it.expanded)
        else if (it.kind === 'row') updateRow(node, it.run, it.member)
        else if (it.kind === 'group') updateGroup(node, it)
        else if (it.kind === 'head') {
          setText(node.lastChild, String(it.count))
          setMorph(node, vtName('h', it.text), 'vt-head')
        }
      },
    )
    renderFoot()
    renderLog()
    watchOffscreen(list)
    ui.prevCards = new Set(items.filter((it) => it.kind === 'card' && !it.expanded).map((it) => runKey(it.run)))
  }

  // Cards scrolled out of the panel stop their loops.
  const offscreen = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const e of entries) toggle(e.target, 'offscreen', !e.isIntersecting)
  }) : null
  function watchOffscreen(list) {
    if (!offscreen) return
    for (const card of list.querySelectorAll(':scope > .run')) {
      if (ui.observed.has(card)) continue
      ui.observed.add(card)
      offscreen.observe(card)
    }
    for (const card of ui.observed) {
      if (card.isConnected) continue
      offscreen.unobserve(card)
      ui.observed.delete(card)
    }
  }
  window.addEventListener('resize', () => placeFlows(true))

  /** The ending beat of a run: a sheen when it went well, one red wash when it did not. */
  function playMoment(key, moment) {
    const set = moment === 'celebrate' ? ui.celebrate : ui.mourn
    set.add(key)
    setTimeout(() => {
      set.delete(key)
      render()
    }, 1600)
  }

  function accept(snap) {
    if (!snap || !Array.isArray(snap.runs)) return
    const now = Date.now()
    ui.lastHeard = now
    ui.snap = snap
    // The "Metro line size" setting: one attribute, and the stylesheet sizes every part from it.
    const metro = ['compact', 'comfortable', 'large'].includes(snap.metroSize) ? snap.metroSize : 'comfortable'
    if (document.documentElement.dataset.metro !== metro) document.documentElement.dataset.metro = metro
    if (booting() && !ui.bootTimer) ui.bootTimer = setTimeout(() => document.documentElement.classList.remove('boot'), 400)
    for (const run of snap.runs) {
      const key = runKey(run)
      const before = ui.seen.get(key)
      const where = run.hostName ? ` on ${run.hostName}` : ''
      if (before && isLive(before) && !isLive(run.state)) {
        ui.lingering.set(key, now + LINGER_MS)
        const cls = look(run).cls
        const moment = cls === 'done' ? 'celebrate' : cls === 'failed' || cls === 'lost' ? 'mourn' : null
        // A window that is hidden keeps the moment for when it shows again.
        if (moment && document.hidden) ui.pending.set(key, moment)
        else if (moment) playMoment(key, moment)
        announce(`${run.workflow}${where}: ${look(run).word}`)
        setTimeout(render, LINGER_MS + 50)
      } else if (before && before !== 'waiting' && run.state === 'waiting') {
        announce(`${run.workflow}${where} is waiting for you: ${run.waiting ? run.waiting.title : ''}`)
      }
      ui.seen.set(key, run.state)
    }
    // Forget runs that left the snapshot: a panel open for weeks stays small.
    const present = new Set(snap.runs.map(runKey))
    for (const key of [...ui.seen.keys()]) if (!present.has(key)) ui.seen.delete(key)
    for (const key of [...ui.open]) if (!present.has(key)) ui.open.delete(key)
    for (const id of [...ui.openGroups]) if (!present.has(id.replace(/^fold:/, ''))) ui.openGroups.delete(id)
    render()
  }

  document.addEventListener('visibilitychange', () => {
    toggle(document.documentElement, 'asleep', document.hidden)
    if (document.hidden) return
    const now = Date.now()
    for (const [key, moment] of ui.pending) {
      ui.lingering.set(key, now + LINGER_MS)
      playMoment(key, moment)
      setTimeout(render, LINGER_MS + 50)
    }
    ui.pending.clear()
    render()
  })
  document.addEventListener('keydown', (event) => {
    // With the log open, Esc is the dialog's: it closes the log, not the agent sheet behind it.
    if (event.key === 'Escape' && ui.sheet && !ui.editing && !ui.log) closeSheet(true)
  })
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button.copy')
    if (button && button.dataset.copy) void copy(button.dataset.copy)
  })

  // Live clocks and "ago" labels tick here; the data only changes when the worker posts.
  setInterval(() => {
    const now = Date.now()
    // A live run and no word from the worker for 30 s (it posts at least every 10 s): stale.
    const stale = Boolean(ui.lastHeard && ui.snap && ui.snap.runs.some((r) => isLive(r.state)) && now - ui.lastHeard > 30000)
    if (stale !== ui.stale) {
      ui.stale = stale
      toggle(document.documentElement, 'stale', stale)
      render()
    }
    for (const node of document.querySelectorAll('[data-since]')) {
      if (node.dataset.since) setClock(node, now - Number(node.dataset.since))
    }
    for (const node of document.querySelectorAll('[data-ago]')) setText(node, ago(Number(node.dataset.ago)))
    for (const node of document.querySelectorAll('[data-tick]')) if (node.dataset.tick) setText(node, WW.duration(now - Number(node.dataset.tick)))
    placeFlows(false)
    if (ui.sheet) {
      const run = findRun(ui.sheet.key)
      const agent = run && findAgent(run, ui.sheet.agentId)
      if (agent && agent.state === 'running') render()
    }
  }, 1000)

  async function start() {
    const announcer = h('div', 'sr-only')
    announcer.id = 'announce'
    announcer.setAttribute('role', 'status')
    announcer.setAttribute('aria-live', 'polite')
    document.body.append(announcer)
    // The frame's fixed parts keep still while the list morphs around them.
    for (const [sel, name] of [['.top', 'top'], ['#hosts', 'hosts'], ['#foot', 'foot']]) {
      const node = document.querySelector(sel)
      if (node) node.style.viewTransitionName = name
    }
    render()
    if (!orca || !orca.plugin) {
      document.getElementById('list').replaceChildren(h('div', 'empty', 'This panel needs Orca.'))
      return
    }
    orca.plugin.on('watch.changed', accept)
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        accept(await orca.plugin.request('watch.snapshot', undefined, { timeoutMs: 15000 }))
        return
      } catch (error) {
        const list = document.getElementById('list')
        list.replaceChildren(h('div', 'empty', `Could not reach the watcher: ${error.message || error}`))
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
      }
    }
  }
  void start()
})()
