/**
 * F16 live proof: a human requirement that arrives while a real T3 worker runs survives nine newer CI/review signals,
 * a host restart over the same state directory, and a second Assignment in the same T3 thread.
 *
 * Skipped unless `F16_E2E=1`. It talks to a real T3 Code MCP endpoint with the real `T3McpClient` (no `fetchImpl`, no fake
 * MCP), launches the real worker model `magpie-codex / auto/dfmodel`, and reads the worker's own `psa-report` from the T3
 * thread it ran in. The test never calls `orchestrator_report` and never writes a report itself.
 *
 * Required environment:
 * - `F16_T3_PROJECT`: the T3 Code project to launch the thread in (project id or registered workspace root).
 * - `T3_MCP_URL` (default `http://127.0.0.1:3773/mcp`) and `T3_MCP_TOKEN` when the endpoint requires one.
 * Optional: `F16_WORKTREE_BASE` (repository the temporary worktree is created from, default the current directory).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ticketContextPackage, renderTicketContext } from '../../src/app/context-package.ts'
import type { Store } from '../../src/app/store.ts'
import { runningAssignment, type Ticket } from '../../src/core/index.ts'
import { T3McpClient, T3_DEFAULT_MCP_URL, T3_DEFAULT_MODEL, T3_DEFAULT_PROVIDER, parsePsaReport } from '../../src/executor/t3.ts'
import { feishu, startRuntime, type Host } from '../fixtures/host.ts'

const LIVE = process.env.F16_E2E === '1'
const MARKER = 'F16-MID-7f3a'
const GATE = '.f16-gate'
const ROOT_TRIGGER = 'om_1'
const TIMEOUT_MS = 300_000

type LiveTrigger = ReturnType<typeof feishu>
const signalTrigger = (id: string, text: string, meta: Record<string, unknown>): LiveTrigger => {
  const base = feishu(id, text, { root_id: ROOT_TRIGGER, mentions: [] })
  // CI is not a person; a review comment is.
  return { ...base, human: meta.ci !== true, meta: { ...base.meta, ...meta } }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor<T>(label: string, read: () => T | undefined, timeoutMs = TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`F16-E2E blocked: timed out after ${timeoutMs}ms waiting for ${label}`)
    await sleep(2_000)
  }
}
async function waitForAsync<T>(label: string, read: () => Promise<T | undefined>, timeoutMs = TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`F16-E2E blocked: timed out after ${timeoutMs}ms waiting for ${label}`)
    await sleep(2_000)
  }
}

/** The Ticket context payload the executor embeds in an Assignment message. */
function payloadOf(message: string): { ticket_id?: string; assignment_id?: string; assignment_number?: number; context?: string } {
  const match = /```json\n([\s\S]*?)\n```/.exec(message)
  if (!match) throw new Error('F16-E2E: the Assignment message carries no Ticket context payload')
  return JSON.parse(match[1]!) as { ticket_id?: string; assignment_id?: string; assignment_number?: number; context?: string }
}

/** The `psa-report` a real T3 thread's assistant message carries, when it names this Ticket and Assignment as ready. */
async function threadReadyReport(client: T3McpClient, threadId: string, ticketId: string, assignmentId: string): Promise<string> {
  return await waitForAsync(`a ready psa-report from T3 thread ${threadId} for ${assignmentId}`, async () => {
    const read = await client.callTool('t3_thread_read', { threadId, view: 'messages', limit: 100, runLimit: 20, maxCharsPerItem: 50_000 })
    const items = Array.isArray(read.items) ? read.items as { type?: string; text?: string }[] : []
    for (const item of items) {
      if (item.type !== 'assistant_message' || typeof item.text !== 'string') continue
      const report = parsePsaReport(item.text)
      if (report && report.ticket_id === ticketId && report.assignment_id === assignmentId && report.state === 'ready') {
        return item.text
      }
    }
    return undefined
  })
}

describe.skipIf(!LIVE)('F16 live: a mid-work human requirement survives a real T3 restart', () => {
  it('keeps F16-MID in the Ticket context and the worker after restart, in the same T3 thread', async () => {
    const mcpUrl = process.env.T3_MCP_URL || T3_DEFAULT_MCP_URL
    const token = process.env.T3_MCP_TOKEN || process.env.T3_MCP_ACCESS_TOKEN || null
    const project = process.env.F16_T3_PROJECT
    if (!project) throw new Error('F16-E2E blocked: set F16_T3_PROJECT to the T3 Code project (id or workspace root)')

    const client = new T3McpClient({ url: mcpUrl, token, connectTimeoutMs: 10_000, callTimeoutMs: 10_000 })
    try {
      await client.connect()
    } catch (error) {
      throw new Error(`F16-E2E blocked: T3 MCP at ${mcpUrl} is unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }

    const stateDir = mkdtempSync(join(tmpdir(), 'f16-e2e-'))
    const workRoot = join(stateDir, 'work')
    const base = process.env.F16_WORKTREE_BASE || process.cwd()
    // A real worktree for the Ticket, created by the product's own prepare hook before the first T3 launch.
    const prepare = `rm -rf "$DSH_SUPERAGENT_DIR"; git -C ${JSON.stringify(base)} worktree prune >/dev/null 2>&1; `
      + `git -C ${JSON.stringify(base)} worktree add --detach "$DSH_SUPERAGENT_DIR" HEAD`
    const seed = (store: Store) => {
      const settings = store.settings()
      store.saveSettings({ ...settings, executor: { ...settings.executor, backend: 't3', directory: workRoot, prepare,
        t3: { ...settings.executor.t3, project, provider: T3_DEFAULT_PROVIDER, model: T3_DEFAULT_MODEL } } })
    }

    // Record what the real client actually sent; the calls still go to the real MCP endpoint.
    const calls: { name: string; args: Record<string, any> }[] = []
    const originalCallTool = T3McpClient.prototype.callTool
    const observe = () => vi.spyOn(T3McpClient.prototype, 'callTool').mockImplementation(function (
      this: T3McpClient, name: string, args: Record<string, any> = {}, options: { timeoutMs?: number } = {}) {
      calls.push({ name, args })
      return originalCallTool.call(this, name, args, options)
    })
    observe()

    let host: Host | undefined
    let ticketId = ''
    try {
      host = await startRuntime(seed, { stateDir })
      expect(host.runtime.store.settings().executor.backend).toBe('t3')
      const origin = feishu('1', `@bot 在工单目录创建 initial.txt（内容 F16-initial），然后等待 ${GATE} 文件出现；`
        + `${GATE} 出现后创建 result.txt（内容 F16-result），最后按协议报告 ready。`)
      const created = await host.acceptedTicket(origin)
      ticketId = created.ticket.id
      const ticket = (): Ticket => host!.runtime.store.tickets.get(ticketId)!
      expect(ticket().id).toBe(ticketId)
      const directory = ticket().execution!.directory
      expect(directory).toContain(workRoot)

      // The real worker must be running before the requirement arrives: it wrote initial.txt and now waits for the gate.
      await waitFor('the real T3 worker to write initial.txt', () => existsSync(join(directory, 'initial.txt')) || undefined)
      expect(readFileSync(join(directory, 'initial.txt'), 'utf8')).toContain('F16-initial')

      // The requirement arrives mid-run. It must ask for result.txt after the gate so the worker keeps running past it.
      const runningBeforeMid = runningAssignment(ticket())
      expect(runningBeforeMid?.state).toBe('running')
      const firstAssignmentId = runningBeforeMid!.id
      const mid = feishu('2', `${MARKER}: gate 打开后请把 result.txt 写成 F16-result，然后报告 ready。`, { root_id: ROOT_TRIGGER, mentions: [] })
      host.runtime.receive(mid)
      await host.runtime.idle()
      // The requirement reached the running Assignment itself, not only the stored Ticket context.
      const midSend = await waitFor('the mid requirement to reach the running T3 Assignment',
        () => calls.find(call => call.name === 't3_thread_send' && String(call.args.message ?? '').includes(MARKER)) ?? undefined)
      expect(midSend.args.threadId).toBeTruthy()

      // Nine newer CI/review signals: the old eight-signal window would push the requirement out.
      const CI_REVIEWS = 9
      for (let index = 0; index < CI_REVIEWS; index += 1) {
        const id = String(10 + index)
        host.runtime.receive(index % 2 === 0
          ? signalTrigger(id, `CI check f16-${index} passed`, { ci: true })
          : signalTrigger(id, `Review comment f16-${index}`, { kind: 'review' }))
      }
      await host.runtime.idle()
      expect(ticket().inputs.filter(input => input.kind === 'trigger')).toHaveLength(1 + CI_REVIEWS)

      // The window the requirement competes with: 8 shown signals, all CI/review, the requirement kept apart.
      const beforeRestart = ticketContextPackage(host.runtime.store, ticket())
      expect(beforeRestart.signals).toHaveLength(8)
      expect(beforeRestart.signals.every(signal => signal.kind === 'ci' || signal.kind === 'review')).toBe(true)
      expect(beforeRestart.signals.some(signal => signal.kind === 'requirement')).toBe(false)
      expect(beforeRestart.requirements?.map(requirement => requirement.triggerId)).toEqual([mid.id])
      expect(beforeRestart.budget.omitted).toBeGreaterThan(0)
      const beforeRestartText = renderTicketContext(beforeRestart)
      expect(beforeRestartText.indexOf('Recent signals')).toBeGreaterThan(beforeRestartText.indexOf('Human requirements'))

      // Only now let the worker finish the first Assignment.
      writeFileSync(join(directory, GATE), 'open\n')
      await waitFor('the first ready report',
        () => ticket().assignments.find(item => item.id === firstAssignmentId)?.report?.state === 'ready' ? true : undefined)
      expect(ticket().ended?.outcome).toBe('completed')
      expect(existsSync(join(directory, 'result.txt'))).toBe(true)
      const first = ticket().assignments.find(item => item.id === firstAssignmentId)!
      const threadBefore = JSON.parse(readFileSync(join(stateDir, 't3-threads.json'), 'utf8')) as { threads: Record<string, { threadId: string }> }
      const threadId = threadBefore.threads[ticketId]?.threadId
      expect(threadId).toBeTruthy()
      const firstReportText = await threadReadyReport(client, threadId!, ticketId, first.id)
      expect(firstReportText).toContain('psa-report')

      const launchCall = calls.find(call => call.name === 't3_thread_launch' && call.args.clientRequestId === first.id)
      expect(launchCall, 'the first Assignment must launch over MCP').toBeTruthy()
      expect(launchCall?.args.modelSelection).toEqual({ instanceId: T3_DEFAULT_PROVIDER, model: T3_DEFAULT_MODEL })
      expect((launchCall?.args.workspaceStrategy as { worktreePath?: string } | undefined)?.worktreePath).toBe(directory)
      const firstNumber = payloadOf(String(launchCall?.args.message ?? '')).assignment_number
      expect(firstNumber).toBe(1)

      // Stop the whole Runtime but keep the SQLite state, the worktree, and t3-threads.json.
      await host.stop({ keepDirectory: true })
      host = await startRuntime(seed, { stateDir })
      observe()
      expect(host.runtime.store.tickets.list()).toHaveLength(1)
      expect(host.runtime.store.tickets.get(ticketId)!.id).toBe(ticketId)

      // A person's message on the same external thread resumes the ended Ticket into a second Assignment.
      const followup = feishu('3', `继续这个工单：读取本 Ticket context 的 Human requirements，把 ${MARKER} 写入 after-restart.txt，`
        + '然后按协议报告 ready。', { root_id: ROOT_TRIGGER, mentions: [] })
      expect(host.runtime.receive(followup)).toBe('stored')
      await host.runtime.idle()
      await waitFor('the second Assignment', () => host!.runtime.store.tickets.get(ticketId)!.assignments.length === 2 ? true : undefined)
      const resumed = host.runtime.store.tickets.get(ticketId)!
      expect(resumed.assignments).toHaveLength(2)
      const second = await waitFor('the second Assignment to run',
        () => runningAssignment(host!.runtime.store.tickets.get(ticketId)!) ?? undefined)
      await waitFor('the second ready report',
        () => host!.runtime.store.tickets.get(ticketId)!.assignments.find(item => item.id === second.id)?.report?.state === 'ready'
          ? true : undefined)
      expect(host.runtime.store.tickets.get(ticketId)!.ended?.outcome).toBe('completed')

      const afterRestart = join(directory, 'after-restart.txt')
      await waitFor('the worker to write after-restart.txt', () => existsSync(afterRestart) || undefined)
      const afterText = readFileSync(afterRestart, 'utf8')
      expect(afterText).toContain(MARKER)

      const secondReportText = await threadReadyReport(client, threadId!, ticketId, second.id)
      expect(secondReportText).toContain('psa-report')
      const threadAfter = JSON.parse(readFileSync(join(stateDir, 't3-threads.json'), 'utf8')) as { threads: Record<string, { threadId: string }> }
      const threadIdAfter = threadAfter.threads[ticketId]?.threadId

      const secondAssignmentMessage = calls.filter(call => call.name === 't3_thread_send')
        .map(call => String(call.args.message ?? ''))
        .find(message => message.includes(`"assignment_id": "${second.id}"`))
      expect(secondAssignmentMessage, 'the second Assignment message must reach the same T3 thread').toBeTruthy()
      expect(secondAssignmentMessage).toContain(`"assignment_number": 2`)
      const sentTo = calls.filter(call => call.name === 't3_thread_send'
        && String(call.args.message ?? '').includes(`"assignment_id": "${second.id}"`)).map(call => call.args.threadId)
      expect(sentTo).toEqual([threadId])

      const payload = payloadOf(secondAssignmentMessage!)
      expect(payload.ticket_id).toBe(ticketId)
      expect(payload.assignment_id).toBe(second.id)
      expect(payload.assignment_number).toBe(2)
      const secondNumber = payload.assignment_number
      expect(host.runtime.store.tickets.get(ticketId)!.assignments).toHaveLength(2)
      const rendered = payload.context ?? ''
      expect(rendered).toContain('Human requirements')
      expect(rendered).toContain(MARKER)
      expect(rendered).toContain(`trigger/${mid.id}`)
      expect(rendered.indexOf('Human requirements')).toBeGreaterThan(-1)
      expect(rendered.indexOf('Recent signals')).toBeGreaterThan(rendered.indexOf('Human requirements'))
      expect(rendered).toContain('older omitted')
      const signalBlock = rendered.slice(rendered.indexOf('Recent signals'), rendered.indexOf('Recall on demand'))
      const signalLines = signalBlock.split('\n').filter(line => line.startsWith('- '))
      expect(signalLines).toHaveLength(8)
      expect(signalLines.every(line => /^- \S+ (ci|review|status)\b/.test(line))).toBe(true)
      expect(signalLines.some(line => /^- \S+ requirement\b/.test(line))).toBe(false)

      const stored = host.runtime.store.tickets.get(ticketId)!
      const pkg = ticketContextPackage(host.runtime.store, stored)
      expect(pkg.signals).toHaveLength(8)
      expect(pkg.signals.some(signal => signal.kind === 'requirement')).toBe(false)
      expect(pkg.requirements?.map(requirement => requirement.triggerId)).toEqual([followup.id, mid.id])
      expect(pkg.budget.omitted).toBeGreaterThan(0)

      const evidence = {
        ticket_same: host.runtime.store.tickets.list().length === 1 && stored.id === ticketId,
        t3_thread_same: Boolean(threadId) && threadIdAfter === threadId,
        assignment_numbers: [firstNumber, secondNumber],
        mid_requirement_after_restart: rendered.includes(MARKER) && afterText.includes(MARKER),
        signals_count: beforeRestart.signals.length,
        requirement_before_signals: rendered.indexOf('Human requirements') > -1
          && rendered.indexOf('Recent signals') > rendered.indexOf('Human requirements'),
        worker_file_contains_marker: afterText.includes(MARKER),
        real_t3_ready_report: firstReportText.includes('psa-report') && secondReportText.includes('psa-report'),
      }
      console.log(`F16_E2E_EVIDENCE ${JSON.stringify(evidence)}`)
      console.log(`F16_E2E_DETAIL ${JSON.stringify({ ticket_id: ticketId, t3_thread_id: threadId, first_assignment: first.id,
        second_assignment: second.id, mid_trigger: mid.id, worktree: directory })}`)

      expect(evidence).toEqual({ ticket_same: true, t3_thread_same: true, assignment_numbers: [1, 2],
        mid_requirement_after_restart: true, signals_count: 8, requirement_before_signals: true,
        worker_file_contains_marker: true, real_t3_ready_report: true })
    } finally {
      const keep = process.env.F16_E2E_KEEP === '1'
      await host?.stop({ keepDirectory: keep }).catch(() => undefined)
      if (!keep) {
        rmSync(stateDir, { recursive: true, force: true })
        try { execFileSync('git', ['-C', base, 'worktree', 'prune'], { stdio: 'ignore' }) } catch { /* Best effort. */ }
      }
    }
  }, 600_000)
})
