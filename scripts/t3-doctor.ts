#!/usr/bin/env node
/** Diagnose the local T3, GitHub identity, Magpie, and DSH pieces the T3 executor needs. */
import { humanT3Report, runT3Doctor } from '../src/executor/t3.ts'

function flags(argv: string[]): Record<string, string | true> {
  const parsed: Record<string, string | true> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[index + 1]
    if (key === 'json' || key === 'help') parsed[key] = true
    else if (next && !next.startsWith('--')) { parsed[key] = next; index += 1 }
    else parsed[key] = true
  }
  return parsed
}

const parsed = flags(process.argv.slice(2))
if (parsed.help) {
  console.log('usage: node --experimental-strip-types scripts/t3-doctor.ts [--json] [--project <path>] [--t3-bin <path>] [--magpie-url <url>] '
    + '[--account <login>] [--state-dir <path>] [--gh-config-dir <path>] [--gh-cli <path>]')
} else {
  const report = await runT3Doctor({
    t3Project: typeof parsed.project === 'string' ? parsed.project : process.cwd(),
    ...(typeof parsed['t3-bin'] === 'string' ? { t3Bin: parsed['t3-bin'] } : {}),
    ...(typeof parsed['magpie-url'] === 'string' ? { magpieUrl: parsed['magpie-url'] } : {}),
    ...(typeof parsed.account === 'string' ? { expectedLogin: parsed.account } : {}),
    ...(typeof parsed['state-dir'] === 'string' ? { stateDir: parsed['state-dir'] } : {}),
    ...(typeof parsed['gh-config-dir'] === 'string' ? { ghConfigDir: parsed['gh-config-dir'] } : {}),
    ...(typeof parsed['gh-cli'] === 'string' ? { ghCli: parsed['gh-cli'] } : {}),
  })
  console.log(parsed.json ? JSON.stringify(report, null, 2) : humanT3Report(report))
  if (!report.ok) process.exitCode = 1
}
