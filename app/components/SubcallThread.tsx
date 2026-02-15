"use client";

import { useState } from "react";

import type { SubcallNode } from "../hooks/useEventTree";
import { StatusBadge } from "./StatusBadge";

export function SubcallThread({ subcall }: { subcall: SubcallNode }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="subcall-thread fade-in">
      <div className="subcall-header" onClick={() => setOpen(!open)}>
        <span className="subcall-label">{subcall.id}</span>
        {subcall.model && <span className="subcall-model">{subcall.model}</span>}
        <StatusBadge status={subcall.status} />
        {subcall.latencyMs != null && (
          <span className="subcall-timing">{(subcall.latencyMs / 1000).toFixed(1)}s</span>
        )}
      </div>
      <div className={`subcall-body ${open ? "" : "collapsed"}`}>
        <div className="subcall-content">
          {subcall.promptPreview && (
            <>
              <div className="subcall-prompt-label">Prompt</div>
              <div className="subcall-prompt">{subcall.promptPreview}</div>
            </>
          )}
          {subcall.responsePreview && (
            <>
              <div className="subcall-response-label">Response</div>
              <div className="subcall-response">{subcall.responsePreview}</div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
