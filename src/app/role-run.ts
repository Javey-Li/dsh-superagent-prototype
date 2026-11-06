/** Fixed role-run and GitHub publication boundaries used by the observer executor. */
import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Ticket, Trigger } from '../core/index.ts'
import { runAsWorker, sameDirectory } from '../infra/environment.ts'
import { packagePath } from '../infra/paths.ts'
import { roleSpecForTicket, type RoleSpec } from '../roles.ts'

const StepSchema = z.object({
  id: z.string(),
  status: z.enum(['pass', 'fail', 'skip']),
  durationMs: z.number().nonnegative().optional(),
  screenshot: z.string().optional(),
  reason: z.string().optional(),
  consoleErrors: z.array(z.string()).default([]),
  pageErrors: z.array(z.string()).default([]),
  failedRequests: z.array(z.string()).default([]),
}).passthrough()
export const RoleRunSchema = z.object({
  schema: z.literal('role-run/v1'),
  runId: z.string().min(1),
  startedAt: z.string(),
  finishedAt: z.string(),
  target: z.object({ url: z.string(), commit: z.string().default(''), build: z.string().default('') }).passthrough(),
  viewports: z.array(z.record(z.string(), z.unknown())).default([]),
  steps: z.array(StepSchema).min(1),
  git: z.object({ before: z.string(), after: z.string() }).optional(),
  limits: z.record(z.string(), z.unknown()).default({}),
}).passthrough()
export type RoleRun = z.infer<typeof RoleRunSchema>

export const FindingSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2', 'P3']),
  title: z.string().trim().min(1).max(160),
  area: z.string().trim().min(1).max(80),
  evidence: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  repro: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  expected: z.string().trim().min(1).max(1000),
  actual: z.string().trim().min(1).max(1000),
  userImpact: z.string().trim().min(1).max(1000),
  confidence: z.number().min(0).max(1),
}).strict()
export type Finding = z.infer<typeof FindingSchema>
export const IdeaSchema = z.object({
  title: z.string().trim().min(1).max(160),
  evidence: z.string().trim().min(1).max(1000),
  whyNow: z.string().trim().min(1).max(1000),
}).strict()
export const PublishSchema = z.object({
  summary: z.string().trim().min(1).max(2000),
  findings: z.array(FindingSchema).min(1),
  ideas: z.array(IdeaSchema).max(2).default([]),
}).strict()
export type Publish = z.infer<typeof PublishSchema>

export interface RoleRunHost {
  readonly subprocess: SubprocessRuntime
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)
/** Resolve the role configuration and immutable slot for a ticket. */
export function roleForTicket(ticket: Ticket, trigger: (id: string) => Trigger | undefined) {
  const spec = roleSpecForTicket(ticket, trigger)
  if (!spec) throw new Error('This ticket is not a configured scheduled role')
  const origin = trigger(ticket.origin.triggerId)
  const slot = typeof origin?.meta.slot === 'string' ? origin.meta.slot
    : ticket.origin.triggerId.slice(-64).replace(/[^A-Za-z0-9._+-]/g, '-')
  return { spec, slot, directory: join(spec.artifactRoot, spec.id, slot.replaceAll(':', '-').replaceAll('/', '-')) }
}

/** Run the fixed FretSense seven-path browser runner once for a role slot; artifacts stay outside the read-only checkout. */
export async function runRoleSimulation(host: RoleRunHost, spec: RoleSpec, slot: string, directory: string, signal: AbortSignal): Promise<RoleRun> {
  const file = join(directory, 'run.json')
  if (await exists(file)) return RoleRunSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const timeoutMs = spec.limits.durationMinutes * 60_000
  const script = packagePath('scripts', 'fretsense-user-sim.mjs')
  await runAsWorker(host.subprocess, [process.execPath, script, '--checkout', spec.checkout, '--target', spec.target,
    '--out', directory, '--run-id', slot, '--timeout-ms', String(timeoutMs)], spec.checkout,
  AbortSignal.any([signal, AbortSignal.timeout(timeoutMs + 30_000)]))
  const parsed = RoleRunSchema.parse(JSON.parse(await readFile(file, 'utf8')))
  if (parsed.runId !== slot) throw new Error('The role runner returned a different run id')
  if (parsed.git && parsed.git.before !== parsed.git.after) throw new Error('The role runner changed its read-only checkout')
  return parsed
}

const normalize = (value: string): string => value.toLocaleLowerCase('en-US').replace(/[`*_#>[\]()]/g, '').replace(/\s+/g, ' ').trim()
/** Stable duplicate fingerprint: the same area, normalized title and repro is one finding across nightly runs. */
export function issueFingerprint(finding: Pick<Finding, 'area' | 'title'> & Partial<Pick<Finding, 'repro'>>): string {
  const repro = (finding.repro ?? []).map(normalize).join('|')
  return createHash('sha256').update(`${normalize(finding.area)}|${normalize(finding.title)}|${repro}`).digest('hex').slice(0, 16)
}

const marker = (fingerprint: string): string => `<!-- user-sim-fingerprint: ${fingerprint} -->`
export function roleIssueTitle(prefix: string, day: string, finding: Finding): string {
  return `${prefix} ${day} 夜间体验：${finding.title}`.slice(0, 240)
}

/** Render the deterministic Issue body; `whoSaid` cannot be omitted by the model. */
export function roleIssueBody(spec: RoleSpec, run: RoleRun, publish: Publish, finding: Finding, fingerprint: string): string {
  const check = (step: RoleRun['steps'][number]) => `- [${step.status === 'pass' ? 'x' : ' '}] ${step.id}${step.status === 'skip' ? '（跳过）' : ''}`
  const evidence = finding.evidence.map(item => `- ${item}`).join('\n')
  const repro = finding.repro.map((item, index) => `${index + 1}. ${item}`).join('\n')
  const ideas = publish.ideas.length ? publish.ideas.map(item => `- **${item.title}**。证据：${item.evidence}。为什么现在：${item.whyNow}`).join('\n') : '- 无'
  return [
    '<!-- whoSaid: ai-record -->',
    marker(fingerprint),
    '',
    '> AI 的记录（不是主人的决定）',
    `> 角色：${spec.project} 模拟用户`,
    `> run: ${run.runId}`,
    `> 目标：${run.target.url} @ ${run.target.commit || 'unknown'}`,
    '',
    '## 一句话',
    '',
    publish.summary,
    '',
    '## 覆盖',
    '',
    ...run.steps.map(check),
    '',
    '## 发现（最多 3 条）',
    '',
    `### ${finding.severity} · ${finding.title}`,
    '',
    `- 范围：${finding.area}`,
    '- 复现：',
    repro,
    `- 预期：${finding.expected}`,
    `- 实际：${finding.actual}`,
    `- 用户影响：${finding.userImpact}`,
    `- 置信度：${finding.confidence}`,
    '- 证据：',
    evidence,
    '',
    '## 新功能想法（最多 2 条）',
    '',
    ideas,
    '',
    '## 未测',
    '',
    '- 真实麦克风、真实吉他、音频准确率：本 run 未使用真实设备。',
  ].join('\n')
}

interface Issue { number: number; title: string; body: string; url: string }
const gh = async (host: RoleRunHost, spec: RoleSpec, cwd: string, args: string[], signal: AbortSignal): Promise<string> => {
  const operator = join(homedir(), '.config', 'gh')
  if (sameDirectory(spec.github.configDir, operator)) throw new Error('The role must use its own agent GH_CONFIG_DIR, never the operator\'s')
  const argv = ['env', '-u', 'GH_TOKEN', '-u', 'GITHUB_TOKEN', `GH_CONFIG_DIR=${spec.github.configDir}`,
    'GH_PROMPT_DISABLED=1', spec.github.cli, ...args]
  return runAsWorker(host.subprocess, argv, cwd, AbortSignal.any([signal, AbortSignal.timeout(60_000)]))
}

/** Publish at most one Issue for this role slot, as the configured agent account and after checking open duplicates. */
export async function publishRoleIssue(host: RoleRunHost, spec: RoleSpec, run: RoleRun, directory: string, publish: Publish,
  signal: AbortSignal): Promise<{ url: string; created: boolean; duplicate?: string }> {
  if (spec.limits.maxIssues < 1) throw new Error('This role is configured not to open Issues')
  if (publish.findings.length > spec.limits.maxFindings) throw new Error(`At most ${spec.limits.maxFindings} findings may be published`)
  const [finding] = publish.findings
  if (!finding) throw new Error('A finding is required to publish an Issue')
  const reportFile = join(directory, 'role-report.json')
  const issueFile = join(directory, 'issue.json')
  if (await exists(issueFile)) {
    const saved = JSON.parse(await readFile(issueFile, 'utf8')) as { url: string }
    return { url: saved.url, created: false }
  }
  const login = (await gh(host, spec, directory, ['api', 'user', '--jq', '.login'], signal)).trim()
  if (login !== spec.github.login) throw new Error(`The role GitHub CLI is @${login || 'unknown'}, not @${spec.github.login}`)
  const fingerprint = issueFingerprint(finding)
  const listed = JSON.parse(await gh(host, spec, directory, ['issue', 'list', '-R', spec.github.repository, '--state', 'open',
    '--limit', '100', '--json', 'number,title,body,url'], signal)) as Issue[]
  const duplicate = listed.find(issue => issue.body.includes(marker(fingerprint)))
  if (duplicate) {
    await writeFile(reportFile, JSON.stringify({ schema: 'role-report/v1', role: spec.id, runId: run.runId, whoSaid: 'ai-record',
      state: 'dropped', duplicateOf: duplicate.url, ...publish }, null, 2))
    return { url: duplicate.url, created: false, duplicate: duplicate.url }
  }
  const day = /^\d{4}-\d{2}-\d{2}/.test(run.runId) ? run.runId.slice(0, 10) : run.startedAt.slice(0, 10)
  const title = roleIssueTitle('[AI 模拟用户]', day, finding)
  const body = roleIssueBody(spec, run, publish, finding, fingerprint)
  await writeFile(reportFile, JSON.stringify({ schema: 'role-report/v1', role: spec.id, runId: run.runId, whoSaid: 'ai-record',
    state: 'ready', target: run.target, coverage: run.steps.map(step => ({ path: step.id, status: step.status })), ...publish }, null, 2))
  const stdout = await gh(host, spec, directory, ['issue', 'create', '-R', spec.github.repository, '--title', title, '--body', body], signal)
  const url = /https:\/\/github\.com\/\S+\/issues\/\d+/.exec(stdout)?.[0]
  if (!url) throw new Error(`GitHub did not return an Issue URL: ${stdout.slice(0, 300)}`)
  await writeFile(issueFile, JSON.stringify({ url, created: true, at: new Date().toISOString(), nonce: randomUUID() }, null, 2))
  return { url, created: true }
}
