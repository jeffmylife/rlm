import { randomUUID } from "node:crypto";

import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { generateText, type ModelMessage } from "ai";

import { LLMBridgeServer } from "./llmBridgeServer.js";
import { resolveRedactionPolicy } from "./logging/redaction.js";
import {
  type ContextMetadataTrace,
  type RLMRuntimeEvent,
  type RedactionPolicy,
  type ReplExecutionTrace,
  type RootIterationTrace,
  type RunTrace,
  type RunTraceCollector,
  type SubcallTrace,
  type TokenUsageTrace,
} from "./logging/traceTypes.js";
import { extractFinalDirective, extractReplCodeBlocks, truncateText } from "./parsing.js";
import { PythonReplWorker, type PythonExecResult } from "./pythonWorker.js";

export type RLMContext = string | Record<string, unknown> | Array<unknown>;

export interface RLMHarnessOptions {
  provider?: OpenAIProvider;
  rootModel?: string;
  subModel?: string;
  maxIterations?: number;
  maxTotalSubcalls?: number;
  maxExecutionOutputChars?: number;
  requestTimeoutMs?: number;
  verbose?: boolean;
  traceCollector?: RunTraceCollector;
  redactionPolicy?: Partial<RedactionPolicy>;
  eventSink?: (event: RLMRuntimeEvent) => void | Promise<void>;
}

export interface RLMCompletionInput {
  context: RLMContext;
  contextFilePath?: string;
  question?: string;
  maxIterations?: number;
}

export interface RLMIterationRecord {
  index: number;
  response: string;
  codeBlocks: Array<{
    code: string;
    result: PythonExecResult;
  }>;
}

export interface RLMCompletionResult {
  answer: string;
  iterations: RLMIterationRecord[];
  subcallCount: number;
  executionTimeMs: number;
  trace?: RunTrace;
}

interface ModelCallResult {
  text: string;
  usage?: TokenUsageTrace;
  finishReason?: string;
  rawFinishReason?: string;
  latencyMs: number;
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are an RLM root model operating over a Python REPL environment.",
  "The REPL has:",
  "1) a `question` variable with the user's request",
  "2) optionally a `context` variable with loaded data (file contents, etc.)",
  "3) `llm_query(prompt, model=None)` for recursive LM calls",
  "4) `llm_query_batched(prompts, model=None)` for concurrent recursive calls",
  "5) `SHOW_VARS()` to inspect available variables",
  "6) `FINAL_VAR(name)` to return an existing variable",
  "",
  "When executing Python, wrap code in triple backticks using `repl`, for example:",
  "```repl",
  "print(question)",
  "```",
  "",
  "When done, you MUST end with exactly one of:",
  "- FINAL(your final answer)",
  "- FINAL_VAR(variable_name)",
  "",
  "Do not emit FINAL/FINAL_VAR until the task is solved.",
].join("\n");

export class RLMHarness {
  private readonly provider: OpenAIProvider;
  private readonly rootModel: string;
  private readonly subModel: string;
  private readonly maxIterations: number;
  private readonly maxTotalSubcalls: number;
  private readonly maxExecutionOutputChars: number;
  private readonly requestTimeoutMs: number;
  private readonly verbose: boolean;
  private readonly traceCollector?: RunTraceCollector;
  private readonly redactionPolicy: RedactionPolicy;
  private readonly eventSink?: (event: RLMRuntimeEvent) => void | Promise<void>;

  constructor(options: RLMHarnessOptions = {}) {
    const gatewayBaseUrl = process.env.AI_GATEWAY_BASE_URL ?? "https://ai-gateway.vercel.sh/v1";

    this.provider =
      options.provider ??
      createOpenAI({
        apiKey: process.env.AI_GATEWAY_API_KEY,
        baseURL: gatewayBaseUrl,
      });

    this.rootModel = options.rootModel ?? process.env.RLM_ROOT_MODEL ?? "openai/gpt-5-mini";
    this.subModel = options.subModel ?? process.env.RLM_SUB_MODEL ?? this.rootModel;
    this.maxIterations = options.maxIterations ?? 16;
    this.maxTotalSubcalls = options.maxTotalSubcalls ?? 200;
    this.maxExecutionOutputChars = options.maxExecutionOutputChars ?? 20_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.verbose = options.verbose ?? false;
    this.traceCollector = options.traceCollector;
    this.redactionPolicy = resolveRedactionPolicy(options.redactionPolicy);
    this.eventSink = options.eventSink;
  }

  async completion(input: RLMCompletionInput): Promise<RLMCompletionResult> {
    const startedAt = Date.now();
    const worker = new PythonReplWorker();

    let subcallCount = 0;
    let subcallSequence = 0;
    let replSequence = 0;
    let activeIterationIndex: number | null = null;
    let activeReplExecutionId: string | null = null;

    const iterationLimit = input.maxIterations ?? this.maxIterations;
    const contextMetadata = describeContext(input.context, this.redactionPolicy.maxContextPreviewChars);

    await this.emitRuntimeEvent({
      kind: "run.started",
      summary: "RLM run started",
      payload: {
        rootModel: this.rootModel,
        subModel: this.subModel,
        iterationLimit,
        maxSubcalls: this.maxTotalSubcalls,
      },
    });

    const trace = this.traceCollector
      ? createRunTrace({
          rootModel: this.rootModel,
          subModel: this.subModel,
          iterationLimit,
          subcallLimit: this.maxTotalSubcalls,
          requestTimeoutMs: this.requestTimeoutMs,
          maxExecutionOutputChars: this.maxExecutionOutputChars,
          rootPromptProvided: Boolean(input.question?.trim()),
          contextMetadata,
          redactionPolicy: this.redactionPolicy,
        })
      : undefined;

    let runFailedMessage: string | undefined;

    const bridge = new LLMBridgeServer({
      onSingleQuery: async ({ prompt, model }) => {
        const chosenModel = model ?? this.subModel;
        const subcallId = `sub-${++subcallSequence}`;
        const iterationIndex = activeIterationIndex;
        const replExecutionId = activeReplExecutionId;
        const startedAtMs = Date.now();
        await this.emitRuntimeEvent({
          kind: "subcall.started",
          summary: `Subcall ${subcallId} started`,
          payload: {
            subcallId,
            iterationIndex,
            replExecutionId,
            model: chosenModel,
            promptChars: prompt.length,
            promptPreview: prompt.slice(0, 500),
          },
        });

        if (subcallCount >= this.maxTotalSubcalls) {
          const response = `Error: sub-call limit reached (${this.maxTotalSubcalls})`;
          await this.emitRuntimeEvent({
            kind: "subcall.rejected",
            summary: `Subcall ${subcallId} rejected`,
            payload: {
              subcallId,
              reason: "subcall_limit_reached",
              maxTotalSubcalls: this.maxTotalSubcalls,
            },
          });
          this.pushSubcallTrace(trace, {
            id: subcallId,
            iterationIndex,
            replExecutionId,
            kind: "single",
            batchIndex: null,
            model: chosenModel,
            prompt,
            promptChars: prompt.length,
            response,
            responseChars: response.length,
            latencyMs: Date.now() - startedAtMs,
            startedAt: new Date(startedAtMs).toISOString(),
            endedAt: new Date().toISOString(),
            error: response,
          });
          return response;
        }

        subcallCount += 1;

        try {
          const response = await this.callModelWithPrompt(chosenModel, prompt);
          await this.emitRuntimeEvent({
            kind: "subcall.completed",
            summary: `Subcall ${subcallId} completed`,
            payload: {
              subcallId,
              latencyMs: response.latencyMs,
              responseChars: response.text.length,
              responsePreview: response.text.slice(0, 1000),
            },
          });
          this.pushSubcallTrace(trace, {
            id: subcallId,
            iterationIndex,
            replExecutionId,
            kind: "single",
            batchIndex: null,
            model: chosenModel,
            prompt,
            promptChars: prompt.length,
            response: response.text,
            responseChars: response.text.length,
            latencyMs: response.latencyMs,
            startedAt: new Date(startedAtMs).toISOString(),
            endedAt: new Date(startedAtMs + response.latencyMs).toISOString(),
            usage: response.usage,
          });
          return response.text;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const response = `Error: LM query failed - ${message}`;
          await this.emitRuntimeEvent({
            kind: "subcall.failed",
            summary: `Subcall ${subcallId} failed`,
            payload: {
              subcallId,
              error: message,
            },
          });
          this.pushSubcallTrace(trace, {
            id: subcallId,
            iterationIndex,
            replExecutionId,
            kind: "single",
            batchIndex: null,
            model: chosenModel,
            prompt,
            promptChars: prompt.length,
            response,
            responseChars: response.length,
            latencyMs: Date.now() - startedAtMs,
            startedAt: new Date(startedAtMs).toISOString(),
            endedAt: new Date().toISOString(),
            error: message,
          });
          return response;
        }
      },
      onBatchedQuery: async ({ prompts, model }) => {
        const responses: string[] = [];
        await this.emitRuntimeEvent({
          kind: "subcall.batch_started",
          summary: "Batched subcall started",
          payload: {
            size: prompts.length,
            model: model ?? this.subModel,
          },
        });

        for (let index = 0; index < prompts.length; index += 1) {
          const prompt = prompts[index] ?? "";
          const chosenModel = model ?? this.subModel;
          const subcallId = `sub-${++subcallSequence}`;
          const iterationIndex = activeIterationIndex;
          const replExecutionId = activeReplExecutionId;
          const startedAtMs = Date.now();
          await this.emitRuntimeEvent({
            kind: "subcall.started",
            summary: `Subcall ${subcallId} started`,
            payload: {
              subcallId,
              iterationIndex,
              replExecutionId,
              model: chosenModel,
              promptChars: prompt.length,
              promptPreview: prompt.slice(0, 500),
              batchIndex: index,
            },
          });

          if (subcallCount >= this.maxTotalSubcalls) {
            const response = `Error: sub-call limit reached (${this.maxTotalSubcalls})`;
            responses.push(response);
            await this.emitRuntimeEvent({
              kind: "subcall.rejected",
              summary: `Subcall ${subcallId} rejected`,
              payload: {
                subcallId,
                reason: "subcall_limit_reached",
                maxTotalSubcalls: this.maxTotalSubcalls,
                batchIndex: index,
              },
            });
            this.pushSubcallTrace(trace, {
              id: subcallId,
              iterationIndex,
              replExecutionId,
              kind: "batched",
              batchIndex: index,
              model: chosenModel,
              prompt,
              promptChars: prompt.length,
              response,
              responseChars: response.length,
              latencyMs: Date.now() - startedAtMs,
              startedAt: new Date(startedAtMs).toISOString(),
              endedAt: new Date().toISOString(),
              error: response,
            });
            continue;
          }

          subcallCount += 1;

          try {
            const response = await this.callModelWithPrompt(chosenModel, prompt);
            responses.push(response.text);
            await this.emitRuntimeEvent({
              kind: "subcall.completed",
              summary: `Subcall ${subcallId} completed`,
              payload: {
                subcallId,
                latencyMs: response.latencyMs,
                responseChars: response.text.length,
                responsePreview: response.text.slice(0, 1000),
                batchIndex: index,
              },
            });

            this.pushSubcallTrace(trace, {
              id: subcallId,
              iterationIndex,
              replExecutionId,
              kind: "batched",
              batchIndex: index,
              model: chosenModel,
              prompt,
              promptChars: prompt.length,
              response: response.text,
              responseChars: response.text.length,
              latencyMs: response.latencyMs,
              startedAt: new Date(startedAtMs).toISOString(),
              endedAt: new Date(startedAtMs + response.latencyMs).toISOString(),
              usage: response.usage,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const response = `Error: LM query failed - ${message}`;
            responses.push(response);
            await this.emitRuntimeEvent({
              kind: "subcall.failed",
              summary: `Subcall ${subcallId} failed`,
              payload: {
                subcallId,
                error: message,
                batchIndex: index,
              },
            });

            this.pushSubcallTrace(trace, {
              id: subcallId,
              iterationIndex,
              replExecutionId,
              kind: "batched",
              batchIndex: index,
              model: chosenModel,
              prompt,
              promptChars: prompt.length,
              response,
              responseChars: response.length,
              latencyMs: Date.now() - startedAtMs,
              startedAt: new Date(startedAtMs).toISOString(),
              endedAt: new Date().toISOString(),
              error: message,
            });
          }
        }

        await this.emitRuntimeEvent({
          kind: "subcall.batch_completed",
          summary: "Batched subcall completed",
          payload: {
            size: prompts.length,
          },
        });

        return responses;
      },
    });

    try {
      await bridge.start();
      await worker.init({
        context: input.context,
        contextFilePath: input.contextFilePath,
        bridgeUrl: bridge.url,
        question: input.question,
      });
      await this.emitRuntimeEvent({
        kind: "run.initialized",
        summary: "Python worker initialized",
        payload: {
          contextFilePath: input.contextFilePath ?? null,
          bridgeUrl: bridge.url,
        },
      });

      const messageHistory: ModelMessage[] = this.buildInitialMessageHistory(contextMetadata);
      const iterations: RLMIterationRecord[] = [];

      for (let i = 0; i < iterationLimit; i += 1) {
        const userPrompt = this.buildTurnPrompt({ iteration: i });
        const messages: ModelMessage[] = [...messageHistory, userPrompt];
        await this.emitRuntimeEvent({
          kind: "root.iteration.started",
          summary: `Root iteration ${i + 1} started`,
          payload: {
            iteration: i + 1,
            inputMessageCount: messages.length,
          },
        });

        const rootStartedAtMs = Date.now();
        const rootCall = await this.callModelWithMessages(this.rootModel, messages);
        const response = rootCall.text;
        const codeBlocks = extractReplCodeBlocks(response);
        await this.emitRuntimeEvent({
          kind: "root.iteration.completed",
          summary: `Root iteration ${i + 1} completed`,
          payload: {
            iteration: i + 1,
            codeBlocks: codeBlocks.length,
            responseChars: response.length,
            responsePreview: response.slice(0, 2000),
            latencyMs: rootCall.latencyMs,
            finishReason: rootCall.finishReason ?? null,
          },
        });

        const iteration: RLMIterationRecord = {
          index: i + 1,
          response,
          codeBlocks: [],
        };

        const iterationTrace: RootIterationTrace | undefined = trace
          ? {
              id: `iter-${i + 1}`,
              index: i + 1,
              turnPrompt: messageText(userPrompt),
              inputMessageCount: messages.length,
              inputChars: totalMessageChars(messages),
              response,
              responseChars: response.length,
              latencyMs: rootCall.latencyMs,
              startedAt: new Date(rootStartedAtMs).toISOString(),
              endedAt: new Date(rootStartedAtMs + rootCall.latencyMs).toISOString(),
              usage: rootCall.usage,
              finishReason: rootCall.finishReason,
              rawFinishReason: rootCall.rawFinishReason,
              replExecutions: [],
              subcallIds: [],
            }
          : undefined;

        for (const code of codeBlocks) {
          const replExecutionId = `repl-${++replSequence}`;
          const replStartedAtMs = Date.now();
          await this.emitRuntimeEvent({
            kind: "repl.execution.started",
            summary: `REPL block ${replExecutionId} started`,
            payload: {
              iteration: i + 1,
              replExecutionId,
              codeChars: code.length,
              code: code.slice(0, 2000),
            },
          });

          activeIterationIndex = i + 1;
          activeReplExecutionId = replExecutionId;

          let result: PythonExecResult;
          try {
            result = await worker.exec(code);
          } finally {
            activeIterationIndex = null;
            activeReplExecutionId = null;
          }
          await this.emitRuntimeEvent({
            kind: "repl.execution.completed",
            summary: `REPL block ${replExecutionId} completed`,
            payload: {
              iteration: i + 1,
              replExecutionId,
              stdoutChars: result.stdout.length,
              stdoutPreview: result.stdout.slice(0, 2000),
              stderrChars: result.stderr.length,
              stderrPreview: result.stderr.slice(0, 2000),
              localsCount: Object.keys(result.locals ?? {}).length,
              localsKeys: Object.keys(result.locals ?? {}),
              executionTimeSec: result.execution_time,
            },
          });

          iteration.codeBlocks.push({ code, result });

          if (iterationTrace) {
            const replTrace: ReplExecutionTrace = {
              id: replExecutionId,
              iterationIndex: i + 1,
              code,
              stdout: result.stdout,
              stderr: result.stderr,
              localsKeys: Object.keys(result.locals ?? {}),
              executionTimeSec: result.execution_time,
              startedAt: new Date(replStartedAtMs).toISOString(),
              endedAt: new Date().toISOString(),
            };

            iterationTrace.replExecutions.push(replTrace);
          }
        }

        iterations.push(iteration);
        if (trace && iterationTrace) {
          trace.rootIterations.push(iterationTrace);
        }

        const finalDirective = extractFinalDirective(response);
        if (finalDirective) {
          const answer =
            finalDirective.kind === "final"
              ? finalDirective.value
              : await worker.finalVar(finalDirective.value);
          await this.emitRuntimeEvent({
            kind: "run.finalized",
            summary: "Run finalized",
            payload: {
              directiveKind: finalDirective.kind,
              finalVarName: finalDirective.kind === "final_var" ? finalDirective.value : null,
              answerChars: answer.length,
            },
          });

          if (trace) {
            trace.finalization = {
              directiveKind: finalDirective.kind,
              answer,
              fallbackUsed: false,
              finalVarName: finalDirective.kind === "final_var" ? finalDirective.value : null,
              fallbackResponse: null,
            };
          }

          return {
            answer,
            iterations,
            subcallCount,
            executionTimeMs: Date.now() - startedAt,
            trace,
          };
        }

        messageHistory.push({ role: "assistant", content: response });

        for (const codeBlock of iteration.codeBlocks) {
          messageHistory.push({
            role: "user",
            content: this.formatExecutionMessage(codeBlock.code, codeBlock.result),
          });
        }
      }

      const fallbackMessages: ModelMessage[] = [
        ...messageHistory,
        {
          role: "user",
          content:
            "Provide your final answer now. Use either FINAL(...) or FINAL_VAR(...). Only include one final answer.",
        },
      ];
      const fallback = await this.callModelWithMessages(this.rootModel, fallbackMessages);
      const fallbackDirective = extractFinalDirective(fallback.text);

      const answer =
        fallbackDirective?.kind === "final_var"
          ? await worker.finalVar(fallbackDirective.value)
          : fallbackDirective?.value ?? fallback.text;
      await this.emitRuntimeEvent({
        kind: "run.finalized",
        summary: "Run finalized via fallback",
        payload: {
          directiveKind: fallbackDirective?.kind ?? "fallback_text",
          finalVarName: fallbackDirective?.kind === "final_var" ? fallbackDirective.value : null,
          answerChars: answer.length,
          fallbackUsed: true,
        },
      });

      if (trace) {
        trace.finalization = {
          directiveKind: fallbackDirective?.kind ?? "fallback_text",
          answer,
          fallbackUsed: true,
          finalVarName: fallbackDirective?.kind === "final_var" ? fallbackDirective.value : null,
          fallbackResponse: fallback.text,
        };
      }

      return {
        answer,
        iterations,
        subcallCount,
        executionTimeMs: Date.now() - startedAt,
        trace,
      };
    } catch (error) {
      runFailedMessage = error instanceof Error ? error.message : String(error);
      await this.emitRuntimeEvent({
        kind: "run.failed",
        summary: "Run failed",
        payload: {
          error: runFailedMessage,
        },
      });
      throw error;
    } finally {
      await bridge.stop();
      await worker.close();

      if (trace) {
        trace.status = runFailedMessage ? "failed" : "completed";
        trace.error = runFailedMessage;
        trace.endedAt = new Date().toISOString();
        trace.durationMs = Date.now() - startedAt;
        this.traceCollector?.onTrace(trace);
      }
      await this.emitRuntimeEvent({
        kind: runFailedMessage ? "run.ended_failed" : "run.ended_completed",
        summary: runFailedMessage ? "Run ended with failure" : "Run completed",
        payload: {
          durationMs: Date.now() - startedAt,
          error: runFailedMessage ?? null,
        },
      });
    }
  }

  private pushSubcallTrace(trace: RunTrace | undefined, subcall: SubcallTrace): void {
    if (!trace) {
      return;
    }

    trace.subcalls.push(subcall);
    if (typeof subcall.iterationIndex === "number") {
      const iteration = trace.rootIterations.find((item) => item.index === subcall.iterationIndex);
      if (iteration) {
        iteration.subcallIds.push(subcall.id);
      }
    }
  }

  private async emitRuntimeEvent(event: Omit<RLMRuntimeEvent, "ts">): Promise<void> {
    if (!this.eventSink) {
      return;
    }

    const payload: RLMRuntimeEvent = {
      ts: Date.now(),
      ...event,
    };

    try {
      await this.eventSink(payload);
    } catch (error) {
      if (this.verbose) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[rlm] event sink error: ${message}\n`);
      }
    }
  }

  private buildInitialMessageHistory(contextMetadata: ContextMetadataTrace): ModelMessage[] {
    return [
      { role: "system", content: DEFAULT_SYSTEM_PROMPT },
      {
        role: "assistant",
        content: [
          `Context metadata: type=${contextMetadata.type}, total_chars=${contextMetadata.totalChars}.`,
          `Chunk lengths: ${contextMetadata.lengths}.`,
          "Start by inspecting the context in REPL before concluding.",
        ].join("\n"),
      },
    ];
  }

  private buildTurnPrompt(input: { iteration: number }): ModelMessage {
    const base = "Read the `question` variable in the REPL to understand the task. Use the REPL to solve it.";

    const firstTurnGuard =
      input.iteration === 0
        ? "Start by reading the question and context variables in the REPL."
        : "Continue from prior execution outputs.";

    return {
      role: "user",
      content: `${firstTurnGuard}\n${base}\nYour next action:`,
    };
  }

  private formatExecutionMessage(code: string, result: PythonExecResult): string {
    const stdout = truncateText(result.stdout ?? "", this.maxExecutionOutputChars);
    const stderr = truncateText(result.stderr ?? "", this.maxExecutionOutputChars);
    const variableNames = Object.keys(result.locals ?? {});

    const outputSections: string[] = [];
    if (stdout.trim().length > 0) {
      outputSections.push(`STDOUT:\n${stdout}`);
    }
    if (stderr.trim().length > 0) {
      outputSections.push(`STDERR:\n${stderr}`);
    }
    outputSections.push(
      variableNames.length > 0
        ? `Variables now available: ${variableNames.join(", ")}`
        : "Variables now available: (none)",
    );

    return `Code executed:\n\`\`\`python\n${code}\n\`\`\`\n\nREPL output:\n${outputSections.join("\n\n")}`;
  }

  private async callModelWithMessages(modelName: string, messages: ModelMessage[]): Promise<ModelCallResult> {
    if (this.verbose) {
      process.stderr.write(`[rlm] root call -> ${modelName} with ${messages.length} messages\n`);
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const result = await generateText({
        model: this.provider(modelName),
        messages,
        abortSignal: controller.signal,
      });

      return {
        text: result.text,
        usage: extractUsageTrace(result.usage),
        finishReason: result.finishReason,
        rawFinishReason: result.rawFinishReason,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async callModelWithPrompt(modelName: string, prompt: string): Promise<ModelCallResult> {
    if (this.verbose) {
      process.stderr.write(`[rlm] subcall -> ${modelName}\n`);
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const result = await generateText({
        model: this.provider(modelName),
        prompt,
        abortSignal: controller.signal,
      });

      return {
        text: result.text,
        usage: extractUsageTrace(result.usage),
        finishReason: result.finishReason,
        rawFinishReason: result.rawFinishReason,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function createRunTrace(input: {
  rootModel: string;
  subModel: string;
  iterationLimit: number;
  subcallLimit: number;
  requestTimeoutMs: number;
  maxExecutionOutputChars: number;
  rootPromptProvided: boolean;
  contextMetadata: ContextMetadataTrace;
  redactionPolicy: RedactionPolicy;
}): RunTrace {
  return {
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    status: "completed",
    config: {
      rootModel: input.rootModel,
      subModel: input.subModel,
      iterationLimit: input.iterationLimit,
      subcallLimit: input.subcallLimit,
      requestTimeoutMs: input.requestTimeoutMs,
      maxExecutionOutputChars: input.maxExecutionOutputChars,
      rootPromptProvided: input.rootPromptProvided,
      redactionPolicy: input.redactionPolicy,
    },
    context: input.contextMetadata,
    rootIterations: [],
    subcalls: [],
  };
}

function describeContext(context: RLMContext, maxPreviewChars: number): ContextMetadataTrace {
  if (typeof context === "string") {
    const preview = context.slice(0, maxPreviewChars);
    return {
      type: "string",
      totalChars: context.length,
      lengths: `[${context.length}]`,
      itemCount: 1,
      preview,
      previewLength: preview.length,
      previewTruncated: context.length > maxPreviewChars,
    };
  }

  if (Array.isArray(context)) {
    const lengths = context.map((item) => safeLength(item));
    const serialized = safeSerialize(context);
    const preview = serialized.slice(0, maxPreviewChars);

    return {
      type: "array",
      totalChars: lengths.reduce((sum, value) => sum + value, 0),
      lengths: compactLengths(lengths),
      itemCount: context.length,
      preview,
      previewLength: preview.length,
      previewTruncated: serialized.length > maxPreviewChars,
    };
  }

  const values = Object.values(context);
  const lengths = values.map((item) => safeLength(item));
  const serialized = safeSerialize(context);
  const preview = serialized.slice(0, maxPreviewChars);

  return {
    type: "object",
    totalChars: lengths.reduce((sum, value) => sum + value, 0),
    lengths: compactLengths(lengths),
    itemCount: Object.keys(context).length,
    preview,
    previewLength: preview.length,
    previewTruncated: serialized.length > maxPreviewChars,
  };
}

function compactLengths(lengths: number[]): string {
  const maxPreview = 100;
  if (lengths.length <= maxPreview) {
    return JSON.stringify(lengths);
  }

  const preview = lengths.slice(0, maxPreview);
  return `${JSON.stringify(preview)} ... [+${lengths.length - maxPreview} more]`;
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === "string") {
    return message.content;
  }

  try {
    return JSON.stringify(message.content);
  } catch {
    return String(message.content);
  }
}

function totalMessageChars(messages: ModelMessage[]): number {
  return messages.reduce((sum, message) => sum + safeLength(message.content), 0);
}

function safeLength(value: unknown): number {
  if (typeof value === "string") {
    return value.length;
  }

  try {
    return JSON.stringify(value).length;
  } catch {
    return String(value).length;
  }
}

function safeSerialize(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractUsageTrace(usage: unknown): TokenUsageTrace | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const record = usage as Record<string, unknown>;
  const usageTrace: TokenUsageTrace = {
    inputTokens: asNumber(record.inputTokens),
    outputTokens: asNumber(record.outputTokens),
    totalTokens: asNumber(record.totalTokens),
    reasoningTokens: asNumber(record.reasoningTokens),
    cachedInputTokens: asNumber(record.cachedInputTokens),
  };

  const hasAnyValue = Object.values(usageTrace).some((value) => typeof value === "number");
  return hasAnyValue ? usageTrace : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
