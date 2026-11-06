/** Schedule Source: a trusted clock that emits one role Trigger per local-time slot. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import { RoleSpecSchema } from '../roles.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { pause } from './poll.ts'

const dailyCron = (value: string): boolean => {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(value.trim())
  return !!match && Number(match[1]) <= 59 && Number(match[2]) <= 23
}
const timezone = z.string().trim().min(1).refine(value => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true }
  catch { return false }
}, 'Unknown IANA timezone')

export const ScheduleConfigSchema = z.object({
  cron: z.string().trim().refine(dailyCron, 'The first version supports a daily five-field cron such as "30 2 * * *"'),
  timezone: timezone.default('Asia/Tokyo'),
  checkSeconds: z.number().int().min(10).max(3600).default(30),
  catchUpHours: z.number().int().min(0).max(48).default(6),
  role: RoleSpecSchema,
}).strict()
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>

interface Local { year: number; month: number; day: number; hour: number; minute: number }
const localAt = (at: number, zone: string): Local => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(at))
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(part => part.type === type)?.value)
  return { year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute') }
}
const sameLocal = (a: Local, b: Local): boolean => a.year === b.year && a.month === b.month && a.day === b.day
  && a.hour === b.hour && a.minute === b.minute
const utcForLocal = (local: Local, zone: string): number | undefined => {
  let guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)
  for (let index = 0; index < 4; index++) {
    const observed = localAt(guess, zone)
    const delta = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute)
      - Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute)
    if (delta === 0) return guess
    guess += delta
  }
  return sameLocal(localAt(guess, zone), local) ? guess : undefined
}
const shiftLocalDay = (local: Local, days: number): Local => {
  const value = new Date(Date.UTC(local.year, local.month - 1, local.day + days, local.hour, local.minute))
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate(), hour: local.hour, minute: local.minute }
}
const cronTime = (config: Pick<ScheduleConfig, 'cron'>): { hour: number; minute: number } => {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/.exec(config.cron.trim())!
  return { minute: Number(match[1]), hour: Number(match[2]) }
}
const offset = (at: number, zone: string): string => {
  const value = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(new Date(at))
    .find(part => part.type === 'timeZoneName')?.value ?? 'GMT'
  return value === 'GMT' ? '+00:00' : value.replace('GMT', '')
}
const pad = (value: number): string => String(value).padStart(2, '0')
/** The local wall-clock label for a slot, such as `2026-11-07T02:30:00+09:00`. */
export function scheduleSlotLabel(at: number, zone: string): string {
  const local = localAt(at, zone)
  return `${local.year}-${pad(local.month)}-${pad(local.day)}T${pad(local.hour)}:${pad(local.minute)}:00${offset(at, zone)}`
}
const localDay = (at: number, zone: string, days: number): Local => {
  const current = localAt(at, zone)
  return shiftLocalDay({ ...current, hour: 0, minute: 0 }, days)
}
/** The latest scheduled instant at or before `now`, or undefined when the local time does not exist that day. */
export function latestScheduleSlot(now: Date, config: Pick<ScheduleConfig, 'cron' | 'timezone'>): Date | undefined {
  const at = now.getTime()
  const { hour, minute } = cronTime(config)
  const candidates = [0, -1, -2].flatMap(day => {
    const date = localDay(at, config.timezone, day)
    const instant = utcForLocal({ ...date, hour, minute }, config.timezone)
    return instant !== undefined && instant <= at ? [instant] : []
  })
  return candidates.length ? new Date(Math.max(...candidates)) : undefined
}
/** Build the one immutable Trigger for a role slot. */
export function scheduleTrigger(config: ScheduleConfig, slot: Date): Trigger {
  const label = scheduleSlotLabel(slot.getTime(), config.timezone)
  return {
    id: `schedule:${config.role.id}:${label}`,
    source: 'schedule',
    threads: [{ source: 'schedule', id: `${config.role.id}:${label}` }],
    actor: { source: 'schedule', id: '' },
    human: false,
    at: slot.toISOString(),
    text: `Nightly ${config.role.project} role run: ${config.role.id}`,
    meta: {
      role: config.role.id,
      roleSpec: config.role,
      project: config.role.project,
      target: config.role.target,
      slot: label,
      maxIssues: config.role.limits.maxIssues,
      maxFindings: config.role.limits.maxFindings,
      windowMinutes: config.role.limits.durationMinutes,
    },
  }
}

export const source = 'schedule'
export const scheduleKind: SourceKind<ScheduleConfig> = {
  kind: source,
  title: { zh: '定时', en: 'Schedule' },
  description: { zh: '按时区把一个有 Mandate 的角色运行送入超级智能体；不直接建工单。', en: 'Emits a scheduled role run into the superagent in a timezone; it never creates a ticket directly.' },
  schema: ScheduleConfigSchema,
  fields: [
    { key: 'cron', type: 'text', label: { zh: 'Cron', en: 'Cron' },
      hint: { zh: '第一版支持每天执行的五段 cron，例如 30 2 * * *。', en: 'The first version supports a daily five-field cron, such as 30 2 * * *.' } },
    { key: 'timezone', type: 'text', label: { zh: '时区', en: 'Timezone' }, hint: { zh: 'IANA 时区，例如 Asia/Tokyo。', en: 'IANA timezone, such as Asia/Tokyo.' } },
    { key: 'checkSeconds', type: 'number', min: 10, max: 3600, advanced: true, label: { zh: '检查间隔 / 秒', en: 'Check interval / seconds' } },
    { key: 'catchUpHours', type: 'number', min: 0, max: 48, advanced: true, label: { zh: '补跑窗口 / 小时', en: 'Catch-up window / hours' },
      hint: { zh: '首次启动或机器休眠后，最多补跑最近一次；超过窗口就记 missed。', en: 'After a restart or sleep, run the latest slot once if it is inside this window; otherwise record missed.' } },
    { key: 'role', type: 'text', readonly: true, label: { zh: '角色配置', en: 'Role configuration' },
      hint: { zh: 'RoleSpec 由该 Source 的 JSON 配置保存；Mandate 记录本次运行的权限和停止条件。', en: 'The RoleSpec is stored in this Source instance JSON; the Mandate records this run\'s authority and stop limits.' } },
  ],
  health: ['schedule'],
  scope: () => ({ listened: true, observed: true, row: 'schedule' }),
}

const LAST = 'schedule:last'
interface LastSlot { slot: string; at: string; state: 'delivered' | 'missed' | 'duplicate' }
/** Check one schedule instance at `now`; exported for tests and for the plugin loop. */
export async function scheduleOnce(ctx: SourceContext, config: ScheduleConfig, now = new Date()): Promise<LastSlot | undefined> {
  const slot = latestScheduleSlot(now, config)
  if (!slot) return undefined
  const label = scheduleSlotLabel(slot.getTime(), config.timezone)
  const stored = ctx.state.get<Record<string, LastSlot>>(LAST)?.[config.role.id]
  if (stored?.slot === label) return stored
  const missMs = now.getTime() - slot.getTime()
  if (missMs > config.catchUpHours * 3600_000) {
    const missed: LastSlot = { slot: label, at: now.toISOString(), state: 'missed' }
    ctx.atomic(() => ctx.state.set(LAST, { ...ctx.state.get<Record<string, LastSlot>>(LAST), [config.role.id]: missed }))
    return missed
  }
  const trigger = scheduleTrigger(config, slot)
  const result = await ctx.receive(trigger)
  const state: LastSlot = { slot: label, at: now.toISOString(), state: result === 'duplicate' ? 'duplicate' : 'delivered' }
  ctx.atomic(() => ctx.state.set(LAST, { ...ctx.state.get<Record<string, LastSlot>>(LAST), [config.role.id]: state }))
  return state
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('schedule', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<ScheduleConfig>(source)
    if (!config) ctx.report('schedule', health('paused', 'sourceOff'))
    else {
      try {
        const state = await scheduleOnce(ctx, config)
        const next = latestScheduleSlot(new Date(Date.now() + 24 * 3600_000), config)
        ctx.report('schedule', { state: 'ready', detail: state ? `${state.state} ${state.slot}` : `waiting for ${next?.toISOString() ?? config.cron}`,
          at: new Date().toISOString() })
      } catch (error) {
        if (!signal.aborted) ctx.report('schedule', { state: 'error', detail: String(error).slice(0, 1000), at: new Date().toISOString() })
      }
    }
    await pause((config?.checkSeconds ?? 30) * 1000, signal)
  }
}

export const name = 'dsh-superagent-schedule'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(scheduleKind), 'schedule: source kind')
  ctx.effect(() => {
    const value = sourceContext(ctx.orchestrator, scheduleKind)
    const controller = new AbortController()
    const running = watch(value, controller.signal).catch((error: unknown) => {
      value.report('schedule', { state: 'error', detail: String(error), at: new Date().toISOString() })
    })
    return async () => { controller.abort(); await running }
  })
}
