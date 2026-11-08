import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { assertRunFreshness, assertRunTested, PublishSchema, issueFingerprint, publishRoleIssue, roleIssueBody,
  roleRunFacts, type RoleRun } from '../src/app/role-run.ts'
import { RoleSpecSchema } from '../src/roles.ts'
import { buildDirectory, buildEnv, chooseNightlyBuild, createBuildManifest, ensureBuild, firstSha, lastGoodBuild,
  networkEnv, parseScutilProxy, pruneBuilds, remoteMainSha, servedBuildMatches, trustedPreviewOwner,
  verifyBuildArtifact, writeJson, type CommandResult, type CommandRun } from '../scripts/fretsense-nightly-build.mjs'

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

function buildCommand(options: { sha?: string; buildCode?: number; stderr?: string; css?: string } = {}) {
  const builtSha = options.sha ?? latestSha
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
    if (joined.includes('rev-parse HEAD')) return ok(`${builtSha}\n`)
    if (joined === 'npm ci --no-audit --no-fund') {
      mkdirSync(join(callOptions!.cwd!, 'node_modules'), { recursive: true })
      return ok()
    }
    if (joined === 'npm run build') {
      if (options.buildCode) return { code: options.buildCode, stdout: '', stderr: options.stderr ?? 'build failed' }
      const output = callOptions!.env!.BUILD_PATH!
      mkdirSync(join(output, 'static', 'js'), { recursive: true })
      mkdirSync(join(output, 'static', 'css'), { recursive: true })
      writeFileSync(join(output, 'index.html'),
        '<!doctype html><html><head><link rel="stylesheet" href="/static/css/main.abc.css"></head>' +
        '<body><div id="root"></div><script src="/static/js/main.abc.js"></script></body></html>')
      writeFileSync(join(output, 'static', 'js', 'main.abc.js'), 'console.log(1)')
      writeFileSync(join(output, 'static', 'css', 'main.abc.css'), options.css ?? 'body{color:#111}')
      writeFileSync(join(output, 'asset-manifest.json'), JSON.stringify({ files: {
        'main.js': 'static/js/main.abc.js', 'main.css': 'static/css/main.abc.css',
      }, entrypoints: ['static/js/main.abc.js', 'static/css/main.abc.css'] }))
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
    const old = buildCommand({ sha: oldSha })
    expect(ensureBuild({ run: old.command, checkout: '/tmp/read-only-checkout', buildRoot: root, sha: oldSha,
      remoteUrl: 'https://example/repo.git', env: { PATH: '/bin' } }).status).toBe('built')
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

  it('does not trust an incomplete marker or a replaced build tree', () => {
    const root = temp()
    const first = buildCommand()
    expect(ensureBuild({ run: first.command, checkout: '/tmp/read-only-checkout', buildRoot: root, sha: latestSha,
      remoteUrl: 'https://example/repo.git', env: { PATH: '/bin' } }).status).toBe('built')
    writeJson(join(root, 'meta', `${latestSha}.json`), { schema: 'nightly-build/v1', sha: latestSha })
    const incomplete = buildCommand()
    expect(ensureBuild({ run: incomplete.command, checkout: '/tmp/read-only-checkout', buildRoot: root, sha: latestSha,
      remoteUrl: 'https://example/repo.git', env: { PATH: '/bin' } }).status).toBe('built')
    expect(incomplete.calls.some(argv => argv.join(' ') === 'npm run build')).toBe(true)

    writeFileSync(join(root, 'builds', latestSha, 'index.html'), 'tampered')
    const replaced = buildCommand()
    expect(ensureBuild({ run: replaced.command, checkout: '/tmp/read-only-checkout', buildRoot: root, sha: latestSha,
      remoteUrl: 'https://example/repo.git', env: { PATH: '/bin' } }).status).toBe('built')
    expect(replaced.calls.some(argv => argv.join(' ') === 'npm run build')).toBe(true)
    expect(verifyBuildArtifact(root, latestSha).ok).toBe(true)
  })

  it('refuses a traversing last-good SHA instead of resolving outside the build root', () => {
    const root = temp()
    const outside = temp()
    writeFileSync(join(outside, 'index.html'), '<script src="/static/js/x.js"></script>')
    writeJson(join(root, 'last-good.json'), { sha: '../../outside' })
    expect(lastGoodBuild(root)).toBeUndefined()
    expect(() => buildDirectory(root, '../../outside')).toThrow('Invalid build SHA')
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
  const index = '<!doctype html><html><head><link rel="stylesheet" href="/static/css/main.abc.css"></head>' +
    '<body><div id="root"></div><script src="/static/js/main.abc.js"></script></body></html>'
  const buildDir = (css = 'body{color:#111}') => {
    const root = temp()
    const dir = join(root, 'builds', latestSha)
    mkdirSync(join(dir, 'static', 'js'), { recursive: true })
    mkdirSync(join(dir, 'static', 'css'), { recursive: true })
    writeFileSync(join(dir, 'index.html'), index)
    writeFileSync(join(dir, 'static', 'js', 'main.abc.js'), 'console.log(1)')
    writeFileSync(join(dir, 'static', 'css', 'main.abc.css'), css)
    writeFileSync(join(dir, 'asset-manifest.json'), JSON.stringify({ entrypoints: [
      'static/js/main.abc.js', 'static/css/main.abc.css'] }))
    createBuildManifest(root, latestSha, dir)
    return dir
  }
  const reply = (body: string | Uint8Array) => ({
    ok: true,
    status: 200,
    text: async () => typeof body === 'string' ? body : Buffer.from(body).toString('utf8'),
    arrayBuffer: async () => typeof body === 'string' ? Buffer.from(body) : body,
  })
  const serve = (files: Record<string, string>) => (async (input: URL) => {
    const body = files[input.pathname.replace(/^\//, '')]
    if (body === undefined) {
      return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => Buffer.alloc(0) }
    }
    return reply(body)
  }) as unknown as typeof fetch

  it('accepts a server that serves the exact index, JS and CSS entrypoints', async () => {
    const dir = buildDir()
    await expect(servedBuildMatches({ target: 'http://127.0.0.1:4173', buildDir: dir, sha: latestSha,
      fetchImpl: serve({ 'index.html': index, 'static/js/main.abc.js': 'console.log(1)',
        'static/css/main.abc.css': 'body{color:#111}' }) })).resolves.toMatchObject({ match: true })
  })

  it('rejects a server that still serves another build', async () => {
    const dir = buildDir()
    const result = await servedBuildMatches({ target: 'http://127.0.0.1:4173', buildDir: dir, sha: latestSha,
      fetchImpl: serve({ 'index.html': '<script src="/static/js/main.old.js"></script>' }) })
    expect(result.match).toBe(false)
    expect(result.reason).toContain('index.html differs')
  })

  it('rejects a matching index and JS whose CSS differs', async () => {
    const dir = buildDir()
    const result = await servedBuildMatches({ target: 'http://127.0.0.1:4173', buildDir: dir, sha: latestSha,
      fetchImpl: serve({ 'index.html': index, 'static/js/main.abc.js': 'console.log(1)',
        'static/css/main.abc.css': 'body{color:red}' }) })
    expect(result.match).toBe(false)
    expect(result.reason).toContain('main.abc.css differs')
  })

  it('rejects a manifest without a JS entrypoint or with a missing entry file', async () => {
    const root = temp()
    const dir = join(root, 'builds', latestSha)
    mkdirSync(join(dir, 'static', 'css'), { recursive: true })
    writeFileSync(join(dir, 'index.html'), index)
    writeFileSync(join(dir, 'static', 'css', 'main.abc.css'), 'body{color:#111}')
    writeJson(join(dir, 'build-manifest.json'), { schema: 'nightly-build-manifest/v1', sha: latestSha,
      files: [], entrypoints: ['index.html', 'static/css/main.abc.css'], treeHash: 'x', fileCount: 2, createdAt: '' })
    await expect(servedBuildMatches({ target: 'http://127.0.0.1:4173', buildDir: dir, sha: latestSha,
      fetchImpl: serve({ 'index.html': index, 'static/css/main.abc.css': 'body{color:#111}' }) }))
      .resolves.toMatchObject({ match: false, reason: expect.stringContaining('no JS entrypoint') })
    writeJson(join(dir, 'build-manifest.json'), { schema: 'nightly-build-manifest/v1', sha: latestSha,
      files: [], entrypoints: ['index.html', 'static/js/missing.js'], treeHash: 'x', fileCount: 2, createdAt: '' })
    await expect(servedBuildMatches({ target: 'http://127.0.0.1:4173', buildDir: dir, sha: latestSha,
      fetchImpl: serve({ 'index.html': index }) }))
      .resolves.toMatchObject({ match: false, reason: expect.stringContaining('missing static/js/missing.js') })
  })
})

describe('preview ownership', () => {
  const buildRoot = '/tmp/nightly-build-root'
  const sourceDir = join(buildRoot, 'source')
  const script = join(sourceDir, 'tools', 'serve_static_preview.mjs')
  const owner = { schema: 'nightly-preview-owner/v1' as const, pid: 123, port: '4173', buildRoot,
    cwd: sourceDir, script }
  const commandOf = (pid: number) => pid === 123 ? `node ${script}` : `node /tmp/other/tools/serve_static_preview.mjs`
  const cwdOf = (pid: number) => pid === 123 ? sourceDir : '/tmp/other'

  it('trusts only the recorded pid with matching build root, cwd and script path', () => {
    expect(trustedPreviewOwner({ owner, buildRoot, sourceDir, port: '4173', listeningPids: [123], commandOf, cwdOf }))
      .toEqual({ ownedPid: 123, foreign: [] })
  })

  it('leaves a foreign same-named preview alive and reports it as foreign', () => {
    const result = trustedPreviewOwner({ buildRoot, sourceDir, port: '4173', listeningPids: [999], commandOf, cwdOf })
    expect(result.ownedPid).toBeUndefined()
    expect(result.foreign).toEqual([{ pid: 999, command: 'node /tmp/other/tools/serve_static_preview.mjs',
      cwd: '/tmp/other' }])
  })

  it('rejects a record whose cwd, script, build root or pid does not match', () => {
    expect(trustedPreviewOwner({ owner: { ...owner, cwd: '/tmp/other' }, buildRoot, sourceDir, port: '4173',
      listeningPids: [123], commandOf, cwdOf }).ownedPid).toBeUndefined()
    expect(trustedPreviewOwner({ owner: { ...owner, script: '/tmp/other/tools/serve_static_preview.mjs' }, buildRoot,
      sourceDir, port: '4173', listeningPids: [123], commandOf, cwdOf }).ownedPid).toBeUndefined()
    expect(trustedPreviewOwner({ owner: { ...owner, buildRoot: '/tmp/other-root' }, buildRoot, sourceDir, port: '4173',
      listeningPids: [123], commandOf, cwdOf }).ownedPid).toBeUndefined()
    expect(trustedPreviewOwner({ owner, buildRoot, sourceDir, port: '4173', listeningPids: [456], commandOf,
      cwdOf }).ownedPid).toBeUndefined()
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
  const build = !value ? run.target.build
    : value.state === 'fresh' ? 'production'
      : value.state === 'stale' ? 'stale'
        : value.state === 'unknown' && value.buildSha ? 'unverified' : 'missing'
  return { ...run, target: { ...run.target, commit, build }, freshness: value }
}

describe('run freshness contract', () => {
  it('accepts a fresh build that matches the remote SHA', () => {
    expect(() => assertRunFreshness(freshnessRun(buildFreshness('fresh', latestSha)))).not.toThrow()
  })

  it('requires non-empty, recorded remote and build SHAs for a fresh claim', () => {
    const empty = freshnessRun({ ...buildFreshness('fresh', ''), remoteSha: '' }, '')
    expect(() => assertRunFreshness(empty)).toThrow('without both remote and build SHAs')
    const noRemoteRecord = freshnessRun({ ...buildFreshness('fresh', latestSha), remote: undefined })
    expect(() => assertRunFreshness(noRemoteRecord)).toThrow('remote record does not match remoteSha')
    const noBuildRecord = freshnessRun({ ...buildFreshness('fresh', latestSha), build: null })
    expect(() => assertRunFreshness(noBuildRecord)).toThrow('build record does not match buildSha')
    const noTarget = freshnessRun(buildFreshness('fresh', latestSha), '')
    expect(() => assertRunFreshness(noTarget)).toThrow('target commit differs')
  })

  it('rejects arbitrary strings and a target.build value that contradicts the state', () => {
    const base = buildFreshness('fresh', latestSha)
    const bad = freshnessRun({ ...base, remoteSha: 'x', buildSha: 'x',
      remote: { ...base.remote!, sha: 'x' }, build: { ...base.build!, sha: 'x' } }, 'x')
    expect(() => assertRunFreshness(bad)).toThrow('not 40-hex')
    const wrongBuild = freshnessRun(buildFreshness('fresh', latestSha))
    wrongBuild.target.build = 'stale'
    expect(() => assertRunFreshness(wrongBuild)).toThrow('target.build=production')
    const staleBuild = freshnessRun(buildFreshness('stale', oldSha))
    staleBuild.target.build = 'production'
    expect(() => assertRunFreshness(staleBuild)).toThrow('target.build=stale')
    expect(() => assertRunFreshness(freshnessRun(buildFreshness('failed', oldSha))))
      .toThrow('failed state cannot carry a build SHA')
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

  it('rejects an all-skip run or one missing a fixed path even when a build SHA exists', () => {
    const allSkip = freshnessRun(buildFreshness('fresh', latestSha))
    allSkip.steps = allSkip.steps.map(step => ({ ...step, status: 'skip' as const }))
    expect(() => assertRunTested(allSkip)).toThrow('did not execute any path')
    const missing = freshnessRun(buildFreshness('fresh', latestSha))
    missing.steps = missing.steps.slice(0, 6)
    expect(() => assertRunTested(missing)).toThrow('fixed seven paths')
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

function expectLossless(value: unknown): void {
  if (value === null || value === undefined) return
  if (Array.isArray(value)) { for (const item of value) expectLossless(item); return }
  if (typeof value !== 'object') return
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    expect(item, key).not.toBeUndefined()
    expectLossless(item)
  }
}

describe('observer tool facts', () => {
  it('omits absent optional fields for a legacy run instead of emitting undefined', () => {
    const legacy: RoleRun = {
      schema: 'role-run/v1',
      runId: '2026-11-09T02:30:00+09:00',
      startedAt: '2026-11-08T17:30:00.000Z',
      finishedAt: '2026-11-08T17:35:00.000Z',
      target: { url: 'http://127.0.0.1:4173', commit: '', build: 'missing' },
      viewports: [],
      steps: [{ id: 'cold-start', status: 'pass', consoleErrors: [], pageErrors: [], failedRequests: [] }],
      limits: {},
    }
    const facts = roleRunFacts(legacy, '/tmp/run')
    expect(Object.hasOwn(facts, 'freshness')).toBe(false)
    expect(Object.hasOwn(facts, 'git')).toBe(false)
    expect(Object.hasOwn(facts.steps[0]!, 'duration_ms')).toBe(false)
    expect(Object.hasOwn(facts.steps[0]!, 'screenshot')).toBe(false)
    expect(Object.hasOwn(facts.steps[0]!, 'reason')).toBe(false)
    expectLossless(facts)
    expect(JSON.parse(JSON.stringify(facts))).toEqual(facts)
  })

  it('includes freshness only when a run has it, and stays lossless JSON', () => {
    const facts = roleRunFacts(freshnessRun(buildFreshness('fresh', latestSha)), '/tmp/run')
    expect(Object.hasOwn(facts, 'freshness')).toBe(true)
    expect(facts.freshness).toMatchObject({ state: 'fresh', remoteSha: latestSha, buildSha: latestSha })
    expectLossless(facts)
    expect(JSON.parse(JSON.stringify(facts))).toEqual(facts)
  })
})

describe('nightly build selection', () => {
  const meta = (value: string) => ({ schema: 'nightly-build/v1' as const, sha: value, lockHash: 'a'.repeat(64),
    builtAt: '2026-11-08T00:00:00.000Z', directory: `/builds/${value}`, source: '/builds/source', durationMs: 1,
    manifestHash: 'b'.repeat(64), entrypoints: ['index.html', 'static/js/main.js'], fileCount: 2 })
  const lastGood = { ...meta(oldSha), directory: `/builds/${oldSha}` }

  it('is fresh only when the exact remote SHA was built or reused', () => {
    const fresh = chooseNightlyBuild({ remoteSha: latestSha,
      buildResult: { status: 'built', verified: true, directory: `/builds/${latestSha}`, meta: meta(latestSha) } })
    expect(fresh.state).toBe('fresh')
    expect(fresh.reason).toBeNull()
    expect(fresh.chosen).toMatchObject({ sha: latestSha, source: 'fresh-build' })
    const reused = chooseNightlyBuild({ remoteSha: latestSha,
      buildResult: { status: 'reused', verified: true, directory: `/builds/${latestSha}`, meta: meta(latestSha) } })
    expect(reused.chosen).toMatchObject({ sha: latestSha, source: 'reused-build' })
  })

  it('does not treat a built or reused result without artifact verification as fresh', () => {
    const unverified = chooseNightlyBuild({ remoteSha: latestSha, lastGood,
      buildResult: { status: 'built', directory: `/builds/${latestSha}`, meta: meta(latestSha) } })
    expect(unverified.state).toBe('stale')
    expect(unverified.reason).toContain('未通过产物校验')
    const failed = chooseNightlyBuild({ remoteSha: latestSha,
      buildResult: { status: 'reused', directory: `/builds/${latestSha}`, meta: meta(latestSha) } })
    expect(failed.state).toBe('failed')
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
