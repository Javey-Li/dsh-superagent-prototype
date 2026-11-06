/** The lifecycle a selected executor backend exposes to Runtime, beyond the core Executor port. */
import type { AssessmentOutcome, Executor, Ticket } from '../core/index.ts'

/**
 * An executor that Runtime can prepare, start, resume, stop, and dispose.
 * Runtime selects one backend at startup: the in-process DSH worker, a T3 Code thread, or a composite that routes each
 * Ticket by its Mandate line.
 */
export interface ExecutorRuntime extends Executor {
  /** Populate a newly accepted ticket's execution metadata before the Engine stores it. */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket
  /** Subscribe to host events, when the backend needs them. */
  install(): void
  /** Reconcile open tickets after a host restart. */
  resume(): void
  /** Stop work within the host's shutdown budget. */
  shutdown(): Promise<void>
  /** Release listeners and timers. */
  dispose(): void
  /** How many assignments currently run, for the overview's load. */
  activeCount(): number
}
