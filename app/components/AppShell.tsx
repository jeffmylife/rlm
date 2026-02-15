"use client";

import { useState } from "react";

import type { Id } from "../../convex/_generated/dataModel";
import { ChatView } from "./ChatView";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  const [selectedDocId, setSelectedDocId] = useState<Id<"documents"> | null>(null);
  const [activeRunId, setActiveRunId] = useState<Id<"runs"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="app-shell">
      <Sidebar
        selectedDocId={selectedDocId}
        setSelectedDocId={setSelectedDocId}
        activeRunId={activeRunId}
        setActiveRunId={setActiveRunId}
        setError={setError}
      />
      <ChatView
        selectedDocId={selectedDocId}
        activeRunId={activeRunId}
        setActiveRunId={setActiveRunId}
        setError={setError}
      />
      {error && (
        <div className="error-toast">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="btn-close">
            &times;
          </button>
        </div>
      )}
    </div>
  );
}
