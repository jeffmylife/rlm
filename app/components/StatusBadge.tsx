"use client";

const STATUS_MAP: Record<string, { label: string; variant: string }> = {
  queued: { label: "queued", variant: "warning" },
  running: { label: "running", variant: "active" },
  completed: { label: "completed", variant: "success" },
  failed: { label: "failed", variant: "error" },
  timed_out: { label: "timed out", variant: "error" },
  cancelled: { label: "cancelled", variant: "dim" },
};

export function StatusBadge({ status }: { status: string }) {
  const info = STATUS_MAP[status] ?? { label: status, variant: "dim" };
  const isActive = status === "running" || status === "queued";

  return (
    <span className={`badge badge-${info.variant}`}>
      {isActive && <span className="badge-dot" />}
      {info.label}
    </span>
  );
}
