#!/usr/bin/env node
/**
 * Install the Codex guard as a host-level PreToolUse hook. It writes only ~/.codex/hooks.json (or --file),
 * keeps a backup, replaces an older personal-super-agent guard, and is idempotent.
 *
 *   node integrations/codex-guard/install.mjs
 *   node integrations/codex-guard/install.mjs --file /tmp/hooks.json --dry-run
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'guard-codex.mjs')
const MATCHER = 'computer|open_application'
const OUR_COMMAND = /codex-guard\/guard-codex\.mjs|personal-super-agent/
const commandFor = script => `PAOS_CODEX_APP=com.openai.codex node '${script.replaceAll("'", `'\\''`)}'`

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function backup(file) {
  if (!fs.existsSync(file)) return null
  const target = `${file}.bak-codex-guard-${Date.now()}`
  fs.copyFileSync(file, target)
  return target
}

/** Add or refresh our one hook entry, leaving every other hook untouched. */
export function install(file = path.join(os.homedir(), '.codex', 'hooks.json'), options = {}) {
  const command = commandFor(SCRIPT)
  if (options.dryRun) return { file, backup: null, command, matcher: MATCHER, added: false }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (!fs.existsSync(file)) fs.writeFileSync(file, `${JSON.stringify({ hooks: {} }, null, 2)}\n`)
  const saved = backup(file)
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  data.hooks = data.hooks && typeof data.hooks === 'object' ? data.hooks : {}
  data.hooks.PreToolUse = Array.isArray(data.hooks.PreToolUse) ? data.hooks.PreToolUse : []
  let replaced = false
  for (const entry of data.hooks.PreToolUse) {
    if (!Array.isArray(entry?.hooks)) continue
    for (const hook of entry.hooks) {
      if (typeof hook?.command === 'string' && OUR_COMMAND.test(hook.command)) {
        hook.command = command
        hook.type = 'command'
        hook.timeout = 5
        entry.matcher = MATCHER
        replaced = true
      }
    }
  }
  if (!replaced) data.hooks.PreToolUse.push({ matcher: MATCHER, hooks: [{ type: 'command', command, timeout: 5 }] })
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
  return { file, backup: saved, command, matcher: MATCHER, added: !replaced }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = install(argument('--file') ?? undefined, { dryRun: process.argv.includes('--dry-run') })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
