/** Observer-only tools for the fixed FretSense user-simulation role. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Ticket } from '../../core/index.ts'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { Store } from '../store.ts'
import { PublishSchema, RoleRunSchema, publishRoleIssue, roleForTicket, roleRunFacts, runRoleSimulation } from '../role-run.ts'
import { tool, type Tool } from './tool.ts'

export interface ObserverToolsHost {
  readonly subprocess: SubprocessRuntime
  readonly store: Pick<Store, 'tickets' | 'triggers'>
}

export function observerTools(host: ObserverToolsHost, ticket: Ticket): Tool[] {
  const role = roleForTicket(ticket, id => host.store.triggers.get(id))
  let prepared: { run: ReturnType<typeof RoleRunSchema.parse>; directory: string } | undefined
  const prepare = async (signal: AbortSignal) => {
    if (prepared) return prepared
    const run = await runRoleSimulation(host, role.spec, role.slot, role.directory, signal)
    prepared = { run, directory: role.directory }
    return prepared
  }
  return [
    tool({
      name: 'fretsense_user_sim_run',
      description: 'Run the fixed FretSense seven-path desktop check once for this scheduled role, write run artifacts outside the read-only checkout, and return the run facts. It checks origin/main, builds that exact SHA in an independent build root when needed, and reports the remote and build SHAs under freshness. This tool starts or verifies the local preview; it never edits the checkout.',
      schema: z.object({}).strict(),
      execute: async (_args, signal) => {
        const { run, directory } = await prepare(signal)
        return roleRunFacts(run, directory)
      },
    }),
    tool({
      name: 'fretsense_user_sim_publish',
      description: `Open at most one GitHub Issue for the prepared run, as ${role.spec.github.login}. The body always includes whoSaid=ai-record and the coverage/未测 sections; this tool refuses more than ${role.spec.limits.maxFindings} findings and duplicate fingerprints.`,
      schema: PublishSchema,
      execute: async (args, signal) => {
        const { run, directory } = await prepare(signal)
        const publish = PublishSchema.parse(args)
        const result = await publishRoleIssue(host, role.spec, run, directory, publish, signal)
        return { ...result, report: join(directory, 'role-report.json') }
      },
    }),
  ]
}

/** Read a saved report when a resumed observer needs it without re-running the browser. */
export async function savedRoleReport(directory: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(join(directory, 'role-report.json'), 'utf8')) as Record<string, unknown> }
  catch { return undefined }
}
