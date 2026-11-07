/**
 * One-page context for a work item, with recall pointers instead of pasted history.
 *
 * The package follows claude-mem's progressive disclosure: a bounded summary that says what the ticket is, where it stands,
 * which Issue/PR/review/CI threads belong to it, and what changed recently; full text stays behind `read` pointers that the
 * agent opens only when it needs them. It is assembled from stored facts, never from a model, so it is deterministic.
 */
import { latestAssignment, latestReport, liveTicket, threadKey, ticketStage } from '../core/index.ts'
import type { Thread, Ticket, TicketInput, Trigger } from '../core/index.ts'

/** The stored facts a package reads; a Store or the in-memory repositories both satisfy it. */
export interface ContextRecords {
  tickets: { get(id: string): Ticket | undefined }
  threads: { get(key: string): Thread | undefined }
  triggers: { get(id: string): Trigger | undefined }
}

export type SignalKind = 'request' | 'requirement' | 'review' | 'ci' | 'comment' | 'policy' | 'note' | 'status'
export interface ContextSignal {
  kind: SignalKind
  at: string
  actor?: string
  human: boolean
  preview: string
  /** Resource that holds the full text; omitted when the item has none. */
  read?: string
}
export interface ContextRequirement {
  at: string
  actor: string
  triggerId: string
  preview: string
  read: string
}
export type AssociationKind = 'issue' | 'pull' | 'review' | 'ci' | 'thread'
export interface ContextAssociation {
  kind: AssociationKind
  /** GitHub number, thread key, or the source's own reference. */
  ref: string
  state: 'open' | 'closed' | 'merged' | 'unknown'
  url?: string
  /** Short latest evidence, such as a review comment or a CI conclusion. */
  latest?: string
  at?: string
  read?: string
}
export interface ContextPackage {
  schema_version: 1
  ticket: { id: string; title: string; state: 'open' | 'ended'; stage: string; outcome?: string; createdAt: string; updatedAt: string }
  mandate: { strength: string; scope: string; policyVersion: string; via?: string; rules?: string[] }
  request: { triggerId: string; actor: string; at: string; preview: string; read: string }
  progress: { assignment: number; state: string; lastReport?: { state: string; summary: string; at: string }; question?: string }
  signals: ContextSignal[]
  requirements?: ContextRequirement[]
  associations: ContextAssociation[]
  recall: { read: string; holds: string }[]
  budget: { limit: number; used: number; omitted: number }
}
export interface ContextOptions { budgetChars?: number; signals?: number; previewChars?: number }

const DEFAULT_BUDGET = 4_500
const DEFAULT_SIGNALS = 8
const PREVIEW = 180

const clip = (text: string, limit: number): string => text.replace(/\s+/g, ' ').trim().slice(0, limit)
const stageName = (ticket: Ticket): string => {
  const stage = ticketStage(ticket)
  return stage.stage === 'person' ? `person/${stage.action}` : stage.stage === 'working' ? `working${stage.action ? `/${stage.action}` : ''}` : stage.stage
}

/** Whether a human Trigger states a requirement, rather than a review, CI result, or context-only message. */
function requirementTrigger(trigger: Trigger): boolean {
  const meta = trigger.meta
  return trigger.human && meta.ci !== true && meta.kind !== 'review' && meta.kind !== 'inline'
}

/** Classify one input for the recent-signals section. Review and CI are read from the source meta the adapter stored. */
function signalOf(input: TicketInput, trigger: Trigger | undefined): ContextSignal | undefined {
  const at = input.at
  if (input.kind === 'policy-changed') return { kind: 'policy', at, human: false, preview: `Policy ${input.from} → ${input.to}` }
  if (input.kind === 'note') return { kind: 'note', at, human: false, preview: clip(input.text, PREVIEW) }
  if (input.kind === 'resumed') return { kind: 'status', at, human: true, preview: 'A person resumed this ticket' }
  if (input.kind === 'reopen') return { kind: 'status', at, human: false, preview: 'Reopened' }
  if (input.kind === 'text') return { kind: 'status', at, human: true, preview: clip(input.text, PREVIEW) }
  if (!trigger) return { kind: 'comment', at, human: false, preview: `Trigger ${input.triggerId}` }
  const meta = trigger.meta
  const kind: SignalKind = meta.ci === true ? 'ci' : meta.kind === 'review' || meta.kind === 'inline' ? 'review'
    : trigger.human && !input.context ? 'requirement' : 'comment'
  return { kind, at, actor: trigger.actor.id || undefined, human: trigger.human, preview: clip(trigger.text, PREVIEW),
    read: `trigger/${trigger.id}` }
}

/** The GitHub number a thread or trigger belongs to, if any. */
const githubNumber = (ref: string | number | undefined | null): string | undefined =>
  ref === undefined || ref === null ? undefined : String(ref)

/**
 * Build an Issue/PR association from each thread the ticket follows and each trigger it received. Reviews and CI are
 * represented as their own associations so the summary answers "did CI pass / did review comment" without rereading logs.
 */
function associationsOf(ticket: Ticket, records: ContextRecords, signals: ContextSignal[]): ContextAssociation[] {
  const found = new Map<string, ContextAssociation>()
  const triggers = [
    ...ticket.origin.triggerIds.flatMap(id => records.triggers.get(id) ? [records.triggers.get(id)!] : []),
    ...ticket.inputs.flatMap(input => input.kind === 'trigger' ? records.triggers.get(input.triggerId) ?? [] : []),
  ]
  const put = (item: ContextAssociation): void => {
    const current = found.get(`${item.kind}:${item.ref}`)
    if (!current || (item.at ?? '') >= (current.at ?? '')) found.set(`${item.kind}:${item.ref}`, item)
  }
  for (const follow of ticket.follows ?? []) {
    const number = follow.thread.startsWith('github:') ? follow.thread.slice('github:'.length) : undefined
    if (number && /^\d+$/.test(number)) put({ kind: 'pull', ref: number, state: follow.closed?.outcome ?? 'open',
      ...follow.closed ? { at: follow.closed.at } : {}, read: `thread/${follow.thread}` })
  }
  for (const trigger of triggers) {
    const meta = trigger.meta
    const number = githubNumber(meta.number as number | undefined)
    if (number) {
      const pull = meta.isPr === true
      put({ kind: pull ? 'pull' : 'issue', ref: number, state: pull && ticket.follows?.some(item => item.thread === `github:${number}` && item.closed) ? 'closed' : 'open',
        ...trigger.url ? { url: trigger.url } : {}, ...trigger.at ? { at: trigger.at } : {}, read: `thread/github:${number}` })
    }
    if (meta.ci === true) put({ kind: 'ci', ref: number ?? threadKey(trigger.threads[0]!), state: 'unknown', latest: clip(trigger.text, 200),
      at: trigger.at, read: `trigger/${trigger.id}` })
    if (meta.kind === 'review' || meta.kind === 'inline') put({ kind: 'review', ref: number ?? threadKey(trigger.threads[0]!), state: 'open',
      latest: clip(trigger.text, 200), at: trigger.at, read: `trigger/${trigger.id}` })
    if (!number && trigger.threads[0]?.source !== 'github') put({ kind: 'thread', ref: threadKey(trigger.threads[0]!), state: 'open', at: trigger.at })
  }
  // A thread the ticket follows only for context still belongs in the page.
  for (const follow of ticket.follows ?? []) {
    if (follow.thread.startsWith('github:')) continue
    put({ kind: 'thread', ref: follow.thread, state: follow.closed?.outcome ?? 'open', ...follow.closed ? { at: follow.closed.at } : {} })
  }
  // Prefer the newest signal evidence for a review/CI association that has no direct trigger meta.
  for (const signal of signals) {
    if (signal.kind === 'ci' && signal.read) put({ kind: 'ci', ref: 'latest', state: 'unknown', latest: signal.preview, at: signal.at, read: signal.read })
  }
  return [...found.values()].sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
}

/** Build a deterministic one-page package. Signals are newest first and trimmed to the budget last. */
export function ticketContextPackage(records: ContextRecords, ticket: Ticket, options: ContextOptions = {}): ContextPackage {
  const budget = options.budgetChars ?? DEFAULT_BUDGET
  const previewChars = options.previewChars ?? PREVIEW
  const origin = records.triggers.get(ticket.origin.triggerId)
  const requirements: ContextRequirement[] = []
  const requirementInputs = new Set<string>()
  for (const input of ticket.inputs) {
    if (input.kind !== 'trigger' || input.context) continue
    const trigger = records.triggers.get(input.triggerId)
    if (!trigger || !requirementTrigger(trigger)) continue
    requirementInputs.add(input.id)
    requirements.push({ at: input.at, actor: trigger.actor.id, triggerId: trigger.id,
      preview: clip(trigger.text, previewChars), read: `trigger/${trigger.id}` })
  }
  requirements.sort((a, b) => b.at.localeCompare(a.at))
  const allSignals = ticket.inputs.flatMap(input => {
    if (requirementInputs.has(input.id)) return []
    const signal = signalOf(input, input.kind === 'trigger' ? records.triggers.get(input.triggerId) : undefined)
    return signal ? [{ ...signal, preview: clip(signal.preview, previewChars) }] : []
  }).sort((a, b) => b.at.localeCompare(a.at))
  const limit = options.signals ?? DEFAULT_SIGNALS
  const signals = allSignals.slice(0, limit)
  const associations = associationsOf(ticket, records, allSignals)
  const assignment = latestAssignment(ticket)
  const report = latestReport(ticket)
  const pkg: ContextPackage = {
    schema_version: 1,
    ticket: { id: ticket.id, title: ticket.title, state: liveTicket(ticket) ? 'open' : 'ended', stage: stageName(ticket),
      ...ticket.ended ? { outcome: ticket.ended.outcome } : {}, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt },
    mandate: { strength: ticket.mandate.strength, scope: ticket.mandate.scope, policyVersion: ticket.mandate.policyVersion,
      via: ticket.mandate.basis.via, ...ticket.mandate.basis.rules?.length ? { rules: ticket.mandate.basis.rules } : {} },
    request: { triggerId: ticket.origin.triggerId, actor: origin?.actor.id ?? ticket.mandate.actor.id, at: origin?.at ?? ticket.createdAt,
      preview: clip(origin?.text ?? ticket.title, previewChars), read: `trigger/${ticket.origin.triggerId}` },
    progress: { assignment: ticket.assignments.length, state: assignment?.state ?? 'none',
      ...report ? { lastReport: { state: report.state, summary: clip(report.summary, 500), at: report.at } } : {},
      ...ticket.attention ? { question: ticket.attention.question } : {} },
    signals,
    ...requirements.length ? { requirements } : {},
    associations,
    recall: [...new Set([`ticket/${ticket.id}`, `ticket/${ticket.id}/inputs`, `ticket/${ticket.id}/summary`,
      ...signals.flatMap(signal => signal.read ? [signal.read] : []), ...associations.flatMap(item => item.read ? [item.read] : [])])]
      .map(read => ({ read, holds: read.startsWith('trigger/') ? 'one message, whole' : read.endsWith('/inputs') ? 'older inputs, newest first'
        : read.endsWith('/summary') ? 'this page' : 'the ticket record' })),
    budget: { limit: budget, used: 0, omitted: Math.max(0, allSignals.length - signals.length) },
  }
  let used = JSON.stringify(pkg).length
  // Drop ordinary signals first. Only when none remain do the oldest requirements go, keeping the newest one.
  while (used > budget && pkg.signals.length > (pkg.requirements?.length ? 0 : 1)) {
    pkg.signals.pop()
    pkg.budget.omitted += 1
    used = JSON.stringify(pkg).length
  }
  while (used > budget && (pkg.requirements?.length ?? 0) > 1) {
    pkg.requirements!.pop()
    pkg.budget.omitted += 1
    used = JSON.stringify(pkg).length
  }
  pkg.budget.used = used
  return pkg
}

/** Render the package for a prompt. Deterministic and compact; no prose that is not derived from the facts above. */
export function renderTicketContext(pkg: ContextPackage): string {
  const lines = [
    `Ticket ${pkg.ticket.id} · ${pkg.ticket.title}`,
    `State: ${pkg.ticket.state}${pkg.ticket.outcome ? ` (${pkg.ticket.outcome})` : ''} · stage ${pkg.ticket.stage} · assignment ${pkg.progress.assignment} (${pkg.progress.state})`,
    `Mandate: ${pkg.mandate.strength}, scope "${pkg.mandate.scope}", policy ${pkg.mandate.policyVersion}${pkg.mandate.rules?.length ? `, rules ${pkg.mandate.rules.join(', ')}` : ''}`,
    `Request (${pkg.request.actor}, ${pkg.request.at}): ${pkg.request.preview}`,
    ...pkg.progress.lastReport ? [`Last report (${pkg.progress.lastReport.state}, ${pkg.progress.lastReport.at}): ${pkg.progress.lastReport.summary}`] : [],
    ...pkg.progress.question ? [`Open question: ${pkg.progress.question}`] : [],
    '',
    'Associations (answer status questions from these, not from memory):',
    ...pkg.associations.length ? pkg.associations.map(item => `- ${item.kind} ${item.ref}: ${item.state}${item.at ? ` at ${item.at}` : ''}${item.latest ? ` — ${item.latest}` : ''}${item.read ? ` [read ${item.read}]` : ''}`)
      : ['- none recorded'],
    '',
    ...pkg.requirements?.length ? [
      'Human requirements (newest first):',
      ...pkg.requirements.map(requirement => `- ${requirement.at} ${requirement.actor}: ${requirement.preview} [read ${requirement.read}]`),
      '',
    ] : [],
    `Recent signals (newest first${pkg.budget.omitted ? `; ${pkg.budget.omitted} older omitted` : ''}):`,
    ...pkg.signals.length ? pkg.signals.map(signal => `- ${signal.at} ${signal.kind}${signal.actor ? ` ${signal.actor}` : ''}: ${signal.preview}${signal.read ? ` [read ${signal.read}]` : ''}`)
      : ['- none'],
    '',
    'Recall on demand (read only what you need):',
    ...pkg.recall.map(item => `- ${item.read}: ${item.holds}`),
  ]
  return lines.join('\n')
}
