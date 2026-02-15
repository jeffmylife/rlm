"use client";

import { useState } from "react";

import type { IterationNode } from "../hooks/useEventTree";
import { ReplBlock } from "./ReplBlock";

export function IterationBlock({
  iteration,
  isActive,
}: {
  iteration: IterationNode;
  isActive: boolean;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="iteration-block fade-in">
      <div
        className={`iteration-header ${isActive ? "active" : ""}`}
        onClick={() => setOpen(!open)}
      >
        <span className={`iteration-chevron ${open ? "open" : ""}`}>{open ? "\u25BE" : "\u25B8"}</span>
        <span className="iteration-number">#{iteration.index}</span>
        <span className="iteration-summary">
          {iteration.codeBlocks} code block{iteration.codeBlocks !== 1 ? "s" : ""}
          {iteration.replBlocks.reduce((n, b) => n + b.subcalls.length, 0) > 0 &&
            ` \u00B7 ${iteration.replBlocks.reduce((n, b) => n + b.subcalls.length, 0)} subcall${
              iteration.replBlocks.reduce((n, b) => n + b.subcalls.length, 0) !== 1 ? "s" : ""
            }`}
        </span>
        {iteration.latencyMs != null && (
          <span className="iteration-timing">{(iteration.latencyMs / 1000).toFixed(1)}s</span>
        )}
      </div>
      <div className={`iteration-body ${open ? "" : "collapsed"}`}>
        <div className="iteration-content">
          {iteration.responsePreview && (
            <pre className="iteration-response">{iteration.responsePreview}</pre>
          )}
          {iteration.replBlocks.map((block) => (
            <ReplBlock key={block.id} block={block} />
          ))}
        </div>
      </div>
    </div>
  );
}
