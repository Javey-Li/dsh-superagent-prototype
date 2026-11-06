import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRepositories } from '../src/core/index.ts'
import type { Assignment, EngineForExecutor, Ticket, Trigger, WorkerReport } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { T3Executor, parsePsaReport, type SpawnImpl, type T3ExecutorHost, type T3ExecutorOptions } from '../src/executor/t3.ts'
import type { SourceContext } from '../src/sources/host.ts'

const AT = '2026-11-07T00:00:00.000Z'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'dsh-t3-')); dirs.push(dir); return dir }

const trigger = (id: string): Trigger => ({ id, source: 'github', threads: [{ source: 'github', id: '1' }], actor: { source: 'github', id: 'alice' },
  human: true, at: AT, text: `request ${id}`, channel: { source: 'github', thread: '1', address: { issue: '1' } }, meta: {} })

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  const assignment: Assignment = { id: 'a1', state: 'pending', createdAt: AT }
  return { id: 't1', title: 'Fix the bug', decisionId: 'd1',
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' }, scope: 'small' },
    channels: [], assignments: [assignment], inputs: [], undelivered: [], createdAt: AT, updatedAt: AT,
    origin: { triggerId: 'tr1', triggerIds: ['tr1'] },
    execution: { name: 'fix', directory: '/repo/worktrees/wt', assignment: 'do the work' }, ...overrides }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } })
}

function fakeMcp(tools: Record<string, (args: Record<string, any>) => unknown>) {
  const calls: Record<string, any>[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as Record<string, any>
    calls.push(payload)
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id,
      result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 't3', version: '1' } } })
    if (payload.method === 'notifications/initialized') return response({})
    if (payload.method === 'tools/call') {
      const handler = tools[payload.params.name as string]
      if (!handler) return response({ jsonrpc: '2.0', id: payload.id, result: { isError: true, content: [{ type: 'text', text: `unknown tool ${payload.params.name}` }] } })
      return response({ jsonrpc: '2.0', id: payload.id, result: await handler(payload.params.arguments as Record<string, any>) })
    }
    return response({})
  }) as typeof fetch
  return { fetchImpl, calls }
}

function fakeSpawn(handler: (call: { command: string; args: string[] }, count: number) => { stdout?: string; stderr?: string; code?: number
  hang?: boolean; error?: Error } | undefined) {
  const calls: { command: string; args: string[] }[] = []
  const spawnImpl: SpawnImpl = (command, args) => {
    const call = { command, args: [...args] }
    calls.push(call)
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean }
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter()
    child.kill = () => { setImmediate(() => child.emit('close', null, 'SIGTERM')); return true }
    const outcome = handler(call, calls.length)
    if (outcome?.hang) return child as never
    setImmediate(() => {
      if (outcome?.error) child.emit('error', outcome.error)
      else {
        if (outcome?.stdout) child.stdout.emit('data', Buffer.from(outcome.stdout))
        if (outcome?.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr))
        child.emit('close', outcome?.code ?? 0, null)
      }
    })
    return child as never
  }
  return { spawnImpl, calls }
}

interface Harness {
  repo: MemoryRepositories
  host: T3ExecutorHost
  engine: { started: [string, string][]; reports: [string, WorkerReport][]; delivered: [string, string, string[]][]
    read: [string, string[]][]; turns: [string, string][] }
}

function harness(t: Ticket, report: WorkerReport | string = { state: 'ready', summary: 'done' }, settings = SettingsSchema.parse({}),
  github: () => SourceContext = () => { throw new Error('github source not configured in tests') }) {
  const dir = tempDir()
  const repo = new MemoryRepositories()
  repo.tickets.save(t); repo.triggers.save(trigger('tr1')); repo.triggers.save(trigger('tr2'))
  const started: [string, string][] = [], reports: [string, WorkerReport][] = [], delivered: [string, string, string[]][] = []
  const read: [string, string[]][] = [], turns: [string, string][] = []
  const bound = typeof report === 'string' ? report : { schema_version: 1, report_id: `r-${Date.now()}`, ticket_id: t.id,
    assignment_id: t.assignments.at(-1)!.id, ...report }
  const text = typeof bound === 'string' ? bound : `done\n\`\`\`psa-report\n${JSON.stringify(bound)}\n\`\`\``
  let latestRun = 'run-1'
  const fake = fakeMcp({
    t3_project_list: () => ({ projects: [{ id: 'p1', title: 'repo', workspaceRoot: '/repo' }], nextCursor: null }),
    t3_thread_launch: args => { latestRun = 'run-1'; return { threadId: 'thread-1', runId: 'run-1', status: 'running', link: 't3://thread-1', projectId: 'p1',
      modelSelection: { instanceId: args.modelSelection?.instanceId, model: args.modelSelection?.model } } },
    t3_thread_send: args => { latestRun = 'run-2'; return { threadId: args.threadId, runId: 'run-2', status: 'running', delivery: 'queued' } },
    t3_thread_wait: args => ({ threadId: args.threadId, runId: args.runId, status: 'completed', timedOut: false }),
    t3_thread_read: args => {
      const thread = { threadId: args.threadId, status: 'idle', pendingRequestCount: 0, link: 't3://thread-1' }
      if (args.view === 'activity') return { thread, items: [], recentRuns: [], nextPosition: null, hasMore: false }
      return { thread, items: [{ itemId: 'm1', type: 'assistant_message', runId: args.runId ?? latestRun, text, textTruncated: false,
        nextTextOffset: null, status: 'completed' }], recentRuns: [], nextPosition: null, hasMore: false }
    },
    t3_thread_interrupt: () => ({ threadId: 'thread-1' }),
  })
  const engine: Harness['engine'] = { started, reports, delivered, read, turns }
  const api: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'> = {
    assignmentStarted: vi.fn((ticketId: string, assignmentId: string) => {
      started.push([ticketId, assignmentId])
      const current = repo.tickets.get(ticketId)!
      const assignment = current.assignments.find(item => item.id === assignmentId)
      if (assignment) { assignment.state = 'running'; current.updatedAt = AT; repo.tickets.save(current) }
    }),
    inputsDelivered: vi.fn((ticketId: string, _assignmentId: string, ids: string[]) => {
      delivered.push([ticketId, _assignmentId, ids])
      const current = repo.tickets.get(ticketId)!
      current.undelivered = current.undelivered.filter(id => !ids.includes(id)); repo.tickets.save(current)
    }),
    inputsRead: vi.fn((ticketId: string, ids: string[]) => { read.push([ticketId, ids]) }),
    turnEnded: vi.fn((ticketId: string, assignmentId: string) => { turns.push([ticketId, assignmentId]) }),
    deliveryFailed: vi.fn(),
    assignmentInterrupted: vi.fn(),
    report: vi.fn((ticketId: string, value: WorkerReport) => { reports.push([ticketId, value]); return repo.tickets.get(ticketId)! }),
  }
  const host: T3ExecutorHost = {
    engine: api, store: { tickets: repo.tickets, triggers: repo.triggers, threads: repo.threads, settings: () => settings },
    machine: { stateDir: dir }, lifetime: new AbortController().signal,
    deployment: () => ({ github: { cli: 'gh', login: 'agent', noreply: 'agent@users.noreply.github.com', configDir: join(dir, 'gh-config') }, stateDir: dir }),
    environment: () => [], sourceLink: async () => ({}), repliedTo: () => undefined, closing: () => false,
    github,
  }
  return { repo, host, engine, fetchImpl: fake.fetchImpl, mcpCalls: fake.calls, dir }
}

function executor(h: ReturnType<typeof harness>, options: Partial<T3ExecutorOptions> = {}) {
  return new T3Executor(h.host, { project: '/repo', mcpUrl: 'http://t3/mcp', mcpToken: 'token', fetchImpl: h.fetchImpl,
    ledgerPath: join(h.dir, 'ledger.json'), verifyIdentity: false, mcpRetryMs: 0, ...options })
}

describe('T3 executor', () => {
  it('launches with the existing worktree and reports the psa-report', async () => {
    const t = ticket()
    const h = harness(t)
    const run = executor(h)
    run.start(t, t.assignments[0]!)
    await run.idle()
    const launch = h.mcpCalls.find(call => call.method === 'tools/call' && call.params.name === 't3_thread_launch')
    expect(launch?.params.arguments.workspaceStrategy).toEqual({ type: 'existing_worktree', worktreePath: '/repo/worktrees/wt' })
    expect(launch?.params.arguments.clientRequestId).toBe('a1')
    expect(launch?.params.arguments.modelSelection).toEqual({ instanceId: 'magpie-codex', model: 'auto/dfmodel' })
    expect(h.engine.started).toEqual([['t1', 'a1']])
    expect(h.engine.reports.at(-1)).toEqual(['t1', { state: 'ready', summary: 'done' }])
    expect(h.engine.turns).toContainEqual(['t1', 'a1'])
  })

  it('runs the prepare command before launch and leaves the runtime mode to the MCP parent', async () => {
    const dir = tempDir()
    const worktree = join(dir, 'worktree')
    const t = ticket({ execution: { name: 'fix', directory: worktree, assignment: 'do the work' } })
    const h = harness(t, { state: 'ready', summary: 'done' }, SettingsSchema.parse({ executor: { prepare: `mkdir -p ${JSON.stringify(worktree)}` } }))
    const run = executor(h)
    run.start(t, t.assignments[0]!)
    await run.idle()
    expect(existsSync(worktree)).toBe(true)
    const launch = h.mcpCalls.find(call => call.method === 'tools/call' && call.params.name === 't3_thread_launch')
    expect(launch?.params.arguments.runtimeMode).toBeUndefined()
    expect(launch?.params.arguments.workspaceStrategy).toEqual({ type: 'existing_worktree', worktreePath: worktree })
  })

  it('does not create a second thread for the same assignment, and continues the ticket thread on retry', async () => {
    const t = ticket()
    const h = harness(t)
    const run = executor(h)
    run.start(t, t.assignments[0]!)
    run.start(t, t.assignments[0]!)
    await run.idle()
    expect(h.mcpCalls.filter(call => call.params?.name === 't3_thread_launch')).toHaveLength(1)

    const current = h.repo.tickets.get('t1')!
    const retry: Assignment = { id: 'a2', state: 'pending', createdAt: AT }
    current.assignments.push(retry); h.repo.tickets.save(current)
    run.start(current, retry)
    await run.idle()
    expect(h.mcpCalls.filter(call => call.params?.name === 't3_thread_launch')).toHaveLength(1)
    expect(h.mcpCalls.filter(call => call.params?.name === 't3_thread_send')).toHaveLength(1)
    expect(h.engine.started).toContainEqual(['t1', 'a2'])
  })

  it('rebinds a T3 thread that a person resumed by hand after the first launch failed', async () => {
    const t = ticket()
    t.assignments[0] = { ...t.assignments[0]!, state: 'running', report: { state: 'failed', summary: 'approval required', at: AT } }
    t.assignments.push({ id: 'a2', state: 'pending', createdAt: AT })
    const h = harness(t)
    const mcp = fakeMcp({
      t3_project_list: () => ({ projects: [{ id: 'p1', title: 'repo', workspaceRoot: '/repo' }], nextCursor: null }),
      t3_thread_list: () => ({ threads: [{ threadId: `mcp:launch:${'a'.repeat(64)}`, title: 'Fix the bug [t1]', createdAt: AT,
        parentThreadId: null, settled: false }], nextCursor: null, total: 1 }),
      t3_thread_send: () => ({ threadId: `mcp:launch:${'a'.repeat(64)}`, runId: 'run-2', status: 'running', delivery: 'queued' }),
      t3_thread_wait: () => ({ status: 'completed', timedOut: false, runId: 'run-2' }),
      t3_thread_read: () => ({ thread: { threadId: `mcp:launch:${'a'.repeat(64)}`, status: 'idle', pendingRequestCount: 0 },
        items: [{ itemId: 'm2', type: 'assistant_message', runId: 'run-2', text: 'done',
          textTruncated: false }], recentRuns: [], nextPosition: null, hasMore: false }),
    })
    const run = executor(h, { fetchImpl: mcp.fetchImpl })
    run.start(t, t.assignments[1]!)
    await run.idle()
    expect(mcp.calls.filter(call => call.params?.name === 't3_thread_launch')).toHaveLength(0)
    expect(mcp.calls.filter(call => call.params?.name === 't3_thread_send')).toHaveLength(1)
    expect(h.engine.started).toContainEqual(['t1', 'a2'])
  })

  it('rebinds a manually resumed thread when a person\'s message reaches a failed ticket', async () => {
    const t = ticket()
    t.assignments[0] = { ...t.assignments[0]!, state: 'running', report: { state: 'failed', summary: 'approval required', at: AT } }
    t.inputs.push({ id: 'i1', kind: 'trigger', triggerId: 'tr2', at: AT, human: true })
    t.undelivered = ['i1']
    const h = harness(t)
    const mcp = fakeMcp({
      t3_project_list: () => ({ projects: [{ id: 'p1', title: 'repo', workspaceRoot: '/repo' }], nextCursor: null }),
      t3_thread_list: () => ({ threads: [{ threadId: `mcp:launch:${'b'.repeat(64)}`, title: 'Fix the bug [t1]', createdAt: AT,
        parentThreadId: null, settled: false }], nextCursor: null, total: 1 }),
      t3_thread_send: args => ({ threadId: args.threadId, runId: 'run-3', status: 'running', delivery: 'queued' }),
      t3_thread_wait: () => ({ status: 'completed', timedOut: false, runId: 'run-3' }),
      t3_thread_read: () => ({ thread: { threadId: `mcp:launch:${'b'.repeat(64)}`, status: 'idle', pendingRequestCount: 0 },
        items: [{ itemId: 'm3', type: 'assistant_message', runId: 'run-3', text: '```psa-report\n' + JSON.stringify({ schema_version: 1,
          report_id: 'r-status', ticket_id: 't1', assignment_id: 'a1', state: 'ready', summary: '改好了，CI 通过，等待合并' }) + '\n```',
          textTruncated: false }], recentRuns: [], nextPosition: null, hasMore: false }),
    })
    const run = executor(h, { fetchImpl: mcp.fetchImpl })
    run.deliver(t, t.assignments[0]!)
    await run.idle()
    expect(mcp.calls.some(call => call.params?.name === 't3_thread_send')).toBe(true)
    expect(h.engine.reports.at(-1)?.[1]).toMatchObject({ state: 'ready', summary: '改好了，CI 通过，等待合并' })
  })

  it('prefers an exact T3 project over a parent workspace root', async () => {
    const t = ticket()
    const h = harness(t)
    const mcp = fakeMcp({
      t3_project_list: () => ({ projects: [{ id: 'parent', workspaceRoot: '/repo' }, { id: 'exact', workspaceRoot: '/repo/worktrees/wt' }],
        nextCursor: null }),
      t3_thread_launch: () => ({ threadId: 'thread-1', runId: 'run-1', status: 'running' }),
      t3_thread_wait: () => ({ status: 'completed', timedOut: false, runId: 'run-1' }),
      t3_thread_read: () => ({ thread: { threadId: 'thread-1', status: 'idle', pendingRequestCount: 0 },
        items: [{ itemId: 'm1', type: 'assistant_message', runId: 'run-1',
          text: '```psa-report\n{"schema_version":1,"report_id":"r1","ticket_id":"t1","assignment_id":"a1","state":"ready","summary":"ok"}\n```',
          textTruncated: false }], recentRuns: [], nextPosition: null, hasMore: false }),
    })
    const run = executor(h, { project: '/repo/worktrees/wt', fetchImpl: mcp.fetchImpl })
    run.start(t, t.assignments[0]!)
    await run.idle()
    const launch = mcp.calls.find(call => call.params?.name === 't3_thread_launch')
    expect(launch?.params.arguments.projectId).toBe('exact')
  })

  it('delivers waiting inputs and marks them read when the T3 turn ends', async () => {
    const t = ticket()
    const h = harness(t)
    const run = executor(h)
    run.start(t, t.assignments[0]!)
    await run.idle()

    const current = h.repo.tickets.get('t1')!
    current.inputs.push({ id: 'i1', kind: 'trigger', triggerId: 'tr2', at: AT, human: true })
    current.undelivered = ['i1']; h.repo.tickets.save(current)
    run.deliver(current, current.assignments[0]!)
    await run.idle()
    expect(h.engine.delivered).toContainEqual(['t1', 'a1', ['i1']])
    expect(h.engine.read).toContainEqual(['t1', ['i1']])
    expect(h.engine.reports.at(-1)?.[1].state).toBe('ready')
  })

  it('interrupts the T3 thread when the ticket ends', async () => {
    const t = ticket()
    const h = harness(t)
    const mcp = fakeMcp({
      t3_project_list: () => ({ projects: [{ id: 'p1', workspaceRoot: '/repo' }], nextCursor: null }),
      t3_thread_launch: () => ({ threadId: 'thread-1', runId: 'run-1', status: 'running' }),
      t3_thread_wait: () => ({ status: 'running', timedOut: true }),
      t3_thread_read: () => ({ thread: { threadId: 'thread-1', status: 'running', pendingRequestCount: 0 }, items: [] }),
      t3_thread_interrupt: () => ({ threadId: 'thread-1' }),
    })
    const run = executor(h, { fetchImpl: mcp.fetchImpl })
    run.start(t, t.assignments[0]!)
    await vi.waitFor(() => expect(mcp.calls.some(call => call.params?.name === 't3_thread_wait')).toBe(true))
    run.stop(t, t.assignments[0]!, 'stopped by a person')
    await vi.waitFor(() => expect(mcp.calls.some(call => call.params?.name === 't3_thread_interrupt')).toBe(true))
    expect(mcp.calls.find(call => call.params?.name === 't3_thread_interrupt')?.params.arguments.reason).toBe('stopped by a person')
    await run.idle()
  })

  it('refuses to launch in the project root when MCP cannot bind the worktree', async () => {
    const t = ticket()
    const h = harness(t)
    const spawn = fakeSpawn(() => ({ stdout: '{"threadId":"thread-cli"}\n' }))
    const run = executor(h, { fetchImpl: (async () => new Response('no', { status: 401 })) as typeof fetch, spawnImpl: spawn.spawnImpl })
    run.start(t, t.assignments[0]!)
    await run.idle()
    expect(spawn.calls.filter(call => call.args.includes('start'))).toHaveLength(0)
    expect(h.engine.reports.at(-1)?.[1].summary).toContain('T3_MCP_REQUIRED_FOR_WORKTREE')
  })

  it('falls back to the CLI for a project-root launch when MCP is unauthorized', async () => {
    const t = ticket({ execution: { name: 'fix', directory: '/repo', assignment: 'do the work' } })
    const h = harness(t)
    const spawn = fakeSpawn(call => {
      if (call.args.includes('start')) return { stdout: '{"threadId":"thread-cli","runId":"run-cli"}\n' }
      return { stdout: JSON.stringify({ thread: { threadId: 'thread-cli', status: 'idle' },
        messages: [{ role: 'assistant', runId: 'run-cli',
          text: '```psa-report\n{"schema_version":1,"report_id":"r-cli","ticket_id":"t1","assignment_id":"a1","state":"ready","summary":"cli done"}\n```' }] }) }
    })
    const run = executor(h, { fetchImpl: (async () => new Response('no', { status: 401 })) as typeof fetch, spawnImpl: spawn.spawnImpl })
    run.start(t, t.assignments[0]!)
    await run.idle()
    expect(spawn.calls.some(call => call.args.includes('start'))).toBe(true)
    expect(h.engine.reports.at(-1)?.[1]).toMatchObject({ state: 'ready', summary: 'cli done' })
  })

  it('reports a mismatch before launching when the agent CLI is signed in as another account', async () => {
    const t = ticket()
    const h = harness(t)
    const spawn = fakeSpawn(() => ({ stdout: 'someone-else\n' }))
    const run = executor(h, { verifyIdentity: true, spawnImpl: spawn.spawnImpl })
    run.start(t, t.assignments[0]!)
    await run.idle()
    expect(h.engine.reports.at(-1)?.[1]).toMatchObject({ state: 'failed' })
    expect(h.engine.reports.at(-1)?.[1].summary).toContain('T3_IDENTITY_MISMATCH')
    expect(h.mcpCalls.some(call => call.params?.name === 't3_thread_launch')).toBe(false)
  })

  it('blocks instead of guessing when the final message has no valid psa-report', async () => {
    const t = ticket()
    const h = harness(t, 'I finished the change, but forgot the report block.')
    const run = executor(h)
    run.start(t, t.assignments[0]!)
    await run.idle()
    expect(h.engine.reports.at(-1)?.[1]).toMatchObject({ state: 'blocked' })
    expect(h.engine.reports.at(-1)?.[1].summary).toContain('psa-report 解析失败')
  })

  it('ignores a report bound to an older assignment instead of overwriting the running one', async () => {
    const t = ticket()
    const h = harness(t, `done\n\`\`\`psa-report\n${JSON.stringify({ schema_version: 1, report_id: 'r-old', ticket_id: 't1',
      assignment_id: 'a0', state: 'ready', summary: 'old run' })}\n\`\`\``)
    const run = executor(h)
    run.start(t, t.assignments[0]!)
    await run.idle()
    expect(h.engine.reports).toEqual([])
  })

  it('blocks a contradictory report rather than repairing it', async () => {
    const t = ticket()
    const h = harness(t, { state: 'ready', summary: 'done', question: 'but also a question' } as WorkerReport)
    const run = executor(h)
    run.start(t, t.assignments[0]!)
    await run.idle()
    expect(h.engine.reports.at(-1)?.[1]).toMatchObject({ state: 'blocked' })
    expect(h.engine.reports.at(-1)?.[1].summary).toContain('ready 报告不能带 question')
  })

  it('keeps following the thread after a waiting report, relays the final ready report, and binds its PR', async () => {
    const t = ticket()
    const waiting = { schema_version: 1, report_id: 'r-wait', ticket_id: 't1', assignment_id: 'a1', state: 'waiting',
      summary: '等 CI：PR #120 https://github.com/Javey-Li/FretSense/pull/120 的检查还在 pending。' }
    const ready = { schema_version: 1, report_id: 'r-ready', ticket_id: 't1', assignment_id: 'a1', state: 'ready',
      summary: '改好了，CI 全绿。PR：https://github.com/Javey-Li/FretSense/pull/120' }
    const waitingText = `work\n\`\`\`psa-report\n${JSON.stringify(waiting)}\n\`\`\``
    const readyText = `work\n\`\`\`psa-report\n${JSON.stringify(ready)}\n\`\`\``
    let latest: string | null = 'run-1'
    const h = harness(t)
    const mcp = fakeMcp({
      t3_project_list: () => ({ projects: [{ id: 'p1', title: 'repo', workspaceRoot: '/repo' }], nextCursor: null }),
      t3_thread_launch: () => ({ threadId: 'thread-1', runId: 'run-1', status: 'running' }),
      t3_thread_wait: args => ({ threadId: args.threadId, runId: args.runId, status: 'completed', timedOut: false }),
      t3_thread_read: args => {
        const thread = { threadId: args.threadId, status: 'idle', pendingRequestCount: 0, latestRunId: latest }
        if (args.view === 'activity') return { thread, items: [], recentRuns: [], nextPosition: null, hasMore: false }
        const items = latest === 'run-2'
          ? [{ itemId: 'm1', type: 'assistant_message', runId: 'run-1', text: waitingText, textTruncated: false, nextTextOffset: null },
            { itemId: 'm2', type: 'assistant_message', runId: 'run-2', text: readyText, textTruncated: false, nextTextOffset: null }]
          : [{ itemId: 'm1', type: 'assistant_message', runId: 'run-1', text: waitingText, textTruncated: false, nextTextOffset: null }]
        return { thread, items, recentRuns: [], nextPosition: null, hasMore: false }
      },
    })
    const bound: [string, { source: string; id: string }, boolean][] = []
    const pull = { number: 120, state: 'open', html_url: 'https://github.com/Javey-Li/FretSense/pull/120',
      user: { login: 'agent', type: 'User' }, body: null, created_at: AT, merged: false, merged_at: null, closed_at: null,
      auto_merge: null, head: { sha: 'c0ffee', ref: 'agent/fix', repo: { full_name: 'Javey-Li/FretSense' } } }
    const github = {
      deployment: { repository: 'Javey-Li/FretSense', github: { cli: 'gh', login: 'agent', noreply: 'agent@users.noreply.github.com' } },
      commands: { withSignal: () => ({ api: async (_schema: unknown, _path: string) => pull }) },
      ready: Promise.resolve(), configured: () => true, config: () => undefined,
      receive: () => ({}), atomic: <T>(work: () => T) => work(),
      state: { get: () => undefined, set: () => {}, keys: () => [] },
      threads: { get: () => undefined, subscribed: () => [], describe: () => {}, patch: vi.fn() },
      tickets: {
        get: (id: string) => h.repo.tickets.get(id),
        open: () => h.repo.tickets.open(),
        bindThread: (id: string, thread: { source: string; id: string }, own: boolean) => {
          bound.push([id, thread, own])
          const current = h.repo.tickets.get(id)!
          const key = `${thread.source}:${thread.id}`
          const follow = current.follows?.find(item => item.thread === key)
          const follows = follow
            ? current.follows!.map(item => item.thread === key ? { ...item, own: item.own || own, closed: undefined } : item)
            : [...(current.follows ?? []), { thread: key, own }]
          h.repo.tickets.save({ ...current, follows })
        },
        threadClosed: vi.fn(),
      },
      triggers: { get: (id: string) => h.repo.triggers.get(id), latest: () => undefined },
      notify: vi.fn(), report: vi.fn(),
    }
    const run = new T3Executor({ ...h.host, github: () => github as unknown as SourceContext },
      { project: '/repo', mcpUrl: 'http://t3/mcp', mcpToken: 'token', fetchImpl: mcp.fetchImpl,
        ledgerPath: join(h.dir, 'ledger.json'), verifyIdentity: false, mcpRetryMs: 0, timeouts: { followPoll: 10 } })
    run.start(t, t.assignments[0]!)
    await vi.waitFor(() => expect(h.engine.reports.some(item => item[1].state === 'waiting')).toBe(true))
    // The PR watch wakes the same thread with a new run, which finishes and reports ready.
    latest = 'run-2'
    await run.idle()
    expect(h.engine.reports.map(item => item[1].state)).toEqual(['waiting', 'ready'])
    expect(h.engine.reports.at(-1)?.[1]).toMatchObject({ state: 'ready', summary: ready.summary })
    expect(bound).toEqual([['t1', { source: 'github', id: '120' }, true]])
    expect(h.engine.turns).toEqual([['t1', 'a1'], ['t1', 'a1']])
  })

  it('resumes following a waiting thread after a host restart and relays its final report', async () => {
    const t = ticket()
    t.assignments[0] = { ...t.assignments[0]!, state: 'running',
      report: { state: 'waiting', summary: 'T3 thread thread-1 is waiting for an external event; the executor keeps following the thread for its next run.', at: AT } }
    const h = harness(t)
    writeFileSync(join(h.dir, 'ledger.json'), JSON.stringify({ version: 1, entries: {},
      threads: { t1: { threadId: 'thread-1', project: '/repo' } } }))
    const mcp = fakeMcp({
      t3_thread_wait: args => ({ threadId: args.threadId, runId: args.runId, status: 'completed', timedOut: false }),
      t3_thread_read: args => ({ thread: { threadId: args.threadId, status: 'idle', pendingRequestCount: 0, latestRunId: 'run-2' },
        items: [{ itemId: 'm2', type: 'assistant_message', runId: 'run-2',
          text: '```psa-report\n' + JSON.stringify({ schema_version: 1, report_id: 'r-ready', ticket_id: 't1', assignment_id: 'a1',
            state: 'ready', summary: 'done after the watch' }) + '\n```', textTruncated: false, nextTextOffset: null }],
        recentRuns: [], nextPosition: null, hasMore: false }),
    })
    const run = executor(h, { fetchImpl: mcp.fetchImpl })
    run.resume()
    await run.idle()
    expect(h.engine.reports.at(-1)?.[1]).toMatchObject({ state: 'ready', summary: 'done after the watch' })
  })

  it('re-waits the same run when a pending input ended the wait, then relays its final report', async () => {
    const t = ticket()
    const h = harness(t)
    let waits = 0
    const mcp = fakeMcp({
      t3_project_list: () => ({ projects: [{ id: 'p1', title: 'repo', workspaceRoot: '/repo' }], nextCursor: null }),
      t3_thread_launch: () => ({ threadId: 'thread-1', runId: 'run-1', status: 'running' }),
      t3_thread_wait: () => { waits += 1; return waits === 1
        ? { status: 'running', timedOut: true } : { status: 'completed', timedOut: false, runId: 'run-1' } },
      t3_thread_read: args => {
        const thread = { threadId: args.threadId, status: 'running', pendingRequestCount: 1 }
        if (args.view === 'activity') return { thread, items: [], recentRuns: [], nextPosition: null, hasMore: false }
        return { thread, items: [{ itemId: 'm1', type: 'assistant_message', runId: 'run-1',
          text: '```psa-report\n' + JSON.stringify({ schema_version: 1, report_id: 'r-approved', ticket_id: 't1',
            assignment_id: 'a1', state: 'ready', summary: 'approved and done' }) + '\n```',
          textTruncated: false, nextTextOffset: null }], recentRuns: [], nextPosition: null, hasMore: false }
      },
    })
    const run = executor(h, { fetchImpl: mcp.fetchImpl })
    run.start(t, t.assignments[0]!)
    await run.idle()
    expect(h.engine.reports.map(item => item[1].state)).toEqual(['waiting', 'ready'])
    expect(h.engine.reports.at(-1)?.[1]).toMatchObject({ state: 'ready', summary: 'approved and done' })
  })

  it('clears a stale fabricated waiting question on resume so the ticket shows its true stage', () => {
    const t = ticket()
    t.assignments[0] = { ...t.assignments[0]!, state: 'pending',
      report: { state: 'failed', summary: 'T3_MCP_REQUIRED_FOR_WORKTREE: the CLI would launch in the project root', at: AT } }
    t.attention = { id: 'att1', question: 'Answer the T3 thread question, then send a message to this Ticket to continue.' }
    const h = harness(t)
    const run = executor(h)
    run.resume()
    expect(h.engine.reports.at(-1)?.[1]).toMatchObject({ state: 'failed', question: null })
  })

  it('archives a failed ticket with no new input for 24 hours as dropped', () => {
    const t = ticket()
    t.assignments[0] = { ...t.assignments[0]!, state: 'pending',
      report: { state: 'failed', summary: 'T3_MCP_UNAVAILABLE: T3 MCP is unreachable',
        at: new Date(Date.now() - 25 * 3_600_000).toISOString() } }
    const h = harness(t)
    const run = executor(h)
    run.resume()
    expect(h.engine.reports.at(-1)?.[1]).toMatchObject({ state: 'dropped' })
    expect(h.engine.reports.at(-1)?.[1].summary).toContain('已过去')
  })

  it('leaves failures alone when fresh, attended, running, answered by new input, or not failed', () => {
    const failed = { state: 'failed' as const, summary: 'T3_MCP_UNAVAILABLE: unreachable', at: '' }
    const stale = new Date(Date.now() - 25 * 3_600_000).toISOString()
    const fresh = new Date(Date.now() - 3_600_000).toISOString()
    const base = ticket()
    base.assignments[0] = { ...base.assignments[0]!, state: 'pending', report: { ...failed, at: fresh } }
    const h = harness(base)
    const save = (t: Ticket) => h.repo.tickets.save(t)
    const freshFailure = ticket()
    freshFailure.id = 't-fresh'; freshFailure.assignments[0] = { ...freshFailure.assignments[0]!, state: 'pending',
      report: { ...failed, at: fresh } }
    save(freshFailure)
    const attended = ticket()
    attended.id = 't-attended'; attended.assignments[0] = { ...attended.assignments[0]!, state: 'pending',
      report: { ...failed, at: stale } }
    attended.attention = { id: 'att1', question: 'which key?' }
    save(attended)
    const running = ticket()
    running.id = 't-running'; running.assignments[0] = { ...running.assignments[0]!, state: 'running',
      report: { ...failed, at: stale } }
    save(running)
    const answered = ticket()
    answered.id = 't-answered'; answered.assignments[0] = { ...answered.assignments[0]!, state: 'pending',
      report: { ...failed, at: stale } }
    answered.inputs.push({ id: 'i1', kind: 'trigger', triggerId: 'tr2', at: fresh })
    save(answered)
    const blocked = ticket()
    blocked.id = 't-blocked'; blocked.assignments[0] = { ...blocked.assignments[0]!, state: 'pending',
      report: { state: 'blocked', summary: 'T3 run is still running after the limit', at: stale } }
    save(blocked)
    const run = executor(h)
    run.resume()
    expect(h.engine.reports).toEqual([])
  })
})

describe('psa-report parser', () => {
  const report = (overrides: Record<string, unknown> = {}) => JSON.stringify({ schema_version: 1, report_id: 'r1', ticket_id: 't1', assignment_id: 'a1',
    state: 'ready', summary: 'ok', ...overrides })
  it('reads the last fenced block, a PSA_REPORT line, and a bare JSON object', () => {
    expect(parsePsaReport(`work\n\`\`\`psa-report\n${report()}\n\`\`\`\n`)).toMatchObject({ state: 'ready', summary: 'ok' })
    expect(parsePsaReport(`work\nPSA_REPORT: ${report({ state: 'blocked', summary: 'need a key', question: 'which key?' })}`))
      .toMatchObject({ state: 'blocked', summary: 'need a key', question: 'which key?' })
    expect(parsePsaReport(report({ state: 'dropped', summary: 'nothing to do' }))).toMatchObject({ state: 'dropped', summary: 'nothing to do' })
  })

  it('rejects a report without the schema version or binding fields, unknown states, and unknown fields', () => {
    expect(parsePsaReport('```psa-report\n{"state":"done","summary":"x"}\n```')).toBeUndefined()
    expect(parsePsaReport(`\`\`\`psa-report\n${report({ schema_version: 2 })}\n\`\`\``)).toBeUndefined()
    expect(parsePsaReport(`\`\`\`psa-report\n${report({ ticket_id: undefined })}\n\`\`\``)).toBeUndefined()
    expect(parsePsaReport(`\`\`\`psa-report\n${report({ surprise: true })}\n\`\`\``)).toBeUndefined()
    expect(parsePsaReport('plain prose')).toBeUndefined()
  })
})

