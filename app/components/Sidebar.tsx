"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";

import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { StatusBadge } from "./StatusBadge";

interface DocRecord {
  _id: Id<"documents">;
  filename: string;
  sizeBytes: number;
  status: "ready" | "invalid" | "deleted";
}

interface RunRecord {
  _id: Id<"runs">;
  question: string;
  status: "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelled";
  durationMs?: number;
  createdAt: number;
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

async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function Sidebar({
  selectedDocId,
  setSelectedDocId,
  activeRunId,
  setActiveRunId,
  setError,
}: {
  selectedDocId: Id<"documents"> | null;
  setSelectedDocId: (id: Id<"documents"> | null) => void;
  activeRunId: Id<"runs"> | null;
  setActiveRunId: (id: Id<"runs"> | null) => void;
  setError: (msg: string | null) => void;
}) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const generateUploadUrl = useMutation(api.files.generateUploadUrl);
  const commitUpload = useMutation(api.files.commitUpload);
  const documents = (useQuery(api.files.listRecent, { limit: 50 }) ?? []) as DocRecord[];
  const runs = (useQuery(api.runs.listRecent, { limit: 20 }) ?? []) as RunRecord[];

  const handleFileSelect = (file: File | null) => {
    if (file) setSelectedFile(file);
  };

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

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) {
      setSelectedFile(file);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>RLM</h1>
        <p>Recursive reasoning engine</p>
      </div>

      <div className="sidebar-section">
        <h2>Upload</h2>
        <div
          className={`upload-zone ${dragOver ? "drag-over" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onClick={() => document.getElementById("file-input")?.click()}
        >
          <input
            type="file"
            accept=".txt,.md"
            onChange={(e) => handleFileSelect(e.target.files?.[0] ?? null)}
            id="file-input"
          />
          {selectedFile ? (
            <div>
              <span className="upload-zone-filename">{selectedFile.name}</span>
              <span className="upload-zone-size">{formatBytes(selectedFile.size)}</span>
            </div>
          ) : (
            <span className="upload-zone-text">Drop .txt or .md file here</span>
          )}
        </div>
        {selectedFile && (
          <button className="btn-primary" onClick={handleUpload} disabled={uploading} style={{ width: "100%" }}>
            {uploading ? <><span className="spinner" />Uploading...</> : "Upload"}
          </button>
        )}
      </div>

      <div className="sidebar-section">
        <h2>Documents</h2>
        <div className="doc-list">
          {documents.length === 0 ? (
            <span className="dim">No documents yet</span>
          ) : (
            documents
              .filter((d) => d.status === "ready")
              .map((doc) => (
                <button
                  key={doc._id}
                  type="button"
                  className={`doc-item ${doc._id === selectedDocId ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedDocId(doc._id);
                    setActiveRunId(null);
                  }}
                >
                  <span className="doc-name">{doc.filename}</span>
                  <span className="doc-meta">{formatBytes(doc.sizeBytes)}</span>
                </button>
              ))
          )}
        </div>
      </div>

      <div className="sidebar-section" style={{ borderBottom: "none" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
          <h2 style={{ margin: 0 }}>Run History</h2>
          <button
            type="button"
            className="btn-secondary"
            style={{ padding: "0.2rem 0.5rem", fontSize: "0.7rem" }}
            onClick={() => {
              setSelectedDocId(null);
              setActiveRunId(null);
            }}
          >
            + New Thread
          </button>
        </div>
        <div className="run-history">
          {runs.length === 0 ? (
            <span className="dim">No runs yet</span>
          ) : (
            runs.map((run) => (
              <button
                key={run._id}
                type="button"
                className={`run-history-item ${run._id === activeRunId ? "active" : ""}`}
                onClick={() => setActiveRunId(run._id)}
              >
                <span className="run-question-preview">{run.question}</span>
                <span className="run-history-meta">
                  <StatusBadge status={run.status} />
                  {run.durationMs != null && (
                    <span className="dim" style={{ fontSize: "0.7rem" }}>
                      {(run.durationMs / 1000).toFixed(0)}s
                    </span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="sidebar-scroll" />
    </aside>
  );
}
