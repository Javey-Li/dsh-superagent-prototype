/** Baseline records in SQLite: the three whoSaid levels, provenance, project queries and the promotion rules. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { WHO_SAID_LABELS, type BaselineInput } from '../src/app/baseline.ts'

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
  expect(() => store.baseline.save(recorded({ whoSaid: 'founder-original' }))).toThrow(/whoSaid never changes in place/)
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
