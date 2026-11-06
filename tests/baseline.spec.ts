/** Baseline records in SQLite: the three whoSaid levels, provenance, project queries and the promotion rules. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { WHO_SAID_LABELS, whoSaidFromAuthor, type BaselineInput } from '../src/app/baseline.ts'

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'baseline-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const original = (overrides: Partial<BaselineInput> = {}): BaselineInput => ({
  id: 'b1',
  projectId: 'fretsense',
  type: 'Decision',
  title: 'Fret Sense stays Web-only',
  claim: 'Fret Sense is a Web product; no desktop or Electron direction.',
  whoSaid: 'founder-original',
  verbatim: 'Fret Sense 是 Web-only，不做桌面和 Electron。',
  provenance: { source: 'conversation:2026-11-07', at: '2026-11-07' },
  ...overrides,
})
const approved = (overrides: Partial<BaselineInput> = {}): BaselineInput => original({
  id: 'b2',
  title: 'Use the existing deck grammar',
  claim: 'Extend the existing deck grammar rather than redesigning it.',
  whoSaid: 'founder-approved-ai',
  provenance: { source: 'conversation:2026-11-07', aiDraft: 'Keep the existing deck grammar.', approvedBy: '就这么办' },
  ...overrides,
})
const recorded = (overrides: Partial<BaselineInput> = {}): BaselineInput => original({
  id: 'b3',
  title: 'Possible release date',
  claim: 'A release in December may be possible.',
  whoSaid: 'ai-record',
  provenance: { source: 'conversation:2026-11-07' },
  ...overrides,
})

it('keeps the three whoSaid levels with their labels and queries them by project and level', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.baseline.save(original())
  store.baseline.save(approved())
  store.baseline.save(recorded())
  store.baseline.save(original({ id: 'other', projectId: 'guitar-os' }))

  expect(store.baseline.get('b1')?.whoSaidLabel).toBe(WHO_SAID_LABELS['founder-original'])
  expect(store.baseline.get('b2')?.whoSaidLabel).toBe(WHO_SAID_LABELS['founder-approved-ai'])
  expect(store.baseline.get('b3')?.whoSaidLabel).toBe(WHO_SAID_LABELS['ai-record'])

  expect(store.baseline.list({ projectId: 'fretsense' }).map(record => record.id).sort()).toEqual(['b1', 'b2', 'b3'])
  expect(store.baseline.list({ whoSaid: 'ai-record' }).map(record => record.id)).toEqual(['b3'])
  expect(store.baseline.list({ projectId: 'fretsense', whoSaid: 'founder-original' }).map(record => record.id)).toEqual(['b1'])
  expect(store.baseline.list({ projectId: 'guitar-os' }).map(record => record.id)).toEqual(['other'])
  expect(store.baseline.list({ projectId: 'missing' })).toEqual([])
  store.close()
})

it('fills type defaults and keeps records across a reopen', () => {
  const path = join(directory, 'orchestrator.sqlite')
  const store = new Store(path)
  store.baseline.save(original())
  store.baseline.save(recorded({ id: 'failure', type: 'Failure', title: 'Lost a take', claim: 'The first take was lost.' }))
  expect([store.baseline.get('b1')?.ttlDays, store.baseline.get('failure')?.ttlDays]).toEqual([90, 365])
  store.close()

  const reopened = new Store(path)
  expect(reopened.baseline.get('b1')).toEqual(expect.objectContaining({ projectId: 'fretsense', whoSaid: 'founder-original',
    whoSaidLabel: WHO_SAID_LABELS['founder-original'] }))
  reopened.close()
})

it('refuses to promote an AI record, or to rewrite it as the owner\'s word', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.baseline.save(recorded())
  expect(() => store.baseline.promote('b3')).toThrow(/ai-record cannot be promoted/)
  expect(store.baseline.get('b3')?.status).toBe('active')
  expect(() => store.baseline.save(recorded({ whoSaid: 'founder-original', verbatim: '主人的原话' })))
    .toThrow(/whoSaid never changes in place/)
  expect(store.baseline.get('b3')?.whoSaid).toBe('ai-record')
  store.close()
})

it('refuses to promote an Example or a non-normative record', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.baseline.save(original({ id: 'example', type: 'Example', title: 'An example', claim: 'One example from a past session.' }))
  store.baseline.save(original({ id: 'loose', normative: false, title: 'A loose note', claim: 'A note without normative weight.' }))
  expect(() => store.baseline.promote('example')).toThrow(/Example cannot be promoted/)
  expect(() => store.baseline.promote('loose')).toThrow(/non-normative record cannot be promoted/)
  expect(() => store.baseline.save(original({ id: 'wrong', type: 'Example', normative: true }))).toThrow(/cannot be normative/)
  store.close()
})

it('promotes an owner-supported normative record and is idempotent', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.baseline.save(original())
  const promoted = store.baseline.promote('b1')
  expect(promoted.status).toBe('promoted')
  expect(store.baseline.list({ status: 'promoted' }).map(record => record.id)).toEqual(['b1'])
  expect(store.baseline.promote('b1')).toEqual(promoted)
  store.close()
})

it('requires provenance, and an AI draft plus owner approval for founder-approved-ai', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  expect(() => store.baseline.save(original({ provenance: { source: '' } }))).toThrow()
  expect(() => store.baseline.save(approved({ provenance: { source: 'conversation:2026-11-07', approvedBy: '就这么办' } })))
    .toThrow(/AI draft/)
  expect(() => store.baseline.save(approved({ provenance: { source: 'conversation:2026-11-07', aiDraft: 'Keep it.' } })))
    .toThrow(/owner's approval/)
  store.close()
})

it('keeps an AI-written Decision non-normative and out of normative queries', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const decision = store.baseline.save(recorded({
    id: 'ai-decision',
    type: 'Decision',
    title: 'A release may happen in December',
    claim: 'A release in December may be possible.',
    normative: true,
  }))
  expect(decision.whoSaid).toBe('ai-record')
  expect(decision.normative).toBe(false)
  expect(() => store.baseline.promote('ai-decision')).toThrow(/ai-record cannot be promoted/)
  store.baseline.save(original({ id: 'owner-decision' }))
  expect(store.baseline.list({ normative: true }).map(record => record.id)).toEqual(['owner-decision'])
  expect(store.baseline.list({ normative: false }).map(record => record.id)).toEqual(['ai-decision'])
  store.close()
})

it('refuses a founder-approved-ai record without provenance', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  expect(() => store.baseline.save(approved({ provenance: undefined as never }))).toThrow()
  expect(() => store.baseline.save(approved({ provenance: null as never }))).toThrow()
  store.close()
})

it('reads text the owner pasted back from an AI draft as founder-approved-ai', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const pasted = store.baseline.save(original({
    id: 'pasted',
    whoSaid: undefined,
    verbatim: undefined,
    approvedFrom: 'https://github.com/Javey-Li/FretSense/issues/5#issuecomment-1',
    title: 'Use the Dm7-G7-CMaj7 route',
    claim: 'Use the Dm7-G7-CMaj7 route for the Delicacy example.',
  }))
  expect(pasted.whoSaid).toBe('founder-approved-ai')
  expect(pasted.whoSaidLabel).toBe('你认可的 AI 建议')
  expect(pasted.author).toBe('human')
  expect(pasted.authority).toBe('owner-approved')
  expect(pasted.provenance.aiDraft).toBe('https://github.com/Javey-Li/FretSense/issues/5#issuecomment-1')
  expect(pasted.provenance.approvedBy).toBe('conversation:2026-11-07')
  store.close()
})

it('derives a mixed-author record from each part and keeps both parts separate', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  const mixed = store.baseline.save(original({
    id: 'mixed',
    whoSaid: undefined,
    verbatim: undefined,
    title: 'Keep the deck grammar and add one component',
    claim: 'Keep the existing deck grammar, and add a component with real interaction.',
    parts: [
      { author: 'human', authority: 'owner-original', evidence: 'stated', verbatim: '保留现在的 deck 语法，再加一个有交互的组件。' },
      { author: 'ai', authority: 'none', evidence: 'inferred', summary: '建议先复用现有 deck 结构，再补组件。' },
    ],
  }))
  expect(mixed.author).toBe('mixed')
  expect(mixed.authority).toBe('owner-original')
  expect(mixed.whoSaid).toBe('founder-original')
  expect(mixed.normative).toBe(true)
  expect(mixed.parts?.map(part => [part.author, part.authority])).toEqual([['human', 'owner-original'], ['ai', 'none']])
  expect(whoSaidFromAuthor('Javey-Li', 'Javey-Li')).toEqual({ author: 'human', authority: 'none', whoSaid: 'ai-record' })
  store.close()
})

it('shows a global record to every project', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.baseline.save(original({ id: 'global', projectId: '*', title: 'One router per project', claim: 'Each project gets its own router.' }))
  store.baseline.save(original({ id: 'local', projectId: 'fretsense' }))
  expect(store.baseline.list({ projectId: 'fretsense' }).map(record => record.id).sort()).toEqual(['global', 'local'])
  expect(store.baseline.list({ projectId: 'guitar-os' }).map(record => record.id)).toEqual(['global'])
  expect(store.baseline.list({ projectId: '*' }).map(record => record.id)).toEqual(['global'])
  store.close()
})

it('hides a superseded record by default and keeps the supersedes link both ways', () => {
  const store = new Store(join(directory, 'orchestrator.sqlite'))
  store.baseline.save(original({ id: 'old', title: 'Concurrency is 15', claim: 'Concurrency stays at 15.' }))
  store.baseline.save(original({ id: 'new', title: 'Concurrency may be 20', claim: 'Raise concurrency to 20.',
    supersedes: 'old' }))
  expect(store.baseline.get('old')?.status).toBe('superseded')
  expect(store.baseline.get('new')?.supersedes).toBe('old')
  expect(store.baseline.list().map(record => record.id)).toEqual(['new'])
  expect(store.baseline.list({ includeSuperseded: true }).map(record => record.id).sort()).toEqual(['new', 'old'])
  expect(store.baseline.list({ status: 'superseded' }).map(record => record.id)).toEqual(['old'])
  expect(() => store.baseline.promote('old')).toThrow(/superseded record cannot be promoted/)

  store.baseline.save(original({ id: 'older', title: 'Concurrency is 10', claim: 'Concurrency stays at 10.' }))
  store.baseline.save(original({ id: 'newer', title: 'Concurrency is 18', claim: 'Concurrency rises to 18.' }))
  const linked = store.baseline.supersede('older', 'newer')
  expect(linked.superseded.status).toBe('superseded')
  expect(linked.replacement.supersedes).toBe('older')
  expect(store.baseline.list().map(record => record.id).sort()).toEqual(['new', 'newer'])
  store.close()
})
