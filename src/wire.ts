// What a paired server sends is checked before it is used: a run that does not have the shape
// of a RunView is dropped, and every field the worker or the panel reads gets a safe value. A
// peer on an older plugin, or a broken one, then costs its own runs only.
import type { AgentView, Answer, EngineId, LogLine, Outcome, PhaseView, RunView } from './protocol'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max = 4000): string | null => (typeof v === 'string' ? v.slice(0, max) : null)
const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0)
const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const oneOf = <T extends string>(v: unknown, values: readonly T[], fallback: T): T => (values.includes(v as T) ? (v as T) : fallback)

const RUN_STATES = ['running', 'waiting', 'paused', 'done', 'failed', 'stopped', 'lost'] as const
const PHASE_STATES = ['pending', 'active', 'done', 'failed', 'skipped'] as const
const AGENT_STATES = ['running', 'done', 'failed'] as const
const TONES = ['info', 'warn', 'error', 'success'] as const
const OUTCOME_TONES = ['ok', 'attention', 'bad', 'neutral'] as const
const ENGINES: readonly EngineId[] = ['odw', 'agentprism']

function agentOf(v: unknown): AgentView | null {
  if (!isObj(v) || typeof v.id !== 'number' || !Number.isSafeInteger(v.id)) return null
  return {
    id: v.id,
    label: text(v.label, 200) ?? `agent ${v.id}`,
    phase: text(v.phase, 200) ?? '',
    state: oneOf(v.state, AGENT_STATES, 'done'),
    adapter: text(v.adapter, 80),
    model: text(v.model, 120),
    startedAt: time(v.startedAt) ?? 0,
    endedAt: time(v.endedAt),
    tokens: time(v.tokens),
    attempts: time(v.attempts),
    error: text(v.error, 400),
  }
}

function phaseOf(v: unknown): PhaseView | null {
  if (!isObj(v)) return null
  const commands = isObj(v.commands) ? v.commands : {}
  return {
    title: text(v.title, 200) ?? '',
    detail: text(v.detail, 400),
    state: oneOf(v.state, PHASE_STATES, 'pending'),
    startedAt: time(v.startedAt),
    endedAt: time(v.endedAt),
    agents: (Array.isArray(v.agents) ? v.agents : []).map(agentOf).filter((a): a is AgentView => a !== null),
    hiddenAgents: count(v.hiddenAgents),
    commands: { running: count(commands.running), done: count(commands.done), failed: count(commands.failed) },
  }
}

function logOf(v: unknown): LogLine | null {
  if (!isObj(v)) return null
  const line = text(v.text, 400)
  return line === null ? null : { ts: time(v.ts) ?? 0, text: line, tone: oneOf(v.tone, TONES, 'info') }
}

function answerOf(v: unknown): Answer | null {
  if (!isObj(v)) return null
  const copy = text(v.copy, 2000)
  const how = text(v.how, 600)
  return copy !== null && how !== null ? { copy, how } : null
}

function outcomeOf(v: unknown): Outcome | null {
  if (!isObj(v) || typeof v.status !== 'string') return null
  return { status: v.status.slice(0, 80), tone: oneOf(v.tone, OUTCOME_TONES, 'neutral'), text: text(v.text, 400) }
}

/** A peer's run as a RunView with every field present, or null when it is not a run. */
export function normalizeRun(v: unknown): RunView | null {
  if (!isObj(v) || typeof v.id !== 'string' || !v.id || v.id.length > 200 || typeof v.workflow !== 'string') return null
  const startedAt = time(v.startedAt)
  if (startedAt === null) return null
  const agents = isObj(v.agents) ? v.agents : {}
  const tokens = isObj(v.tokens) ? v.tokens : {}
  const waiting = isObj(v.waiting)
    ? { title: text(v.waiting.title, 400) ?? 'a checkpoint', since: time(v.waiting.since) ?? startedAt, checkpointId: time(v.waiting.checkpointId) }
    : null
  return {
    id: v.id,
    engine: oneOf(v.engine, ENGINES, 'odw'),
    host: null,
    hostName: null,
    workflow: v.workflow.slice(0, 200),
    description: text(v.description, 600),
    state: oneOf(v.state, RUN_STATES, 'lost'),
    startedAt,
    updatedAt: time(v.updatedAt) ?? startedAt,
    endedAt: time(v.endedAt),
    source: text(v.source, 200),
    subject: text(v.subject, 80),
    subjectLabel: text(v.subjectLabel, 200),
    dry: v.dry === true,
    adapter: text(v.adapter, 80),
    phases: (Array.isArray(v.phases) ? v.phases : []).map(phaseOf).filter((p): p is PhaseView => p !== null),
    agents: { total: count(agents.total), running: count(agents.running), done: count(agents.done), failed: count(agents.failed) },
    tokens: { spent: count(tokens.spent), budget: time(tokens.budget) },
    log: (Array.isArray(v.log) ? v.log : []).map(logOf).filter((l): l is LogLine => l !== null),
    waiting,
    answer: answerOf(v.answer),
    error: text(v.error, 600),
    outcome: outcomeOf(v.outcome),
  }
}
