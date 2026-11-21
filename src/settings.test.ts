import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import type { Snapshot } from './protocol'
import { DEFAULT_METRO_SIZE, metroSize } from './settings'
import activate, { deactivate } from './worker'

test('the metro line size is one of three, else comfortable', () => {
  assert.equal(DEFAULT_METRO_SIZE, 'comfortable')
  assert.equal(metroSize('compact'), 'compact')
  assert.equal(metroSize('comfortable'), 'comfortable')
  assert.equal(metroSize('large'), 'large')
  assert.equal(metroSize(' Large '), 'large')
  for (const value of [undefined, null, '', 'huge', 3, true, {}]) assert.equal(metroSize(value), 'comfortable')
})

test('the snapshot carries the metro size, and a change reaches the panel without a reload', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'watch-metro-'))
  t.after(() => { deactivate(); rmSync(root, { recursive: true, force: true }) })
  const settings: Record<string, unknown> = { runsRoot: root, agentprismRoot: join(root, 'absent'), remotes: 'off', notifications: false }
  const handlers = new Map<string, (input: null) => Promise<unknown>>()
  const posted: Snapshot[] = []
  let changed = () => {}
  activate({
    commands: { register() {} },
    host: { async call() {} },
    log() {},
    panels: { handle: (name: string, handler: (input: null) => Promise<unknown>) => handlers.set(name, handler), post: (_: string, s: Snapshot) => posted.push(s) },
    settings: { get: async () => ({ ...settings }), onDidChange(fn: () => void) { changed = fn } },
  } as unknown as OrcaWorkerApi)
  const snapshot = handlers.get('watch.snapshot')!
  assert.equal(((await snapshot(null)) as Snapshot).metroSize, 'comfortable')
  settings.metroSize = 'large'
  changed()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(posted.at(-1)?.metroSize, 'large', 'the change is posted at once')
  settings.metroSize = 'tiny'
  changed()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(posted.at(-1)?.metroSize, 'comfortable')
})
