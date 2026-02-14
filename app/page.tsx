"use client";

import { useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { useMutation } from "convex/react";
import { ConvexError } from "convex/values";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

interface DocRecord {
  _id: Id<"documents">;
  filename: string;
  sizeBytes: number;
  status: "ready" | "invalid" | "deleted";
}

interface RunRecord {
  _id: Id<"runs">;
  status: "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelled";
  answer?: string;
  errorCode?: string;
  errorMessage?: string;
  durationMs?: number;
}

interface EventRecord {
  _id: string;
  seq: number;
  ts: number;
  kind: string;
  summary: string;
  payload?: unknown;
}

interface ArtifactRecord {
  _id: string;
  kind: string;
  url: string | null;
}

export default function HomePage() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [question, setQuestion] = useState("");
  const [selectedDocId, setSelectedDocId] = useState<Id<"documents"> | null>(null);
  const [activeRunId, setActiveRunId] = useState<Id<"runs"> | null>(null);
  const [uploading, setUploading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const commitUpload = useMutation(api.files.commitUpload);
  const startRun = useMutation(api.runs.start);
  const documents = (useQuery(api.files.listRecent, { limit: 20 }) ?? []) as DocRecord[];
  const run = useQuery(api.runs.get, activeRunId ? { runId: activeRunId } : "skip") as RunRecord | undefined;
  const events = useQuery(api.runEvents.list, activeRunId ? { runId: activeRunId, limit: 300 } : "skip") as
    | { items: EventRecord[]; nextCursor: number | null }
    | undefined;
  const artifacts = (useQuery(api.runs.listArtifacts, activeRunId ? { runId: activeRunId } : "skip") ??
    []) as ArtifactRecord[];

  const selectedDoc = useMemo(
    () => documents.find((d) => d._id === selectedDocId) ?? null,
    [documents, selectedDocId],
  );

  const handleUpload = async () => {
    if (!selectedFile) return;
    setError(null);
    setUploading(true);
    try {
      const url = await generateUploadUrl({});
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": selectedFile.type || "text/plain" },
        body: selectedFile,
      });
      if (!res.ok) throw new Error(`Upload failed (${res.status})`);
      const { storageId } = (await res.json()) as { storageId: string };
      if (!storageId) throw new Error("No storageId returned");

      const sha256 = await hashFile(selectedFile);
      const docId = await commitUpload({
        storageId: storageId as Id<"_storage">,
        filename: selectedFile.name,
        sizeBytes: selectedFile.size,
        mimeType: selectedFile.name.toLowerCase().endsWith(".md") ? "text/markdown" : "text/plain",
        sha256,
      });
      setSelectedDocId(docId);
      setSelectedFile(null);
    } catch (err) {
      setError(err instanceof ConvexError ? String(err.data) : err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleStartRun = async () => {
    if (!selectedDocId || !question.trim()) return;
    setError(null);
    setStarting(true);
    try {
      const runId = await startRun({
        documentId: selectedDocId,
        question: question.trim(),
      });
      setActiveRunId(runId);
    } catch (err) {
      setError(err instanceof ConvexError ? String(err.data) : err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const isRunActive = run?.status === "queued" || run?.status === "running";

  return (
    <div className="container">
      <header className="header">
        <h1>RLM Sandbox</h1>
        <p>Upload a document, ask a question, and watch recursive reasoning in real time.</p>
      </header>

      <div className="grid-2">
        {/* Documents Panel */}
        <section className="card">
          <h2>Documents</h2>

          <div className="upload-area">
            <input
              type="file"
              accept=".txt,.md"
              onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              id="file-input"
            />
            <label htmlFor="file-input" className="upload-label">
              {selectedFile ? (
                <>
                  <strong>{selectedFile.name}</strong>
                  <span className="dim">{formatBytes(selectedFile.size)}</span>
                </>
              ) : (
                <span className="dim">Choose a .txt or .md file</span>
              )}
            </label>
            <button className="btn-primary" onClick={handleUpload} disabled={!selectedFile || uploading}>
              {uploading ? (
                <>
                  <span className="spinner" />
                  Uploading
                </>
              ) : (
                "Upload"
              )}
            </button>
          </div>

          <div className="doc-list">
            {documents.length === 0 ? (
              <p className="dim">No documents uploaded yet.</p>
            ) : (
              documents.map((doc) => (
                <button
                  key={doc._id}
                  type="button"
                  className={`doc-item ${doc._id === selectedDocId ? "selected" : ""}`}
                  onClick={() => setSelectedDocId(doc._id)}
                >
                  <span className="doc-name">{doc.filename}</span>
                  <span className="doc-meta">
                    {formatBytes(doc.sizeBytes)}
                    {doc.status !== "ready" && (
                      <span className={`badge badge-${doc.status === "invalid" ? "error" : "dim"}`}>
                        {doc.status}
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        </section>

        {/* Run Panel */}
        <section className="card">
          <h2>Run</h2>

          {selectedDoc ? (
            <p className="dim" style={{ marginBottom: "0.75rem" }}>
              Using: <strong>{selectedDoc.filename}</strong>
            </p>
          ) : (
            <p className="dim" style={{ marginBottom: "0.75rem" }}>
              Select a document to get started.
            </p>
          )}

          <textarea
            placeholder="What would you like to know about this document?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={!selectedDocId}
          />

          <button
            className="btn-primary"
            onClick={handleStartRun}
            disabled={!selectedDocId || !question.trim() || starting || isRunActive}
          >
            {starting ? (
              <>
                <span className="spinner" />
                Starting
              </>
            ) : isRunActive ? (
              <>
                <span className="spinner" />
                Running
              </>
            ) : (
              "Start Run"
            )}
          </button>

          {run && (
            <div className="run-info">
              <div className="run-status-row">
                <span className={`badge badge-${statusColor(run.status)}`}>{run.status}</span>
                {run.durationMs != null && <span className="dim">{(run.durationMs / 1000).toFixed(1)}s</span>}
              </div>

              {run.errorMessage && (
                <div className="error-box">
                  {run.errorCode && <strong>{run.errorCode}</strong>}
                  <pre>{run.errorMessage}</pre>
                </div>
              )}

              {run.answer && (
                <div className="answer-box">
                  <h3>Answer</h3>
                  <pre>{run.answer}</pre>
                </div>
              )}

              {artifacts.length > 0 && (
                <div>
                  <h3>Artifacts</h3>
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
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Timeline */}
      {activeRunId && events?.items && events.items.length > 0 && (
        <section className="card">
          <h2>
            Timeline <span className="dim">({events.items.length} events)</span>
          </h2>
          <div className="timeline">
            {events.items.map((event) => (
              <div className="timeline-event" key={event._id}>
                <div className="event-header">
                  <span className="event-seq">#{event.seq}</span>
                  <span className="event-kind">{event.kind}</span>
                  <span className="event-time">{new Date(event.ts).toLocaleTimeString()}</span>
                </div>
                <div className="event-summary">{event.summary}</div>
                {event.payload != null && (
                  <details>
                    <summary className="dim">details</summary>
                    <pre className="event-payload">{JSON.stringify(event.payload, null, 2)}</pre>
                  </details>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

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

function statusColor(status: string): string {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
    case "timed_out":
      return "error";
    case "running":
      return "active";
    case "queued":
      return "warning";
    default:
      return "dim";
  }
}

async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

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
