/** RoleSpec configuration for trusted scheduled roles, independent of the executor capability it selects. */
import { z } from 'zod'
import type { ExecutorProfile, RoleLimits, Trigger } from './core/index.ts'

const name = (max: number) => z.string().trim().min(1).max(max)
const absolutePath = (description: string) => z.string().trim().startsWith('/', description)
const repository = z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/name')
const localTarget = z.string().url().refine(value => {
  const host = new URL(value).hostname
  return host === '127.0.0.1' || host === 'localhost'
}, 'A role target must be a local HTTP endpoint')

/** Stop limits copied into a scheduled role's Mandate. */
export const RoleLimitsSchema: z.ZodType<RoleLimits> = z.object({
  durationMinutes: z.number().int().min(1).max(120).default(20),
  maxIssues: z.number().int().min(0).max(5).default(1),
  maxFindings: z.number().int().min(1).max(10).default(3),
}).strict()

/** A scheduled role's authorization and run configuration; executor profiles separately define what can execute it. */
export const RoleSpecSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
  project: name(80),
  policyRule: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  executorProfile: z.enum(['builder', 'observer']),
  output: z.literal('role-report/v1').default('role-report/v1'),
  instructions: name(12_000),
  target: localTarget,
  checkout: absolutePath('The checkout must be an absolute path'),
  artifactRoot: absolutePath('The artifact root must be an absolute path'),
  github: z.object({
    repository,
    cli: z.string().trim().min(1).default('gh'),
    configDir: absolutePath('The agent gh config directory must be an absolute path'),
    login: z.string().regex(/^[A-Za-z0-9-]+$/),
  }).strict(),
  limits: RoleLimitsSchema.default(() => RoleLimitsSchema.parse({})),
}).strict()
export type RoleSpec = z.infer<typeof RoleSpecSchema>

/** A role's executor profile id, carried by its Mandate. */
export const executorProfile = (value: unknown): ExecutorProfile | undefined => {
  return value === 'router' || value === 'builder' || value === 'observer' ? value : undefined
}

/**
 * Reads the RoleSpec a trusted schedule Source put on a Trigger. The Source is the authority: an arbitrary
 * GitHub/Feishu message cannot claim a role merely by putting JSON in its metadata.
 */
export function roleSpecOf(trigger: Trigger | undefined): RoleSpec | undefined {
  if (trigger?.source !== 'schedule') return undefined
  const parsed = RoleSpecSchema.safeParse(trigger.meta.roleSpec)
  return parsed.success && trigger.meta.role === parsed.data.id ? parsed.data : undefined
}

/** Resolve the immutable RoleSpec that authorized `ticket`, by checking its origin Trigger and Mandate. */
export function roleSpecForTicket(ticket: { mandate: { role?: string }; origin: { triggerId: string } },
  trigger: (id: string) => Trigger | undefined): RoleSpec | undefined {
  if (!ticket.mandate.role) return undefined
  const spec = roleSpecOf(trigger(ticket.origin.triggerId))
  return spec?.id === ticket.mandate.role ? spec : undefined
}
