"use client";

import { type KeyboardEvent, useState } from "react";

export function QuestionInput({
  onSubmit,
  onCancel,
  disabled,
  isRunning,
}: {
  onSubmit: (question: string) => void;
  onCancel: () => void;
  disabled: boolean;
  isRunning: boolean;
}) {
  const [value, setValue] = useState("");

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSubmit(trimmed);
    setValue("");
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="input-bar">
      <textarea
        placeholder={disabled ? "Select a document first..." : "Ask a question about this document..."}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled || isRunning}
        rows={1}
      />
      {isRunning ? (
        <button className="btn-cancel" onClick={onCancel}>
          Cancel
        </button>
      ) : (
        <button
          className="btn-primary"
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
        >
          Send
        </button>
      )}
    </div>
  );
}
