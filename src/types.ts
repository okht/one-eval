import type { Diagnostic } from './diagnostics.js';
import type { AdmissionRecord } from './admission.js';
import type { RuntimeProvenance } from './provenance.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface Message { role: 'system' | 'user' | 'assistant'; content: string }
export type ProviderSpec = string | { id: string; config?: JsonObject };
export interface EvalCase {
  id: string;
  input: string;
  reference?: Json;
  metadata?: JsonObject;
  weight: number;
  conversation?: { mode: 'scripted'; turns: string[] } | {
    mode: 'simulated'; goal: string; facts?: JsonObject; constraints?: string[];
    provider: ProviderSpec; maxTurns: number;
  };
}
export interface TargetConfig {
  kind: 'provider' | 'module';
  provider?: ProviderSpec;
  path?: string;
  config?: JsonObject;
  isolation: { mode: 'stateless' | 'managed'; scope: 'independent' | 'shared'; evidence: string };
  retrySafe: boolean;
}
export interface ExecutionConfig { repeats: number; concurrency: number; timeoutMs: number; maxAttempts?: number; minIntervalMs?: number }
export interface ExecutionPlan {
  version: 1; name: string; cases: EvalCase[]; target: TargetConfig; execution: ExecutionConfig;
}
export interface SourceFile { path: string; sha256: string }
export interface PreparedPlan { plan: ExecutionPlan; planHash: string; files: SourceFile[]; baseDir: string }
export interface TrialContext {
  runId: string; trialId: string; caseId: string; repeat: number; attempt: number;
  sessionId: string; signal: AbortSignal; workDir: string; baseDir?: string;
}
export interface IsolationCheck { ok: boolean; evidence: string }
export interface TargetReply { output: string; metadata?: JsonObject; cost?: number; tokenUsage?: JsonObject }
export interface TargetAdapter {
  prepare(context: TrialContext): Promise<Json>;
  verify(session: Json, context: TrialContext): Promise<IsolationCheck>;
  execute(messages: Message[], session: Json, context: TrialContext): Promise<TargetReply>;
  cleanup(session: Json, context: TrialContext): Promise<void>;
  recover?(context: {runId: string; workDir: string; signal: AbortSignal}): Promise<IsolationCheck>;
  close?(): Promise<void>;
}
export interface ConversationResult {
  output: string; messages: Message[]; stopReason: 'single_turn' | 'script_complete' | 'simulator_stop' | 'max_turns';
  metadata?: JsonObject;
}
export type TrialStatus = 'running' | 'completed' | 'execution_error' | 'isolation_error' | 'cleanup_error' | 'interrupted' | 'invalid_simulation';
export interface TrialArtifact {
  version: 1; runId: string; trialId: string; caseId: string; repeat: number; attempt: number;
  sessionId: string; startedAt: string; finishedAt?: string; status: TrialStatus;
  messages: Message[]; output?: string; outputHash?: string; stopReason?: ConversationResult['stopReason'];
  isolation?: IsolationCheck; metadata?: JsonObject; error?: string; cleanupError?: string;
  diagnostic?: Diagnostic; cleanupDiagnostic?: Diagnostic;
}
export interface RunManifest {
  version: 1; runId: string; createdAt: string; prepared: PreparedPlan;
  engine: { name: 'promptfoo'; version: string };
  admission?: AdmissionRecord;
  admissionHistory?: AdmissionRecord[];
  runtime?: RuntimeProvenance;
  environmentHash?: string;
}
export interface RunState { blocked: boolean; reason?: string; updatedAt: string; activeProcess?: number; limitReached?: boolean; limitReason?: string }
export interface RunSummary {
  runId: string; directory: string; planned: number; completed: number; failed: number;
  pending: number; blocked: boolean; reason?: string;
  limitReached?: boolean; limitReason?: string;
  mode?: 'formal' | 'exploratory' | 'legacy_unverified';
}
export interface JudgeConfig {
  id: string; kind: 'llm' | 'command'; repeats: number; weight: number;
  provider?: ProviderSpec; prompt?: string; command?: string; args?: string[];
  env?: Record<string,string>; cwd?: string;
}
export interface GradingPlan { version: 1; judges: JudgeConfig[]; concurrency: number; timeoutMs: number; maxAttempts?: number; minIntervalMs?: number; maxCost?: number }
export interface PreparedGrading { plan: GradingPlan; versionHash: string; files: SourceFile[]; baseDir: string }
export interface GradeValue { status: 'scored' | 'insufficient_evidence' | 'abstained'; score?: number; reason: string }
export interface GradeRecord {
  version: 1; id: string; runId: string; trialId: string; caseId: string; executionAttempt: number;
  outputHash: string; gradingVersion: string; judgeId: string; repeat: number; attempt: number;
  status: GradeValue['status'] | 'grading_error'; score?: number; reason: string; createdAt: string;
  diagnostic?: Diagnostic; cleanupDiagnostic?: Diagnostic; durationMs?: number;
  usage?: { tokenUsage?: JsonObject; cost?: number };
  rawOutput?: string; rawOutputTruncated?: boolean;
}
export interface GradeInput { case: EvalCase; artifact: TrialArtifact; instructions: string; judgeId: string; repeat: number }
