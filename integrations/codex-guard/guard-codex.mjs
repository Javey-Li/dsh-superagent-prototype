#!/usr/bin/env node
/**
 * Host-level Codex guard: refuses computer-use and open-application calls that target the wrong Codex app.
 * The installer pins PAOS_CODEX_APP=com.openai.codex, so ambiguity is judged against that one bundle id.
 */
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

export const CODEX_BUNDLE_ID = 'com.openai.codex'
export const CODEX_APP_PATH = '/Applications/ChatGPT.app'
export const CODEX_APP_CANDIDATES = [
  { path: CODEX_APP_PATH, bundleId: CODEX_BUNDLE_ID, label: 'ChatGPT (official Codex)' },
  { path: '/Applications/Codex Web GPT.app', bundleId: 'dev.codexwebgpt.launcher', label: 'Codex Web GPT (third party)' },
  { path: '/Applications/Waves/Applications V17/CODEX.app', bundleId: 'com.WavesAudio.CODEX', label: 'Waves CODEX (audio plug-in)' },
]

const APP_TOOL = /(^|[^a-z])(computer|computer_use|cua|open_application|open_app|launch_app|launch_application|openapplication)([^a-z]|$)/i
const CODEX_RELATED = /codex|chatgpt\.app|com\.openai\.codex|wavesaudio|codex web gpt/i
const WRONG_TARGET = /com\.wavesaudio\.codex|dev\.codexwebgpt\.launcher|\/Applications\/Waves\/.*CODEX\.app|codex web gpt/i
const CORRECT_TARGET = /com\.openai\.codex|\/Applications\/ChatGPT\.app|chatgpt\.app/i

/** Whether a tool name is a computer-use or open-application operation, including namespaced MCP names. */
export function isAppOperationTool(toolName) {
  return APP_TOOL.test(toolName)
}

/** Whether the request mentions Codex at all; unrelated app launches are never the guard's business. */
export function isCodexRelated(raw) {
  return CODEX_RELATED.test(raw)
}

/** Classify the app named by a request as the wrong Codex app, the official one, or something ambiguous. */
export function classifyTarget(raw) {
  if (WRONG_TARGET.test(raw)) return 'wrong'
  if (CORRECT_TARGET.test(raw)) return 'correct'
  return 'ambiguous'
}

/**
 * Check the configured Codex app. A pin is authoritative: the guard never falls back to a different app.
 * Without a pin, presence decides; more than one candidate stays an error until the installer's pin is present.
 */
export function checkCodexApp(env = process.env, exists = fs.existsSync) {
  const pin = env.PAOS_CODEX_APP?.trim()
  if (pin) {
    const candidate = CODEX_APP_CANDIDATES.find(item => item.bundleId === pin)
    const path = pin.startsWith('/') ? pin : candidate?.path
    if (!path) return { status: 'fail', detail: `PAOS_CODEX_APP names an unknown app: ${pin}`, pinned: true }
    if (!exists(path)) return { status: 'fail', detail: `PAOS_CODEX_APP points to a missing app: ${path}`, pinned: true }
    return { status: 'pass', detail: `Pinned to ${pin} at ${path}`, resolution: path, bundleId: candidate?.bundleId ?? pin, pinned: true }
  }

  const present = CODEX_APP_CANDIDATES.filter(item => exists(item.path))
  if (!present.length) return { status: 'fail', detail: 'No Codex app bundle was found' }
  if (present.length === 1) {
    return { status: 'pass', detail: `Only Codex app: ${present[0].label} (${present[0].bundleId})`,
      resolution: present[0].path, bundleId: present[0].bundleId }
  }
  const preferred = present.find(item => item.bundleId === CODEX_BUNDLE_ID)
  return { status: 'fail', detail: `Codex is ambiguous: ${present.map(item => `${item.label}(${item.bundleId})`).join(' | ')}. Pin PAOS_CODEX_APP=com.openai.codex`,
    candidates: present, preferredBundleId: CODEX_BUNDLE_ID, preferredResolution: preferred?.path ?? null }
}

/**
 * Decide one request. Only computer-use and open-application tools are considered. A wrong Codex app is always
 * refused; an ambiguous Codex target is refused whenever the configured app does not resolve.
 */
export function decide(toolName, inputText, env = process.env, exists = fs.existsSync) {
  const status = checkCodexApp(env, exists)
  const target = classifyTarget(`${toolName} ${inputText}`)
  const related = isAppOperationTool(toolName) && isCodexRelated(`${toolName} ${inputText}`)
  const block = related && (target === 'wrong' || (target === 'ambiguous' && status.status === 'fail'))
  const detail = target === 'wrong'
    ? `This call targets Waves CODEX or Codex Web GPT, not ${CODEX_BUNDLE_ID}. Use ${CODEX_BUNDLE_ID} or ${CODEX_APP_PATH}.`
    : status.detail
  return { block, target, status, detail }
}

function readStdin() {
  if (process.stdin.isTTY) return ''
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

/** Read one hook payload from stdin and exit 2 when the call must be refused. */
export function main() {
  const raw = readStdin()
  let toolName = ''
  let inputText = raw
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      toolName = parsed.tool_name ?? parsed.toolName ?? ''
      const input = parsed.tool_input ?? parsed.input ?? {}
      inputText = typeof input === 'string' ? input : JSON.stringify(input)
    } catch {
      inputText = raw
    }
  }
  const result = decide(toolName, inputText)
  if (!result.block) process.exit(0)
  process.stderr.write(`\n[codex-guard] ${result.detail}\n`)
  process.exit(2)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
