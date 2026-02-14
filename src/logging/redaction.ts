import { createHash } from "node:crypto";

import { type RedactionPolicy } from "./traceTypes.js";

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
  maxPromptChars: 12_000,
  maxContextPreviewChars: 4_000,
  maxReplOutputChars: 200_000,
  headChars: 4_000,
  tailChars: 1_500,
};

export interface RedactedText {
  text: string;
  redacted: boolean;
  originalLength: number;
  digest: string | null;
}

export function resolveRedactionPolicy(policy?: Partial<RedactionPolicy>): RedactionPolicy {
  return {
    maxPromptChars: policy?.maxPromptChars ?? DEFAULT_REDACTION_POLICY.maxPromptChars,
    maxContextPreviewChars:
      policy?.maxContextPreviewChars ?? DEFAULT_REDACTION_POLICY.maxContextPreviewChars,
    maxReplOutputChars: policy?.maxReplOutputChars ?? DEFAULT_REDACTION_POLICY.maxReplOutputChars,
    headChars: policy?.headChars ?? DEFAULT_REDACTION_POLICY.headChars,
    tailChars: policy?.tailChars ?? DEFAULT_REDACTION_POLICY.tailChars,
  };
}

export function redactPromptText(text: string, policy: RedactionPolicy): RedactedText {
  return redactLongText(text, policy.maxPromptChars, policy);
}

export function redactContextPreview(text: string, policy: RedactionPolicy): RedactedText {
  if (text.length <= policy.maxContextPreviewChars) {
    return {
      text,
      redacted: false,
      originalLength: text.length,
      digest: null,
    };
  }

  const digest = sha256(text);
  const preview = text.slice(0, policy.maxContextPreviewChars);
  return {
    text: `${preview}\n... [context preview truncated ${text.length - policy.maxContextPreviewChars} chars]`,
    redacted: true,
    originalLength: text.length,
    digest,
  };
}

export function redactReplOutput(text: string, policy: RedactionPolicy): RedactedText {
  return redactLongText(text, policy.maxReplOutputChars, policy);
}

function redactLongText(text: string, threshold: number, policy: RedactionPolicy): RedactedText {
  if (text.length <= threshold) {
    return {
      text,
      redacted: false,
      originalLength: text.length,
      digest: null,
    };
  }

  const head = text.slice(0, policy.headChars);
  const tail = text.slice(Math.max(text.length - policy.tailChars, policy.headChars));
  const omitted = text.length - head.length - tail.length;
  const digest = sha256(text);

  const rendered = [
    head,
    `\n... [truncated ${omitted} chars; sha256=${digest}] ...\n`,
    tail,
  ].join("");

  return {
    text: rendered,
    redacted: true,
    originalLength: text.length,
    digest,
  };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
