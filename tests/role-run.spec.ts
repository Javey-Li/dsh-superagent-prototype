import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { PublishSchema, issueFingerprint, publishRoleIssue, roleIssueBody, type RoleRun } from '../src/app/role-run.ts'
import { RoleSpecSchema } from '../src/roles.ts'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'role-run-')); dirs.push(dir); return dir }
const role = RoleSpecSchema.parse({
  id: 'fretsense-user-sim',
  project: 'FretSense',
  policyRule: 'fretsense-user-sim',
  executorProfile: 'observer',
  instructions: 'Run the fixed seven paths and publish at most one Issue.',
  target: 'http://127.0.0.1:4173',
  checkout: '/tmp/fretsense-readonly',
  artifactRoot: '/tmp/fretsense-role-runs',
  github: { repository: 'Javey-Li/FretSense', cli: 'gh', configDir: temp(), login: 'javey-agent' },
})
const finding = { severity: 'P2' as const, title: 'Chords 主卡与状态条在 1440×900 重叠', area: 'Chords',
  evidence: ['screenshots/changes.png'], repro: ['打开 /?tab=changes', '等待训练器加载'],
  expected: '主卡与状态条不重叠', actual: '状态条压住主卡下沿', userImpact: '用户看不清当前状态', confidence: 0.82 }
const publish = PublishSchema.parse({ summary: 'Chords 在 1440×900 下有一个布局重叠，其余路径可用。', findings: [finding],
  ideas: [{ title: 'Chords 增加前后对比预览', evidence: '比较两个和弦需要来回切换', whyNow: '不改变训练语义' }] })
const run: RoleRun = {
  schema: 'role-run/v1',
  runId: '2026-11-07T02-30+09-00',
  startedAt: '2026-11-06T17:30:00.000Z',
  finishedAt: '2026-11-06T17:36:00.000Z',
  target: { url: 'http://127.0.0.1:4173', commit: 'abc1234', build: 'production' },
  viewports: [{ name: 'desktop', width: 1440, height: 900 }],
  steps: ['cold-start', 'home', 'note', 'interval', 'scale', 'changes', 'persona'].map((id, index) => ({
    id, status: id === 'changes' ? 'fail' as const : 'pass' as const, durationMs: 100 + index,
    ...(id === 'changes' ? { reason: 'horizontal overflow 24px' } : {}),
    consoleErrors: [], pageErrors: [], failedRequests: [],
  })),
  git: { before: '', after: '' },
  limits: { durationMs: 1_200_000, issues: 1, findings: 3 },
}

function subprocess(result: (argv: string[]) => string) {
  const calls: string[][] = []
  const value = {
    spawn: vi.fn(({ argv }: { argv: string[] }) => {
      calls.push(argv)
      const text = result(argv)
      const reader = (content: string) => ({ readFrom: () => ({ text: content, nextOffset: content.length, lossy: false }) })
      return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: reader(text), stderr: reader('') } }
    }),
  } as unknown as SubprocessRuntime
  return { value, calls }
}

describe('role-run publication', () => {
  it('renders whoSaid, the fingerprint, seven-path coverage and the untested audio boundary itself', () => {
    const fingerprint = issueFingerprint(finding)
    expect(fingerprint).toBe(issueFingerprint({ area: ' chords ', title: '**Chords 主卡与状态条在 1440×900 重叠**',
      repro: ['**打开 /?tab=changes**', '等待训练器加载 '] }))
    const body = roleIssueBody(role, run, publish, finding, fingerprint)
    expect(body).toContain('<!-- whoSaid: ai-record -->')
    expect(body).toContain(`<!-- user-sim-fingerprint: ${fingerprint} -->`)
    expect(body).toContain('- [ ] changes')
    expect(body).toContain('真实麦克风、真实吉他、音频准确率：本 run 未使用真实设备。')
    expect(body.match(/- \[[ x]\] /g)).toHaveLength(7)
  })

  it('checks the agent account, lists duplicates, creates one Issue, and caches the result for this run', async () => {
    const directory = temp()
    const fake = subprocess(argv => {
      const joined = argv.join(' ')
      if (joined.includes('api user')) return 'javey-agent\n'
      if (joined.includes('issue list')) return '[]'
      if (joined.includes('issue create')) return 'https://github.com/Javey-Li/FretSense/issues/42\n'
      return ''
    })
    const first = await publishRoleIssue({ subprocess: fake.value }, role, run, directory, publish, new AbortController().signal)
    expect(first).toEqual({ url: 'https://github.com/Javey-Li/FretSense/issues/42', created: true })
    const create = fake.calls.find(argv => argv.includes('create'))!
    expect(create).toEqual(expect.arrayContaining(['GH_CONFIG_DIR=' + role.github.configDir, 'gh', 'issue', 'create',
      '-R', 'Javey-Li/FretSense']))
    expect(create.join('\n')).toContain('<!-- whoSaid: ai-record -->')
    expect(JSON.parse(readFileSync(join(directory, 'issue.json'), 'utf8'))).toMatchObject({ url: first.url, created: true })
    const calls = fake.calls.length
    expect(await publishRoleIssue({ subprocess: fake.value }, role, run, directory, publish, new AbortController().signal))
      .toEqual({ url: first.url, created: false })
    expect(fake.calls).toHaveLength(calls)
  })

  it('refuses a different GitHub account, a duplicate fingerprint, and more than the configured findings', async () => {
    const directory = temp()
    const wrong = subprocess(() => 'Javey-Li\n')
    await expect(publishRoleIssue({ subprocess: wrong.value }, role, run, directory, publish, new AbortController().signal))
      .rejects.toThrow('not @javey-agent')
    const duplicate = subprocess(argv => argv.join(' ').includes('api user') ? 'javey-agent\n'
      : JSON.stringify([{ number: 7, title: 'old', url: 'https://github.com/Javey-Li/FretSense/issues/7',
        body: `<!-- user-sim-fingerprint: ${issueFingerprint(finding)} -->` }]))
    expect(await publishRoleIssue({ subprocess: duplicate.value }, role, run, temp(), publish, new AbortController().signal))
      .toMatchObject({ created: false, duplicate: 'https://github.com/Javey-Li/FretSense/issues/7' })
    const excessive = { ...publish, findings: [finding, finding, finding, finding] }
    await expect(publishRoleIssue({ subprocess: wrong.value }, role, run, temp(), excessive, new AbortController().signal))
      .rejects.toThrow('At most 3 findings')
  })
})
