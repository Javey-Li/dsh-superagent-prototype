/** Routes each Assignment to the write line (T3) or the read line (DSH worker), with an independent quota per line. */
import type { AssessmentOutcome, Assignment, Ticket } from '../core/index.ts'
import { workLine, type WorkLine } from '../core/index.ts'
import type { ExecutorRuntime } from './backend.ts'

/** Each instance may run at most two T3 write Assignments; further write work waits in `pending`. */
export const WRITE_LIMIT = 2

/**
 * The Executor Runtime selects when both lines run: Mandates with `line: 'write'` go to T3, and all others go to the
 * DSH worker. The two backends queue and count independently, so a full read line never blocks a write slot and vice versa.
 * Write quotas are enforced by the T3 backend's `maxWorkers`, which Runtime sets to {@link WRITE_LIMIT}.
 */
export class CompositeExecutor implements ExecutorRuntime {
  constructor(private readonly write: ExecutorRuntime, private readonly read: ExecutorRuntime) {}

  /** Populate execution metadata with the backend for the accepted line. Both backends produce the same ticket metadata. */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return this.backend(outcome.line ?? workLine(ticket.mandate)).prepare(ticket, outcome)
  }

  install(): void { this.write.install(); this.read.install() }

  resume(): void { this.write.resume(); this.read.resume() }

  start(ticket: Ticket, assignment: Assignment): void { this.backend(workLine(ticket.mandate)).start(ticket, assignment) }

  deliver(ticket: Ticket, assignment: Assignment): void { this.backend(workLine(ticket.mandate)).deliver(ticket, assignment) }

  stop(ticket: Ticket, assignment: Assignment, reason: string): void { this.backend(workLine(ticket.mandate)).stop(ticket, assignment, reason) }

  async shutdown(): Promise<void> { await Promise.allSettled([this.write.shutdown(), this.read.shutdown()]) }

  dispose(): void { this.write.dispose(); this.read.dispose() }

  /** Assignments running on both lines, for the overview's load. */
  activeCount(): number { return this.write.activeCount() + this.read.activeCount() }

  private backend(line: WorkLine): ExecutorRuntime { return line === 'write' ? this.write : this.read }
}
