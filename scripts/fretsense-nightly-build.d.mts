export declare const PROXY_ENV_KEYS: readonly string[]
export declare const BUILD_MANIFEST: string
export declare const PREVIEW_OWNER: string

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
export declare function isBuildSha(value: unknown): boolean
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
  manifestHash: string
  entrypoints: string[]
  fileCount: number
}
export declare function readBuildMeta(buildRoot: string, sha: string): BuildMeta | undefined
export interface BuildManifestFile { path: string; size: number; sha256: string }
export interface BuildManifest {
  schema: 'nightly-build-manifest/v1'
  sha: string
  files: BuildManifestFile[]
  entrypoints: string[]
  treeHash: string
  fileCount: number
  createdAt: string
}
export declare function createBuildManifest(buildRoot: string, sha: string, directory: string): BuildManifest
export declare function verifyBuildArtifact(buildRoot: string, sha: string, meta?: BuildMeta): { ok: boolean; reason?: string;
  manifest?: BuildManifest }
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
  verified?: boolean
}
export declare function ensureBuild(input: { run?: CommandRun; checkout: string; buildRoot: string; sha: string;
  remoteUrl: string; branch?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }): BuildResult
export declare function servedBuildMatches(input: { target: string; buildDir: string;
  sha: string; fetchImpl?: typeof fetch }): Promise<{ match: boolean; reason?: string; entrypoints?: string[] }>
export interface PreviewOwner {
  schema?: 'nightly-preview-owner/v1'
  pid: number
  port: string | number
  buildRoot: string
  cwd: string
  script: string
  startedAt?: string
}
export declare function writePreviewOwner(buildRoot: string, owner: Omit<PreviewOwner, 'schema'>): void
export declare function clearPreviewOwner(buildRoot: string, pid: number): void
export declare function trustedPreviewOwner(input: { owner?: Partial<PreviewOwner>; buildRoot: string; sourceDir: string;
  port: string | number; listeningPids?: number[]; commandOf?: (pid: number) => string;
  cwdOf?: (pid: number) => string }): { ownedPid?: number;
  foreign: { pid: number; command: string; cwd: string }[] }
