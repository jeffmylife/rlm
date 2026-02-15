"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { QuestionInput } from "./QuestionInput";
import { RunThread } from "./RunThread";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let size = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && size >= 1024; i++) {
    size /= 1024;
    unit = units[i];
  }
  return `${size.toFixed(1)} ${unit}`;
}

export function ChatView({
  selectedDocId,
  activeRunId,
  setActiveRunId,
  setError,
}: {
  selectedDocId: Id<"documents"> | null;
  activeRunId: Id<"runs"> | null;
  setActiveRunId: (id: Id<"runs"> | null) => void;
  setError: (msg: string | null) => void;
}) {
  const [starting, setStarting] = useState(false);
  const startRun = useMutation(api.runs.start);
  const cancelRun = useMutation(api.runs.cancel);

  const doc = useQuery(
    api.files.get,
    selectedDocId ? { documentId: selectedDocId } : "skip",
  ) as { _id: Id<"documents">; filename: string; sizeBytes: number } | null | undefined;

  const activeRun = useQuery(
    api.runs.get,
    activeRunId ? { runId: activeRunId } : "skip",
  );

  const isRunActive = activeRun?.status === "queued" || activeRun?.status === "running";

  const scrollRef = useAutoScroll(activeRunId);

  const handleSubmit = async (question: string) => {
    setError(null);
    setStarting(true);
    try {
      const runId = await startRun({
        question,
        ...(selectedDocId ? { documentId: selectedDocId } : {}),
      });
      setActiveRunId(runId);
    } catch (err) {
      setError(err instanceof ConvexError ? String(err.data) : err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const handleCancel = async () => {
    if (!activeRunId) return;
    try {
      await cancelRun({ runId: activeRunId });
    } catch (err) {
      setError(err instanceof ConvexError ? String(err.data) : err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="chat-view">
      {doc && (
        <div className="chat-header">
          <span className="chat-header-filename">{doc.filename}</span>
          <span className="chat-header-meta">{formatBytes(doc.sizeBytes)}</span>
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef}>
        {activeRun ? (
          <div>
            <div className="question-bubble">
              <div className="question-label">Question</div>
              {activeRun.question}
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              <RunThread runId={activeRun._id} />
            </div>
          </div>
        ) : (
          <div className="dim" style={{ textAlign: "center", padding: "2rem" }}>
            Start a new thread by asking a question below.
          </div>
        )}
      </div>

      <QuestionInput
        onSubmit={handleSubmit}
        onCancel={handleCancel}
        disabled={starting}
        isRunning={isRunActive}
      />
    </div>
  );
}
