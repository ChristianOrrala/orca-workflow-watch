// Recorded worker replies from dev/preview.mjs and scripts/simulate-run.mjs (--plan for the log).
// Serve the repository on loopback and load /dev/listing/?view=cover|live|finished|log|paired.
const view = new URLSearchParams(location.search).get('view') || 'cover'
const copy = {
  cover: [['Every workflow', 'run, live,', 'beside your code.'], ''],
  live: [['Watch agents', 'work in', 'parallel.'], 'Follow each agent on the timeline as the review runs.'],
  finished: [['See where', 'the time', 'went.'], 'Open a finished run to compare phase durations and see which agents ran together.'],
  log: [['Read the', 'whole run', 'log.'], 'Open the event log in one click. Follow new lines as they arrive, or scroll back to a failed step.'],
  paired: [['Two machines.', 'One run', 'history.'], 'See runs from this computer and your paired Orca servers in the same sidebar.'],
}
const [lines, description] = copy[view]
document.body.className = view + (['paired', 'finished'].includes(view) ? ' light' : '')
const headline = document.querySelector('h1')
for (const [i, line] of lines.entries()) {
  const span = document.createElement('span')
  if (i === lines.length - 1) {
    const em = document.createElement('em')
    em.textContent = line
    span.append(em)
  } else span.textContent = line
  headline.append(span)
}
document.querySelector('#copy p').textContent = description
if (view === 'cover') {
  const features = [
    ['M3 6h9m-6 6h12m-3 6h6', 'Phase timelines with durations'],
    ['M3 12h5l3-7 3 14 3-7h4', 'Every agent as it works'],
    ['M4 4h16v16H4zM8 9h8m-8 5h6', 'The full run log in one click'],
    ['M3 4h13v9H3zM7 17h6m5-7h3v10h-8v-3', 'Runs from paired servers, too'],
  ]
  for (const [path, label] of features) {
    const li = document.createElement('li')
    li.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + path + '"/></svg>'
    li.append(label)
    document.querySelector('ul').append(li)
  }
}

const read = async (path) => (await fetch(path)).text()
const [panel, preview, recording] = await Promise.all([
  read('/panel/index.html'), read('/dev/preview.html'), read('demo.json').then(JSON.parse),
])
const theme = new DOMParser().parseFromString(preview, 'text/html').querySelector('style').outerHTML
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check) {
  for (let i = 0; i < 120; i++) {
    const value = check()
    if (value) return value
    await sleep(50)
  }
  throw new Error('Panel did not reach its requested state')
}
async function show(state) {
  const snap = structuredClone(recording.snapshot)
  const select = {
    live: r => !r.host && r.workflow !== 'plan-flow',
    finished: r => !r.host && r.state === 'done' && r.workflow !== 'plan-flow',
    history: r => !r.host && r.state !== 'running' && r.workflow !== 'plan-flow',
    log: r => r.workflow === 'plan-flow',
    paired: r => r.state !== 'running' && r.workflow !== 'plan-flow' && (r.host || r.workflow !== 'deep-research'),
  }
  snap.runs = snap.runs.filter(select[state])
  if (state === 'history') snap.runs = snap.runs.slice(0, 2)
  if (state !== 'paired') snap.hosts = []
  // Freeze the clock at the worker reading. The page still renders the actual panel and its interactions.
  const now = Math.max(snap.scannedAt, ...snap.runs.map(r => r.updatedAt))
  const shim = `<script>
    Date.now = () => ${now}
    window.orca = {on: () => ({}), plugin: {
      on: () => ({}), request: async (name, input) => {
        if (name === 'watch.snapshot') return ${JSON.stringify(snap)}
        if (name === 'watch.log') return (${JSON.stringify(recording.logs)})[input.runId]
        throw new Error(name)
      }
    }}
    </script>`
  const light = ['history', 'finished', 'paired'].includes(state)
  const width = 400
  const box = document.createElement('div')
  box.className = 'shot'
  const frame = document.createElement('iframe')
  frame.title = state + ' panel'
  frame.width = width
  frame.height = 450
  box.append(frame)
  document.querySelector('#panels').append(box)
  frame.srcdoc = panel.replace('<html>', '<html class="' + (light ? 'light' : 'dark') + '" style="--w:400px">')
    .replace('<head>', '<head><base href="/panel/">' + theme + shim)
  const doc = await waitFor(() => frame.contentDocument?.querySelector('.run, button.row')?.ownerDocument)
  if (state === 'finished') {
    doc.querySelector('button.row').click()
    await waitFor(() => doc.querySelector('article.expanded'))
  }
  if (state === 'log') {
    doc.querySelector('.log-toggle').click()
    await waitFor(() => doc.querySelector('dialog[open] li'))
  }
  await sleep(800)
  // Frame the sidebar at a natural boundary: a whole card or the end of its history rows.
  const bottom = el => el.getBoundingClientRect().bottom + frame.contentWindow.scrollY
  let height = 460
  if (state === 'history') height = Math.ceil(bottom(doc.querySelector('#list'))) + 10
  if (state === 'paired') height = Math.ceil(bottom(doc.querySelector('#foot'))) + 10
  if (state === 'live' || state === 'finished') height = Math.ceil(bottom(doc.querySelector('article.run'))) + 10
  frame.height = height
  let zoom = parseFloat(getComputedStyle(box).getPropertyValue('--zoom'))
  if (view !== 'cover') {
    zoom = Math.min(zoom, 912 / height)
    box.style.left = (1125 - width * zoom / 2) + 'px'
    box.style.top = (1000 - height * zoom) / 2 + 'px'
  }
  box.style.setProperty('--zoom', zoom)
  box.style.width = width * zoom + 'px'
  box.style.height = height * zoom + 'px'
}
for (const state of view === 'cover' ? ['live', 'history'] : [view]) await show(state)
document.body.dataset.ready = 'true'
