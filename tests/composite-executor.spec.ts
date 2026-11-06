import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRepositories } from '../src/core/index.ts'
import type { Assignment, EngineForExecutor, Ticket, Trigger, WorkerReport } from '../src/core/index.ts'
import { SettingsSchema } from '../src/policy.ts'
import { CompositeExecutor, WRITE_LIMIT } from '../src/executor/composite.ts'
import type { ExecutorRuntime } from '../src/executor/backend.ts'
import { T3Executor } from '../src/executor/t3.ts'

const AT = '2026-11-07T00:00:00.000Z'
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const tempDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'dsh-composite-')); dirs.push(dir); return dir }

const trigger = (id: string): Trigger => ({ id, source: 'github', threads: [{ source: 'github', id: '1' }], actor: { source: 'github', id: 'alice' },
  human: true, at: AT, text: `request ${id}`, meta: {} })

function ticket(id: string, line: 'read' | 'write' | undefined, assignmentId: string): Ticket {
  const assignment: Assignment = { id: assignmentId, state: 'pending', createdAt: AT }
  return { id, title: `Ticket ${id}`, decisionId: `d-${id}`,
    mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'github', id: 'alice' },
      scope: 'small', ...(line ? { line } : {}) },
    channels: [], assignments: [assignment], inputs: [], undelivered: [], createdAt: AT, updatedAt: AT,
    origin: { triggerId: 'tr1', triggerIds: ['tr1'] },
    execution: { name: `work-${id}`, directory: `/repo/worktrees/${id}`, assignment: 'do the work' } }
}

/** A stand-in backend that records the lifecycle calls CompositeExecutor routes to it. */
class Recorder implements ExecutorRuntime {
  started: string[] = []
  delivered: string[] = []
  stopped: string[] = []
  running = 0
  prepare(ticket: Ticket): Ticket { return ticket }
  install(): void {}
  resume(): void {}
  async shutdown(): Promise<void> {}
  dispose(): void {}
  activeCount(): number { return this.running }
  start(ticket: Ticket): void { this.started.push(ticket.id); this.running += 1 }
  deliver(ticket: Ticket): void { this.delivered.push(ticket.id) }
  stop(ticket: Ticket): void { this.stopped.push(ticket.id); this.running = Math.max(0, this.running - 1) }
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } })
}

function fakeMcp() {
  const calls: Record<string, any>[] = []
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const payload = JSON.parse(String(init.body)) as Record<string, any>
    calls.push(payload)
    if (payload.method === 'initialize') return response({ jsonrpc: '2.0', id: payload.id,
      result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 't3', version: '1' } } })
    if (payload.method === 'notifications/initialized') return response({})
    if (payload.method === 'tools/call') {
      const name = payload.params.name as string
      const args = payload.params.arguments as Record<string, any>
      if (name === 't3_project_list') return response({ jsonrpc: '2.0', id: payload.id,
        result: { projects: [{ id: 'p1', workspaceRoot: '/repo' }], nextCursor: null } })
      if (name === 't3_thread_launch') return response({ jsonrpc: '2.0', id: payload.id,
        result: { threadId: `thread-${args.clientRequestId}`, runId: `run-${args.clientRequestId}`, status: 'running' } })
      if (name === 't3_thread_send') return response({ jsonrpc: '2.0', id: payload.id,
        result: { threadId: args.threadId, runId: `run-${args.threadId}-next`, status: 'running' } })
      if (name === 't3_thread_wait') return response({ jsonrpc: '2.0', id: payload.id,
        result: { threadId: args.threadId, runId: args.runId, status: 'running', timedOut: true } })
      if (name === 't3_thread_read') return response({ jsonrpc: '2.0', id: payload.id,
        result: { thread: { threadId: args.threadId, status: 'running', pendingRequestCount: 0 }, items: [] } })
      if (name === 't3_thread_interrupt') return response({ jsonrpc: '2.0', id: payload.id, result: { threadId: args.threadId } })
      return response({ jsonrpc: '2.0', id: payload.id, result: { isError: true, content: [{ type: 'text', text: `unknown ${name}` }] } })
    }
    return response({})
  }) as typeof fetch
  return { fetchImpl, calls }
}

function t3Harness(tickets: Ticket[]) {
  const dir = tempDir()
  const repo = new MemoryRepositories()
  for (const item of tickets) repo.tickets.save(item)
  repo.triggers.save(trigger('tr1'))
  const started: [string, string][] = [], reports: [string, WorkerReport][] = []
  const api: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'> = {
    assignmentStarted: vi.fn((ticketId: string, assignmentId: string) => {
      started.push([ticketId, assignmentId])
      const current = repo.tickets.get(ticketId)!
      const assignment = current.assignments.find(entry => entry.id === assignmentId)
      if (assignment) { assignment.state = 'running'; repo.tickets.save(current) }
    }),
    inputsDelivered: vi.fn(), inputsRead: vi.fn(), turnEnded: vi.fn(), deliveryFailed: vi.fn(),
    assignmentInterrupted: vi.fn(),
    report: vi.fn((ticketId: string, report: WorkerReport) => { reports.push([ticketId, report]); return repo.tickets.get(ticketId)! }),
  }
  const host = { engine: api, store: { tickets: repo.tickets, triggers: repo.triggers, settings: () => SettingsSchema.parse({}) },
    machine: { stateDir: dir }, lifetime: new AbortController().signal, health: undefined,
    deployment: () => ({ github: { cli: 'gh', login: 'agent', noreply: 'agent@users.noreply.github.com' }, stateDir: dir }),
    sourceLink: async () => ({}), repliedTo: () => undefined, closing: () => false }
  const mcp = fakeMcp()
  const write = new T3Executor(host, { project: '/repo', mcpUrl: 'http://t3/mcp', mcpToken: 'token', fetchImpl: mcp.fetchImpl,
    ledgerPath: join(dir, 'ledger.json'), verifyIdentity: false, mcpRetryMs: 0, maxWorkers: WRITE_LIMIT })
  return { repo, write, mcp, started, reports }
}

const launches = (calls: Record<string, any>[]) => calls.filter(call => call.params?.name === 't3_thread_launch')

describe('composite executor', () => {
  it('routes write Tickets to T3 and read Tickets to DSH, including legacy Mandates without a line', () => {
    const write = new Recorder(), read = new Recorder()
    const composite = new CompositeExecutor(write, read)
    const writeTicket = ticket('w1', 'write', 'a1')
    const readTicket = ticket('r1', 'read', 'a2')
    const legacy = ticket('l1', undefined, 'a3')

    composite.start(writeTicket, writeTicket.assignments[0]!)
    composite.start(readTicket, readTicket.assignments[0]!)
    composite.start(legacy, legacy.assignments[0]!)

    expect(write.started).toEqual(['w1'])
    expect(read.started).toEqual(['r1', 'l1'])
    expect(composite.activeCount()).toBe(3)

    composite.deliver(writeTicket, writeTicket.assignments[0]!)
    composite.deliver(readTicket, readTicket.assignments[0]!)
    composite.stop(writeTicket, writeTicket.assignments[0]!, 'done')
    composite.stop(readTicket, readTicket.assignments[0]!, 'done')
    expect(write.delivered).toEqual(['w1'])
    expect(read.delivered).toEqual(['r1'])
    expect(write.stopped).toEqual(['w1'])
    expect(read.stopped).toEqual(['r1'])
  })

  it('runs two write Assignments, queues the third, and frees a write slot on stop and retry without touching the read line', async () => {
    const tickets = [ticket('w1', 'write', 'a1'), ticket('w2', 'write', 'a2'), ticket('w3', 'write', 'a3')]
    const h = t3Harness(tickets)
    const read = new Recorder()
    const composite = new CompositeExecutor(h.write, read)
    for (const item of tickets) composite.start(item, item.assignments[0]!)

    await vi.waitFor(() => expect(h.started).toHaveLength(2))
    expect(launches(h.mcp.calls)).toHaveLength(2)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(launches(h.mcp.calls)).toHaveLength(2)

    composite.stop(tickets[0]!, tickets[0]!.assignments[0]!, 'stopped')
    await vi.waitFor(() => expect(h.started).toHaveLength(3))
    expect(h.started.map(([, assignmentId]) => assignmentId)).toEqual(['a1', 'a2', 'a3'])

    // Retry one running write ticket: its old Assignment frees the slot and its replacement takes it.
    const retried = h.repo.tickets.get('w2')!
    retried.assignments.push({ id: 'a2b', state: 'pending', createdAt: AT })
    h.repo.tickets.save(retried)
    composite.stop(retried, retried.assignments[0]!, 'retried')
    composite.start(retried, retried.assignments.at(-1)!)
    await vi.waitFor(() => expect(h.started).toHaveLength(4))
    expect(h.started.at(-1)).toEqual(['w2', 'a2b'])

    expect(read.started).toEqual([])
    composite.stop(retried, retried.assignments.at(-1)!, 'done')
    composite.stop(tickets[2]!, tickets[2]!.assignments[0]!, 'done')
    await h.write.idle()
  })
})
