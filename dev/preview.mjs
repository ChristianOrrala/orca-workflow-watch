#!/usr/bin/env node
// Runs the plugin's real worker against a stand-in Orca host and serves the panel to a
// browser, for working on the panel without loading it into Orca.
//
//   node --import ./dev/register.mjs dev/preview.mjs --root /tmp/odw-demo [--port 4517]
//        [--agentprism ~/.agentprism/workflows]                       AgentPrism runs too
//        [--metro compact|comfortable|large]                          the metro line size
//        [--remote /tmp/odw-server-runs [--remote-name "Mac mini"] [--remote-key none]]
//                                                                     a fake paired server
//   then open http://127.0.0.1:4517/  (?theme=light for the light theme)
//
// The page gets a window.orca with plugin.request (POST /request) and plugin.on (server-sent
// events): the same calls the panel makes in Orca. Notifications and status bar updates print
// here instead.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const port = Number(opt('port', '4517'))
const settings = { runsRoot: opt('root', '~/.odw/runs'), agentprismRoot: opt('agentprism', '~/.agentprism/workflows'), notifications: true, history: 12, metroSize: opt('metro', 'comfortable'), remotes: 'auto', orcaCli: '' }
// --remote <runs folder>: pretend a paired server holds those runs (dev/fake-orca answers for it).
if (opt('remote', null)) {
  process.env.FAKE_ORCA_ROOT = opt('remote', null)
  process.env.FAKE_ORCA_NAME = opt('remote-name', 'Mac mini')
  // --remote-key none: a server without the plugin; local.workflow-watch-orca: a development folder there.
  if (opt('remote-key', null)) process.env.FAKE_ORCA_KEY = opt('remote-key', null)
  settings.orcaCli = join(here, 'fake-orca')
}

const handlers = new Map()
const clients = new Set()
const settingsListeners = []
const fakeOrca = {
  api: { major: 1, minor: 10 },
  grantedCapabilities: ['settings:own', 'notifications:show'],
  log: (message) => console.log(`[worker] ${message}`),
  panels: {
    handle(name, handler) {
      handlers.set(name, handler)
      return { dispose: () => handlers.delete(name) }
    },
    post(event, payload) {
      const data = `event: message\ndata: ${JSON.stringify({ event, payload })}\n\n`
      for (const res of clients) res.write(data)
    },
  },
  settings: {
    async get(key) {
      return key ? settings[key] : { ...settings }
    },
    async set(key, value) {
      settings[key] = value
      for (const l of settingsListeners) l({ key })
    },
    onDidChange(listener) {
      settingsListeners.push(listener)
      return { dispose() {} }
    },
  },
  host: {
    has: () => true,
    async call(method, params) {
      if (method === 'notifications.show') console.log(`[notify] ${params.title} — ${params.body ?? ''}`)
      else if (method === 'statusBar.update') console.log(`[status] ${params.text} (${params.tone})`)
      return { delivered: true }
    },
  },
  events: { on: () => ({ dispose() {} }) },
  commands: { register: () => ({ dispose() {} }) },
}

const { default: activate } = await import(join(pluginRoot, 'src', 'worker.ts'))
activate(fakeOrca)

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' }

// Only this page may drive the worker: a request names this host (no DNS rebinding), comes from
// this origin when it says where from, and is JSON (so another site's form cannot send one).
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
const BODY_MAX = 64 * 1024

createServer(async (req, res) => {
  if (!allowedHosts.has(req.headers.host ?? '')) return res.writeHead(421).end('wrong host')
  const url = new URL(req.url, 'http://x')
  if (url.pathname === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    res.write(': hi\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }
  if (url.pathname === '/request' && req.method === 'POST') {
    const origin = req.headers.origin
    if (origin && !allowedHosts.has(origin.replace(/^http:\/\//, ''))) return res.writeHead(403).end('wrong origin')
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return res.writeHead(415).end('send JSON')
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > BODY_MAX) return res.writeHead(413).end('too big')
    }
    let parsed
    try {
      parsed = JSON.parse(body || '{}')
    } catch {
      return res.writeHead(400).end('not JSON')
    }
    const { name, input } = parsed ?? {}
    // A stand-in for Orca's Settings page: { name: 'dev.setting', input: { key, value } }.
    if (name === 'dev.setting' && input && typeof input.key === 'string' && input.key in settings) {
      await fakeOrca.settings.set(input.key, input.value)
      return res.end(JSON.stringify({ output: { ok: true } }))
    }
    const handler = handlers.get(name)
    res.setHeader('content-type', 'application/json')
    if (!handler) return res.end(JSON.stringify({ error: { code: 'unknown_method', message: name } }))
    try {
      res.end(JSON.stringify({ output: await handler(input, { panel: { id: 'preview', surface: 'panel', contributionId: 'runs' }, signal: new AbortController().signal }) }))
    } catch (error) {
      res.end(JSON.stringify({ error: { code: error.code ?? 'action_failed', message: error.message } }))
    }
    return
  }
  const path = url.pathname === '/' ? '/dev/preview.html' : url.pathname
  // The panel's files and the preview page, nothing else of the folder.
  if (!path.startsWith('/panel/') && path !== '/dev/preview.html') return res.writeHead(404).end('not found')
  const file = normalize(join(pluginRoot, path))
  if (!file.startsWith(pluginRoot + sep)) return res.writeHead(403).end()
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(port, '127.0.0.1', () => console.log(`preview on http://127.0.0.1:${port}/ watching ${settings.runsRoot}`))
