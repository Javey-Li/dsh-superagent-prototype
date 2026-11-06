import { describe, expect, it, vi } from 'vitest'
import type { SourceContext } from '../src/sources/host.ts'
import { ScheduleConfigSchema, latestScheduleSlot, scheduleOnce, scheduleSlotLabel, scheduleTrigger } from '../src/sources/schedule.ts'
import { RoleSpecSchema } from '../src/roles.ts'

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
const config = ScheduleConfigSchema.parse({ cron: '30 2 * * *', timezone: 'Asia/Tokyo', role })

describe('Schedule Source', () => {
  it('computes the latest 02:30 Asia/Tokyo slot and a stable local label', () => {
    const at = new Date('2026-11-06T17:31:00.000Z')
    const slot = latestScheduleSlot(at, config)!
    expect(slot.toISOString()).toBe('2026-11-06T17:30:00.000Z')
    expect(scheduleSlotLabel(slot.getTime(), config.timezone)).toBe('2026-11-07T02:30:00+09:00')
    expect(latestScheduleSlot(new Date('2026-11-06T17:29:59.000Z'), config)!.toISOString()).toBe('2026-11-05T17:30:00.000Z')
  })

  it('builds one immutable Trigger whose role spec and limits cross into the domain', () => {
    const slot = latestScheduleSlot(new Date('2026-11-06T17:31:00.000Z'), config)!
    const trigger = scheduleTrigger(config, slot)
    expect(trigger).toMatchObject({
      id: 'schedule:fretsense-user-sim:2026-11-07T02:30:00+09:00',
      source: 'schedule',
      threads: [{ source: 'schedule', id: 'fretsense-user-sim:2026-11-07T02:30:00+09:00' }],
      actor: { source: 'schedule', id: '' },
      human: false,
      meta: { role: 'fretsense-user-sim', project: 'FretSense', target: 'http://127.0.0.1:4173',
        maxIssues: 1, maxFindings: 3, windowMinutes: 20 },
    })
    expect(trigger.meta.roleSpec).toMatchObject({ policyRule: 'fretsense-user-sim', executorProfile: 'observer',
      github: { repository: 'Javey-Li/FretSense', login: 'javey-agent' } })
  })

  it('delivers a slot once, catches up inside the window, and records a missed slot', async () => {
    const state = new Map<string, unknown>()
    const receive = vi.fn(async () => 'stored' as const)
    const ctx = {
      state: { get: (key: string) => state.get(key), set: (key: string, value: unknown) => { if (value === undefined) state.delete(key); else state.set(key, value) } },
      atomic: <T>(run: () => T) => run(),
      receive,
    } as unknown as SourceContext
    const at = new Date('2026-11-06T17:31:00.000Z')
    expect(await scheduleOnce(ctx, config, at)).toMatchObject({ state: 'delivered', slot: '2026-11-07T02:30:00+09:00' })
    expect(await scheduleOnce(ctx, config, at)).toMatchObject({ state: 'delivered' })
    expect(receive).toHaveBeenCalledTimes(1)

    const catchUp = { ...ctx, state: { get: () => undefined, set: () => {} } } as unknown as SourceContext
    receive.mockClear()
    expect(await scheduleOnce(catchUp, config, new Date('2026-11-06T20:00:00.000Z'))).toMatchObject({ state: 'delivered' })
    expect(receive).toHaveBeenCalledTimes(1)

    const missed = { ...ctx, state: { get: () => undefined, set: () => {} } } as unknown as SourceContext
    receive.mockClear()
    expect(await scheduleOnce(missed, config, new Date('2026-11-07T01:00:00.000Z'))).toMatchObject({ state: 'missed' })
    expect(receive).not.toHaveBeenCalled()
  })

  it('accepts only the first-version daily cron, a valid timezone, and a local target', () => {
    expect(() => ScheduleConfigSchema.parse({ cron: '*/5 * * * *', role })).toThrow('daily five-field cron')
    expect(() => ScheduleConfigSchema.parse({ cron: '30 2 * * *', timezone: 'Mars/Olympus', role })).toThrow('Unknown IANA timezone')
    expect(() => RoleSpecSchema.parse({ ...role, target: 'https://example.com' })).toThrow('local HTTP endpoint')
    expect(() => RoleSpecSchema.parse({ ...role, checkout: 'relative/checkout' })).toThrow('absolute path')
  })
})
