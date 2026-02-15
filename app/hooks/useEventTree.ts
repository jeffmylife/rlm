"use client";

import { useMemo } from "react";

import type { Id } from "../../convex/_generated/dataModel";

interface RawEvent {
  _id: Id<"run_events">;
  _creationTime: number;
  runId: Id<"runs">;
  seq: number;
  ts: number;
  kind: string;
  summary: string;
  payload?: Record<string, unknown>;
}

export interface SubcallNode {
  id: string;
  status: "started" | "completed" | "failed";
  model?: string;
  promptPreview?: string;
  responsePreview?: string;
  latencyMs?: number;
  batchIndex?: number;
}

export interface ReplBlockNode {
  id: string;
  status: "started" | "completed";
  code?: string;
  stdoutPreview?: string;
  stderrPreview?: string;
  localsKeys?: string[];
  executionTime?: number;
  subcalls: SubcallNode[];
}

export interface IterationNode {
  index: number;
  status: "started" | "completed";
  responsePreview?: string;
  latencyMs?: number;
  codeBlocks: number;
  replBlocks: ReplBlockNode[];
}

export function useEventTree(events: RawEvent[] | undefined): IterationNode[] {
  return useMemo(() => {
    if (!events || events.length === 0) return [];

    const iterations = new Map<number, IterationNode>();
    const replBlocks = new Map<string, ReplBlockNode>();
    const subcalls = new Map<string, SubcallNode>();

    for (const event of events) {
      const p = (event.payload ?? {}) as Record<string, unknown>;

      switch (event.kind) {
        case "root.iteration.started": {
          const idx = p.iteration as number;
          if (idx == null) break;
          iterations.set(idx, {
            index: idx,
            status: "started",
            codeBlocks: 0,
            replBlocks: [],
          });
          break;
        }

        case "root.iteration.completed": {
          const idx = p.iteration as number;
          if (idx == null) break;
          const iter = iterations.get(idx);
          if (iter) {
            iter.status = "completed";
            iter.responsePreview = p.responsePreview as string | undefined;
            iter.latencyMs = p.latencyMs as number | undefined;
            iter.codeBlocks = (p.codeBlocks as number) ?? 0;
          }
          break;
        }

        case "repl.execution.started": {
          const replId = p.replExecutionId as string;
          const iterIdx = p.iteration as number;
          if (!replId || iterIdx == null) break;
          const block: ReplBlockNode = {
            id: replId,
            status: "started",
            code: p.code as string | undefined,
            subcalls: [],
          };
          replBlocks.set(replId, block);
          const iter = iterations.get(iterIdx);
          if (iter) {
            iter.replBlocks.push(block);
          }
          break;
        }

        case "repl.execution.completed": {
          const replId = p.replExecutionId as string;
          if (!replId) break;
          const block = replBlocks.get(replId);
          if (block) {
            block.status = "completed";
            block.stdoutPreview = p.stdoutPreview as string | undefined;
            block.stderrPreview = p.stderrPreview as string | undefined;
            block.localsKeys = p.localsKeys as string[] | undefined;
            block.executionTime = p.executionTimeSec as number | undefined;
          }
          break;
        }

        case "subcall.started": {
          const subcallId = p.subcallId as string;
          const replId = p.replExecutionId as string;
          if (!subcallId) break;
          const node: SubcallNode = {
            id: subcallId,
            status: "started",
            model: p.model as string | undefined,
            promptPreview: p.promptPreview as string | undefined,
            batchIndex: p.batchIndex as number | undefined,
          };
          subcalls.set(subcallId, node);
          if (replId) {
            const block = replBlocks.get(replId);
            if (block) {
              block.subcalls.push(node);
            }
          }
          break;
        }

        case "subcall.completed": {
          const subcallId = p.subcallId as string;
          if (!subcallId) break;
          const node = subcalls.get(subcallId);
          if (node) {
            node.status = "completed";
            node.responsePreview = p.responsePreview as string | undefined;
            node.latencyMs = p.latencyMs as number | undefined;
          }
          break;
        }

        case "subcall.failed":
        case "subcall.rejected": {
          const subcallId = p.subcallId as string;
          if (!subcallId) break;
          const node = subcalls.get(subcallId);
          if (node) {
            node.status = "failed";
          }
          break;
        }
      }
    }

    return Array.from(iterations.values()).sort((a, b) => a.index - b.index);
  }, [events]);
}
