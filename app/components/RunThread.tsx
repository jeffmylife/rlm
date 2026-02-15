"use client";

import { useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useEventTree } from "../hooks/useEventTree";
import { AnswerBlock } from "./AnswerBlock";
import { IterationBlock } from "./IterationBlock";
import { StatusBadge } from "./StatusBadge";

interface RunRecord {
  _id: Id<"runs">;
  status: "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelled";
  answer?: string;
  errorCode?: string;
  errorMessage?: string;
  durationMs?: number;
}

interface ArtifactRecord {
  _id: Id<"run_artifacts">;
  kind: string;
  url: string | null;
}

export function RunThread({ runId }: { runId: Id<"runs"> }) {
  const run = useQuery(api.runs.get, { runId }) as RunRecord | null | undefined;
  const events = useQuery(api.runEvents.streamAll, { runId });
  const artifacts = (useQuery(api.runs.listArtifacts, { runId }) ?? []) as ArtifactRecord[];
  const tree = useEventTree(events ?? undefined);

  if (!run) return null;

  const isActive = run.status === "queued" || run.status === "running";

  return (
    <div className="run-thread">
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.25rem" }}>
        <StatusBadge status={run.status} />
        {run.durationMs != null && (
          <span className="dim">{(run.durationMs / 1000).toFixed(1)}s</span>
        )}
      </div>

      {tree.map((iteration) => (
        <IterationBlock
          key={iteration.index}
          iteration={iteration}
          isActive={isActive && iteration.status === "started"}
        />
      ))}

      {run.answer && <AnswerBlock answer={run.answer} />}

      {run.errorMessage && (
        <div className="error-block fade-in">
          <div className="error-label">Error</div>
          {run.errorCode && <div className="error-code">{run.errorCode}</div>}
          <pre className="error-message">{run.errorMessage}</pre>
        </div>
      )}

      {artifacts.length > 0 && (
        <div className="artifact-links">
          {artifacts.map(
            (a) =>
              a.url && (
                <a key={a._id} href={a.url} target="_blank" rel="noreferrer" className="btn-secondary">
                  {a.kind.replace("_", " ")}
                </a>
              ),
          )}
        </div>
      )}
    </div>
  );
}
