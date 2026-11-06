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
  'founder-original': '你的原话',
  'founder-approved-ai': '你认可的 AI 建议',
  'ai-record': 'AI 的记录',
}

/** Who wrote the text, separate from whether it counts as the owner's decision. */
export const AUTHORS = ['human', 'ai', 'mixed'] as const
export type Author = typeof AUTHORS[number]
/** Whether the record carries the owner's authority: their words, their approval, or neither. */
export const AUTHORITIES = ['owner-original', 'owner-approved', 'none'] as const
export type Authority = typeof AUTHORITIES[number]
/** How the record is known: stated, observed, relayed or inferred. */
export const EVIDENCE = ['stated', 'observed', 'relayed', 'inferred'] as const
export type Evidence = typeof EVIDENCE[number]

/** The kinds of baseline records; only the normative ones may become rules or decisions. */
export const BASELINE_TYPES = ['Intent', 'Decision', 'Failure', 'Guard', 'Reference', 'Pattern', 'Example', 'OpenQuestion', 'ProjectState'] as const
export type BaselineType = typeof BASELINE_TYPES[number]
/** Types that may carry normative weight; an Example or a Reference never does. */
export const NORMATIVE_TYPES: readonly BaselineType[] = ['Intent', 'Decision', 'Guard', 'Pattern']
/** A record starts `active`, becomes `promoted` once accepted, and `superseded` once a newer record replaces it. */
export const BASELINE_STATUSES = ['active', 'promoted', 'superseded'] as const
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

/** One segment of a mixed-author record; each segment keeps its own author, authority and exact words. */
export const BaselinePartSchema = z.object({
  author: z.enum(AUTHORS),
  authority: z.enum(AUTHORITIES),
  evidence: z.enum(EVIDENCE).optional(),
  verbatim: z.string().trim().min(1).max(10000).optional(),
  summary: z.string().trim().min(1).max(10000).optional(),
  paraphrase: z.boolean().optional(),
}).strict()
export type BaselinePart = z.infer<typeof BaselinePartSchema>

/** The fields a caller supplies when it records a baseline entry. */
export const BaselineInputSchema = z.object({
  id: z.string().trim().min(1).max(200),
  projectId: z.string().trim().min(1).max(200),
  type: z.enum(BASELINE_TYPES),
  title: z.string().trim().min(1).max(300),
  claim: z.string().trim().min(1).max(10000),
  /** Derived from `authority` when omitted; accepted for callers that already know the level. */
  whoSaid: z.enum(WHO_SAID).optional(),
  author: z.enum(AUTHORS).optional(),
  authority: z.enum(AUTHORITIES).optional(),
  evidence: z.enum(EVIDENCE).optional(),
  /** The owner's exact words, when the caller has them. */
  verbatim: z.string().trim().min(1).max(10000).optional(),
  /** An AI summary or paraphrase, kept apart from the owner's exact words. */
  summary: z.string().trim().min(1).max(10000).optional(),
  /** Explicitly marks an owner-original record as a close paraphrase rather than exact words. */
  paraphrase: z.boolean().optional(),
  /** Marks text the owner pasted back from an AI draft; this is the explicit approval signal. */
  approvedFrom: z.string().trim().min(1).max(2000).optional(),
  /** Mixed-author records keep every segment with its own author and authority. */
  parts: z.array(BaselinePartSchema).min(1).max(20).optional(),
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
  whoSaid: z.enum(WHO_SAID),
  author: z.enum(AUTHORS),
  authority: z.enum(AUTHORITIES),
  evidence: z.enum(EVIDENCE),
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
  /** `true` keeps only normative records, `false` only non-normative ones. */
  normative?: boolean
  /** Superseded records stay out of the default view; history reads them explicitly. */
  includeSuperseded?: boolean
  /** Newest first; defaults to 100 and is clamped to 1..1000. */
  limit?: number
}

/** Map the owner-authority field to the level readers see. */
export function whoSaidFromAuthority(authority: Authority): WhoSaid {
  if (authority === 'owner-original') return 'founder-original'
  if (authority === 'owner-approved') return 'founder-approved-ai'
  return 'ai-record'
}

/** Map the level readers see back to the authority it implies. */
export function authorityFromWhoSaid(whoSaid: WhoSaid): Authority {
  if (whoSaid === 'founder-original') return 'owner-original'
  if (whoSaid === 'founder-approved-ai') return 'owner-approved'
  return 'none'
}

/**
 * Classify a GitHub account by who wrote the text. Being the repository owner makes the author human, but it does
 * not by itself grant owner authority: an owner can paste an AI draft back without approving it.
 */
export function whoSaidFromAuthor(login: string, ownerLogin: string): { author: Author; authority: Authority; whoSaid: WhoSaid } {
  const author: Author = login.trim().toLowerCase() === ownerLogin.trim().toLowerCase() ? 'human' : 'ai'
  return { author, authority: 'none', whoSaid: 'ai-record' }
}

function authorityOf(parts: BaselinePart[]): Authority {
  if (parts.some(part => part.authority === 'owner-original')) return 'owner-original'
  if (parts.some(part => part.authority === 'owner-approved')) return 'owner-approved'
  return 'none'
}

function assertPart(part: BaselinePart, index: number): void {
  if (part.author === 'mixed') throw new Error(`Baseline part ${index + 1} must name one author; mixed belongs to the whole record`)
  if (!part.verbatim && !part.summary) throw new Error(`Baseline part ${index + 1} needs verbatim or summary text`)
  if (part.authority !== 'none' && part.author === 'ai') {
    throw new Error(`Baseline part ${index + 1} cannot be ${part.authority} when its author is ai`)
  }
  if (part.authority === 'owner-original' && !part.verbatim && !part.paraphrase) {
    throw new Error(`Baseline part ${index + 1} must keep the owner's verbatim words, or set paraphrase`)
  }
}

function evidenceFor(authority: Authority, author: Author, evidence?: Evidence): Evidence {
  if (evidence) {
    if (authority !== 'none' && evidence === 'inferred') {
      throw new Error(`An ${authority} record cannot be inferred; owner authority needs a stated or observed source`)
    }
    return evidence
  }
  if (authority !== 'none') return 'stated'
  return author === 'ai' ? 'inferred' : 'relayed'
}

/**
 * Normalize one input into a stored record: fill defaults, derive the Chinese label, and refuse provenance or
 * normativity that the declared level and type cannot support.
 */
export function baselineRecord(input: BaselineInput): BaselineRecord {
  const parsed = BaselineInputSchema.parse(input)
  if ((parsed.normative ?? NORMATIVE_TYPES.includes(parsed.type)) && !NORMATIVE_TYPES.includes(parsed.type)) {
    throw new Error(`A ${parsed.type} record cannot be normative; only ${NORMATIVE_TYPES.join(', ')} may be`)
  }

  let author: Author
  let authority: Authority
  let evidence: Evidence
  if (parsed.parts) {
    parsed.parts.forEach(assertPart)
    authority = authorityOf(parsed.parts)
    const authors = new Set(parsed.parts.map(part => part.author))
    author = authors.size > 1 ? 'mixed' : parsed.parts[0]!.author
    if (parsed.author !== undefined && parsed.author !== author) {
      throw new Error(`The record's author is ${author}; it cannot also be ${parsed.author}`)
    }
    if (parsed.authority !== undefined && parsed.authority !== authority) {
      throw new Error(`The record's authority is ${authority}; it cannot also be ${parsed.authority}`)
    }
    evidence = evidenceFor(authority, author, parsed.evidence)
  } else {
    authority = parsed.authority
      ?? (parsed.approvedFrom ? 'owner-approved' : undefined)
      ?? (parsed.whoSaid ? authorityFromWhoSaid(parsed.whoSaid) : 'none')
    if (parsed.approvedFrom && parsed.authority !== undefined && parsed.authority !== 'owner-approved') {
      throw new Error('approvedFrom marks an owner-approved record; it cannot be used with another authority')
    }
    author = parsed.author ?? (authority === 'none' ? 'ai' : 'human')
    if (parsed.approvedFrom && author === 'ai') {
      throw new Error('approvedFrom is the owner pasting text back, so its author must be human')
    }
    if (authority !== 'none' && author === 'ai') {
      throw new Error(`An ${authority} record cannot be written by an ai author`)
    }
    evidence = evidenceFor(authority, author, parsed.evidence)
  }

  const whoSaid = whoSaidFromAuthority(authority)
  if (parsed.whoSaid !== undefined && parsed.whoSaid !== whoSaid) {
    throw new Error(`whoSaid ${parsed.whoSaid} conflicts with authority ${authority}, which reads as ${whoSaid}`)
  }
  if (whoSaid === 'founder-original') {
    const keepsVerbatim = parsed.parts
      ? parsed.parts.some(part => part.authority === 'owner-original' && (part.verbatim || part.paraphrase))
      : Boolean(parsed.verbatim || parsed.paraphrase)
    if (!keepsVerbatim) {
      throw new Error('A founder-original record must keep the owner\'s verbatim words, or set paraphrase')
    }
  }

  const provenance: BaselineProvenance = parsed.approvedFrom
    ? {
        ...parsed.provenance,
        aiDraft: parsed.provenance.aiDraft ?? parsed.approvedFrom,
        approvedBy: parsed.provenance.approvedBy ?? parsed.provenance.source,
      }
    : parsed.provenance
  if (whoSaid === 'founder-approved-ai' && (!provenance.aiDraft || !provenance.approvedBy)) {
    throw new Error('A founder-approved-ai record must keep both the AI draft and the owner\'s approval in its provenance')
  }

  const normative = parsed.type !== 'Example'
    && (parsed.normative ?? NORMATIVE_TYPES.includes(parsed.type))
    && whoSaid !== 'ai-record'
  const createdAt = parsed.createdAt ?? new Date().toISOString()
  return {
    ...parsed,
    provenance,
    whoSaid,
    author,
    authority,
    evidence,
    whoSaidLabel: WHO_SAID_LABELS[whoSaid],
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
  const raw = value as Record<string, unknown>
  const { whoSaidLabel: _label, ...rest } = raw
  const authority: Authority = AUTHORITIES.includes(rest.authority as Authority)
    ? rest.authority as Authority
    : WHO_SAID.includes(rest.whoSaid as WhoSaid)
      ? authorityFromWhoSaid(rest.whoSaid as WhoSaid)
      : 'none'
  const whoSaid: WhoSaid = WHO_SAID.includes(rest.whoSaid as WhoSaid)
    ? rest.whoSaid as WhoSaid
    : whoSaidFromAuthority(authority)
  const parsed = BaselineRecordSchema.parse({
    author: whoSaid === 'ai-record' ? 'ai' : 'human',
    authority,
    evidence: whoSaid === 'ai-record' ? 'inferred' : 'stated',
    ...rest,
    whoSaid,
  })
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
export function promotionRefusal(record: Pick<BaselineRecord, 'whoSaid' | 'type' | 'normative' | 'status'>): string | undefined {
  if (record.status === 'superseded') return 'A superseded record cannot be promoted; promote its replacement instead'
  if (record.whoSaid === 'ai-record') {
    return 'An ai-record cannot be promoted; the owner must confirm a new founder-original or founder-approved-ai record'
  }
  if (record.type === 'Example') return 'An Example cannot be promoted; create a Decision first'
  if (!record.normative) return 'A non-normative record cannot be promoted; create a Decision first'
  return undefined
}
