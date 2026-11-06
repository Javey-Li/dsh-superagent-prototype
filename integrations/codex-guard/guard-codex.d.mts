export interface CodexAppCandidate {
  path: string
  bundleId: string
  label: string
}
export interface CodexAppStatus {
  status: 'pass' | 'fail'
  detail: string
  pinned?: boolean
  resolution?: string
  bundleId?: string
  candidates?: CodexAppCandidate[]
  preferredBundleId?: string
  preferredResolution?: string | null
}
export interface GuardDecision {
  block: boolean
  target: 'wrong' | 'correct' | 'ambiguous'
  status: CodexAppStatus
  detail: string
}
export declare const CODEX_BUNDLE_ID: 'com.openai.codex'
export declare const CODEX_APP_PATH: '/Applications/ChatGPT.app'
export declare const CODEX_APP_CANDIDATES: readonly CodexAppCandidate[]
export declare function isAppOperationTool(toolName: string): boolean
export declare function isCodexRelated(raw: string): boolean
export declare function classifyTarget(raw: string): 'wrong' | 'correct' | 'ambiguous'
export declare function checkCodexApp(env?: Record<string, string | undefined>,
  exists?: (path: string) => boolean): CodexAppStatus
export declare function decide(toolName: string, inputText: string, env?: Record<string, string | undefined>,
  exists?: (path: string) => boolean): GuardDecision
export declare function main(): void
