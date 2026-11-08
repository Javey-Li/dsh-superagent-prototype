/** Builds the exact origin/main commit the nightly FretSense observer should test.
 *
 * The observer checkout is read-only. This module keeps a separate build root, checks out the
 * explicit remote SHA there, installs the locked dependencies and records a build SHA marker.
 * A failed build never falls back silently: callers get `failed` and may use a recorded
 * last-good build only after marking it stale.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const PROXY_ENV_KEYS = ['http_proxy', 'https_proxy', 'all_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY']
const SHA = /^[0-9a-f]{40}$/
const HASH = /^[0-9a-f]{64}$/
export const BUILD_MANIFEST = 'build-manifest.json'
export const PREVIEW_OWNER = 'preview-owner.json'

/** Read the enabled macOS system proxy. The shell proxy may point at another port, so callers strip it. */
export function parseScutilProxy(text) {
  const values = {}
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9]+)\s*:\s*(.*?)\s*$/)
    if (match) values[match[1]] = match[2]
  }
  const enabled = values.HTTPEnable === '1' || values.HTTPSEnable === '1' || values.SOCKSEnable === '1'
  const host = values.HTTPSProxy || values.HTTPProxy || values.SOCKSProxy
  const port = values.HTTPSPort || values.HTTPPort || values.SOCKSPort
  if (!enabled || !host || !port) return undefined
  return { host, port, url: `http://${host}:${port}` }
}

function withoutAmbientCredentials(env) {
  const clean = { ...env }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN']) delete clean[key]
  return clean
}

/** Strip all six shell proxy variables and, when scutil reports a proxy, use that single port. */
export function networkEnv(base = process.env, systemProxy) {
  const env = withoutAmbientCredentials(base)
  for (const key of PROXY_ENV_KEYS) delete env[key]
  if (!systemProxy) return env
  for (const key of PROXY_ENV_KEYS) env[key] = systemProxy.url
  return env
}

/** A build must not inherit tokens, but still needs the system proxy for the locked dependency install. */
export function buildEnv(base = process.env, systemProxy) {
  return {
    ...networkEnv(base, systemProxy),
    NO_UPDATE_NOTIFIER: '1',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_config_update_notifier: 'false',
  }
}

/** Run a command without throwing; callers decide whether a non-zero exit is a failure. */
export function defaultRun(argv, options = {}) {
  try {
    const stdout = execFileSync(argv[0], argv.slice(1), {
      cwd: options.cwd,
      env: options.env,
      encoding: 'utf8',
      timeout: options.timeout,
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, stdout, stderr: '' }
  } catch (error) {
    return {
      code: typeof error.status === 'number' ? error.status : -1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message ?? ''),
      signal: error.signal ?? null,
    }
  }
}

export function firstSha(text) {
  const match = String(text).match(/\b([0-9a-f]{40})\b/)
  return match?.[1]
}

/** Ask origin for the current main SHA. The caller supplies an environment that follows the proxy guard. */
export function remoteMainSha({ run = defaultRun, checkout, remote = 'origin', branch = 'main', env }) {
  const url = run(['git', '-C', checkout, 'remote', 'get-url', remote], { env, timeout: 30_000 })
  if (url.code !== 0) throw new Error(`Cannot read ${remote} from ${checkout}: ${tailOf(url.stderr) || `exit ${url.code}`}`)
  const remoteUrl = url.stdout.trim()
  const result = run(['git', '-C', checkout, 'ls-remote', '--exit-code', remoteUrl, `refs/heads/${branch}`],
    { env, timeout: 60_000 })
  if (result.code !== 0) {
    throw new Error(`git ls-remote ${remote}/${branch} failed: ${tailOf(result.stderr) || `exit ${result.code}`}`)
  }
  const sha = firstSha(result.stdout)
  if (!sha) throw new Error(`git ls-remote ${remote}/${branch} returned no SHA`)
  return { sha, url: remoteUrl }
}

export function tailOf(text, lines = 4) {
  const rows = String(text ?? '').trim().split(/\r?\n/).filter(Boolean)
  return rows.slice(-lines).join(' | ').slice(0, 800)
}

export function fileHash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return undefined }
}

/** Write a file through a temporary sibling so readers never see a half-written marker. */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

export const isBuildSha = value => typeof value === 'string' && SHA.test(value)
const isHash = value => typeof value === 'string' && HASH.test(value)

function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function samePath(a, b) {
  try { return fs.realpathSync(a) === fs.realpathSync(b) } catch { return path.resolve(a) === path.resolve(b) }
}

/** Build paths are derived from a validated 40-hex SHA; a pointer can never traverse outside the build root. */
export function buildDirectory(buildRoot, sha) {
  if (!isBuildSha(sha)) throw new Error(`Invalid build SHA: ${sha}`)
  return path.join(buildRoot, 'builds', sha)
}

export function buildMetaFile(buildRoot, sha) {
  if (!isBuildSha(sha)) throw new Error(`Invalid build SHA: ${sha}`)
  return path.join(buildRoot, 'meta', `${sha}.json`)
}

/** A marker is usable only when every field is present, typed and pointed at this build root. */
export function readBuildMeta(buildRoot, sha) {
  if (!isBuildSha(sha)) return undefined
  const meta = readJson(buildMetaFile(buildRoot, sha))
  if (!meta || meta.schema !== 'nightly-build/v1' || meta.sha !== sha) return undefined
  if (!isHash(meta.lockHash) || !isHash(meta.manifestHash)) return undefined
  if (typeof meta.builtAt !== 'string' || Number.isNaN(Date.parse(meta.builtAt))) return undefined
  if (typeof meta.directory !== 'string' || !samePath(meta.directory, buildDirectory(buildRoot, sha))) return undefined
  if (typeof meta.source !== 'string' || !samePath(meta.source, path.join(buildRoot, 'source'))) return undefined
  if (!Number.isFinite(meta.durationMs) || meta.durationMs < 0) return undefined
  if (!Number.isInteger(meta.fileCount) || meta.fileCount < 1) return undefined
  if (!Array.isArray(meta.entrypoints) || !meta.entrypoints.length || !meta.entrypoints.includes('index.html')
    || !meta.entrypoints.every(entry => typeof entry === 'string')) return undefined
  return meta
}

function walkBuild(directory) {
  const files = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`build contains a symlink: ${path.relative(directory, full)}`)
      if (entry.isDirectory()) { visit(full); continue }
      if (!entry.isFile()) throw new Error(`build contains a non-file entry: ${path.relative(directory, full)}`)
      const relative = path.relative(directory, full).split(path.sep).join('/')
      if (relative === BUILD_MANIFEST) continue
      files.push({ path: relative, size: fs.statSync(full).size, sha256: fileHash(full) })
    }
  }
  visit(directory)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

const treeHash = files => createHash('sha256').update(JSON.stringify(files)).digest('hex')

function entrypointPath(value) {
  const clean = String(value).split('?')[0].split('#')[0].replace(/^\/+/, '')
  if (!clean || clean.startsWith('..') || path.isAbsolute(clean)) return undefined
  if (!/\.(?:js|css)$/i.test(clean)) return undefined
  return clean
}

function buildEntrypoints(directory, files) {
  const present = new Set(files.map(file => file.path))
  const found = new Set()
  const add = (value) => {
    const entry = entrypointPath(value)
    if (entry) found.add(entry)
  }
  const index = fs.readFileSync(path.join(directory, 'index.html'), 'utf8')
  for (const match of index.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi)) add(match[1])
  for (const match of index.matchAll(/<link\b[^>]*\bhref\s*=\s*"([^"]+)"/gi)) add(match[1])
  const assetManifest = readJson(path.join(directory, 'asset-manifest.json'))
  if (Array.isArray(assetManifest?.entrypoints)) for (const entry of assetManifest.entrypoints) add(entry)
  for (const entry of found) {
    if (!present.has(entry)) throw new Error(`build entrypoint is missing: ${entry}`)
  }
  if (![...found].some(entry => entry.endsWith('.js'))) throw new Error('build has no verifiable JS entrypoint')
  return ['index.html', ...[...found].sort()]
}

/** Hash the actual successful build output. The manifest is written inside the build directory. */
export function createBuildManifest(buildRoot, sha, directory) {
  if (!isBuildSha(sha)) throw new Error(`Invalid build SHA: ${sha}`)
  if (!samePath(directory, buildDirectory(buildRoot, sha))) throw new Error('build directory is not the trusted SHA path')
  const files = walkBuild(directory)
  if (!files.some(file => file.path === 'index.html')) throw new Error('build has no index.html')
  const entrypoints = buildEntrypoints(directory, files)
  const manifest = {
    schema: 'nightly-build-manifest/v1',
    sha,
    files,
    entrypoints,
    treeHash: treeHash(files),
    fileCount: files.length,
    createdAt: new Date().toISOString(),
  }
  writeJson(path.join(directory, BUILD_MANIFEST), manifest)
  return manifest
}

/** Recompute the cached build tree and compare it to the manifest and marker. */
export function verifyBuildArtifact(buildRoot, sha, meta = readBuildMeta(buildRoot, sha)) {
  if (!meta || !isBuildSha(sha) || meta.sha !== sha) return { ok: false, reason: 'missing or invalid build marker' }
  let directory
  try { directory = buildDirectory(buildRoot, sha) } catch (error) { return { ok: false, reason: String(error) } }
  const manifest = readJson(path.join(directory, BUILD_MANIFEST))
  if (!manifest || manifest.schema !== 'nightly-build-manifest/v1' || manifest.sha !== sha) {
    return { ok: false, reason: 'missing or invalid build manifest' }
  }
  if (!Array.isArray(manifest.files) || !manifest.files.length) return { ok: false, reason: 'build manifest has no files' }
  if (!manifest.entrypoints || !Array.isArray(manifest.entrypoints) || !manifest.entrypoints.includes('index.html')) {
    return { ok: false, reason: 'build manifest has no index entrypoint' }
  }
  if (!manifest.entrypoints.some(entry => String(entry).endsWith('.js'))) {
    return { ok: false, reason: 'build manifest has no JS entrypoint' }
  }
  let actual
  try { actual = walkBuild(directory) } catch (error) { return { ok: false, reason: `build tree is not readable: ${String(error)}` } }
  const actualHash = treeHash(actual)
  if (actualHash !== manifest.treeHash || actualHash !== meta.manifestHash) {
    return { ok: false, reason: 'build content hash differs from the marker' }
  }
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    return { ok: false, reason: 'build file list differs from the manifest' }
  }
  const filePaths = new Set(actual.map(file => file.path))
  if (!manifest.entrypoints.every(entry => typeof entry === 'string' && filePaths.has(entry))) {
    return { ok: false, reason: 'build manifest references a missing entrypoint' }
  }
  if (JSON.stringify(manifest.entrypoints) !== JSON.stringify(meta.entrypoints)) {
    return { ok: false, reason: 'build entrypoints differ from the marker' }
  }
  if (manifest.fileCount !== meta.fileCount || actual.length !== meta.fileCount) {
    return { ok: false, reason: 'build file count differs from the marker' }
  }
  return { ok: true, manifest }
}

/** The newest successful build this runner produced; its SHA is reported when it is not origin/main. */
export function lastGoodBuild(buildRoot) {
  const pointer = readJson(path.join(buildRoot, 'last-good.json'))
  if (!isBuildSha(pointer?.sha)) return undefined
  const meta = readBuildMeta(buildRoot, pointer.sha)
  if (!meta) return undefined
  if (!verifyBuildArtifact(buildRoot, pointer.sha, meta).ok) return undefined
  return { ...meta, directory: buildDirectory(buildRoot, pointer.sha) }
}

/**
 * Decide which build the run may test. A failed or unreadable remote never becomes `fresh`;
 * a last good build is usable only as an explicit `stale`/`unknown` observation.
 */
export function chooseNightlyBuild({ remote = 'origin', branch = 'main', remoteSha, remoteError, buildResult, lastGood }) {
  if (remoteSha) {
    if ((buildResult?.status === 'built' || buildResult?.status === 'reused') && buildResult.verified === true) {
      return {
        state: 'fresh',
        meta: buildResult.meta,
        chosen: { sha: remoteSha, directory: buildResult.directory, sourceDir: buildResult.meta?.source,
          source: buildResult.status === 'reused' ? 'reused-build' : 'fresh-build' },
        reason: null,
      }
    }
    const detail = buildResult?.status === 'built' || buildResult?.status === 'reused'
      ? '构建结果未通过产物校验'
      : buildResult?.reason ?? 'unknown'
    const reason = `远端 ${remote}/${branch} ${remoteSha.slice(0, 12)} 构建失败：${detail}` +
      (buildResult?.log ? `；日志：${buildResult.log}` : '')
    if (lastGood) {
      return {
        state: 'stale',
        meta: lastGood,
        chosen: { sha: lastGood.sha, directory: lastGood.directory, sourceDir: lastGood.source, source: 'last-good' },
        reason: `${reason}；本次实测旧 build ${lastGood.sha.slice(0, 12)}，不是最新`,
      }
    }
    return { state: 'failed', meta: undefined, chosen: undefined, reason: `${reason}；没有可用的 last good build，本次未测` }
  }
  const reason = `无法确认 ${remote}/${branch} 最新 SHA：${remoteError ?? 'unknown error'}`
  if (lastGood) {
    return {
      state: 'unknown',
      meta: lastGood,
      chosen: { sha: lastGood.sha, directory: lastGood.directory, sourceDir: lastGood.source, source: 'last-good' },
      reason: `${reason}；本次实测 build ${lastGood.sha.slice(0, 12)}，无法证明是最新`,
    }
  }
  return { state: 'unknown', meta: undefined, chosen: undefined, reason: `${reason}；没有可用的 build，本次未测` }
}

/** Keep only the newest successful build outputs so the nightly machine does not grow without bound. */
export function pruneBuilds(buildRoot, keep = 3) {
  const builds = path.join(buildRoot, 'builds')
  let entries
  try { entries = fs.readdirSync(builds, { withFileTypes: true }) } catch { return [] }
  const protectedSha = readJson(path.join(buildRoot, 'last-good.json'))?.sha
  const rows = entries.filter(entry => entry.isDirectory() && SHA.test(entry.name))
    .map(entry => ({ sha: entry.name, meta: readBuildMeta(buildRoot, entry.name) }))
    .sort((a, b) => String(b.meta?.builtAt ?? '').localeCompare(String(a.meta?.builtAt ?? '')))
  const removed = []
  for (const row of rows.slice(Math.max(0, keep))) {
    if (row.sha === protectedSha) continue
    fs.rmSync(path.join(builds, row.sha), { recursive: true, force: true })
    fs.rmSync(buildMetaFile(buildRoot, row.sha), { force: true })
    removed.push(row.sha)
  }
  return removed
}

function writeFailure(buildRoot, sha, failure) {
  const file = path.join(buildRoot, 'failures', `${sha}-${Date.now()}.json`)
  writeJson(file, { schema: 'nightly-build-failure/v1', sha, at: new Date().toISOString(), ...failure })
  return file
}

/**
 * Check out `sha` in a build-only clone, install `package-lock.json` dependencies and build there.
 * The read-only observer checkout is only used as a local object source, never modified.
 */
export function ensureBuild({ run = defaultRun, checkout, buildRoot, sha, remoteUrl, branch = 'main', env, timeoutMs = 600_000 }) {
  if (!SHA.test(sha)) return { status: 'failed', reason: `Invalid build SHA: ${sha}` }
  const started = Date.now()
  const deadline = started + Math.max(30_000, timeoutMs)
  const left = () => Math.max(1_000, deadline - Date.now())
  const logs = []
  const log = line => { logs.push(line) }
  const finish = (status, extra = {}) => {
    const logFile = path.join(buildRoot, 'logs', `${sha}-${started}.log`)
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 })
    fs.writeFileSync(logFile, `${logs.join('\n')}\n`, { mode: 0o600 })
    return { status, log: logFile, ...extra }
  }
  const fail = (step, result, extra = {}) => {
    const reason = `${step} ${result?.code === 0 ? 'did not produce a build' : `exited ${result?.code ?? 'unknown'}`}` +
      (tailOf(result?.stderr) ? `: ${tailOf(result.stderr)}` : '')
    const failureFile = writeFailure(buildRoot, sha, { step, code: result?.code ?? null,
      stderr: tailOf(result?.stderr, 20), stdout: tailOf(result?.stdout, 20) })
    fs.rmSync(buildDirectory(buildRoot, sha), { recursive: true, force: true })
    fs.rmSync(buildMetaFile(buildRoot, sha), { force: true })
    log(`${step} failed: ${reason}`)
    return finish('failed', { sha, reason, failure: failureFile, ...extra })
  }

  const existing = readBuildMeta(buildRoot, sha)
  const directory = buildDirectory(buildRoot, sha)
  if (existing) {
    if (verifyBuildArtifact(buildRoot, sha, existing).ok) {
      return { status: 'reused', verified: true, sha, directory, meta: existing }
    }
    fs.rmSync(directory, { recursive: true, force: true })
    fs.rmSync(buildMetaFile(buildRoot, sha), { force: true })
  }

  fs.mkdirSync(buildRoot, { recursive: true, mode: 0o700 })
  const sourceDir = path.join(buildRoot, 'source')
  if (!fs.existsSync(path.join(sourceDir, '.git'))) {
    fs.rmSync(sourceDir, { recursive: true, force: true })
    const clone = run(['git', 'clone', '--no-checkout', checkout, sourceDir], { env, timeout: Math.min(120_000, left()) })
    if (clone.code !== 0) return fail('git clone', clone)
  }
  const present = run(['git', '-C', sourceDir, 'cat-file', '-e', `${sha}^{commit}`], { env, timeout: 15_000 })
  if (present.code !== 0) {
    let fetch = run(['git', '-C', sourceDir, 'fetch', '--depth', '1', remoteUrl, sha], { env, timeout: Math.min(180_000, left()) })
    if (fetch.code !== 0) {
      fetch = run(['git', '-C', sourceDir, 'fetch', '--depth', '1', remoteUrl, `refs/heads/${branch}`],
        { env, timeout: Math.min(180_000, left()) })
    }
    if (fetch.code !== 0) return fail('git fetch', fetch)
  }
  const checkedOut = run(['git', '-C', sourceDir, 'checkout', '--detach', '--force', sha], { env, timeout: 60_000 })
  if (checkedOut.code !== 0) return fail('git checkout', checkedOut)
  const head = run(['git', '-C', sourceDir, 'rev-parse', 'HEAD'], { env, timeout: 30_000 })
  if (head.code !== 0 || head.stdout.trim() !== sha) {
    return fail('git checkout', { code: head.code, stderr: `HEAD ${head.stdout.trim() || 'unknown'} != ${sha}` })
  }
  // Remove ignored build leftovers and untracked files from earlier checkouts, but keep the installed dependencies.
  const cleaned = run(['git', '-C', sourceDir, 'clean', '-ffdx', '-e', 'node_modules'], { env, timeout: 60_000 })
  if (cleaned.code !== 0) return fail('git clean', cleaned)

  const lock = fileHash(path.join(sourceDir, 'package-lock.json'))
  const depsFile = path.join(buildRoot, 'deps.json')
  const installed = readJson(depsFile)
  if (!fs.existsSync(path.join(sourceDir, 'node_modules')) || installed?.lockHash !== lock) {
    const ci = run(['npm', 'ci', '--no-audit', '--no-fund'], { cwd: sourceDir, env, timeout: Math.min(480_000, left()) })
    if (ci.code !== 0) return fail('npm ci', ci)
    writeJson(depsFile, { lockHash: lock, installedAt: new Date().toISOString() })
  }

  fs.rmSync(directory, { recursive: true, force: true })
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const build = run(['npm', 'run', 'build'], {
    cwd: sourceDir,
    env: { ...env, BUILD_PATH: directory },
    timeout: Math.min(600_000, left()),
  })
  if (build.code !== 0 || !fs.existsSync(path.join(directory, 'index.html'))) return fail('npm run build', build)

  let manifest
  try { manifest = createBuildManifest(buildRoot, sha, directory) }
  catch (error) { return fail('build manifest', { code: 1, stderr: String(error instanceof Error ? error.message : error) }) }
  const meta = {
    schema: 'nightly-build/v1',
    sha,
    lockHash: lock,
    builtAt: new Date().toISOString(),
    directory,
    source: sourceDir,
    durationMs: Date.now() - started,
    manifestHash: manifest.treeHash,
    entrypoints: manifest.entrypoints,
    fileCount: manifest.fileCount,
  }
  writeJson(buildMetaFile(buildRoot, sha), meta)
  writeJson(path.join(buildRoot, 'last-good.json'), { schema: 'nightly-build-pointer/v1', sha, builtAt: meta.builtAt, directory })
  pruneBuilds(buildRoot)
  return finish('built', { sha, directory, meta, verified: true })
}

/**
 * Prove the preview serves the exact build. Compare every manifest entrypoint (index, all JS/CSS),
 * and never match when the manifest has no JS entry. A replaced CSS/chunk therefore cannot pass.
 */
export async function servedBuildMatches({ target, buildDir, sha, fetchImpl = fetch }) {
  if (!isBuildSha(sha)) return { match: false, reason: `invalid build SHA: ${sha}` }
  const manifest = readJson(path.join(buildDir, BUILD_MANIFEST))
  if (!manifest || manifest.schema !== 'nightly-build-manifest/v1' || manifest.sha !== sha) {
    return { match: false, reason: 'missing or invalid build manifest' }
  }
  if (!Array.isArray(manifest.entrypoints) || !manifest.entrypoints.includes('index.html')) {
    return { match: false, reason: 'build manifest has no index entrypoint' }
  }
  if (!manifest.entrypoints.some(entry => String(entry).endsWith('.js'))) {
    return { match: false, reason: 'build manifest has no JS entrypoint' }
  }
  for (const entry of manifest.entrypoints) {
    if (typeof entry !== 'string' || entry.startsWith('..') || path.isAbsolute(entry)) {
      return { match: false, reason: `invalid entrypoint: ${entry}` }
    }
    const local = path.join(buildDir, entry)
    if (!inside(buildDir, local) || !fs.existsSync(local)) return { match: false, reason: `missing ${entry}` }
    let response
    try { response = await fetchImpl(new URL(`/${entry}`, target)) }
    catch (error) { return { match: false, reason: `cannot fetch ${entry}: ${String(error)}` } }
    if (!response.ok) return { match: false, reason: `${entry} answered ${response.status}` }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.equals(fs.readFileSync(local))) return { match: false, reason: `served ${entry} differs from the build` }
  }
  return { match: true, entrypoints: manifest.entrypoints }
}

/** Owner records let the runner stop only the preview it started, never a foreign same-named script. */
export function writePreviewOwner(buildRoot, owner) {
  writeJson(path.join(buildRoot, PREVIEW_OWNER), { schema: 'nightly-preview-owner/v1', ...owner })
}

export function clearPreviewOwner(buildRoot, pid) {
  const file = path.join(buildRoot, PREVIEW_OWNER)
  const owner = readJson(file)
  if (owner?.pid === pid) fs.rmSync(file, { force: true })
}

export function trustedPreviewOwner({ owner, buildRoot, sourceDir, port, listeningPids = [], commandOf = () => '',
  cwdOf = () => '' }) {
  const expectedScript = path.join(sourceDir, 'tools', 'serve_static_preview.mjs')
  const trusted = owner?.schema === 'nightly-preview-owner/v1'
    && Number.isInteger(owner.pid) && owner.pid > 0
    && String(owner.port) === String(port)
    && samePath(owner.buildRoot, buildRoot)
    && samePath(owner.cwd, sourceDir)
    && samePath(owner.script, expectedScript)
    && inside(buildRoot, sourceDir)
    && Array.isArray(listeningPids) && listeningPids.length === 1 && listeningPids[0] === owner.pid
    && commandOf(owner.pid).includes(expectedScript)
    && samePath(cwdOf(owner.pid), sourceDir)
  if (trusted) return { ownedPid: owner.pid, foreign: [] }
  return {
    ownedPid: undefined,
    foreign: listeningPids.map(pid => ({ pid, command: commandOf(pid), cwd: cwdOf(pid) })),
  }
}
