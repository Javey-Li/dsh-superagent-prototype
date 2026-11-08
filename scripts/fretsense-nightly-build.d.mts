export declare const PROXY_ENV_KEYS: readonly string[]

export interface SystemProxy { host: string; port: string; url: string }
export interface CommandResult { code: number; stdout: string; stderr: string; signal?: string | null }
export interface CommandOptions { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number }
export type CommandRun = (argv: string[], options?: CommandOptions) => CommandResult

export declare function parseScutilProxy(text: string): SystemProxy | undefined
export declare function networkEnv(base?: NodeJS.ProcessEnv, systemProxy?: SystemProxy): NodeJS.ProcessEnv
export declare function buildEnv(base?: NodeJS.ProcessEnv, systemProxy?: SystemProxy): NodeJS.ProcessEnv
export declare function defaultRun(argv: string[], options?: CommandOptions): CommandResult
export declare function firstSha(text: string): string | undefined
export declare function remoteMainSha(input: { run?: CommandRun; checkout: string; remote?: string; branch?: string;
  env?: NodeJS.ProcessEnv }): { sha: string; url: string }
export declare function tailOf(text: string, lines?: number): string
export declare function fileHash(file: string): string
export declare function readJson(file: string): Record<string, any> | undefined
export declare function writeJson(file: string, value: unknown): void
export declare function buildDirectory(buildRoot: string, sha: string): string
export declare function buildMetaFile(buildRoot: string, sha: string): string
export interface BuildMeta {
  schema: 'nightly-build/v1'
  sha: string
  lockHash: string
  builtAt: string
  directory: string
  source: string
  durationMs: number
}
export declare function readBuildMeta(buildRoot: string, sha: string): BuildMeta | undefined
export declare function lastGoodBuild(buildRoot: string): (BuildMeta & { directory: string }) | undefined
export interface BuildChoice {
  state: 'fresh' | 'stale' | 'failed' | 'unknown'
  meta?: BuildMeta
  chosen?: { sha: string; directory: string; sourceDir?: string; source: string }
  reason: string | null
}
export declare function chooseNightlyBuild(input: { remote?: string; branch?: string; remoteSha?: string;
  remoteError?: string; buildResult?: BuildResult; lastGood?: BuildMeta & { directory: string } }): BuildChoice
export declare function pruneBuilds(buildRoot: string, keep?: number): string[]
export interface BuildResult {
  status: 'reused' | 'built' | 'failed'
  sha?: string
  directory?: string
  meta?: BuildMeta
  reason?: string
  log?: string
  failure?: string
}
export declare function ensureBuild(input: { run?: CommandRun; checkout: string; buildRoot: string; sha: string;
  remoteUrl: string; branch?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): BuildResult
export declare function servedBuildMatches(input: { target: string; buildDir: string;
  fetchImpl?: typeof fetch }): Promise<{ match: boolean; reason?: string }>
