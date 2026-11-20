#!/usr/bin/env node
// Writes ODW-shaped runs into a runs folder, so the panel can be watched without spending a
// model call. The files follow ODW's run store (meta.json, status.json, events.jsonl, agents/):
// the worker reads them exactly as it reads real runs.
//
//   node scripts/simulate-run.mjs --root /tmp/odw-demo            history + one live run
//   node scripts/simulate-run.mjs --root /tmp/odw-demo --speed 3  three times faster
//   node scripts/simulate-run.mjs --root /tmp/odw-demo --history-only
//   node scripts/simulate-run.mjs --root /tmp/odw-demo --loop          a new live run every minute
//   node scripts/simulate-run.mjs --root /tmp/odw-demo --plan           one run shaped like plan-flow
//
// The live run keeps this process's pid in status.json, so stopping the script with Ctrl-C
// leaves a run the panel shows as lost, the way a crashed ODW worker looks.
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const root = opt('root', join(process.env.HOME ?? '.', '.odw', 'runs-demo'))
const speed = Number(opt('speed', '1')) || 1
const historyOnly = argv.includes('--history-only')
const loop = argv.includes('--loop')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / speed))
const rand = (a, b) => a + Math.random() * (b - a)

function runIdAt(date, salt) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}-${salt}`
}

function atomic(path, value) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2))
  renameSync(`${path}.tmp`, path)
}

class Run {
  constructor(workflow, description, phases, { startedAt = Date.now(), salt, budget = null, source = '/work/acme-api', adapter = 'claude' } = {}) {
    this.clock = startedAt
    this.runId = runIdAt(new Date(startedAt), salt ?? Math.random().toString(16).slice(2, 8))
    this.dir = join(root, workflow, this.runId)
    mkdirSync(join(this.dir, 'agents'), { recursive: true })
    this.status = { runId: this.runId, state: 'running', dispatched: 0, updatedAt: startedAt / 1000, pid: process.pid, pidStart: 'sim', name: workflow, description, phases, spentTokens: 0 }
    this.nextAgent = 1
    this.nextCommand = 1
    atomic(join(this.dir, 'meta.json'), { runId: this.runId, workflowName: workflow, source, args: null, createdAt: startedAt / 1000, budgetTotal: budget, dry: false, adapter, odwVersion: '0.5.0-dev+gbaf2c8e' })
    this.save()
    this.emit('run_started', { runId: this.runId, setup: { settings: { defaultAdapter: adapter } } })
  }
  /** Live runs stamp the wall clock; history runs move their own clock forward. */
  now() {
    return this.live ? Date.now() : this.clock
  }
  advance(ms) {
    this.clock += ms
  }
  emit(type, fields = {}) {
    appendFileSync(join(this.dir, 'events.jsonl'), JSON.stringify({ ts: this.now() / 1000, type, ...fields }) + '\n')
    this.status.updatedAt = this.now() / 1000
  }
  save() {
    atomic(join(this.dir, 'status.json'), this.status)
  }
  phase(title) {
    this.current = title
    this.emit('phase_started', { phase: title })
  }
  log(message) {
    this.emit('log', { message })
  }
  start(label, { adapter = 'claude', model = null, prompt = `Do the ${label} part.` } = {}) {
    const agentId = this.nextAgent++
    this.status.dispatched++
    atomic(join(this.dir, 'agents', `${agentId}.call.json`), { agentId, label, phase: this.current, prompt, adapter, model, options: { label } })
    this.emit('agent_started', { agentId, label, phase: this.current, adapter, ...(model ? { model } : {}), permissions: 'edit' })
    this.save()
    return { agentId, label, adapter, model, phase: this.current, startedAt: this.now() }
  }
  finish(agent, value, tokens = Math.round(rand(300, 2400)), attempts = 1) {
    this.status.spentTokens += tokens
    atomic(join(this.dir, 'agents', `${agent.agentId}.json`), { agentId: agent.agentId, label: agent.label, phase: agent.phase, adapter: agent.adapter, attempts, startedAt: agent.startedAt / 1000, finishedAt: this.now() / 1000, value })
    this.emit('agent_finished', { agentId: agent.agentId, label: agent.label, phase: agent.phase, adapter: agent.adapter, attempts, usage: { outputTokens: tokens }, saved: true })
    this.save()
  }
  fail(agent, error, tokens = Math.round(rand(100, 600))) {
    this.status.spentTokens += tokens
    writeFileSync(join(this.dir, 'agents', `${agent.agentId}.stderr.txt`), `${error}\n`)
    this.emit('agent_failed', { agentId: agent.agentId, label: agent.label, phase: agent.phase, adapter: agent.adapter, error, reason: 'exit', usage: { outputTokens: tokens } })
    this.save()
  }
  command(label, ok = true) {
    const commandId = this.nextCommand++
    this.emit('command_started', { commandId, label, phase: this.current, command: label })
    return () => this.emit(ok ? 'command_finished' : 'command_failed', { commandId, label, phase: this.current, exitCode: ok ? 0 : 1 })
  }
  wait(title) {
    const checkpointId = 1
    this.status.state = 'waiting'
    this.status.waiting = { checkpointId, title, since: this.now() / 1000 }
    this.emit('checkpoint_requested', { checkpointId, title, payload: null, phase: this.current })
    this.save()
  }
  resolve() {
    this.status.state = 'running'
    this.status.waiting = null
    this.emit('checkpoint_resolved', { checkpointId: 1, action: 'approve', approved: true, by: 'dashboard' })
    this.save()
  }
  /** What the script returned, kept by ODW as result.json `{ value }`. */
  returned(value) {
    atomic(join(this.dir, 'result.json'), { value })
  }
  end(state, error) {
    if (state === 'done') this.emit('run_finished', { runId: this.runId })
    else if (state === 'failed') this.emit('run_failed', { runId: this.runId, error })
    else this.emit('run_stopped', { runId: this.runId, who: 'someone' })
    this.status.state = state
    this.status.waiting = null
    this.status.pid = 0
    this.save()
  }
}

const LENSES = ['correctness', 'security', 'performance', 'readability', 'tests']
const REVIEW_PHASES = [{ title: 'Map' }, { title: 'Review' }, { title: 'Verify' }, { title: 'Apply' }, { title: 'Summarize' }]

/** Finished runs, written at once with their own clock, oldest first. */
function history() {
  const h = 3600_000
  const day = 24 * h
  const done = (workflow, desc, ago, build) => {
    const run = new Run(workflow, desc, build.phases, { startedAt: Date.now() - ago, budget: build.budget ?? null, adapter: build.adapter ?? 'claude', source: build.source })
    build.body(run)
    return run
  }
  done('deep-research', 'Research a question across sources, then verify every claim before it lands in the report.', 2 * day, {
    phases: [{ title: 'Plan' }, { title: 'Search' }, { title: 'Verify' }, { title: 'Write' }],
    adapter: 'codex',
    body(run) {
      run.phase('Plan')
      const plan = run.start('plan', { adapter: 'codex' })
      run.advance(21_000)
      run.finish(plan, { questions: 6 })
      run.phase('Search')
      const searches = Array.from({ length: 6 }, (_, i) => run.start(`search:${i + 1}`, { adapter: 'codex' }))
      searches.forEach((a) => (run.advance(rand(9_000, 40_000)), run.finish(a, { sources: 4 })))
      run.phase('Verify')
      const checks = Array.from({ length: 4 }, (_, i) => run.start(`verify:${i + 1}`, { adapter: 'claude' }))
      checks.forEach((a) => (run.advance(rand(8_000, 20_000)), run.finish(a, { ok: true })))
      run.phase('Write')
      const write = run.start('write', { adapter: 'claude' })
      run.advance(52_000)
      run.finish(write, '# Report\n\n…')
      run.log('12 of 14 claims held up')
      run.end('done')
    },
  })
  done('fix-until-green', 'Run the tests, hand each failure to an agent, and loop until the suite is green.', 5 * h, {
    phases: [{ title: 'Test' }, { title: 'Fix' }],
    adapter: 'opencode',
    source: '/work/billing',
    body(run) {
      for (let round = 1; round <= 3; round++) {
        run.phase('Test')
        const end = run.command('npm test', false)
        run.advance(14_000)
        end()
        run.phase('Fix')
        const fix = run.start(`fix:round-${round}`, { adapter: 'opencode', model: 'big-pickle' })
        run.advance(rand(30_000, 70_000))
        if (round < 3) run.finish(fix, 'Patched the parser.')
        else run.fail(fix, 'opencode exited 1: free usage limit reached')
      }
      run.end('failed', 'fix:round-3 failed: opencode exited 1: free usage limit reached')
    },
  })
  done('review-swarm', 'Review a change set through several lenses in parallel, verify every finding independently, and keep only what survives.', 40 * 60_000, {
    phases: REVIEW_PHASES,
    budget: 60_000,
    body(run) {
      run.phase('Map')
      const map = run.start('map')
      run.advance(18_000)
      run.finish(map, { files: ['src/api.ts'] })
      run.phase('Review')
      const reviews = LENSES.map((l) => run.start(`review:${l}`))
      reviews.forEach((a) => (run.advance(rand(6_000, 25_000)), run.finish(a, { findings: [] })))
      run.log('2 candidate findings from 5 lenses')
      run.phase('Verify')
      const v = [run.start('verify:1'), run.start('verify:2')]
      v.forEach((a) => (run.advance(rand(8_000, 16_000)), run.finish(a, { verdict: 'holds' })))
      run.phase('Summarize')
      const s = run.start('summarize')
      run.advance(11_000)
      run.finish(s, '2 findings survived.')
      run.log('2 of 2 findings survived verification')
      run.end('done')
    },
  })
}

/** One run, live, at the wall clock: a fan-out, a retry, a failure, a checkpoint. */
async function live() {
  const run = new Run('review-swarm', 'Review a change set through several lenses in parallel, verify every finding independently, and keep only what survives.', REVIEW_PHASES, { budget: 60_000 })
  run.live = true
  run.log('reviewing the uncommitted changes (git diff HEAD)')
  run.phase('Map')
  const map = run.start('map', { prompt: 'Map the change set: which files changed, and what could break.' })
  await sleep(4000)
  run.finish(map, { summary: 'A new payment retry path in src/api.ts and its tests.', files: ['src/api.ts', 'src/retry.ts', 'test/retry.test.ts'], risks: ['double charge on timeout'] }, 1840)
  run.phase('Review')
  const reviews = []
  for (const lens of LENSES) {
    reviews.push(run.start(`review:${lens}`, { adapter: lens === 'security' ? 'codex' : 'claude', prompt: `Review the changes strictly through the lens of ${lens}. Report only concrete, verifiable problems.` }))
    await sleep(700)
  }
  const order = [3, 0, 4, 1, 2]
  for (const i of order) {
    await sleep(rand(1800, 3800))
    if (LENSES[i] === 'performance') run.fail(reviews[i], 'claude exited 1: stream disconnected before completion')
    else run.finish(reviews[i], { findings: LENSES[i] === 'security' ? [{ title: 'Retry has no idempotency key', severity: 'high', file: 'src/retry.ts', line: 42 }] : [] })
  }
  run.log('3 candidate findings from 4 of 5 lenses')
  run.phase('Verify')
  const verifiers = [run.start('verify:idempotency-key'), run.start('verify:timeout-path'), run.start('verify:test-gap')]
  for (const v of verifiers) {
    await sleep(rand(2500, 4500))
    run.finish(v, { verdict: v.label.endsWith('test-gap') ? 'refuted' : 'holds' })
  }
  run.log('2 of 3 findings survived verification')
  run.phase('Apply')
  run.wait('Apply 2 verified fixes to src/retry.ts?')
  await sleep(20000)
  run.resolve()
  const apply = run.start('apply:fixes', { prompt: 'Apply the two verified fixes.' })
  const end = run.command('npm test')
  await sleep(5000)
  end()
  run.finish(apply, 'Added an idempotency key and a timeout guard; tests pass.', 3120)
  run.phase('Summarize')
  const s = run.start('summarize')
  await sleep(3000)
  run.finish(s, '2 findings fixed, 1 refuted.')
  run.end('done')
}

/** Shaped like plan-flow: a task loop of implement + two reviewers, gates, then a halt that asks. */
async function planLive() {
  const run = new Run('plan-flow', 'Execute an approved implementation plan task by task: implement, gate, two reviewers, then an integration review; in a second stage, full gates and a checkpointed local merge.', [{ title: 'Preflight' }, { title: 'Tasks' }, { title: 'Deferred fixes' }, { title: 'Integration review' }, { title: 'Merge' }], { adapter: 'worker' })
  run.live = true
  run.phase('Preflight')
  for (const g of ['git root', 'git branch', 'gate typecheck']) {
    const end = run.command(g)
    await sleep(500)
    end()
  }
  run.log('Plan: Invoices export — 8 task(s), reviewers conformance + adversarial')
  run.phase('Tasks')
  for (let t = 1; t <= 8; t++) {
    const attempts = t === 3 ? 2 : 1
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const impl = run.start(`implement:${t}:${attempt}`, { adapter: 'worker', model: 'deepseek/deepseek-v4-pro' })
      await sleep(rand(1500, 2600))
      run.finish(impl, { status: 'DONE' })
      const gate = run.command(`gate test`, !(t === 3 && attempt === 1))
      await sleep(600)
      gate()
      const reviews = ['conformance', 'adversarial'].map((axis) => run.start(`review:${axis}:${t}:${attempt}`, { adapter: 'reviewer' }))
      await sleep(rand(1200, 2200))
      reviews.forEach((r, i) => (t === 5 && i === 1 ? run.fail(r, 'opencode exited 1: model overloaded') : run.finish(r, { findings: [] })))
      if (t === 5) {
        const again = run.start(`review:adversarial:${t}:${attempt}:again`, { adapter: 'reviewer' })
        await sleep(1500)
        run.finish(again, { findings: [] })
      }
    }
    run.log(`Task ${t} complete — ${attempts} attempt(s)`)
  }
  run.phase('Integration review')
  const integration = run.start('review:integration:1', { adapter: 'reviewer' })
  await sleep(3000)
  run.finish(integration, { findings: [{ severity: 'Critical' }] })
  const fix = run.start('fix:integration:1', { adapter: 'worker' })
  await sleep(2500)
  run.finish(fix, { status: 'BLOCKED' })
  const question = 'fix:integration:1 is blocked: should the export keep cancelled invoices?'
  run.log(`WAITING for the owner (integration review): ${question}`)
  run.returned({ status: 'waiting-for-owner', build_done: false, question, where: 'integration review' })
  run.end('done')
}

mkdirSync(root, { recursive: true })
if (argv.includes('--plan')) {
  await planLive()
  process.exit(0)
}
history()
console.log(`history written to ${root}`)
if (!historyOnly) {
  do {
    console.log('live run started; Ctrl-C leaves it lost')
    await live()
    console.log('live run done')
    if (loop) await sleep(8000)
  } while (loop)
}
