"use client";

export function AnswerBlock({ answer }: { answer: string }) {
  return (
    <div className="answer-block fade-in">
      <div className="answer-label">Final Answer</div>
      <pre className="answer-text">{answer}</pre>
    </div>
  );
}
