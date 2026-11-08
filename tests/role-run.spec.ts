import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { assertRunFreshness, assertRunTested, PublishSchema, issueFingerprint, publishRoleIssue, roleIssueBody,
  type RoleRun } from '../src/app/role-run.ts'
import { RoleSpecSchema } from '../src/roles.ts'
import { buildEnv, chooseNightlyBuild, ensureBuild, firstSha, lastGoodBuild, networkEnv, parseScutilProxy, pruneBuilds,
  remoteMainSha, servedBuildMatches, writeJson, type CommandResult, type CommandRun } from '../scripts/fretsense-nightly-build.mjs'

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

const latestSha = '3c6cf73f6465c8384da22a118b7f1627fcbb8532'
const oldSha = '1e28eb13b2738703aa511cea7128445cdaeaafc8'
const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' })

describe('nightly proxy guard', () => {
  it('reads the macOS system proxy and replaces the six shell proxy variables with that same port', () => {
    const proxy = parseScutilProxy(`<dictionary> {
  HTTPEnable : 1
  HTTPPort : 12450
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 12450
  HTTPSProxy : 127.0.0.1
}`)
    expect(proxy).toEqual({ host: '127.0.0.1', port: '12450', url: 'http://127.0.0.1:12450' })
    const env = networkEnv({ HOME: '/Users/x', NO_PROXY: 'localhost', HTTP_PROXY: 'http://127.0.0.1:7897',
      https_proxy: 'http://127.0.0.1:7897', ALL_PROXY: 'http://127.0.0.1:7897' }, proxy)
    expect(env.HOME).toBe('/Users/x')
    expect(env.NO_PROXY).toBe('localhost')
    for (const key of ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']) {
      expect(env[key]).toBe('http://127.0.0.1:12450')
    }
  })

  it('treats a disabled system proxy as no proxy and keeps credentials out of the build environment', () => {
    expect(parseScutilProxy('HTTPEnable : 0\nHTTPProxy : 127.0.0.1\nHTTPPort : 7897')).toBeUndefined()
    const env = buildEnv({ PATH: '/bin', GH_TOKEN: 'secret', GITHUB_TOKEN: 'secret', NPM_TOKEN: 'secret' })
    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.NPM_TOKEN).toBeUndefined()
    expect(env.PATH).toBe('/bin')
  })
})

describe('remote main SHA', () => {
  it('asks origin for the branch ref and returns the exact SHA and URL', () => {
    const calls: string[][] = []
    const command = ((argv: string[]) => {
      calls.push(argv)
      if (argv.includes('get-url')) return ok('https://github.com/Javey-Li/FretSense.git\n')
      return ok(`${latestSha}\trefs/heads/main\n`)
    }) as CommandRun
    expect(firstSha(`abc ${latestSha} refs/heads/main`)).toBe(latestSha)
    expect(remoteMainSha({ run: command, checkout: '/tmp/checkout' }))
      .toEqual({ sha: latestSha, url: 'https://github.com/Javey-Li/FretSense.git' })
    expect(calls[1]).toEqual(['git', '-C', '/tmp/checkout', 'ls-remote', '--exit-code',
      'https://github.com/Javey-Li/FretSense.git', 'refs/heads/main'])
  })

  it('fails loudly when the remote cannot be read instead of guessing a local HEAD', () => {
    const command = ((argv: string[]) => argv.includes('get-url') ? ok('https://example.invalid/repo.git\n')
      : ({ code: 128, stdout: '', stderr: 'connection refused' })) as CommandRun
    expect(() => remoteMainSha({ run: command, checkout: '/tmp/checkout' })).toThrow('connection refused')
  })
})

function buildCommand(options: { buildCode?: number; stderr?: string } = {}) {
  const calls: string[][] = []
  const command = ((argv: string[], callOptions?: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
    calls.push(argv)
    const joined = argv.join(' ')
    if (joined.startsWith('git clone')) {
      const target = argv[argv.length - 1]!
      mkdirSync(join(target, '.git'), { recursive: true })
      writeFileSync(join(target, 'package-lock.json'), '{"lockfileVersion":3}\n')
      return ok()
    }
    if (joined.includes('cat-file')) return ok()
    if (joined.includes('checkout --detach')) return ok()
    if (joined.includes('rev-parse HEAD')) return ok(`${latestSha}\n`)
    if (joined === 'npm ci --no-audit --no-fund') {
      mkdirSync(join(callOptions!.cwd!, 'node_modules'), { recursive: true })
      return ok()
    }
    if (joined === 'npm run build') {
      if (options.buildCode) return { code: options.buildCode, stdout: '', stderr: options.stderr ?? 'build failed' }
      const output = callOptions!.env!.BUILD_PATH!
      mkdirSync(join(output, 'static', 'js'), { recursive: true })
      writeFileSync(join(output, 'index.html'), '<script src="/static/js/main.abc.js"></script>')
      writeFileSync(join(output, 'static', 'js', 'main.abc.js'), 'console.log(1)')
      return ok()
    }
    return ok()
  }) as CommandRun
  return { command, calls }
}

describe('independent build root', () => {
  it('checks out the explicit SHA, installs locked dependencies, builds, and records the build SHA', () => {
    const root = temp()
    const { command, calls } = buildCommand()
    const result = ensureBuild({ run: command, checkout: '/tmp/read-only-checkout', buildRoot: root, sha: latestSha,
      remoteUrl: 'https://example/repo.git', env: { PATH: '/bin' } })
    expect(result.status).toBe('built')
    expect(result.directory).toBe(join(root, 'builds', latestSha))
    expect(readFileSync(join(root, 'builds', latestSha, 'index.html'), 'utf8')).toContain('main.abc.js')
    expect(JSON.parse(readFileSync(join(root, 'meta', `${latestSha}.json`), 'utf8')))
      .toMatchObject({ schema: 'nightly-build/v1', sha: latestSha })
    expect(lastGoodBuild(root)).toMatchObject({ sha: latestSha, directory: join(root, 'builds', latestSha) })
    expect(calls.some(argv => argv.join(' ').includes('checkout --detach --force'))).toBe(true)
    expect(calls.some(argv => argv.join(' ') === 'npm ci --no-audit --no-fund')).toBe(true)
  })

  it('reuses a recorded build for the same SHA without installing or building again', () => {
    const root = temp()
    const first = buildCommand()
    ensureBuild({ run: first.command, checkout: '/tmp/read-only-checkout', buildRoot: root, sha: latestSha,
      remoteUrl: 'https://example/repo.git', env: { PATH: '/bin' } })
    const second = buildCommand()
    const result = ensureBuild({ run: second.command, checkout: '/tmp/read-only-checkout', buildRoot: root, sha: latestSha,
      remoteUrl: 'https://example/repo.git', env: { PATH: '/bin' } })
    expect(result.status).toBe('reused')
    expect(second.calls).toHaveLength(0)
  })

  it('reports a real build failure and does not overwrite the last good build', () => {
    const root = temp()
    mkdirSync(join(root, 'builds', oldSha), { recursive: true })
    writeFileSync(join(root, 'builds', oldSha, 'index.html'), 'old')
    writeJson(join(root, 'meta', `${oldSha}.json`), { schema: 'nightly-build/v1', sha: oldSha, lockHash: 'old',
      builtAt: '2026-11-08T00:00:00.000Z', directory: join(root, 'builds', oldSha), source: join(root, 'source') })
    writeJson(join(root, 'last-good.json'), { schema: 'nightly-build-pointer/v1', sha: oldSha,
      builtAt: '2026-11-08T00:00:00.000Z', directory: join(root, 'builds', oldSha) })
    const { command } = buildCommand({ buildCode: 1, stderr: 'Module not found: ./missing.js' })
    const result = ensureBuild({ run: command, checkout: '/tmp/read-only-checkout', buildRoot: root, sha: latestSha,
      remoteUrl: 'https://example/repo.git', env: { PATH: '/bin' } })
    expect(result.status).toBe('failed')
    expect(result.reason).toContain('npm run build exited 1')
    expect(result.reason).toContain('Module not found')
    expect(result.failure).toBeTruthy()
    expect(lastGoodBuild(root)?.sha).toBe(oldSha)
    expect(() => readFileSync(join(root, 'builds', latestSha, 'index.html'))).toThrow()
  })

  it('keeps three recent builds and never prunes the last good pointer', () => {
    const root = temp()
    for (const [index, value] of [oldSha, latestSha, 'a'.repeat(40), 'b'.repeat(40)].entries()) {
      mkdirSync(join(root, 'builds', value), { recursive: true })
      writeFileSync(join(root, 'builds', value, 'index.html'), value)
      writeJson(join(root, 'meta', `${value}.json`), { schema: 'nightly-build/v1', sha: value, lockHash: 'x',
        builtAt: `2026-11-0${index + 1}T00:00:00.000Z`, directory: join(root, 'builds', value), source: join(root, 'source') })
    }
    writeJson(join(root, 'last-good.json'), { sha: oldSha })
    expect(pruneBuilds(root, 3)).not.toContain(oldSha)
    expect(pruneBuilds(root, 2)).not.toContain(oldSha)
  })
})

describe('served build proof', () => {
  const buildDir = () => {
    const dir = temp()
    mkdirSync(join(dir, 'static', 'js'), { recursive: true })
    writeFileSync(join(dir, 'index.html'), '<script src="/static/js/main.abc.js"></script>')
    writeFileSync(join(dir, 'static', 'js', 'main.abc.js'), 'console.log(1)')
    return dir
  }
  const reply = (body: string | Uint8Array) => ({
    ok: true,
    status: 200,
    text: async () => typeof body === 'string' ? body : Buffer.from(body).toString('utf8'),
    arrayBuffer: async () => typeof body === 'string' ? Buffer.from(body) : body,
  })

  it('accepts a server that serves the exact index and hashed bundle', async () => {
    const dir = buildDir()
    const fetchImpl = (async (input: URL) => input.pathname.endsWith('.js') ? reply('console.log(1)')
      : reply('<script src="/static/js/main.abc.js"></script>')) as unknown as typeof fetch
    await expect(servedBuildMatches({ target: 'http://127.0.0.1:4173', buildDir: dir, fetchImpl }))
      .resolves.toEqual({ match: true })
  })

  it('rejects a server that still serves another build', async () => {
    const dir = buildDir()
    const fetchImpl = (async () => reply('<script src="/static/js/main.old.js"></script>')) as unknown as typeof fetch
    const result = await servedBuildMatches({ target: 'http://127.0.0.1:4173', buildDir: dir, fetchImpl })
    expect(result.match).toBe(false)
    expect(result.reason).toContain('index.html differs')
  })

  it('rejects a matching index whose bundle differs', async () => {
    const dir = buildDir()
    const fetchImpl = (async (input: URL) => input.pathname.endsWith('.js') ? reply('console.log(2)')
      : reply('<script src="/static/js/main.abc.js"></script>')) as unknown as typeof fetch
    const result = await servedBuildMatches({ target: 'http://127.0.0.1:4173', buildDir: dir, fetchImpl })
    expect(result.match).toBe(false)
    expect(result.reason).toContain('main.abc.js differs')
  })
})

type Freshness = NonNullable<RoleRun['freshness']>
const buildFreshness = (state: Freshness['state'], buildSha: string, reason?: string): Freshness => ({
  state,
  remoteSha: latestSha,
  buildSha,
  remote: { remote: 'origin', branch: 'main', url: 'https://github.com/Javey-Li/FretSense.git', sha: latestSha,
    checkedAt: '2026-11-08T17:29:00.000Z' },
  build: { sha: buildSha, source: state === 'fresh' ? 'fresh-build' : 'last-good',
    directory: `/tmp/builds/${buildSha}`, builtAt: '2026-11-08T17:32:00.000Z' },
  reason: reason ?? null,
})
function freshnessRun(value: Freshness | undefined, commit = value?.buildSha ?? ''): RoleRun {
  return { ...run, target: { ...run.target, commit }, freshness: value }
}

describe('run freshness contract', () => {
  it('accepts a fresh build that matches the remote SHA', () => {
    expect(() => assertRunFreshness(freshnessRun(buildFreshness('fresh', latestSha)))).not.toThrow()
  })

  it('rejects a fresh claim or target commit that contradicts the build SHA', () => {
    expect(() => assertRunFreshness(freshnessRun(buildFreshness('fresh', oldSha)))).toThrow('differs from origin')
    expect(() => assertRunFreshness(freshnessRun(buildFreshness('fresh', latestSha), oldSha))).toThrow('target commit differs')
  })

  it('rejects calling a current build stale', () => {
    expect(() => assertRunFreshness(freshnessRun(buildFreshness('stale', latestSha)))).toThrow('as stale')
  })

  it('refuses to present a failed or unverified build with no build SHA as a completed observation', () => {
    const failed = freshnessRun({ state: 'failed', remoteSha: latestSha, buildSha: '',
      remote: { remote: 'origin', branch: 'main', url: '', sha: latestSha, checkedAt: '' },
      build: null, reason: 'npm run build exited 1' }, '')
    expect(() => assertRunTested(failed)).toThrow('did not test a build: npm run build exited 1')
    expect(() => assertRunTested(freshnessRun(buildFreshness('stale', oldSha)))).not.toThrow()
    const legacy = { ...run }
    delete legacy.freshness
    expect(() => assertRunTested(legacy)).not.toThrow()
  })

  it('renders both SHAs and marks a stale or failed run as not latest', () => {
    const fresh = roleIssueBody(role, freshnessRun(buildFreshness('fresh', latestSha)), publish, finding, 'fp')
    expect(fresh).toContain('## 构建新鲜度')
    expect(fresh).toContain(`origin/main\`：\`${latestSha}`)
    expect(fresh).toContain(`本次实测 build：\`${latestSha}`)
    expect(fresh).not.toContain('未测最新')
    const stale = roleIssueBody(role, freshnessRun(buildFreshness('stale', oldSha,
      `远端 origin/main ${latestSha.slice(0, 12)} 构建失败：npm run build exited 1；本次实测旧 build ${oldSha.slice(0, 12)}，不是最新`)),
    publish, finding, 'fp')
    expect(stale).toContain(`origin/main\`：\`${latestSha}`)
    expect(stale).toContain(`本次实测 build：\`${oldSha}`)
    expect(stale).toContain('**未测最新**（stale）')
    expect(stale).toContain('npm run build exited 1')
    const failed = roleIssueBody(role, freshnessRun({
      state: 'failed', remoteSha: latestSha, buildSha: '',
      remote: { remote: 'origin', branch: 'main', url: '', sha: latestSha, checkedAt: '' },
      build: null, reason: '远端 origin/main 构建失败：npm ci exited 1；没有可用的 last good build，本次未测',
    }, ''), publish, finding, 'fp')
    expect(failed).toContain(`origin/main\`：\`${latestSha}`)
    expect(failed).toContain('本次实测 build：`unknown`')
    expect(failed).toContain('**未测最新**（failed）')
  })
})

describe('nightly build selection', () => {
  const meta = (value: string) => ({ schema: 'nightly-build/v1' as const, sha: value, lockHash: 'x',
    builtAt: '2026-11-08T00:00:00.000Z', directory: `/builds/${value}`, source: '/builds/source', durationMs: 1 })
  const lastGood = { ...meta(oldSha), directory: `/builds/${oldSha}` }

  it('is fresh only when the exact remote SHA was built or reused', () => {
    const fresh = chooseNightlyBuild({ remoteSha: latestSha,
      buildResult: { status: 'built', directory: `/builds/${latestSha}`, meta: meta(latestSha) } })
    expect(fresh.state).toBe('fresh')
    expect(fresh.reason).toBeNull()
    expect(fresh.chosen).toMatchObject({ sha: latestSha, source: 'fresh-build' })
    const reused = chooseNightlyBuild({ remoteSha: latestSha,
      buildResult: { status: 'reused', directory: `/builds/${latestSha}`, meta: meta(latestSha) } })
    expect(reused.chosen).toMatchObject({ sha: latestSha, source: 'reused-build' })
  })

  it('marks a last good build stale when the new SHA failed, with the real failure in the reason', () => {
    const choice = chooseNightlyBuild({ remoteSha: latestSha, lastGood,
      buildResult: { status: 'failed', reason: 'npm run build exited 1: Module not found', log: '/logs/build.log' } })
    expect(choice.state).toBe('stale')
    expect(choice.chosen).toMatchObject({ sha: oldSha, source: 'last-good' })
    expect(choice.reason).toContain('npm run build exited 1')
    expect(choice.reason).toContain('不是最新')
  })

  it('is failed with no build when the new SHA fails and there is no last good', () => {
    const choice = chooseNightlyBuild({ remoteSha: latestSha,
      buildResult: { status: 'failed', reason: 'npm ci exited 1: network' } })
    expect(choice.state).toBe('failed')
    expect(choice.chosen).toBeUndefined()
    expect(choice.reason).toContain('没有可用的 last good build')
  })

  it('is unknown when origin cannot be read, even if it falls back to a recorded build', () => {
    const choice = chooseNightlyBuild({ remoteError: 'proxy timeout', lastGood })
    expect(choice.state).toBe('unknown')
    expect(choice.chosen).toMatchObject({ sha: oldSha, source: 'last-good' })
    expect(choice.reason).toContain('无法确认')
    expect(choice.reason).toContain('无法证明是最新')
    const noBuild = chooseNightlyBuild({ remoteError: 'proxy timeout' })
    expect(noBuild.state).toBe('unknown')
    expect(noBuild.chosen).toBeUndefined()
  })
})
