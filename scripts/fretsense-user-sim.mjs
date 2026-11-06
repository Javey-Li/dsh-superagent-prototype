#!/usr/bin/env node
/** Fixed read-only FretSense user simulation used by the scheduled observer role. */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

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
if (!path.isAbsolute(checkout) || !path.isAbsolute(output)) throw new Error('checkout and out must be absolute paths')
if (output === checkout || output.startsWith(`${checkout}${path.sep}`)) throw new Error('artifacts must stay outside the read-only checkout')
if (!runId) throw new Error('run-id is required')
const url = new URL(target)
if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('The role target must be a local HTTP endpoint')
if (!fs.existsSync(path.join(checkout, 'build', 'index.html'))) throw new Error(`Missing ${path.join(checkout, 'build', 'index.html')}`)

const requireFromCheckout = createRequire(path.join(checkout, 'package.json'))
const { chromium } = requireFromCheckout('playwright')
const git = (argv) => execFileSync('git', ['-C', checkout, ...argv], { encoding: 'utf8' }).trim()
const before = git(['status', '--porcelain'])
const commit = git(['rev-parse', 'HEAD'])
fs.mkdirSync(path.join(output, 'screenshots'), { recursive: true, mode: 0o700 })

let preview
async function reachable() {
  try { return (await fetch(target)).ok } catch { return false }
}
async function previewServer() {
  if (await reachable()) return false
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  preview = spawn(process.execPath, [path.join(checkout, 'tools', 'serve_static_preview.mjs')], {
    cwd: checkout,
    env: { ...process.env, HOST: url.hostname, PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  preview.stderr.on('data', chunk => { stderr += String(chunk) })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await reachable()) return true
    if (preview.exitCode !== null) throw new Error(`Preview server exited: ${stderr.trim()}`)
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  preview.kill()
  throw new Error(`Preview server did not answer ${target}: ${stderr.trim()}`)
}

const deadline = Date.now() + timeoutMs
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

let browser
try {
  const startedPreview = await previewServer()
  browser = await chromium.launch({ headless: true })
  const results = []
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
  const after = git(['status', '--porcelain'])
  const report = {
    schema: 'role-run/v1',
    runId,
    startedAt: new Date(deadline - timeoutMs).toISOString(),
    finishedAt: new Date().toISOString(),
    target: { url: target, commit, build: fs.existsSync(path.join(checkout, 'build', 'index.html')) ? 'production' : 'missing' },
    viewports: [{ name: 'desktop', ...viewport }],
    steps: results,
    git: { before, after },
    limits: { durationMs: timeoutMs, issues: 1, findings: 3 },
    preview: { started: startedPreview },
  }
  const temporary = path.join(output, 'run.json.tmp')
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, path.join(output, 'run.json'))
  process.stdout.write(`${path.join(output, 'run.json')}\n`)
} finally {
  await browser?.close().catch(() => {})
  preview?.kill()
}
