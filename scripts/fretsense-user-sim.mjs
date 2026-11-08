#!/usr/bin/env node
/** Fixed read-only FretSense user simulation used by the scheduled observer role. */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { buildEnv, chooseNightlyBuild, clearPreviewOwner, ensureBuild, lastGoodBuild, networkEnv, parseScutilProxy,
  PREVIEW_OWNER, readJson, remoteMainSha, servedBuildMatches, trustedPreviewOwner,
  writePreviewOwner } from './fretsense-nightly-build.mjs'

function argsOf(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token?.startsWith('--')) continue
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${token} needs a value`)
    values[token.slice(2)] = value
    index += 1
  }
  return values
}

const args = argsOf(process.argv.slice(2))
const checkout = path.resolve(args.checkout || '')
const target = String(args.target || '')
const output = path.resolve(args.out || '')
const runId = String(args['run-id'] || '')
const timeoutMs = Math.max(30_000, Number(args['timeout-ms'] || 1_200_000))
const remote = String(args.remote || 'origin')
const branch = String(args.branch || 'main')
const buildRoot = path.resolve(args['build-root'] || path.join(output, '..'))
if (!path.isAbsolute(checkout) || !path.isAbsolute(output) || !path.isAbsolute(buildRoot)) {
  throw new Error('checkout, out and build-root must be absolute paths')
}
if (output === checkout || output.startsWith(`${checkout}${path.sep}`)) throw new Error('artifacts must stay outside the read-only checkout')
if (buildRoot === checkout || buildRoot.startsWith(`${checkout}${path.sep}`)) throw new Error('build-root must stay outside the read-only checkout')
const buildOutputs = path.join(buildRoot, 'builds')
if (output === buildRoot || output === buildOutputs || output.startsWith(`${buildOutputs}${path.sep}`)) {
  throw new Error('artifacts must stay outside the nightly build outputs')
}
if (!runId) throw new Error('run-id is required')
const url = new URL(target)
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('The role target must be a local HTTP endpoint')

const startedAt = new Date().toISOString()
const deadline = Date.parse(startedAt) + timeoutMs
const requireFromCheckout = createRequire(path.join(checkout, 'package.json'))
const git = (argv) => execFileSync('git', ['-C', checkout, ...argv], { encoding: 'utf8' }).trim()
const before = git(['status', '--porcelain'])
const commit = git(['rev-parse', 'HEAD'])
fs.mkdirSync(path.join(output, 'screenshots'), { recursive: true, mode: 0o700 })

const systemProxy = (() => {
  try { return parseScutilProxy(execFileSync('scutil', ['--proxy'], { encoding: 'utf8' })) } catch { return undefined }
})()
const netEnv = networkEnv(process.env, systemProxy)
const buildRuntimeEnv = buildEnv(process.env, systemProxy)

let remoteSha = ''
let remoteUrl = ''
let remoteError
try {
  const found = remoteMainSha({ checkout, remote, branch, env: netEnv })
  remoteSha = found.sha
  remoteUrl = found.url
} catch (error) {
  remoteError = String(error instanceof Error ? error.message : error)
}
const checkedAt = new Date().toISOString()

let buildResult
if (remoteSha) {
  try {
    buildResult = ensureBuild({ checkout, buildRoot, sha: remoteSha, remoteUrl, branch,
      env: buildRuntimeEnv, timeoutMs: Math.min(600_000, Math.max(30_000, deadline - Date.now())) })
  } catch (error) {
    buildResult = { status: 'failed', reason: `build setup crashed: ${String(error instanceof Error ? error.message : error)}` }
  }
}
const decision = chooseNightlyBuild({ remote, branch, remoteSha, remoteError, buildResult,
  lastGood: lastGoodBuild(buildRoot) })
const chosen = decision.chosen
const freshnessState = decision.state
const freshnessReason = decision.reason
const buildMeta = decision.meta

const freshness = {
  state: freshnessState,
  remoteSha,
  buildSha: chosen?.sha ?? '',
  remote: { remote, branch, url: remoteUrl, sha: remoteSha, checkedAt, ...(remoteError ? { error: remoteError } : {}) },
  build: buildMeta ? { sha: buildMeta.sha, source: chosen?.source, sourceDir: buildMeta.source,
    directory: buildMeta.directory, builtAt: buildMeta.builtAt, lockHash: buildMeta.lockHash } : null,
  reason: freshnessReason ?? null,
}

const viewport = { width: 1440, height: 900 }
const returning = () => {
  localStorage.setItem('svultra_onboarding_done', 'true')
  localStorage.setItem('fret_sense_mode_gate_done', 'true')
  localStorage.setItem('svultra_calib', JSON.stringify({ pitchOffset: 1, minRms: 0.01, phase: 'completed' }))
}
const steps = [
  { id: 'cold-start', path: '/', wait: '#root:not(:empty)', init: false },
  { id: 'home', path: '/?tab=home&viewport=desktop-full', wait: 'body', init: true, contains: ['Live Fretboard', 'Fret Sense'] },
  { id: 'note', path: '/?tab=note', wait: '[data-testid="notes-trainer-view"]', init: true },
  { id: 'interval', path: '/?tab=interval', wait: '[data-testid="intervals-trainer-view"]', init: true },
  { id: 'scale', path: '/?tab=scale', wait: '[data-testid="scales-trainer-view"]', init: true },
  { id: 'changes', path: '/?tab=changes', wait: '[data-testid="changes-trainer-view"]', init: true },
  { id: 'persona', path: '/?tab=persona&viewport=desktop-full', wait: '[data-testid="persona-view"]', init: true },
]

const port = url.port || (url.protocol === 'https:' ? '443' : '80')
const reachable = async () => {
  try { return (await fetch(target)).ok } catch { return false }
}
const listenPids = () => {
  try {
    const text = execFileSync('lsof', ['-nP', `-tiTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim()
    return text ? text.split(/\s+/).map(Number).filter(Number.isFinite) : []
  } catch { return [] }
}
const commandOf = (pid) => {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() } catch { return '' }
}
const cwdOf = (pid) => {
  try {
    const text = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
    const line = text.split(/\r?\n/).find(row => row.startsWith('n'))
    return line ? line.slice(1) : ''
  } catch { return '' }
}
const stopOwnedPreview = async (chosenBuild) => {
  const pids = listenPids()
  if (!pids.length) return { ok: true }
  const owner = readJson(path.join(buildRoot, PREVIEW_OWNER))
  const trusted = trustedPreviewOwner({ owner, buildRoot, sourceDir: chosenBuild.sourceDir, port,
    listeningPids: pids, commandOf, cwdOf })
  if (!trusted.ownedPid) {
    return { ok: false, reason: `port ${port} is held by another preview: ` +
      trusted.foreign.map(item => `${item.pid} ${item.command || item.cwd || 'unknown'}`).join('; ') }
  }
  try { process.kill(trusted.ownedPid, 'SIGTERM') } catch { /* already gone */ }
  const until = Date.now() + 5_000
  while (Date.now() < until) {
    if (!(await reachable())) { clearPreviewOwner(buildRoot, trusted.ownedPid); return { ok: true } }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return { ok: false, reason: `port ${port} still answers after stopping the owned preview` }
}

let preview
let startedPreview = false
let previewState = 'not-started'
let previewReason
async function serve(chosenBuild) {
  const link = path.join(chosenBuild.sourceDir, 'build')
  fs.rmSync(link, { recursive: true, force: true })
  fs.symlinkSync(path.relative(chosenBuild.sourceDir, chosenBuild.directory), link, 'dir')
  if (await reachable()) {
    const match = await servedBuildMatches({ target, buildDir: chosenBuild.directory, sha: chosenBuild.sha })
    if (match.match) { previewState = 'reused'; return true }
    const stopped = await stopOwnedPreview(chosenBuild)
    if (!stopped.ok) { previewState = 'conflict'; previewReason = `${match.reason}; ${stopped.reason}`; return false }
  }
  const script = path.join(chosenBuild.sourceDir, 'tools', 'serve_static_preview.mjs')
  preview = spawn(process.execPath, [script], {
    cwd: chosenBuild.sourceDir,
    env: { ...process.env, HOST: url.hostname, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (preview.pid) {
    writePreviewOwner(buildRoot, { pid: preview.pid, port, buildRoot, cwd: chosenBuild.sourceDir, script,
      startedAt: new Date().toISOString() })
  }
  let stderr = ''
  let spawnError
  preview.on('error', error => { spawnError = error })
  preview.stderr.on('data', chunk => { stderr += String(chunk) })
  const until = Date.now() + 15_000
  while (Date.now() < until) {
    if (spawnError) { previewState = 'failed'; previewReason = `preview spawn failed: ${spawnError.message}`; return false }
    if (await reachable()) {
      startedPreview = true
      const match = await servedBuildMatches({ target, buildDir: chosenBuild.directory, sha: chosenBuild.sha })
      if (!match.match) { previewState = 'mismatch'; previewReason = match.reason; return false }
      previewState = 'started'
      return true
    }
    if (preview.exitCode !== null) { previewState = 'failed'; previewReason = `preview exited: ${stderr.trim()}`; return false }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  preview.kill()
  previewState = 'timeout'
  previewReason = `preview did not answer ${target}: ${stderr.trim()}`
  return false
}

const skipped = (reason) => steps.map(spec => ({ id: spec.id, status: 'skip', durationMs: 0, reason,
  consoleErrors: [], pageErrors: [], failedRequests: [] }))

let browser
let results
let previewStarted = false
try {
  try {
    const ready = chosen ? await serve(chosen) : false
    if (!ready) {
      results = skipped((chosen
        ? `未运行路径：${previewState} ${previewReason ?? ''}`
        : `未运行路径：${freshnessReason ?? 'no build'}`).slice(0, 500))
    } else {
      previewStarted = startedPreview
      const { chromium } = requireFromCheckout('playwright')
      browser = await chromium.launch({ headless: true })
      results = []
      for (const spec of steps) {
        const started = Date.now()
        const remaining = deadline - started
        const consoleErrors = []
        const pageErrors = []
        const failedRequests = []
        if (remaining <= 0) {
          results.push({ id: spec.id, status: 'skip', durationMs: 0, reason: '20-minute role budget exhausted',
            consoleErrors, pageErrors, failedRequests })
          continue
        }
        const context = await browser.newContext({ viewport })
        if (spec.init) await context.addInitScript(returning)
        const page = await context.newPage()
        page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 1000)) })
        page.on('pageerror', error => pageErrors.push(String(error).slice(0, 1000)))
        page.on('requestfailed', request => failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ''}`.slice(0, 1000)))
        let status = 'pass'
        let reason
        try {
          await page.goto(new URL(spec.path, target).href, { waitUntil: 'domcontentloaded', timeout: Math.min(20_000, remaining) })
          await page.locator(spec.wait).first().waitFor({ state: 'attached', timeout: Math.min(20_000, deadline - Date.now()) })
          const facts = await page.evaluate(() => {
            const body = document.body
            const text = body?.innerText?.trim() ?? ''
            const root = document.querySelector('#root')
            return { text, rootChildren: root?.children.length ?? 0,
              horizontalOverflow: Math.max(document.documentElement.scrollWidth, body?.scrollWidth ?? 0)
                - Math.max(document.documentElement.clientWidth, body?.clientWidth ?? 0) }
          })
          if (facts.text.length < 10 || facts.rootChildren === 0) { status = 'fail'; reason = 'blank or empty root' }
          else if (facts.text.includes('页面出了点问题')) { status = 'fail'; reason = 'application error boundary is visible' }
          else if (spec.contains && !spec.contains.some(text => facts.text.includes(text))) {
            status = 'fail'
            reason = `expected one of: ${spec.contains.join(', ')}`
          }
          else if (facts.horizontalOverflow > 2) { status = 'fail'; reason = `horizontal overflow ${facts.horizontalOverflow}px at 1440x900` }
          else if (consoleErrors.length || pageErrors.length || failedRequests.length) {
            status = 'fail'
            reason = `${consoleErrors.length} console error(s), ${pageErrors.length} page error(s), ${failedRequests.length} failed request(s)`
          }
        } catch (error) {
          status = 'fail'
          reason = String(error instanceof Error ? error.message : error).slice(0, 1000)
        }
        const screenshot = `screenshots/${spec.id}.png`
        try { await page.screenshot({ path: path.join(output, screenshot), fullPage: false }) }
        catch (error) { if (status === 'pass') { status = 'fail'; reason = `screenshot failed: ${String(error)}` } }
        results.push({ id: spec.id, status, durationMs: Date.now() - started, screenshot, ...(reason ? { reason } : {}),
          consoleErrors, pageErrors, failedRequests })
        await context.close()
      }
    }
  } catch (error) {
    results = skipped(`角色运行失败：${String(error instanceof Error ? error.message : error)}`.slice(0, 500))
  }
  const after = git(['status', '--porcelain'])
  const report = {
    schema: 'role-run/v1',
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    target: {
      url: target,
      commit: chosen?.sha ?? '',
      build: !chosen ? 'missing' : freshnessState === 'fresh' ? 'production' : freshnessState === 'stale' ? 'stale' : 'unverified',
      ...(chosen?.directory ? { directory: chosen.directory } : {}),
      checkout,
      checkoutHead: commit,
    },
    freshness,
    viewports: [{ name: 'desktop', ...viewport }],
    steps: results,
    git: { before, after },
    limits: { durationMs: timeoutMs, issues: 1, findings: 3 },
    preview: { started: previewStarted, state: previewState, ...(previewReason ? { reason: previewReason } : {}) },
  }
  const temporary = path.join(output, 'run.json.tmp')
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, path.join(output, 'run.json'))
  process.stdout.write(`${path.join(output, 'run.json')}\n`)
} finally {
  await browser?.close().catch(() => {})
  if (preview?.pid) clearPreviewOwner(buildRoot, preview.pid)
  preview?.kill()
}
