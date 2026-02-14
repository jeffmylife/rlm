export interface RedactionPolicy {
  maxPromptChars: number;
  maxContextPreviewChars: number;
  maxReplOutputChars: number;
  headChars: number;
  tailChars: number;
}

export interface RunTraceCollector {
  onTrace: (trace: RunTrace) => void;
}

export interface RLMRuntimeEvent {
  ts: number;
  kind: string;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface TokenUsageTrace {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
}

export interface ContextMetadataTrace {
  type: "string" | "array" | "object";
  totalChars: number;
  lengths: string;
  itemCount: number;
  preview: string;
  previewLength: number;
  previewTruncated: boolean;
}

export interface RunConfig {
  rootModel: string;
  subModel: string;
  iterationLimit: number;
  subcallLimit: number;
  requestTimeoutMs: number;
  maxExecutionOutputChars: number;
  rootPromptProvided: boolean;
  redactionPolicy: RedactionPolicy;
}

export interface ReplExecutionTrace {
  id: string;
  iterationIndex: number;
  code: string;
  stdout: string;
  stderr: string;
  localsKeys: string[];
  executionTimeSec: number;
  startedAt: string;
  endedAt: string;
}

export interface RootIterationTrace {
  id: string;
  index: number;
  turnPrompt: string;
  inputMessageCount: number;
  inputChars: number;
  response: string;
  responseChars: number;
  latencyMs: number;
  startedAt: string;
  endedAt: string;
  usage?: TokenUsageTrace;
  finishReason?: string;
  rawFinishReason?: string;
  replExecutions: ReplExecutionTrace[];
  subcallIds: string[];
}

export interface SubcallTrace {
  id: string;
  iterationIndex: number | null;
  replExecutionId: string | null;
  kind: "single" | "batched";
  batchIndex: number | null;
  model: string;
  prompt: string;
  promptChars: number;
  response: string;
  responseChars: number;
  latencyMs: number;
  startedAt: string;
  endedAt: string;
  usage?: TokenUsageTrace;
  error?: string;
}

export interface FinalizationTrace {
  directiveKind: "final" | "final_var" | "fallback_text";
  answer: string;
  fallbackUsed: boolean;
  finalVarName: string | null;
  fallbackResponse: string | null;
}

export interface RunTrace {
  runId: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: "completed" | "failed";
  error?: string;
  config: RunConfig;
  context: ContextMetadataTrace;
  rootIterations: RootIterationTrace[];
  subcalls: SubcallTrace[];
  finalization?: FinalizationTrace;
}
