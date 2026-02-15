"use client";

import type { ReplBlockNode } from "../hooks/useEventTree";
import { SubcallThread } from "./SubcallThread";

export function ReplBlock({ block }: { block: ReplBlockNode }) {
  return (
    <div className="repl-block fade-in">
      <div className="repl-code-header">
        <span>python</span>
        {block.status === "completed" && block.executionTime != null && (
          <span className="repl-execution-time">{block.executionTime.toFixed(2)}s</span>
        )}
        {block.status === "started" && (
          <span className="repl-execution-time"><span className="spinner" style={{ width: 8, height: 8, borderWidth: 1.5, marginRight: 4 }} />running</span>
        )}
      </div>
      {block.code && <pre className="repl-code">{block.code}</pre>}
      {block.status === "started" && (
        <div className="repl-executing">Executing...</div>
      )}
      {block.status === "completed" && (
        <>
          {block.stdoutPreview && (
            <pre className="repl-output">{block.stdoutPreview}</pre>
          )}
          {block.stderrPreview && (
            <pre className="repl-output repl-stderr">{block.stderrPreview}</pre>
          )}
          {block.localsKeys && block.localsKeys.length > 0 && (
            <div className="repl-locals">vars: {block.localsKeys.join(", ")}</div>
          )}
        </>
      )}
      {block.subcalls.length > 0 && block.subcalls.map((sc) => (
        <SubcallThread key={sc.id} subcall={sc} />
      ))}
    </div>
  );
}
