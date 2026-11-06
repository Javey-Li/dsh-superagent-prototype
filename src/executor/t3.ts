/**
 * T3 executor: runs each Ticket Assignment in a T3 Code thread bound to the Ticket's existing worktree.
 *
 * T3 is addressed over its MCP endpoint first, with the T3 CLI as a fallback where the CLI can express the operation.
 * Binding an existing worktree (`workspaceStrategy: existing_worktree`) needs MCP; the CLI cannot name an existing worktree.
 * The thread's final message must carry a `psa-report` JSON block, which this executor validates and reports to the Engine.
 */
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { latestAssignment, liveTicket, runningAssignment, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, ReportState, Ticket, TicketInput, Trigger, WorkerReport }
  from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { HealthEntry } from '../infra/health.ts'
import { agentVariables, workerBin } from '../infra/environment.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../app/store.ts'
import type { Variable } from '../app/execution-environment.ts'
import { batchLine, batchOf, inputMessage as inputTextOf, mandateInstructions, ticketExecution, triggerMessage } from './dsh.ts'
import type { ExecutorRuntime } from './backend.ts'
import { renderTicketContext, ticketContextPackage } from '../app/context-package.ts'

/** Default T3 server binary on this machine; override with `T3_BIN` or Execution settings. */
export const T3_DEFAULT_BIN = '/Users/javeyli/Projects/t3code/apps/server/dist/bin.mjs'
export const T3_DEFAULT_MCP_URL = 'http://127.0.0.1:3773/mcp'
export const T3_DEFAULT_PROVIDER = 'magpie-codex'
export const T3_DEFAULT_MODEL = 'auto/dfmodel'
/** T3's MCP protocol version. */
const MCP_PROTOCOL_VERSION = '2025-06-18'
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const WAIT_SLICE_MS = 300_000
const PREPARE_TIMEOUT_MS = 180_000
const TERMINAL_STATUS = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'rolled_back'])
const RUNNING_STATUS = new Set(['preparing', 'queued', 'starting', 'running'])

const now = (): string => new Date().toISOString()
const firstLine = (text: string): string => String(text || '').trim().split('\n')[0]?.trim() ?? ''
/** The title a T3 thread carries for a Ticket: the human title plus the stable Ticket id used for recovery. */
export const threadTitle = (ticket: Pick<Ticket, 'id' | 'title'>): string => {
  const suffix = ` [${ticket.id}]`
  return `${ticket.title.slice(0, 200 - suffix.length)}${suffix}`
}
const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(abortError()); return }
  const onAbort = (): void => { clearTimeout(timer); reject(abortError()) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
  timer.unref?.()
  signal.addEventListener('abort', onAbort, { once: true })
})
/** Internal signal that the executor, not T3, ended a wait. */
class Aborted extends Error { constructor() { super('T3 executor stopped') } }
const abortError = (): Aborted => new Aborted()
/** True when a failure is the executor's own stop rather than a T3 failure. */
const isAborted = (error: unknown): boolean => error instanceof Aborted || (error as { name?: string } | undefined)?.name === 'AbortError'

/** A structured T3 adapter failure. `code` is stable for tests and doctors. */
export class T3ExecutorError extends Error {
  constructor(readonly code: string, message: string, readonly detail: Record<string, unknown> = {}) {
    super(message)
    this.name = 'T3ExecutorError'
  }
}

/** The child process surface `runCommand` uses, so tests can supply a fake spawn. */
export interface SpawnedChild {
  stdout?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}
export type SpawnImpl = (command: string, args: readonly string[], options: SpawnOptions) => SpawnedChild

export interface CommandResult {
  ok: boolean
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
  command: string
  args: readonly string[]
  error: string | null
}

/** Runs a command without rejecting: spawn failures, non-zero exits, and timeouts all return a structured result. */
export function runCommand({ command, args = [], timeoutMs = 30_000, spawnImpl = nodeSpawn as unknown as SpawnImpl, env = process.env,
  cwd }: { command: string; args?: readonly string[]; timeoutMs?: number; spawnImpl?: SpawnImpl; env?: NodeJS.ProcessEnv; cwd?: string }): Promise<CommandResult> {
  return new Promise(resolve => {
    const startedAt = Date.now()
    let stdout = '', stderr = '', stdoutBytes = 0, stderrBytes = 0
    let settled = false, timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined, forceTimer: ReturnType<typeof setTimeout> | undefined
    let child: SpawnedChild | undefined
    const finish = (code: number | null, signal: NodeJS.Signals | null, spawnError: Error | null = null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (forceTimer) clearTimeout(forceTimer)
      resolve({ ok: code === 0 && !timedOut && !spawnError, code, signal, stdout, stderr, timedOut, durationMs: Date.now() - startedAt,
        command, args, error: spawnError ? String(spawnError.message || spawnError) : null })
    }
    try {
      child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env, cwd, windowsHide: true })
    } catch (error) {
      finish(null, null, error as Error)
      return
    }
    timer = setTimeout(() => {
      timedOut = true
      try { child?.kill('SIGTERM') } catch { /* Already gone. */ }
      forceTimer = setTimeout(() => { try { child?.kill('SIGKILL') } catch { /* Already gone. */ } }, 2_000)
      forceTimer.unref?.()
    }, timeoutMs)
    timer.unref?.()
    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer | string): void => {
      const text = chunk.toString()
      const bytes = Buffer.byteLength(text)
      if (stream === 'stdout') {
        if (stdoutBytes >= MAX_OUTPUT_BYTES) return
        stdout = (stdout + text).slice(0, MAX_OUTPUT_BYTES); stdoutBytes += bytes
      } else {
        if (stderrBytes >= MAX_OUTPUT_BYTES) return
        stderr = (stderr + text).slice(0, MAX_OUTPUT_BYTES); stderrBytes += bytes
      }
    }
    child.stdout?.on('data', collect('stdout'))
    child.stderr?.on('data', collect('stderr'))
    child.on('error', error => finish(null, null, error))
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/** Picks the command and leading arguments for a T3 binary: a `.mjs` or `.js` file runs through Node. */
export function t3Command(bin: string): { command: string; prefix: string[] } {
  return bin.endsWith('.mjs') || bin.endsWith('.js') ? { command: process.execPath, prefix: [bin] } : { command: bin, prefix: [] }
}

/** Parses a JSON document, or the last JSON object line in it, returning `undefined` when no JSON is found. */
export function parseJsonOutput(text: string): unknown {
  const trimmed = String(text || '').trim()
  if (!trimmed) return undefined
  try { return JSON.parse(trimmed) } catch {
    for (const line of trimmed.split('\n').reverse()) {
      const candidate = line.trim()
      if (!candidate.startsWith('{') && !candidate.startsWith('[')) continue
      try { return JSON.parse(candidate) } catch { /* Keep looking. */ }
    }
    return undefined
  }
}

/** One MCP message from a JSON or SSE body. */
export function parseMcpMessages(text: string, contentType = ''): Record<string, unknown>[] {
  const body = String(text || '').trim()
  if (!body) return []
  if (!contentType.includes('text/event-stream')) {
    const parsed: unknown = JSON.parse(body)
    return Array.isArray(parsed) ? parsed as Record<string, unknown>[] : [parsed as Record<string, unknown>]
  }
  const messages: Record<string, unknown>[] = []
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n')
    if (!data) continue
    try { messages.push(JSON.parse(data) as Record<string, unknown>) } catch { /* Ignore SSE comments and keep-alives. */ }
  }
  return messages
}

/** A small JSON-RPC MCP client for T3's HTTP endpoint, with session and protocol headers. */
export class T3McpClient {
  private sessionId: string | null = null
  private protocolVersion = MCP_PROTOCOL_VERSION
  private connected = false
  private connecting: Promise<T3McpClient> | null = null
  private nextId = 1
  constructor(private readonly options: { url: string | null; token: string | null; fetchImpl?: typeof fetch; connectTimeoutMs?: number
    callTimeoutMs?: number; clientInfo?: { name: string; version: string } }) {}

  get configured(): boolean { return Boolean(this.options.url) }

  async connect(): Promise<T3McpClient> {
    if (this.connected) return this
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      const result = await this.request({ jsonrpc: '2.0', id: this.nextId++, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {}, clientInfo: this.options.clientInfo ?? { name: 'dsh-superagent', version: '0.1.0' } } },
      { timeoutMs: this.options.connectTimeoutMs ?? 10_000 })
      this.protocolVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : MCP_PROTOCOL_VERSION
      this.connected = true
      await this.notify('notifications/initialized', {})
      return this
    })()
    try { return await this.connecting } finally { this.connecting = null }
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    await this.request({ jsonrpc: '2.0', method, params }, { timeoutMs: this.options.connectTimeoutMs ?? 10_000, allowEmpty: true })
      .catch(() => undefined)
  }

  async callTool(name: string, args: Record<string, unknown> = {}, { timeoutMs = this.options.callTimeoutMs ?? 30_000 } = {}): Promise<Record<string, any>> {
    await this.connect()
    const result = await this.request({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } }, { timeoutMs })
    if (result?.isError) throw new T3ExecutorError('T3_MCP_TOOL_ERROR', `T3 MCP tool ${name} failed: ${mcpText(result)}`, { tool: name, result })
    if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent as Record<string, any>
    if (result && typeof result === 'object' && result.content === undefined) return result as Record<string, any>
    const parsed = parseJsonOutput(mcpText(result))
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : { text: mcpText(result) }
  }

  private async request(payload: Record<string, unknown>, { timeoutMs, allowEmpty = false }: { timeoutMs: number; allowEmpty?: boolean }): Promise<Record<string, any> | null> {
    if (!this.options.url) throw new T3ExecutorError('T3_MCP_NOT_CONFIGURED', 'T3 MCP URL is not configured')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': this.protocolVersion }
    if (this.options.token) headers.authorization = `Bearer ${this.options.token}`
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId
    try {
      const response = await (this.options.fetchImpl ?? globalThis.fetch)(this.options.url, { method: 'POST', headers, body: JSON.stringify(payload),
        signal: controller.signal } as RequestInit)
      const session = response.headers?.get?.('mcp-session-id')
      if (session) this.sessionId = session
      const text = await response.text()
      if (response.status === 401 || response.status === 403) throw new T3ExecutorError('T3_MCP_UNAUTHORIZED',
        `T3 MCP rejected the request (HTTP ${response.status}); grant this agent access in T3 Code or set T3_MCP_TOKEN`, { status: response.status, body: firstLine(text) })
      if (!response.ok) throw new T3ExecutorError('T3_MCP_HTTP', `T3 MCP returned HTTP ${response.status}: ${firstLine(text) || 'empty response'}`,
        { status: response.status, body: text.slice(0, 2_000) })
      if (!text.trim()) {
        if (allowEmpty) return null
        throw new T3ExecutorError('T3_MCP_EMPTY', 'T3 MCP returned an empty response')
      }
      if (payload.id === undefined) return null
      const messages = parseMcpMessages(text, response.headers?.get?.('content-type') ?? '')
      const message = messages.find(entry => entry.id === payload.id)
      if (!message) {
        if (allowEmpty) return null
        throw new T3ExecutorError('T3_MCP_INVALID', 'T3 MCP response did not contain this request', { body: text.slice(0, 2_000) })
      }
      if (message.error) throw new T3ExecutorError('T3_MCP_ERROR', `T3 MCP error ${String((message.error as { code?: unknown }).code ?? '')}: ${String((message.error as { message?: unknown }).message ?? '')}`.trim(),
        { rpcError: message.error })
      return (message.result ?? null) as Record<string, any> | null
    } catch (error) {
      if (error instanceof T3ExecutorError) {
        if (['T3_MCP_UNAUTHORIZED', 'T3_MCP_UNAVAILABLE', 'T3_MCP_TIMEOUT', 'T3_MCP_HTTP', 'T3_MCP_EMPTY', 'T3_MCP_INVALID'].includes(error.code)) {
          this.connected = false; this.sessionId = null
        }
        throw error
      }
      if (isAborted(error)) throw new T3ExecutorError('T3_MCP_TIMEOUT', `T3 MCP request timed out (${timeoutMs}ms)`, { timeoutMs })
      throw new T3ExecutorError('T3_MCP_UNAVAILABLE', `T3 MCP is unreachable: ${error instanceof Error ? error.message : String(error)}`)
    } finally { clearTimeout(timer) }
  }
}

function mcpText(result: Record<string, any> | null | undefined): string {
  const content = Array.isArray(result?.content) ? result.content as { type?: string; text?: string }[] : []
  return content.filter(item => item.type === 'text' && typeof item.text === 'string').map(item => item.text).join('\n')
}

/**
 * The structured report a T3 thread must leave at the end of its final message. Binding fields are required: a report that
 * does not name this Ticket and Assignment is a protocol failure, not a guessable progress update.
 */
export const PsaReportSchema = z.object({
  schema_version: z.literal(1),
  report_id: z.string().trim().min(1).max(200),
  ticket_id: z.string().trim().min(1).max(200),
  assignment_id: z.string().trim().min(1).max(200),
  state: z.enum(['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']),
  summary: z.string().trim().min(1).max(4_000),
  question: z.string().trim().min(1).max(2_000).nullable().optional(),
  asked_by: z.string().trim().min(1).max(200).optional(),
  answers: z.string().trim().min(1).max(200).optional(),
  evidence: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
}).strict()
export type PsaReport = z.infer<typeof PsaReportSchema>

/**
 * Extracts the last `psa-report` block from a final message.
 * Accepts a fenced ` ```psa-report ` block, a `PSA_REPORT: {...}` line, or a final JSON object carrying a valid state.
 */
export function parsePsaReport(text: string): PsaReport | undefined {
  const body = String(text || '')
  const fenced = [...body.matchAll(/```psa-report\s*\n?([\s\S]*?)```/gi)]
  for (const match of fenced.reverse()) {
    const parsed = PsaReportSchema.safeParse(parseJsonOutput(match[1] ?? ''))
    if (parsed.success) return parsed.data
  }
  for (const line of body.split('\n').reverse()) {
    const match = /^\s*(?:PSA_REPORT|psa-report)\s*:\s*(\{[\s\S]*\})\s*$/i.exec(line)
    if (!match) continue
    const parsed = PsaReportSchema.safeParse(parseJsonOutput(match[1] ?? ''))
    if (parsed.success) return parsed.data
  }
  for (const line of body.split('\n').reverse()) {
    const candidate = line.trim()
    if (!candidate.startsWith('{')) continue
    const parsed = PsaReportSchema.safeParse(parseJsonOutput(candidate))
    if (parsed.success) return parsed.data
  }
  return undefined
}

/** The prompt contract for a T3 thread's final report. */
export const PSA_PROTOCOL = [
  'PSA report protocol (required):',
  'End your final message with exactly one fenced block of this form, and put nothing after it:',
  '```psa-report',
  '{"schema_version":1,"report_id":"<unique id for this run>","ticket_id":"<context ticket_id>","assignment_id":"<context assignment_id>","state":"ready","summary":"what changed, what you verified, and the PR link"}',
  '```',
  'State is one of: progress (work continues), waiting (you need another external event), ready (the assignment is complete and verified),',
  'blocked or failed (a person must act; add "question"), dropped (there is nothing to do).',
  'summary is required, factual, and at most 4000 characters. A ready report ends the Ticket. A blocked or failed report must include',
  '"question" with the one decision or action the person must take; optionally "asked_by" with a trigger_id from the context.',
  'ticket_id and assignment_id must repeat the context values exactly; a report naming another ticket or assignment is rejected.',
].join('\n')

/** A durable thread binding, keyed by Ticket ID, so a retry or restart continues in the same T3 thread. */
interface TicketThread { threadId: string; project: string; link?: string }
interface LedgerEntry { threadId: string; project: string; provider: string; model: string; mode: string; hash: string; createdAt: string }
interface LedgerFile { version: 1; entries: Record<string, LedgerEntry>; threads: Record<string, TicketThread> }

/** Durable idempotency and Ticket-to-thread bindings; writes are atomic renames. */
class T3Ledger {
  constructor(private readonly path: string) {}
  read(): LedgerFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<LedgerFile>
      return { version: 1, entries: parsed.entries ?? {}, threads: parsed.threads ?? {} }
    } catch { return { version: 1, entries: {}, threads: {} } }
  }
  write(value: LedgerFile): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`)
    renameSync(temporary, this.path)
  }
  entry(id: string): LedgerEntry | undefined { return this.read().entries[id] }
  remember(id: string, entry: LedgerEntry): void {
    const value = this.read(); value.entries[id] = entry; this.write(value)
  }
  forget(id: string): void {
    const value = this.read()
    if (!value.entries[id]) return
    delete value.entries[id]; this.write(value)
  }
  thread(ticketId: string): TicketThread | undefined { return this.read().threads[ticketId] }
  bind(ticketId: string, thread: TicketThread): void {
    const value = this.read(); value.threads[ticketId] = thread; this.write(value)
  }
  unbind(ticketId: string): void {
    const value = this.read()
    if (!value.threads[ticketId]) return
    delete value.threads[ticketId]; this.write(value)
  }
}

function requestHash(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

/** Host dependencies of `T3Executor`. */
export interface T3ExecutorHost {
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'settings'> & { readonly threads: Pick<Store['threads'], 'get'> }
  readonly machine: Pick<Machine, 'stateDir'>
  readonly lifetime: AbortSignal
  readonly health?: HealthEntry
  /** Execution environment variables for `ticket`, passed to its workspace prepare command. */
  environment(ticket: Ticket): Variable[]
  /** The resolved deployment; throws while setup is not configured. */
  deployment(): Pick<Deployment, 'github' | 'stateDir'>
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  repliedTo(trigger: Trigger): Trigger | undefined
  closing(): boolean
}

export interface T3ExecutorOptions {
  bin?: string
  mcpUrl?: string | null
  mcpToken?: string | null
  project?: string
  provider?: string
  model?: string
  ghCli?: string
  ghConfigDir?: string
  ledgerPath?: string
  spawnImpl?: SpawnImpl
  fetchImpl?: typeof fetch
  env?: NodeJS.ProcessEnv
  timeouts?: Partial<{ version: number; list: number; launch: number; send: number; wait: number; read: number; interrupt: number }>
  mcpRetryMs?: number
  maxRunMs?: number
  /** Maximum concurrent T3 assignments; defaults to `executor.maxWorkers`. Composite routing passes the write quota. */
  maxWorkers?: number
  verifyIdentity?: boolean
}

interface ActiveRun { ticketId: string; assignmentId: string; abort: AbortController }

/**
 * Executes Assignments in T3 Code threads. One T3 thread runs a Ticket; a retry or host restart sends the next
 * Assignment into that same thread, while `clientRequestId = assignment.id` makes a lost launch reply safe to retry.
 */
export class T3Executor implements ExecutorRuntime {
  private readonly ledger: T3Ledger
  private readonly mcp: T3McpClient
  private readonly spawnImpl: SpawnImpl
  private readonly baseEnv: NodeJS.ProcessEnv
  private readonly timeouts: { version: number; list: number; launch: number; send: number; wait: number; read: number; interrupt: number }
  private readonly launchQueue: { ticketId: string; assignmentId: string }[] = []
  private readonly deliveryQueue = new Map<string, { ticketId: string; assignmentId: string }>()
  private readonly queued = new Set<string>()
  private readonly running = new Map<string, Set<ActiveRun>>()
  private readonly follows = new Set<Promise<void>>()
  private readonly held = new Set<string>()
  private readonly slotWaiters: { assignmentId: string; wake: () => void }[] = []
  private readonly idleWaiters: (() => void)[] = []
  private readonly projectIds = new Map<string, string>()
  private readonly projectCache = new Map<string, string>()
  /** `assignmentId:report_id` keys already applied, so a repeated report is handled once. */
  private readonly reported = new Set<string>()
  private identityPromise?: Promise<string>
  private mcpProbe?: { until: number; ok: boolean }
  private pumpingLaunches = false
  private pumpingDeliveries = false
  private disposed = false
  private stopping = false

  constructor(private readonly host: T3ExecutorHost, private readonly options: T3ExecutorOptions = {}) {
    this.ledger = new T3Ledger(options.ledgerPath ?? join(host.machine.stateDir, 't3-threads.json'))
    this.spawnImpl = options.spawnImpl ?? nodeSpawn as unknown as SpawnImpl
    this.baseEnv = options.env ?? process.env
    this.timeouts = { version: 10_000, list: 30_000, launch: 60_000, send: 300_000, wait: WAIT_SLICE_MS, read: 30_000,
      interrupt: 15_000, ...options.timeouts }
    this.mcp = new T3McpClient({ url: this.mcpUrl(), token: this.mcpToken(), fetchImpl: options.fetchImpl,
      connectTimeoutMs: this.timeouts.version, callTimeoutMs: this.timeouts.list })
    // A host stop aborts every run; the signal is composed with each run's own controller.
    host.lifetime.addEventListener('abort', () => {
      this.stopping = true
      for (const runs of this.running.values()) for (const run of runs) run.abort.abort()
    }, { once: true })
  }

  /** Populates a Ticket's execution metadata the same way the DSH executor does. */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.settings(), this.host.machine.stateDir) }
  }

  /** T3 threads report through polling, so no host event subscription is needed. */
  install(): void {}

  /** Queue an accepted or resumed Assignment for launch. */
  start(ticket: Ticket, assignment: Assignment): void {
    if (this.stopping || this.disposed) return
    if (this.queued.has(assignment.id) || this.running.has(assignment.id)) return
    this.queued.add(assignment.id)
    this.launchQueue.push({ ticketId: ticket.id, assignmentId: assignment.id })
    void this.pumpLaunches()
  }

  /** Queue the Ticket's waiting Inputs for delivery to its running T3 thread. */
  deliver(ticket: Ticket, assignment: Assignment): void {
    if (this.stopping || this.disposed) return
    this.deliveryQueue.set(ticket.id, { ticketId: ticket.id, assignmentId: assignment.id })
    void this.pumpDeliveries()
  }

  /** Interrupt the Ticket's T3 turn. The Ticket's ending transaction has already ended the Assignment. */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    this.queued.delete(assignment.id)
    this.deliveryQueue.delete(ticket.id)
    for (const run of this.running.get(assignment.id) ?? []) run.abort.abort()
    const thread = this.threadOf(ticket.id)
    this.release(assignment.id)
    if (thread) void this.background(this.interrupt(thread.threadId, reason))
  }

  /** Reconcile open tickets after a host restart. */
  resume(): void {
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket)
      if (running) {
        const thread = this.threadOf(ticket.id)
        void (async () => {
          if (thread) await this.interrupt(thread.threadId, 'dsh-superagent restarted')
          if (!this.stopping) this.host.engine.assignmentInterrupted(ticket.id, running.id)
        })()
        continue
      }
      const latest = latestAssignment(ticket)
      if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    for (const runs of this.running.values()) for (const run of runs) run.abort.abort()
    const threads = new Set<string>()
    for (const ticket of this.host.store.tickets.list()) {
      const thread = this.threadOf(ticket.id)
      if (thread) threads.add(thread.threadId)
    }
    await Promise.allSettled([...threads].map(threadId => this.interrupt(threadId, 'dsh-superagent stopped')))
    await Promise.allSettled([...this.follows])
  }

  dispose(): void {
    this.stopping = true
    this.disposed = true
    for (const runs of this.running.values()) for (const run of runs) run.abort.abort()
    this.running.clear(); this.launchQueue.length = 0; this.deliveryQueue.clear(); this.queued.clear()
    for (const waiter of this.slotWaiters.splice(0)) waiter.wake()
    for (const wake of this.idleWaiters.splice(0)) wake()
  }

  activeCount(): number { return this.running.size }

  /** Resolves when no launch, delivery, or followed run remains; used by tests and shutdown diagnostics. */
  idle(): Promise<void> {
    if (!this.busy()) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  private settings(): Settings { return this.host.store.settings() }
  private t3Settings(): Settings['executor']['t3'] { return this.settings().executor.t3 }
  private bin(): string { return this.options.bin || this.baseEnv.T3_BIN || this.t3Settings().bin || T3_DEFAULT_BIN }
  private mcpUrl(): string | null { return this.options.mcpUrl ?? this.baseEnv.T3_MCP_URL ?? this.t3Settings().mcpUrl ?? T3_DEFAULT_MCP_URL }
  private mcpToken(): string | null { return this.options.mcpToken ?? this.baseEnv.T3_MCP_TOKEN ?? this.baseEnv.T3_MCP_ACCESS_TOKEN ?? null }
  private provider(): string { return this.options.provider || this.t3Settings().provider || T3_DEFAULT_PROVIDER }
  private model(): string { return this.options.model || this.t3Settings().model || T3_DEFAULT_MODEL }
  private ghConfigDir(): string {
    return this.options.ghConfigDir || this.t3Settings().ghConfigDir || this.safeDeployment()?.github.configDir
      || join(this.host.machine.stateDir, 'gh-config')
  }

  /** The explicit environment a T3 CLI subprocess and identity probe run with. */
  private environment(): NodeJS.ProcessEnv {
    const stateDir = this.host.machine.stateDir
    const deployment = this.safeDeployment()
    const env: NodeJS.ProcessEnv = { ...this.baseEnv, ...agentVariables(stateDir), GH_CONFIG_DIR: this.ghConfigDir(),
      PATH: [workerBin(stateDir), this.baseEnv.PATH ?? ''].filter(Boolean).join(':') }
    if (deployment) {
      env.GIT_AUTHOR_NAME = deployment.github.login
      env.GIT_AUTHOR_EMAIL = deployment.github.noreply
      env.GIT_COMMITTER_NAME = deployment.github.login
      env.GIT_COMMITTER_EMAIL = deployment.github.noreply
    }
    return env
  }

  private safeDeployment(): Pick<Deployment, 'github' | 'stateDir'> | undefined {
    try { return this.host.deployment() } catch { return undefined }
  }

  private async identity(): Promise<string> {
    if (this.options.verifyIdentity === false) return this.safeDeployment()?.github.login ?? ''
    if (!this.identityPromise) {
      this.identityPromise = this.readIdentity()
      this.identityPromise.catch(() => { this.identityPromise = undefined })
    }
    return this.identityPromise
  }

  private async readIdentity(): Promise<string> {
    const deployment = this.safeDeployment()
    if (!deployment) throw new T3ExecutorError('T3_SETUP_PENDING', 'dsh-superagent setup has not resolved the GitHub identity yet')
    const gh = this.options.ghCli || deployment.github.cli || 'gh'
    const result = await this.run({ command: gh, args: ['api', 'user', '--jq', '.login'], timeoutMs: 15_000 })
    if (!result.ok) throw new T3ExecutorError('T3_GH_UNAVAILABLE',
      `GitHub identity check failed (${gh} api user): ${firstLine(result.stderr) || firstLine(result.stdout) || result.error || 'no output'}`,
      { hint: 'export GH_TOKEN=$(gh auth token) or sign the agent CLI in again' })
    const login = firstLine(result.stdout)
    if (!login) throw new T3ExecutorError('T3_GH_UNAVAILABLE', 'GitHub identity check printed no login')
    if (deployment.github.login && login !== deployment.github.login) throw new T3ExecutorError('T3_IDENTITY_MISMATCH',
      `T3 would act as @${login}, but this installation is configured for @${deployment.github.login}`, { expected: deployment.github.login, actual: login })
    return login
  }

  private run({ command, args, timeoutMs }: { command: string; args: readonly string[]; timeoutMs: number }): Promise<CommandResult> {
    return runCommand({ command, args, timeoutMs, spawnImpl: this.spawnImpl, env: this.environment(), cwd: this.host.machine.stateDir })
  }

  private async t3Run(args: readonly string[], timeoutMs: number): Promise<CommandResult> {
    const { command, prefix } = t3Command(this.bin())
    return this.run({ command, args: [...prefix, ...args], timeoutMs })
  }

  private async projectFor(ticket: Ticket): Promise<string> {
    const configured = this.options.project || this.t3Settings().project
    if (configured) return configured
    const directory = ticket.execution?.directory
    if (!directory) throw new T3ExecutorError('T3_NO_WORKTREE', 'The Ticket has no execution directory to bind a T3 thread to')
    const cached = this.projectCache.get(directory)
    if (cached) return cached
    const absolute = await this.run({ command: 'git', args: ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'], timeoutMs: 15_000 })
    const common = absolute.ok ? firstLine(absolute.stdout) : ''
    let project: string
    if (common) project = dirname(common)
    else {
      const relative = await this.run({ command: 'git', args: ['-C', directory, 'rev-parse', '--git-common-dir'], timeoutMs: 15_000 })
      const value = relative.ok ? firstLine(relative.stdout) : ''
      if (!value) throw new T3ExecutorError('T3_NO_PROJECT', `Could not find the repository of ${directory}; set Execution → T3 → project`)
      project = dirname(resolve(directory, value))
    }
    this.projectCache.set(directory, project)
    return project
  }

  /**
   * Runs the configured `executor.prepare` command before the first T3 launch.
   * An existing directory counts as prepared, matching the DSH executor; a failed prepare fails the Ticket instead of
   * letting T3 bind the project root or an incomplete worktree.
   */
  private async prepareDirectory(ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory
    if (!directory || existsSync(directory)) return
    const command = this.settings().executor.prepare.trim()
    if (!command) return
    mkdirSync(dirname(directory), { recursive: true })
    const ticketEnv = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
    const result = await runCommand({ command: 'sh', args: ['-c', command], timeoutMs: PREPARE_TIMEOUT_MS, spawnImpl: this.spawnImpl,
      env: { ...this.environment(), ...ticketEnv }, cwd: dirname(directory) })
    if (!result.ok) {
      const output = firstLine(result.stderr) || firstLine(result.stdout) || result.error || `exit ${result.code}`
      throw new T3ExecutorError('T3_PREPARE_FAILED', `The prepare command failed: ${output}`, { directory })
    }
    if (!existsSync(directory)) throw new T3ExecutorError('T3_PREPARE_FAILED', `The prepare command did not create ${directory}`, { directory })
  }

  private async mcpAvailable(): Promise<boolean> {
    const nowMs = Date.now()
    if (this.mcpProbe && nowMs < this.mcpProbe.until) return this.mcpProbe.ok
    if (!this.mcp.configured) {
      this.mcpProbe = { until: nowMs + (this.options.mcpRetryMs ?? 60_000), ok: false }
      return false
    }
    try {
      await this.mcp.connect()
      this.mcpProbe = { until: nowMs + 5 * 60_000, ok: true }
      return true
    } catch (error) {
      this.mcpProbe = { until: nowMs + (this.options.mcpRetryMs ?? 60_000), ok: false }
      this.warn(`T3 MCP unavailable: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  }

  private async resolveProjectId(project: string): Promise<string> {
    const key = resolve(project)
    const cached = this.projectIds.get(key)
    if (cached) return cached
    let cursor: number | null = 0
    for (let page = 0; page < 10 && cursor !== null; page += 1) {
      const result = await this.mcp.callTool('t3_project_list', { cursor, limit: 100 }, { timeoutMs: this.timeouts.list })
      const projects = Array.isArray(result.projects) ? result.projects as { id?: string; workspaceRoot?: string }[] : []
      const roots = projects.flatMap(entry => entry.workspaceRoot
        ? [{ entry, root: resolve(entry.workspaceRoot) }] : [])
      // Prefer the exact project root; a parent workspace such as /Projects must not capture a nested repository.
      const match = projects.find(entry => entry.id === project)
        ?? roots.find(item => item.root === key)?.entry
        ?? roots.filter(item => key.startsWith(`${item.root}/`)).sort((a, b) => b.root.length - a.root.length)[0]?.entry
      if (match?.id) { this.projectIds.set(key, match.id); return match.id }
      cursor = typeof result.nextCursor === 'number' ? result.nextCursor : null
    }
    throw new T3ExecutorError('T3_MCP_PROJECT_NOT_FOUND', `No T3 Code project matches ${key}; register it in T3 Code first`, { project: key })
  }

  private threadOf(ticketId: string): TicketThread | undefined {
    return this.ledger.thread(ticketId)
  }

  /** The bound thread, or one discovered in the project after a failed launch and a manual T3 recovery. */
  private async threadFor(ticket: Ticket): Promise<TicketThread | undefined> {
    return this.threadOf(ticket.id) ?? await this.discoverThread(ticket)
  }

  /**
   * Find a T3 thread that already belongs to this Ticket but whose first MCP launch reply was lost. T3 names a launched thread
   * `mcp:launch:<hash>` and this executor's launches carry `[<ticket id>]` in the title, so the thread is discoverable after an
   * approval-required launch failed before the reply arrived and a person continued it by hand. If more than one thread matches,
   * nothing is bound: a wrong binding is worse than a person retrying.
   */
  private async discoverThread(ticket: Ticket): Promise<TicketThread | undefined> {
    if (!await this.mcpAvailable().catch(() => false)) return undefined
    const project = await this.projectFor(ticket)
    const projectId = await this.resolveProjectId(project)
    const result = await this.mcp.callTool('t3_thread_list', { projectId, titleContains: ticket.id, limit: 20 },
      { timeoutMs: this.timeouts.list })
    const threads = Array.isArray(result?.threads) ? result.threads as Record<string, unknown>[] : []
    const bound = new Set(Object.entries(this.ledger.read().threads).flatMap(([id, thread]) => id === ticket.id ? [] : [thread.threadId]))
    const since = Date.parse(ticket.createdAt) - 10 * 60_000
    const candidates = threads.filter(thread => {
      const id = typeof thread.threadId === 'string' ? thread.threadId : ''
      const created = typeof thread.createdAt === 'string' ? Date.parse(thread.createdAt) : Number.NaN
      return id.startsWith('mcp:launch:') && !bound.has(id) && thread.parentThreadId == null
        && typeof thread.title === 'string' && thread.title.includes(`[${ticket.id}]`)
        && (!Number.isFinite(created) || created >= since)
    })
    if (candidates.length !== 1) {
      if (candidates.length > 1) this.warn(`Found ${candidates.length} T3 threads for ${ticket.id}; not rebinding automatically`)
      return undefined
    }
    const found = candidates[0]!
    const thread: TicketThread = { threadId: String(found.threadId), project, ...typeof found.link === 'string' ? { link: found.link } : {} }
    this.bind(ticket.id, thread)
    this.health('ready', `Rebound ${ticket.id} to its existing T3 thread ${thread.threadId}`)
    return thread
  }

  private bind(ticketId: string, thread: TicketThread): void { this.ledger.bind(ticketId, thread) }

  private async pumpLaunches(): Promise<void> {
    if (this.pumpingLaunches) return
    this.pumpingLaunches = true
    try {
      while (this.launchQueue.length && !this.stopping) {
        const job = this.launchQueue.shift()!
        this.queued.delete(job.assignmentId)
        if (!this.current(job.ticketId, job.assignmentId)) continue
        await this.acquire(job.assignmentId)
        if (!this.current(job.ticketId, job.assignmentId)) { this.release(job.assignmentId); continue }
        try {
          const started = await this.launch(job)
          if (!started) this.release(job.assignmentId)
        } catch (error) {
          this.release(job.assignmentId)
          if (!isAborted(error)) this.fail(job.ticketId, job.assignmentId, error)
        }
      }
    } finally {
      this.pumpingLaunches = false
      this.notifyIdle()
    }
  }

  private async pumpDeliveries(): Promise<void> {
    if (this.pumpingDeliveries) return
    this.pumpingDeliveries = true
    try {
      while (this.deliveryQueue.size && !this.stopping) {
        const entry = this.deliveryQueue.entries().next().value as [string, { ticketId: string; assignmentId: string }] | undefined
        if (!entry) break
        const [ticketId, job] = entry
        this.deliveryQueue.delete(ticketId)
        try { await this.deliverQueued(job) } catch (error) {
          if (!isAborted(error)) {
            const ticket = this.host.store.tickets.get(job.ticketId)
            if (ticket && liveTicket(ticket) && runningAssignment(ticket)?.id === job.assignmentId) {
              this.host.engine.deliveryFailed(job.ticketId, job.assignmentId, error instanceof Error ? error.message : String(error))
            }
            this.fail(job.ticketId, job.assignmentId, error)
          }
        }
      }
    } finally {
      this.pumpingDeliveries = false
      this.notifyIdle()
    }
  }

  private async launch(job: { ticketId: string; assignmentId: string }): Promise<boolean> {
    const ticket = this.host.store.tickets.get(job.ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== job.assignmentId || assignment.state !== 'pending') return false
    if (this.host.closing() || this.stopping) return false
    await this.identity()
    await this.prepareDirectory(ticket)
    const project = await this.projectFor(ticket)
    const message = await this.assignmentMessage(ticket, assignment)
    // A launch can fail after T3 created the thread (for example an approval-required parent blocked the first run) and a person
    // may resume that thread by hand. Discover it before creating a duplicate.
    const interrupted = ticket.assignments.some(item => item.report?.state === 'failed' || item.report?.state === 'blocked')
    const existing = this.threadOf(ticket.id) ?? (interrupted ? await this.discoverThread(ticket) : undefined)
    if (existing && await this.threadAlive(existing.threadId)) {
      const sent = await this.sendThread(existing.threadId, message)
      this.host.engine.assignmentStarted(ticket.id, assignment.id)
      this.follow({ ticketId: ticket.id, assignmentId: assignment.id, threadId: existing.threadId, runId: sent.runId, inputIds: [], mode: sent.mode })
      this.health('ready', 'T3 thread is running')
      return true
    }
    if (existing) this.ledger.unbind(ticket.id)
    const launched = await this.launchThread(ticket, assignment, project, message)
    this.bind(ticket.id, { threadId: launched.threadId, project, ...(launched.link ? { link: launched.link } : {}) })
    this.ledger.remember(assignment.id, { threadId: launched.threadId, project, provider: this.provider(), model: this.model(),
      mode: launched.mode, hash: requestHash({ message, project, provider: this.provider(), model: this.model(), worktree: ticket.execution?.directory }),
      createdAt: now() })
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
    this.follow({ ticketId: ticket.id, assignmentId: assignment.id, threadId: launched.threadId, runId: launched.runId, inputIds: [], mode: launched.mode })
    this.health('ready', 'T3 thread is running')
    return true
  }

  private async launchThread(ticket: Ticket, assignment: Assignment, project: string, message: string) {
    const worktree = ticket.execution?.directory
    const title = threadTitle(ticket)
    const provider = this.provider(), model = this.model()
    const attempts: { mode: string; code: string; message: string }[] = []
    if (await this.mcpAvailable()) {
      try {
        const projectId = await this.resolveProjectId(project)
        const result = await this.mcp.callTool('t3_thread_launch', { projectId, title, message,
          modelSelection: { instanceId: provider, model },
          ...(worktree ? { workspaceStrategy: { type: 'existing_worktree', worktreePath: worktree } } : {}), clientRequestId: assignment.id },
        { timeoutMs: this.timeouts.launch })
        const threadId = typeof result.threadId === 'string' ? result.threadId : typeof result.id === 'string' ? result.id : ''
        if (!threadId) throw new T3ExecutorError('T3_MCP_INVALID', 'T3 MCP launched a thread without a threadId')
        return { threadId, runId: typeof result.runId === 'string' ? result.runId : null, link: typeof result.link === 'string' ? result.link : undefined, mode: 'mcp' }
      } catch (error) {
        attempts.push({ mode: 'mcp', code: (error as T3ExecutorError).code ?? 'T3_MCP_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) })
        this.mcpProbe = undefined
      }
    } else attempts.push({ mode: 'mcp', code: 'T3_MCP_UNAVAILABLE', message: 'T3 MCP is not reachable' })

    // The CLI cannot bind an existing worktree. Refuse rather than silently launching in the project root.
    if (worktree && resolve(worktree) !== resolve(project)) {
      throw new T3ExecutorError('T3_MCP_REQUIRED_FOR_WORKTREE',
        `T3 MCP is required to bind the existing worktree ${worktree}; the CLI would launch in the project root instead`, { attempts, worktree, project })
    }
    const { command, prefix } = t3Command(this.bin())
    const args = [...prefix, 'thread', 'start', project, message, '--provider', provider, '--model', model, '--title', title, '--json']
    const run = await this.run({ command, args, timeoutMs: this.timeouts.launch })
    const parsed = parseJsonOutput(run.stdout) as { threadId?: string; runId?: string } | undefined
    if (!run.ok || !parsed?.threadId) {
      throw new T3ExecutorError(run.timedOut ? 'T3_TIMEOUT' : 'T3_CLI_FAILED',
        `T3 launch failed: ${firstLine(run.stderr) || firstLine(run.stdout) || `exit ${run.code}`}`,
        { attempts: [...attempts, { mode: 'cli', code: run.timedOut ? 'T3_TIMEOUT' : 'T3_CLI_FAILED', message: firstLine(run.stderr) || firstLine(run.stdout) }] })
    }
    return { threadId: parsed.threadId, runId: parsed.runId ?? null, mode: 'cli' }
  }

  private async sendThread(threadId: string, message: string): Promise<{ runId: string | null; mode: string }> {
    const attempts: { mode: string; code: string; message: string }[] = []
    if (await this.mcpAvailable()) {
      try {
        const sent = await this.mcp.callTool('t3_thread_send', { threadId, message, mode: 'queue' }, { timeoutMs: this.timeouts.send })
        return { runId: typeof sent.runId === 'string' ? sent.runId : null, mode: 'mcp' }
      } catch (error) {
        attempts.push({ mode: 'mcp', code: (error as T3ExecutorError).code ?? 'T3_MCP_UNAVAILABLE', message: error instanceof Error ? error.message : String(error) })
        this.mcpProbe = undefined
      }
    } else attempts.push({ mode: 'mcp', code: 'T3_MCP_UNAVAILABLE', message: 'T3 MCP is not reachable' })
    const { command, prefix } = t3Command(this.bin())
    const run = await this.run({ command, args: [...prefix, 'thread', 'send', threadId, message, '--json'], timeoutMs: this.timeouts.send })
    const parsed = parseJsonOutput(run.stdout) as { runId?: string } | undefined
    if (!run.ok || !parsed?.runId) {
      throw new T3ExecutorError(run.timedOut ? 'T3_TIMEOUT' : 'T3_CLI_FAILED',
        `T3 send failed: ${firstLine(run.stderr) || firstLine(run.stdout) || `exit ${run.code}`}`, { attempts })
    }
    return { runId: parsed.runId, mode: 'cli' }
  }

  private async threadAlive(threadId: string): Promise<boolean> {
    try {
      if (await this.mcpAvailable()) {
        await this.mcp.callTool('t3_thread_read', { threadId, limit: 1, runLimit: 1 }, { timeoutMs: this.timeouts.read })
        return true
      }
      const result = await this.t3Run(['thread', 'show', threadId, '--messages', '1', '--json'], this.timeouts.read)
      return result.ok
    } catch { return false }
  }

  private async deliverQueued(job: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(job.ticketId)
    const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
    if (!ticket || !assignment || assignment.id !== job.assignmentId || !ticket.undelivered.length) return
    const thread = await this.threadFor(ticket)
    if (!thread) {
      this.host.engine.deliveryFailed(ticket.id, assignment.id, 'The T3 thread is not known; launch the Assignment again')
      return
    }
    const inputIds = [...ticket.undelivered]
    const inputs = inputIds.flatMap(id => ticket.inputs.find(input => input.id === id) ?? [])
    const message = await this.inputMessage(ticket, inputs)
    if (!message) {
      this.host.engine.inputsDelivered(ticket.id, assignment.id, inputIds)
      return
    }
    const sent = await this.sendThread(thread.threadId, message)
    this.host.engine.inputsDelivered(ticket.id, assignment.id, inputIds)
    this.follow({ ticketId: ticket.id, assignmentId: assignment.id, threadId: thread.threadId, runId: sent.runId, inputIds, mode: sent.mode })
  }

  private async inputMessage(ticket: Ticket, inputs: TicketInput[]): Promise<string> {
    const parts: string[] = []
    for (const input of inputs) {
      if (input.kind === 'trigger') {
        const trigger = this.host.store.triggers.get(input.triggerId)
        if (!trigger) continue
        const card = triggerMessage(trigger, await this.host.sourceLink(trigger), input.note, this.host.repliedTo(trigger))
        const message = inputTextOf(input, card)
        if (message) parts.push(message)
      } else {
        const message = inputTextOf(input)
        if (message) parts.push(message)
      }
    }
    return parts.join('\n\n').slice(0, 40_000)
  }

  private async assignmentMessage(ticket: Ticket, assignment: Assignment): Promise<string> {
    const source = this.host.store.triggers.get(ticket.origin.triggerId)
    const trigger = source ? triggerMessage(source, await this.host.sourceLink(source).catch(() => ({})), undefined, undefined) : undefined
    const batch = batchOf(this.host, ticket).map(batchLine)
    const deployment = this.safeDeployment()
    const payload = { ticket_id: ticket.id, assignment_id: assignment.id, title: ticket.title, assignment: ticket.execution?.assignment ?? '',
      worktree: ticket.execution?.directory ?? '', ...(trigger ? { trigger } : {}), ...(batch.length ? { batch } : {}),
      github: { login: deployment?.github.login ?? '', config_dir: this.ghConfigDir() }, assignment_number: ticket.assignments.length,
      context: renderTicketContext(ticketContextPackage(this.host.store, ticket)) }
    const mandate = mandateInstructions(ticket.mandate)
    const identity = deployment
      ? `GitHub identity: every gh invocation must use GH_CONFIG_DIR=${this.ghConfigDir()}; commit as ${deployment.github.login} <${deployment.github.noreply}>.`
      : `GitHub identity: use GH_CONFIG_DIR=${this.ghConfigDir()} for every gh invocation.`
    return [
      'You are the write executor for a dsh-superagent Ticket. Work only inside the worktree in the context below.',
      identity,
      'Before any GitHub write, run `gh api user --jq .login` with that GH_CONFIG_DIR and confirm it prints the configured login. Do not switch accounts.',
      ...mandate ? [`Mandate restriction: ${mandate}`] : [],
      'Ticket context:',
      '```json',
      JSON.stringify(payload, null, 2).slice(0, 60_000),
      '```',
      PSA_PROTOCOL,
    ].join('\n\n')
  }

  private follow(input: { ticketId: string; assignmentId: string; threadId: string; runId: string | null; inputIds: string[]; mode: string }): void {
    const abort = new AbortController()
    const onLifetime = (): void => abort.abort()
    this.host.lifetime.addEventListener('abort', onLifetime, { once: true })
    const run: ActiveRun = { ticketId: input.ticketId, assignmentId: input.assignmentId, abort }
    const runs = this.running.get(input.assignmentId) ?? new Set<ActiveRun>()
    runs.add(run); this.running.set(input.assignmentId, runs)
    const promise = (async () => {
      try {
        const outcome = await this.waitRun(input.threadId, input.runId, input.mode, abort.signal)
        if (abort.signal.aborted || !this.current(input.ticketId, input.assignmentId)) return
        this.host.engine.turnEnded(input.ticketId, input.assignmentId)
        if (input.inputIds.length) this.host.engine.inputsRead(input.ticketId, input.inputIds)
        const report = await this.reportFor(input.ticketId, input.assignmentId, input.threadId, outcome, input.mode)
        if (report) this.report(input.ticketId, input.assignmentId, report)
        this.health('ready', 'T3 thread reported')
      } catch (error) {
        if (abort.signal.aborted || isAborted(error)) return
        this.fail(input.ticketId, input.assignmentId, error)
      } finally {
        const active = this.running.get(input.assignmentId)
        active?.delete(run)
        if (!active?.size) this.running.delete(input.assignmentId)
        this.release(input.assignmentId)
        this.host.lifetime.removeEventListener('abort', onLifetime)
        this.notifyIdle()
      }
    })()
    this.follows.add(promise)
    void promise.finally(() => { this.follows.delete(promise) })
  }

  private async waitRun(threadId: string, runId: string | null, mode: string, signal: AbortSignal): Promise<{ status: string; runId: string | null; error?: string }> {
    return mode === 'cli' ? this.waitRunCli(threadId, runId, signal) : this.waitRunMcp(threadId, runId, signal)
  }

  private async waitRunMcp(threadId: string, runId: string | null, signal: AbortSignal): Promise<{ status: string; runId: string | null }> {
    const deadline = Date.now() + (this.options.maxRunMs ?? 6 * 60 * 60_000)
    for (;;) {
      if (signal.aborted) throw abortError()
      const waited = await this.mcp.callTool('t3_thread_wait', { threadId, runId, timeoutMs: this.timeouts.wait },
        { timeoutMs: this.timeouts.wait + 10_000 })
      const status = typeof waited.status === 'string' ? waited.status : 'unknown'
      if (!waited.timedOut) return { status, runId: typeof waited.runId === 'string' ? waited.runId : runId }
      const seen = await this.readMcp(threadId, 1)
      const pending = Number((seen.thread as { pendingRequestCount?: unknown } | undefined)?.pendingRequestCount ?? 0)
      if (pending > 0) return { status: 'waiting', runId }
      const threadStatus = (seen.thread as { status?: unknown } | undefined)?.status
      if (threadStatus === 'idle') return { status: 'completed', runId }
      if (typeof threadStatus === 'string' && TERMINAL_STATUS.has(threadStatus)) return { status: threadStatus, runId }
      if (Date.now() > deadline) return { status: 'running', runId }
      // A timeout can return immediately in tests or on a flaky bridge; yield so timers and abort handlers run.
      await sleep(500, signal)
    }
  }

  private async waitRunCli(threadId: string, runId: string | null, signal: AbortSignal): Promise<{ status: string; runId: string | null }> {
    const deadline = Date.now() + (this.options.maxRunMs ?? 6 * 60 * 60_000)
    for (;;) {
      if (signal.aborted) throw abortError()
      const shown = await this.showCli(threadId)
      const status = shown.thread?.status ?? 'unknown'
      if (status === 'idle') return { status: 'completed', runId }
      if (status === 'waiting') return { status: 'waiting', runId }
      if (TERMINAL_STATUS.has(status)) return { status, runId }
      if (Date.now() > deadline) return { status: 'running', runId }
      await sleep(2_000, signal)
    }
  }

  private async reportFor(ticketId: string, assignmentId: string, threadId: string, outcome: { status: string; runId: string | null; error?: string },
    mode: string): Promise<WorkerReport | undefined> {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return undefined
    if (outcome.status === 'waiting') return { state: 'blocked', summary: `T3 thread ${threadId} is waiting for a person's answer.`,
      question: 'Answer the T3 thread question, then send a message to this Ticket to continue.' }
    if (outcome.status === 'completed') {
      const text = mode === 'cli' ? await this.finalTextCli(threadId, outcome.runId) : await this.finalTextMcp(threadId, outcome.runId)
      const report = parsePsaReport(text)
      if (!report) return { state: 'blocked', summary: `psa-report 解析失败：缺少符合 schema_version 1 的 report 块。原始输出：${text.trim().slice(-1_200) || '(empty)'}` }
      return this.workerReport(ticket, assignmentId, report)
    }
    if (['failed', 'rolled_back', 'interrupted', 'cancelled'].includes(outcome.status)) {
      const text = outcome.error ?? (mode === 'cli' ? '' : await this.errorTextMcp(threadId, outcome.runId))
      return { state: 'failed', summary: `T3 run ended ${outcome.status}${text ? `: ${text}` : ''}`.slice(0, 4_000) }
    }
    if (outcome.status === 'running') await this.interrupt(threadId, 'T3 run exceeded the executor limit')
    return { state: 'blocked', summary: `T3 run is still running after the executor's limit; a person must decide whether to retry` }
  }

  /**
   * Convert a parsed report, refusing rather than repairing protocol violations. A report bound to another Assignment is stale
   * and ignored; one bound to another Ticket, or carrying contradictory question/answer fields, is blocked for a person.
   */
  private workerReport(ticket: Ticket, assignmentId: string, report: PsaReport): WorkerReport | undefined {
    if (report.assignment_id !== assignmentId) {
      this.warn(`Ignored a stale psa-report for ${ticket.id}: reported assignment ${report.assignment_id}, running ${assignmentId}`)
      return undefined
    }
    const invalid = (why: string): WorkerReport => ({ state: 'blocked', summary: `psa-report 不符合协议：${why}。报告内容：${report.summary.slice(0, 1_500)}` })
    const key = `${assignmentId}:${report.report_id}`
    if (this.reported.has(key)) return undefined
    this.reported.add(key)
    if (report.ticket_id !== ticket.id) return invalid(`ticket_id=${report.ticket_id} 与当前工单 ${ticket.id} 不一致`)
    if (report.state === 'ready' && report.question) return invalid('ready 报告不能带 question')
    if (report.answers && report.question) return invalid('回答与提问不能出现在同一次报告')
    if (report.asked_by && !report.question) return invalid('asked_by 没有对应的 question')
    const known = new Set([ticket.origin.triggerId, ...ticket.origin.triggerIds, ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? [input.triggerId] : [])])
    const human = (id: string): boolean => known.has(id) && this.host.store.triggers.get(id)?.human === true
    if (report.asked_by && !human(report.asked_by)) return invalid(`asked_by=${report.asked_by} 不是这个工单收到的人的消息`)
    if (report.answers && !human(report.answers)) return invalid(`answers=${report.answers} 不是这个工单收到的人的消息`)
    return { state: report.state as ReportState, summary: report.summary.slice(0, 4_000), ...(report.question ? { question: report.question } : {}),
      ...(report.question && report.asked_by ? { askedBy: report.asked_by } : {}),
      ...(report.answers ? { answers: report.answers } : {}) }
  }

  private async readMcp(threadId: string, limit: number, runLimit = 1, view: 'messages' | 'activity' = 'messages'): Promise<Record<string, any>> {
    return this.mcp.callTool('t3_thread_read', { threadId, view, limit, runLimit, maxCharsPerItem: 50_000 }, { timeoutMs: this.timeouts.read })
  }

  private async finalTextMcp(threadId: string, runId: string | null): Promise<string> {
    const read = await this.readMcp(threadId, 100, 5)
    const items = Array.isArray(read.items) ? read.items as Record<string, any>[] : []
    const item = items.findLast(entry => entry.type === 'assistant_message' && (!runId || entry.runId === runId))
    if (!item) return ''
    let text = typeof item.text === 'string' ? item.text : ''
    let offset = item.textTruncated ? (typeof item.nextTextOffset === 'number' ? item.nextTextOffset : null) : null
    while (offset !== null) {
      const page = await this.mcp.callTool('t3_thread_read', { threadId, itemId: item.itemId, textOffset: offset, runLimit: 1 }, { timeoutMs: this.timeouts.read })
      const chunk = (Array.isArray(page.items) ? page.items as Record<string, any>[] : []).find(entry => entry.itemId === item.itemId)
      if (!chunk) break
      text += typeof chunk.text === 'string' ? chunk.text : ''
      offset = chunk.textTruncated && typeof chunk.nextTextOffset === 'number' ? chunk.nextTextOffset : null
    }
    return text
  }

  private async errorTextMcp(threadId: string, runId: string | null): Promise<string> {
    const read = await this.readMcp(threadId, 100, 5, 'activity')
    const items = Array.isArray(read.items) ? read.items as Record<string, any>[] : []
    const item = items.findLast(entry => entry.type === 'error' && (!runId || entry.runId === runId))
    return typeof item?.text === 'string' ? item.text : ''
  }

  private async showCli(threadId: string): Promise<{ thread?: Record<string, any>; messages: Record<string, any>[] }> {
    const result = await this.t3Run(['thread', 'show', threadId, '--messages', '20', '--json'], this.timeouts.read)
    const parsed = parseJsonOutput(result.stdout) as { thread?: Record<string, any>; messages?: Record<string, any>[] } | undefined
    if (!result.ok || !parsed) throw new T3ExecutorError('T3_CLI_FAILED',
      `T3 thread show failed: ${firstLine(result.stderr) || firstLine(result.stdout) || `exit ${result.code}`}`)
    return { thread: parsed.thread, messages: Array.isArray(parsed.messages) ? parsed.messages : [] }
  }

  private async finalTextCli(threadId: string, runId: string | null): Promise<string> {
    const shown = await this.showCli(threadId)
    const message = shown.messages.findLast(entry => entry.role === 'assistant' && (!runId || entry.runId === runId))
    return typeof message?.text === 'string' ? message.text : ''
  }

  private report(ticketId: string, assignmentId: string, report: WorkerReport): void {
    if (!this.current(ticketId, assignmentId)) return
    try { this.host.engine.report(ticketId, report) }
    catch (error) {
      // Never repair a rejected report into another state: a person must see the protocol or binding failure.
      const why = error instanceof Error ? error.message : String(error)
      this.warn(`T3 report for ${ticketId} was refused: ${why}`)
      try {
        this.host.engine.report(ticketId, { state: 'blocked',
          summary: `psa-report 被宿主拒绝（${why}）；原报告状态 ${report.state}。需要人确认后重报。`.slice(0, 4_000) })
      } catch (blockedError) {
        this.warn(`T3 blocked fallback could not be reported: ${blockedError instanceof Error ? blockedError.message : String(blockedError)}`)
      }
    }
  }

  private fail(ticketId: string, assignmentId: string, error: unknown): void {
    if (!this.current(ticketId, assignmentId)) return
    const summary = error instanceof T3ExecutorError
      ? `${error.code}: ${error.message}`
      : `T3 executor failed: ${error instanceof Error ? error.message : String(error)}`
    try { this.host.engine.report(ticketId, { state: 'failed', summary: summary.slice(0, 4_000) }) }
    catch (reportError) { this.warn(`T3 failure could not be reported: ${reportError instanceof Error ? reportError.message : String(reportError)}`) }
    this.health('error', summary.slice(0, 500))
  }

  private async interrupt(threadId: string, reason: string): Promise<void> {
    if (!await this.mcpAvailable()) {
      this.warn('T3 interrupt needs MCP; the CLI has no interrupt command')
      return
    }
    try { await this.mcp.callTool('t3_thread_interrupt', { threadId, reason }, { timeoutMs: this.timeouts.interrupt }) }
    catch (error) { this.warn(`T3 interrupt failed: ${error instanceof Error ? error.message : String(error)}`) }
  }

  private current(ticketId: string, assignmentId: string): Ticket | undefined {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket)) return undefined
    return latestAssignment(ticket)?.id === assignmentId || runningAssignment(ticket)?.id === assignmentId ? ticket : undefined
  }

  private acquire(assignmentId: string): Promise<void> {
    const limit = this.options.maxWorkers ?? this.settings().executor.maxWorkers
    if (this.held.size < limit || this.held.has(assignmentId)) { this.held.add(assignmentId); return Promise.resolve() }
    return new Promise(resolve => {
      const wait = (): void => {
        if (this.held.size < limit) resolve()
        else this.slotWaiters.push({ assignmentId, wake: wait })
      }
      wait()
    })
  }

  private release(assignmentId: string): void {
    // A stopped Assignment that still waits for a slot leaves the queue; wake it so the launch pump can drop it.
    if (!this.held.delete(assignmentId)) {
      const waiting = this.slotWaiters.findIndex(waiter => waiter.assignmentId === assignmentId)
      if (waiting >= 0) this.slotWaiters.splice(waiting, 1)[0]!.wake()
      return
    }
    this.slotWaiters.shift()?.wake()
  }

  private busy(): boolean {
    return this.pumpingLaunches || this.pumpingDeliveries || this.launchQueue.length > 0 || this.deliveryQueue.size > 0 || this.running.size > 0
  }
  private notifyIdle(): void { if (!this.busy()) for (const wake of this.idleWaiters.splice(0)) wake() }

  private warn(message: string): void { this.health('error', message.slice(0, 500)) }
  private health(state: 'ready' | 'error', detail: string): void {
    this.host.health?.set({ state, detail, at: now() })
  }

  private background(work: Promise<void>): Promise<void> {
    return work.then(() => { if (this.host.health?.get()?.state === 'error') this.health('ready', 'T3 executor is ready') },
      error => { this.warn(error instanceof Error ? error.message : String(error)) })
  }
}

/** A deployment-independent view of the T3 executor's doctor checks. */
export interface T3DoctorCheck { id: string; title: string; ok: boolean; detail: string; hint?: string }
export interface T3DoctorReport { ok: boolean; checkedAt: string; checks: T3DoctorCheck[]; hints: string[] }

/** Runs the T3 environment checks: agent gh identity, T3 CLI, T3 MCP, Magpie, and the DSH harness. */
export async function runT3Doctor({ spawnImpl = nodeSpawn as unknown as SpawnImpl, env = process.env, t3Bin = env.T3_BIN || T3_DEFAULT_BIN,
  t3Project = env.T3_PROJECT || process.cwd(), magpieUrl = env.MAGPIE_URL || 'http://127.0.0.1:3425/', mcpUrl = env.T3_MCP_URL || T3_DEFAULT_MCP_URL,
  mcpToken = env.T3_MCP_TOKEN || env.T3_MCP_ACCESS_TOKEN || null, ghCli = env.GH_CLI || 'gh', ghConfigDir = env.GH_CONFIG_DIR || '',
  expectedLogin = env.DSH_SUPERAGENT_GITHUB_ACCOUNT || '', stateDir = env.DSH_SUPERAGENT_STATE_DIR || '', fetchImpl = globalThis.fetch }: {
  spawnImpl?: SpawnImpl; env?: NodeJS.ProcessEnv; t3Bin?: string; t3Project?: string; magpieUrl?: string; mcpUrl?: string; mcpToken?: string | null
  ghCli?: string; ghConfigDir?: string; expectedLogin?: string; stateDir?: string; fetchImpl?: typeof fetch
} = {}): Promise<T3DoctorReport> {
  const run = (command: string, args: readonly string[], timeoutMs: number): Promise<CommandResult> =>
    runCommand({ command, args, timeoutMs, spawnImpl, env: { ...env, ...ghConfigDir ? { GH_CONFIG_DIR: ghConfigDir } : {} }, cwd: t3Project })
  const gh = async (): Promise<T3DoctorCheck> => {
    const result = await run(ghCli, ['api', 'user', '--jq', '.login'], 15_000)
    if (!result.ok) return { id: 'gh', title: 'gh', ok: false, detail: firstLine(result.stderr) || firstLine(result.stdout) || result.error || `exit ${result.code}`,
      hint: 'export GH_TOKEN=$(gh auth token) or sign in the agent gh CLI through GH_CONFIG_DIR' }
    const login = firstLine(result.stdout)
    if (expectedLogin && login !== expectedLogin) return { id: 'gh', title: 'gh', ok: false, detail: `@${login} via ${ghConfigDir}; expected @${expectedLogin}`,
      hint: `Point the T3 server and worker shims at GH_CONFIG_DIR=${ghConfigDir}, signed in as @${expectedLogin}` }
    return { id: 'gh', title: 'gh', ok: true, detail: `@${login} via ${ghConfigDir || 'the inherited GH_CONFIG_DIR'}` }
  }
  // The T3 server, not this doctor process, starts providers: its inherited environment is what a thread's gh actually sees.
  const serverEnv = async (): Promise<T3DoctorCheck> => {
    const port = (() => { try { return new URL(mcpUrl).port || '80' } catch { return '3773' } })()
    const listening = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], 5_000)
    const pid = firstLine(listening.stdout).split('\n')[0]?.trim()
    if (!pid) return { id: 't3-env', title: 'T3 env', ok: false, detail: `No process listens on ${port}`, hint: 'Start T3 Code before the pilot' }
    const ps = await run('ps', ['eww', '-p', pid, '-o', 'command='], 5_000)
    const shown = ps.stdout
    const value = (name: string): string | undefined => {
      const match = new RegExp(`(?:^|\\s)${name}=([^\\s]*)`).exec(shown)
      return match?.[1]
    }
    if (!shown.trim()) return { id: 't3-env', title: 'T3 env', ok: true, detail: `pid ${pid}; environment not visible, verify manually`, }
    const dir = value('GH_CONFIG_DIR')
    const token = value('GH_TOKEN') || value('GITHUB_TOKEN')
    const git = value('GIT_CONFIG_GLOBAL')
    const problems = [
      ...ghConfigDir && dir !== ghConfigDir ? [`GH_CONFIG_DIR=${dir ?? '(unset)'}, expected ${ghConfigDir}`] : [],
      ...!ghConfigDir && !dir ? ['GH_CONFIG_DIR is unset; pass --gh-config-dir to check the agent identity directory'] : [],
      ...token ? ['GH_TOKEN/GITHUB_TOKEN is set in the T3 server'] : [],
      ...stateDir && git && git !== join(stateDir, 'worker-gitconfig') ? [`GIT_CONFIG_GLOBAL=${git}, expected ${join(stateDir, 'worker-gitconfig')}`] : [],
    ]
    return problems.length
      ? { id: 't3-env', title: 'T3 env', ok: false, detail: `pid ${pid}: ${problems.join('; ')}`,
        hint: `Restart T3 server with GH_CONFIG_DIR=${ghConfigDir}${stateDir ? ` GIT_CONFIG_GLOBAL=${join(stateDir, 'worker-gitconfig')}` : ''} and without GH_TOKEN/GITHUB_TOKEN` }
      : { id: 't3-env', title: 'T3 env', ok: true, detail: `pid ${pid}: GH_CONFIG_DIR=${dir}` }
  }
  const t3 = async (): Promise<T3DoctorCheck> => {
    const { command, prefix } = t3Command(t3Bin)
    const [version, list] = await Promise.all([run(command, [...prefix, '--version'], 15_000),
      run(command, [...prefix, 'thread', 'list', '--project', t3Project, '--json'], 30_000)])
    const threads = parseJsonOutput(list.stdout)
    const ok = version.ok && list.ok && Array.isArray(threads)
    return { id: 't3', title: 'T3', ok, detail: ok
      ? `${firstLine(version.stdout) || 't3'} · ${(threads as unknown[]).length} threads`
      : `${firstLine(version.stderr) || 'version failed'}; ${firstLine(list.stderr) || firstLine(list.stdout) || 'list failed'}`,
      ...ok ? {} : { hint: `Start T3 Code and register ${t3Project} as a project` } }
  }
  const mcp = async (): Promise<T3DoctorCheck> => {
    const client = new T3McpClient({ url: mcpUrl, token: mcpToken, fetchImpl, connectTimeoutMs: 5_000, callTimeoutMs: 5_000 })
    try { await client.connect(); return { id: 'mcp', title: 'T3 MCP', ok: true, detail: mcpUrl } }
    catch (error) { return { id: 'mcp', title: 'T3 MCP', ok: false, detail: error instanceof Error ? error.message : String(error),
      hint: 'Grant this agent access in T3 Code, or set T3_MCP_TOKEN; existing-worktree binding needs MCP' } }
  }
  const magpie = async (): Promise<T3DoctorCheck> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5_000)
    try {
      const response = await fetchImpl(magpieUrl, { signal: controller.signal })
      return { id: 'magpie', title: 'Magpie', ok: response.ok, detail: `HTTP ${response.status}`,
        ...response.ok ? {} : { hint: `Start Magpie on ${magpieUrl}` } }
    } catch (error) { return { id: 'magpie', title: 'Magpie', ok: false, detail: error instanceof Error ? error.message : String(error),
      hint: `Start Magpie on ${magpieUrl}` } }
    finally { clearTimeout(timer) }
  }
  const harness = async (): Promise<T3DoctorCheck> => {
    const command = await run('sh', ['-c', 'command -v dsh'], 5_000)
    const path = firstLine(command.stdout)
    return path ? { id: 'harness', title: 'harness', ok: true, detail: `dsh at ${path}` }
      : { id: 'harness', title: 'harness', ok: false, detail: 'dsh command not found', hint: 'Install the dsh CLI and the package peer dependencies' }
  }
  const checks = await Promise.all([gh(), serverEnv(), t3(), mcp(), magpie(), harness()])
  return { ok: checks.every(check => check.ok), checkedAt: now(), checks, hints: checks.flatMap(check => !check.ok && check.hint ? [check.hint] : []) }
}

/** Human-readable doctor output. */
export function humanT3Report(report: T3DoctorReport): string {
  const lines = [`T3 doctor · ${report.checkedAt}`]
  for (const check of report.checks) lines.push(`${check.ok ? '[ok]  ' : '[fail]'} ${check.title.padEnd(9)} ${check.detail}`)
  if (report.hints.length) { lines.push(''); for (const hint of report.hints) lines.push(`-> ${hint}`) }
  return lines.join('\n')
}
