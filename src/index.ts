export {
  RLMHarness,
  type RLMHarnessOptions,
  type RLMCompletionInput,
  type RLMCompletionResult,
  type RLMContext,
} from "./harness.js";

export {
  DEFAULT_REDACTION_POLICY,
  resolveRedactionPolicy,
  redactContextPreview,
  redactPromptText,
  redactReplOutput,
  type RedactedText,
} from "./logging/redaction.js";
export type {
  RedactionPolicy,
  RunTraceCollector,
  RunTrace,
  RunConfig,
  RootIterationTrace,
  ReplExecutionTrace,
  SubcallTrace,
  FinalizationTrace,
  ContextMetadataTrace,
  TokenUsageTrace,
  RLMRuntimeEvent,
} from "./logging/traceTypes.js";
