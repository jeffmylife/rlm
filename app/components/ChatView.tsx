"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { useAutoScroll } from "../hooks/useAutoScroll";
import { QuestionInput } from "./QuestionInput";
import { RunThread } from "./RunThread";

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
      <div className="chat-scroll" ref={scrollRef}>
        {activeRun ? (
          <div>
            <div className="question-bubble">
              <div className="question-label">You</div>
              {activeRun.question}
            </div>
            <div style={{ marginTop: "0.75rem" }}>
              <RunThread runId={activeRun._id} />
            </div>
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">&gt;_</div>
            <h2>Ask anything</h2>
            <p>Submit a question to start a reasoning thread</p>
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
