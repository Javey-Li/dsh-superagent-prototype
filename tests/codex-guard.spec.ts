/** The host-level Codex guard: only computer-use and open-application calls, always pinned to the official bundle id. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CODEX_APP_PATH, CODEX_BUNDLE_ID, decide, isAppOperationTool } from '../integrations/codex-guard/guard-codex.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const INSTALLER = join(ROOT, 'integrations', 'codex-guard', 'install.mjs')
const onlyOfficial = (path: string) => path === CODEX_APP_PATH
const pinned = { PAOS_CODEX_APP: CODEX_BUNDLE_ID }

let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'codex-guard-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

it('blocks app operations that target Waves CODEX or Codex Web GPT', () => {
  for (const tool of ['computer', 'computer_use', 'computer_20250124', 'mcp__unified-computer-use__computer', 'open_application']) {
    expect(isAppOperationTool(tool), tool).toBe(true)
    expect(decide(tool, JSON.stringify({ app: 'com.WavesAudio.CODEX' }), pinned, onlyOfficial).block, tool).toBe(true)
    expect(decide(tool, JSON.stringify({ app: '/Applications/Codex Web GPT.app' }), pinned, onlyOfficial).block, tool).toBe(true)
  }
})

it('allows the official Codex app and leaves non-app tools alone', () => {
  expect(decide('open_application', JSON.stringify({ app: CODEX_BUNDLE_ID }), pinned, onlyOfficial).block).toBe(false)
  expect(decide('computer', `click ${CODEX_APP_PATH}`, pinned, onlyOfficial).block).toBe(false)
  expect(isAppOperationTool('shell')).toBe(false)
  expect(decide('shell', 'open /Applications/Waves/Applications V17/CODEX.app', pinned, onlyOfficial).block).toBe(false)
  expect(decide('open_application', JSON.stringify({ app: '/Applications/Slack.app' }), pinned, onlyOfficial).block).toBe(false)
})

it('refuses an ambiguous Codex target when no working pin resolves it', () => {
  expect(decide('open_application', JSON.stringify({ app: 'codex' }), pinned, onlyOfficial).block).toBe(false)
  expect(decide('open_application', JSON.stringify({ app: 'codex' }), pinned, () => false).block).toBe(true)
  const ambiguousEnv = { PAOS_CODEX_APP: undefined }
  const twoApps = (path: string) => path === CODEX_APP_PATH || path === '/Applications/Waves/Applications V17/CODEX.app'
  const result = decide('open_application', JSON.stringify({ app: 'codex' }), ambiguousEnv, twoApps)
  expect(result.target).toBe('ambiguous')
  expect(result.status.status).toBe('fail')
  expect(result.block).toBe(true)
})

it('installs one host hook, pins the bundle id and replaces an older personal-super-agent guard', () => {
  const file = join(directory, 'hooks.json')
  writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [
    { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo unrelated' }] },
    { matcher: '', hooks: [{ type: 'command', command: 'node /old/personal-super-agent/hooks/guard-codex.mjs' }] },
  ] } }))
  execFileSync(process.execPath, [INSTALLER, '--file', file], { cwd: ROOT, encoding: 'utf8' })
  const data = JSON.parse(readFileSync(file, 'utf8'))
  expect(data.hooks.PreToolUse).toHaveLength(2)
  expect(data.hooks.PreToolUse[0].hooks[0].command).toBe('echo unrelated')
  const guard = data.hooks.PreToolUse[1]
  expect(guard.matcher).toBe('computer|open_application')
  expect(guard.hooks[0].command).toContain(`PAOS_CODEX_APP=${CODEX_BUNDLE_ID}`)
  expect(guard.hooks[0].command).toContain('codex-guard/guard-codex.mjs')

  execFileSync(process.execPath, [INSTALLER, '--file', file], { cwd: ROOT, encoding: 'utf8' })
  expect(JSON.parse(readFileSync(file, 'utf8')).hooks.PreToolUse).toHaveLength(2)
})

it('does not write anything in a dry run', () => {
  const file = join(directory, 'missing.json')
  const output = execFileSync(process.execPath, [INSTALLER, '--file', file, '--dry-run'], { cwd: ROOT, encoding: 'utf8' })
  expect(JSON.parse(output).file).toBe(file)
  expect(existsSync(file)).toBe(false)
})
