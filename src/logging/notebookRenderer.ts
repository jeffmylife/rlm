import {
  redactContextPreview,
  redactPromptText,
  redactReplOutput,
  resolveRedactionPolicy,
} from "./redaction.js";
import {
  type RedactionPolicy,
  type ReplExecutionTrace,
  type RunTrace,
  type SubcallTrace,
  type TokenUsageTrace,
} from "./traceTypes.js";

export interface NotebookRenderOptions {
  trace: RunTrace;
  title?: string;
  redactionPolicy?: Partial<RedactionPolicy>;
}

export interface NotebookDocument {
  nbformat: 4;
  nbformat_minor: 5;
  metadata: Record<string, unknown>;
  cells: NotebookCell[];
}

type NotebookCell = NotebookMarkdownCell | NotebookCodeCell;

interface NotebookMarkdownCell {
  cell_type: "markdown";
  metadata: Record<string, unknown>;
  source: string[];
}

interface NotebookCodeCell {
  cell_type: "code";
  metadata: Record<string, unknown>;
  execution_count: number | null;
  source: string[];
  outputs: NotebookOutput[];
}

type NotebookOutput = {
  output_type: "stream";
  name: "stdout" | "stderr";
  text: string[];
};

export function renderRunTraceNotebook(options: NotebookRenderOptions): NotebookDocument {
  const trace = options.trace;
  const policy = resolveRedactionPolicy(options.redactionPolicy);
  const title = options.title?.trim() || "RLM Run Replay";

  const cells: NotebookCell[] = [];

  cells.push(
    markdownCell(
      [
        `# ${title}`,
        "",
        "## Run Overview",
        "",
        "| Field | Value |",
        "| --- | --- |",
        `| Run ID | \`${trace.runId}\` |`,
        `| Status | \`${trace.status}\` |`,
        `| Root Model | \`${trace.config.rootModel}\` |`,
        `| Sub Model | \`${trace.config.subModel}\` |`,
        `| Iterations | \`${trace.rootIterations.length}\` |`,
        `| Subcalls | \`${trace.subcalls.length}\` |`,
        `| Duration | \`${trace.durationMs ?? "N/A"} ms\` |`,
        `| Started | \`${trace.startedAt}\` |`,
        `| Ended | \`${trace.endedAt ?? "N/A"}\` |`,
      ].join("\n"),
    ),
  );

  const contextPreview = redactContextPreview(trace.context.preview, policy);

  cells.push(
    markdownCell(
      [
        "## Context",
        "",
        "| Field | Value |",
        "| --- | --- |",
        `| Type | \`${trace.context.type}\` |`,
        `| Item Count | \`${trace.context.itemCount}\` |`,
        `| Total Chars | \`${trace.context.totalChars}\` |`,
        `| Length Summary | \`${trace.context.lengths}\` |`,
        contextPreview.redacted
          ? `| Preview | Truncated with digest \`${contextPreview.digest}\` |`
          : "| Preview | Included in full |",
        "",
        detailsBlock("Show context preview", fencedBlock(contextPreview.text, "text")),
      ].join("\n"),
    ),
  );

  cells.push(
    markdownCell(
      [
        "## Config",
        "",
        "| Field | Value |",
        "| --- | --- |",
        `| Iteration Limit | \`${trace.config.iterationLimit}\` |`,
        `| Subcall Limit | \`${trace.config.subcallLimit}\` |`,
        `| Request Timeout | \`${trace.config.requestTimeoutMs} ms\` |`,
        `| Output Truncation | \`${trace.config.maxExecutionOutputChars} chars\` |`,
        `| Root Prompt Provided | \`${trace.config.rootPromptProvided}\` |`,
        "",
        "_Balanced redaction is active by default. Large prompt/context text is collapsed with digest-backed truncation._",
      ].join("\n"),
    ),
  );

  for (const iteration of trace.rootIterations) {
    const promptText = redactPromptText(iteration.turnPrompt, policy);
    const responseText = redactPromptText(iteration.response, policy);

    const promptPreview = summarizeParagraph(promptText.text, 260);
    const responsePreview = summarizeParagraph(responseText.text, 360);

    const iterationLines = [
      `## Iteration ${iteration.index}`,
      "",
      "| Metric | Value |",
      "| --- | --- |",
      `| Root Latency | \`${iteration.latencyMs} ms\` |`,
      `| Input Messages | \`${iteration.inputMessageCount}\` |`,
      `| Input Chars | \`${iteration.inputChars}\` |`,
      `| Response Chars | \`${iteration.responseChars}\` |`,
      `| Usage | \`${formatUsage(iteration.usage)}\` |`,
      `| Finish Reason | \`${iteration.finishReason ?? "N/A"}\` |`,
      `| REPL Blocks | \`${iteration.replExecutions.length}\` |`,
      `| Subcalls | \`${trace.subcalls.filter((item) => item.iterationIndex === iteration.index).length}\` |`,
      "",
      "### Root Prompt",
      "",
      promptPreview,
      "",
      detailsBlock("Show full prompt text", fencedBlock(promptText.text, "text")),
      "",
      "### Root Response",
      "",
      responsePreview,
      "",
      detailsBlock("Show full root response", fencedBlock(responseText.text, "text")),
      "",
      "### REPL Activity",
      "",
      iteration.replExecutions.length === 0
        ? "_No REPL blocks were executed in this iteration._"
        : `Executed ${iteration.replExecutions.length} REPL block(s).`,
    ];

    cells.push(markdownCell(iterationLines.join("\n")));

    for (const repl of iteration.replExecutions) {
      cells.push(renderReplCell(repl, policy));
    }

    const subcalls = trace.subcalls.filter((subcall) => subcall.iterationIndex === iteration.index);
    cells.push(markdownCell(renderSubcallTable(subcalls, iteration.index)));
  }

  if (trace.finalization) {
    const finalPreview = summarizeParagraph(trace.finalization.answer, 420);
    const finalLines = [
      "## Final Answer",
      "",
      "| Field | Value |",
      "| --- | --- |",
      `| Directive | \`${trace.finalization.directiveKind}\` |`,
      `| Fallback Used | \`${trace.finalization.fallbackUsed}\` |`,
      `| Final Var Name | \`${trace.finalization.finalVarName ?? "N/A"}\` |`,
      "",
      finalPreview,
      "",
      detailsBlock("Show full final answer", fencedBlock(trace.finalization.answer, "markdown")),
    ];

    if (trace.finalization.fallbackResponse) {
      const fallbackResponse = redactPromptText(trace.finalization.fallbackResponse, policy);
      finalLines.push(
        "",
        detailsBlock("Show fallback root response", fencedBlock(fallbackResponse.text, "text")),
      );
    }

    cells.push(markdownCell(finalLines.join("\n")));
  }

  cells.push(
    codeCell(JSON.stringify(trace), [], {
      tags: ["rlm-raw-trace", "hidden"],
      jupyter: {
        source_hidden: true,
      },
    }),
  );

  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
      language_info: {
        name: "python",
      },
      rlm_run: {
        run_id: trace.runId,
        status: trace.status,
        root_model: trace.config.rootModel,
        sub_model: trace.config.subModel,
        iterations: trace.rootIterations.length,
        subcalls: trace.subcalls.length,
        duration_ms: trace.durationMs ?? null,
      },
    },
    cells,
  };
}

function renderReplCell(repl: ReplExecutionTrace, policy: RedactionPolicy): NotebookCodeCell {
  const outputs: NotebookOutput[] = [];

  if (repl.stdout.length > 0) {
    const redactedStdout = redactReplOutput(repl.stdout, policy);
    outputs.push({
      output_type: "stream",
      name: "stdout",
      text: sourceLines(redactedStdout.text),
    });
  }

  if (repl.stderr.length > 0) {
    const redactedStderr = redactReplOutput(repl.stderr, policy);
    outputs.push({
      output_type: "stream",
      name: "stderr",
      text: sourceLines(redactedStderr.text),
    });
  }

  return codeCell(repl.code, outputs, {
    rlm: {
      repl_execution_id: repl.id,
      iteration: repl.iterationIndex,
      execution_time_sec: repl.executionTimeSec,
      locals_keys: repl.localsKeys,
      started_at: repl.startedAt,
      ended_at: repl.endedAt,
    },
  });
}

function renderSubcallTable(subcalls: SubcallTrace[], iterationIndex: number): string {
  if (subcalls.length === 0) {
    return `### Subcalls (Iteration ${iterationIndex})\n\n_No subcalls recorded in this iteration._`;
  }

  const rows = subcalls.map((subcall) => {
    const promptPreview = summarizeForTable(subcall.prompt);
    const responsePreview = summarizeForTable(subcall.response);

    return [
      escapeTableCell(subcall.id),
      escapeTableCell(subcall.kind),
      escapeTableCell(subcall.model),
      String(subcall.latencyMs),
      escapeTableCell(promptPreview),
      escapeTableCell(responsePreview),
      escapeTableCell(subcall.error ? "yes" : "no"),
    ].join(" | ");
  });

  return [
    `### Subcalls (Iteration ${iterationIndex})`,
    "",
    "| ID | Kind | Model | Latency ms | Prompt Preview | Response Preview | Error |",
    "| --- | --- | --- | ---: | --- | --- | --- |",
    ...rows.map((row) => `| ${row} |`),
  ].join("\n");
}

function formatUsage(usage?: TokenUsageTrace): string {
  if (!usage) {
    return "N/A";
  }

  const parts: string[] = [];
  if (usage.inputTokens !== undefined) {
    parts.push(`input=${usage.inputTokens}`);
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`output=${usage.outputTokens}`);
  }
  if (usage.totalTokens !== undefined) {
    parts.push(`total=${usage.totalTokens}`);
  }
  if (usage.reasoningTokens !== undefined) {
    parts.push(`reasoning=${usage.reasoningTokens}`);
  }
  if (usage.cachedInputTokens !== undefined) {
    parts.push(`cached_input=${usage.cachedInputTokens}`);
  }

  return parts.length > 0 ? parts.join(", ") : "N/A";
}

function summarizeParagraph(text: string, maxLength: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "_No text._";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function summarizeForTable(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= 64) {
    return normalized;
  }

  return `${normalized.slice(0, 61)}...`;
}

function detailsBlock(summary: string, body: string): string {
  const safeSummary = escapeHtml(summary);
  return [`<details>`, `<summary>${safeSummary}</summary>`, "", body, "", `</details>`].join("\n");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function markdownCell(text: string): NotebookMarkdownCell {
  return {
    cell_type: "markdown",
    metadata: {},
    source: sourceLines(text),
  };
}

function codeCell(
  source: string,
  outputs: NotebookOutput[],
  metadata: Record<string, unknown>,
): NotebookCodeCell {
  return {
    cell_type: "code",
    metadata,
    execution_count: null,
    source: sourceLines(source),
    outputs,
  };
}

function sourceLines(text: string): string[] {
  const lines = text.split("\n");
  return lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line));
}

function fencedBlock(text: string, language = "text"): string {
  const tickRuns = text.match(/`+/g) ?? [];
  const maxRun = tickRuns.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = "`".repeat(Math.max(3, maxRun + 1));
  return `${fence}${language}\n${text}\n${fence}`;
}
