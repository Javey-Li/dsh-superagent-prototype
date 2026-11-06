/**
 * Baseline records: what the owner said, what the owner approved from an AI suggestion, and what an AI merely recorded.
 * A baseline record never grants permission; it only keeps past words and their provenance.
 */
import { z } from 'zod'

/** The three levels of `whoSaid`; only an explicit owner statement or approval may claim the first two. */
export const WHO_SAID = ['founder-original', 'founder-approved-ai', 'ai-record'] as const
export type WhoSaid = typeof WHO_SAID[number]
/** Chinese labels shown next to each level; derived from `whoSaid` so the two can never disagree. */
export const WHO_SAID_LABELS: Record<WhoSaid, string> = {
  'founder-original': '主人的原话',
  'founder-approved-ai': '主人认可的 AI 建议',
  'ai-record': 'AI 的记录',
}

/** The kinds of baseline records; only the normative ones may become rules or decisions. */
export const BASELINE_TYPES = ['Intent', 'Decision', 'Failure', 'Guard', 'Reference', 'Pattern', 'Example', 'OpenQuestion', 'ProjectState'] as const
export type BaselineType = typeof BASELINE_TYPES[number]
/** Types that may carry normative weight; an Example or a Reference never does. */
export const NORMATIVE_TYPES: readonly BaselineType[] = ['Intent', 'Decision', 'Guard', 'Pattern']
/** A record starts `active` and becomes `promoted` once it is accepted as normative baseline. */
export const BASELINE_STATUSES = ['active', 'promoted'] as const
export type BaselineStatus = typeof BASELINE_STATUSES[number]

/**
 * Where a record came from. `source` is the original statement: a link, a file path, or a conversation id.
 * A `founder-approved-ai` record also keeps the AI draft and the owner's approval.
 */
export const BaselineProvenanceSchema = z.object({
  source: z.string().trim().min(1).max(2000),
  at: z.string().trim().min(1).optional(),
  aiDraft: z.string().trim().min(1).max(4000).optional(),
  approvedBy: z.string().trim().min(1).max(2000).optional(),
}).strict()
export type BaselineProvenance = z.infer<typeof BaselineProvenanceSchema>

/** The fields a caller supplies when it records a baseline entry. */
export const BaselineInputSchema = z.object({
  id: z.string().trim().min(1).max(200),
  projectId: z.string().trim().min(1).max(200),
  type: z.enum(BASELINE_TYPES),
  title: z.string().trim().min(1).max(300),
  claim: z.string().trim().min(1).max(10000),
  whoSaid: z.enum(WHO_SAID),
  provenance: BaselineProvenanceSchema,
  confidence: z.number().min(0).max(1).optional(),
  status: z.enum(BASELINE_STATUSES).optional(),
  scope: z.string().trim().max(500).optional(),
  normative: z.boolean().optional(),
  ttlDays: z.number().int().positive().max(3650).optional(),
  lastVerified: z.string().trim().min(1).optional(),
  supersedes: z.string().trim().min(1).max(200).nullish(),
  createdAt: z.string().trim().min(1).optional(),
}).strict()
export type BaselineInput = z.input<typeof BaselineInputSchema>

/** A stored baseline record; `whoSaidLabel` is derived when the record is read. */
export const BaselineRecordSchema = BaselineInputSchema.extend({
  confidence: z.number().min(0).max(1),
  status: z.enum(BASELINE_STATUSES),
  scope: z.string(),
  normative: z.boolean(),
  ttlDays: z.number().int().positive(),
  lastVerified: z.string().min(1),
  createdAt: z.string().min(1),
}).strict()
export type StoredBaseline = z.infer<typeof BaselineRecordSchema>
export type BaselineRecord = StoredBaseline & { whoSaidLabel: string }

/** Which records to list: every filter is optional and they combine with AND. */
export interface BaselineQuery {
  projectId?: string
  whoSaid?: WhoSaid
  type?: BaselineType
  status?: BaselineStatus
  /** Newest first; defaults to 100 and is clamped to 1..1000. */
  limit?: number
}

/**
 * Normalize one input into a stored record: fill defaults, derive the Chinese label, and refuse provenance or
 * normativity that the declared level and type cannot support.
 */
export function baselineRecord(input: BaselineInput): BaselineRecord {
  const parsed = BaselineInputSchema.parse(input)
  const normative = parsed.normative ?? NORMATIVE_TYPES.includes(parsed.type)
  if (normative && !NORMATIVE_TYPES.includes(parsed.type)) {
    throw new Error(`A ${parsed.type} record cannot be normative; only ${NORMATIVE_TYPES.join(', ')} may be`)
  }
  if (parsed.whoSaid === 'founder-approved-ai' && (!parsed.provenance.aiDraft || !parsed.provenance.approvedBy)) {
    throw new Error('A founder-approved-ai record must keep both the AI draft and the owner\'s approval in its provenance')
  }
  const createdAt = parsed.createdAt ?? new Date().toISOString()
  return {
    ...parsed,
    whoSaidLabel: WHO_SAID_LABELS[parsed.whoSaid],
    confidence: parsed.confidence ?? 1,
    status: parsed.status ?? 'active',
    scope: parsed.scope ?? '',
    normative,
    ttlDays: parsed.ttlDays ?? (parsed.type === 'Failure' ? 365 : 90),
    lastVerified: parsed.lastVerified ?? createdAt,
    createdAt,
  }
}

/** Read a stored baseline record and derive its current Chinese label. */
export function baselineFromStored(value: unknown): BaselineRecord {
  const parsed = BaselineRecordSchema.parse(value)
  return { ...parsed, whoSaidLabel: WHO_SAID_LABELS[parsed.whoSaid] }
}

/** Drop the derived label before writing a record to SQLite. */
export function storedBaseline(record: BaselineRecord): StoredBaseline {
  const { whoSaidLabel: _label, ...stored } = record
  return stored
}

/**
 * Why a record may not be promoted, or `undefined` when it may.
 * An AI record needs a new owner-confirmed record rather than promotion, and an Example or any non-normative record
 * needs a new Decision first; neither rule can be waived in place.
 */
export function promotionRefusal(record: Pick<BaselineRecord, 'whoSaid' | 'type' | 'normative'>): string | undefined {
  if (record.whoSaid === 'ai-record') {
    return 'An ai-record cannot be promoted; the owner must confirm a new founder-original or founder-approved-ai record'
  }
  if (record.type === 'Example') return 'An Example cannot be promoted; create a Decision first'
  if (!record.normative) return 'A non-normative record cannot be promoted; create a Decision first'
  return undefined
}
