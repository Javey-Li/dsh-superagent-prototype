import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Engine, MemoryRepositories, UserError, type Assessor, type Executor, type OutboundMessage } from '../src/core/index.ts'
import { SettingsSchema, policyVersion, settingsPolicy } from '../src/policy.ts'
import { RoleSpecSchema, roleSpecOf } from '../src/roles.ts'
import { ScheduleConfigSchema, scheduleKind, scheduleTrigger } from '../src/sources/schedule.ts'
import { SourceRegistry } from '../src/sources/registry.ts'

const role = RoleSpecSchema.parse({
  id: 'fretsense-user-sim',
  project: 'FretSense',
  policyRule: 'fretsense-user-sim',
  executorProfile: 'observer',
  instructions: 'Run the fixed seven paths and publish at most one Issue.',
  target: 'http://127.0.0.1:4173',
  checkout: '/tmp/fretsense-readonly',
  artifactRoot: '/tmp/fretsense-role-runs',
  github: { repository: 'Javey-Li/FretSense', cli: 'gh', configDir: '/tmp/gh-agent', login: 'javey-agent' },
})
const schedule = ScheduleConfigSchema.parse({ cron: '30 2 * * *', timezone: 'Asia/Tokyo', role })
const trigger = scheduleTrigger(schedule, new Date('2026-11-06T17:30:00.000Z'))
const roleRule = {
  id: 'fretsense-user-sim',
  name: 'FretSense nightly observation',
  enabled: true,
  instruction: 'Accept the trusted schedule role as read-only observation work and require a whoSaid=ai-record Issue.',
}

function settings(enabled = true) {
  return SettingsSchema.parse({
    eval: { mode: 'auto' },
    sources: { schedule: { enabled: true, config: schedule } },
    policy: { rules: [{ ...roleRule, enabled }], sources: {} },
    executor: { profiles: { observer: { preset: 'dsh-superagent-observer', ghPolicy: 'issues',
      model: { provider: 'workbuddy', model: 'deepseek-v4.1-flash' } } } },
  })
}

describe('scheduled RoleSpec', () => {
  it('ships a deployable FretSense role instance with 02:30 JST and javey-agent publication', () => {
    const example = SettingsSchema.parse(JSON.parse(readFileSync(join(import.meta.dirname, '..', 'examples', 'fretsense-user-sim.settings.json'), 'utf8')))
    expect(example.sources.schedule!.config).toMatchObject({
      cron: '30 2 * * *',
      timezone: 'Asia/Tokyo',
      role: { id: 'fretsense-user-sim', executorProfile: 'observer', target: 'http://127.0.0.1:4173',
        github: { repository: 'Javey-Li/FretSense', configDir: '/Users/javeyli/.config/gh-agent', login: 'javey-agent' },
        limits: { durationMinutes: 20, maxIssues: 1, maxFindings: 3 } },
    })
    expect(example.policy.sources.github?.allowed).toEqual([])
    expect(example.executor.profiles.observer).toEqual({ preset: 'dsh-superagent-observer', ghPolicy: 'issues',
      model: { provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash' } })
  })

  it('reads a role only from a matching trusted Schedule Trigger', () => {
    expect(roleSpecOf(trigger)?.id).toBe('fretsense-user-sim')
    expect(roleSpecOf({ ...trigger, source: 'github' })).toBeUndefined()
    expect(roleSpecOf({ ...trigger, meta: { ...trigger.meta, role: 'another-role' } })).toBeUndefined()
  })

  it('admits the role as an inferred candidate and keeps its profile and stop limits in the Mandate', () => {
    const value = settings()
    const sources = new SourceRegistry(() => value)
    sources.register(scheduleKind)
    expect(sources.scope({ source: 'schedule', meta: trigger.meta })).toEqual({ listened: true, observed: true, row: 'schedule' })
    const policy = settingsPolicy(value, sources)
    expect(policy.role?.(trigger)).toEqual({ id: 'fretsense-user-sim', policyRule: 'fretsense-user-sim',
      executorProfile: 'observer', limits: { durationMinutes: 20, maxIssues: 1, maxFindings: 3 } })
    expect(policy.gate(trigger, { key: 'schedule:x', ref: trigger.threads[0]!, createdAt: trigger.at, subscriptions: [],
      correlated: [], pending: [], meta: {} }, [])).toMatchObject({ admissible: true, strength: 'inferred',
      basis: { via: 'admission', observation: { mode: 'auto' } } })

    const repo = new MemoryRepositories()
    const starts = vi.fn()
    const assessor: Assessor = { request: vi.fn() }
    const executor: Executor = { start: starts, deliver: vi.fn(), stop: vi.fn() }
    const outbox = { send: (_message: OutboundMessage) => {}, status: () => undefined, withdraw: () => {} }
    const engine = new Engine({ repo, scope: sources, policy: () => policy, assessor, executor, outbox })
    repo.triggers.save(trigger)
    const decision = engine.decide(trigger.id, {
      kind: 'accept', title: 'FretSense nightly user simulation', scope: 'Read-only seven-path run; at most one Issue.',
      reason: 'Role run', rules: ['fretsense-user-sim'], name: 'fretsense-user-sim',
    })
    const ticket = repo.tickets.get(decision.ticketId!)!
    expect(ticket.mandate).toMatchObject({ role: 'fretsense-user-sim', executorProfile: 'observer', line: 'read',
      limits: { durationMinutes: 20, maxIssues: 1, maxFindings: 3 },
      basis: { rules: ['fretsense-user-sim'], observation: { mode: 'auto' } } })
    expect(ticket.assignments[0]).toMatchObject({ executorProfile: 'observer', state: 'pending' })
    expect(starts).toHaveBeenCalledWith(ticket, ticket.assignments[0])
  })

  it('refuses the role when its policy rule is disabled or omitted from the assessment', () => {
    const disabled = settings(false)
    const disabledSources = new SourceRegistry(() => disabled)
    disabledSources.register(scheduleKind)
    const disabledPolicy = settingsPolicy(disabled, disabledSources)
    expect(disabledPolicy.role?.(trigger)).toBeUndefined()
    expect(disabledPolicy.gate(trigger, { key: 'schedule:x', ref: trigger.threads[0]!, createdAt: trigger.at, subscriptions: [],
      correlated: [], pending: [], meta: {} }, [])).toEqual({ admissible: false, reason: 'role_disabled' })

    const value = settings()
    const sources = new SourceRegistry(() => value)
    sources.register(scheduleKind)
    const repo = new MemoryRepositories()
    const engine = new Engine({ repo, scope: sources, policy: () => settingsPolicy(value, sources),
      assessor: { request: vi.fn() }, executor: { start: vi.fn(), deliver: vi.fn(), stop: vi.fn() },
      outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
    repo.triggers.save(trigger)
    expect(() => engine.decide(trigger.id, { kind: 'accept', title: 'Nightly', scope: 'read-only', reason: 'role',
      rules: ['copy'], name: 'nightly-role' })).toThrow(UserError)
  })

  it('keeps executor profiles out of the policy version while the role rule remains versioned', () => {
    const value = settings()
    const changedProfile = SettingsSchema.parse({ ...value, executor: { ...value.executor,
      profiles: { ...value.executor.profiles, observer: { ...value.executor.profiles.observer, model: null } } } })
    expect(policyVersion(changedProfile)).toBe(policyVersion(value))
    const changedRule = SettingsSchema.parse({ ...value, policy: { ...value.policy,
      rules: value.policy.rules.map(rule => ({ ...rule, instruction: `${rule.instruction} Changed.` })) } })
    expect(policyVersion(changedRule)).not.toBe(policyVersion(value))
  })
})
