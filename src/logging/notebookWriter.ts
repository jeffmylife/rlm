import fs from "node:fs/promises";
import path from "node:path";

import { type NotebookDocument } from "./notebookRenderer.js";

export interface NotebookWriteResult {
  path: string;
}

export interface NotebookWriteOptions {
  notebook: NotebookDocument;
  outputTarget: string;
  runId: string;
  now?: Date;
}

export async function writeNotebookFile(options: NotebookWriteOptions): Promise<NotebookWriteResult> {
  const outputPath = await resolveNotebookOutputPath(options.outputTarget, options.runId, options.now);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const payload = `${JSON.stringify(options.notebook, null, 2)}\n`;
  const temporaryPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;

  await fs.writeFile(temporaryPath, payload, "utf8");
  await fs.rename(temporaryPath, outputPath);

  return { path: outputPath };
}

export async function resolveNotebookOutputPath(
  outputTarget: string,
  runId: string,
  now: Date = new Date(),
): Promise<string> {
  const resolvedTarget = path.resolve(outputTarget);
  const stats = await statOrNull(resolvedTarget);

  if (stats?.isDirectory()) {
    return path.join(resolvedTarget, buildNotebookFilename(runId, now));
  }

  if (!stats && path.extname(resolvedTarget).toLowerCase() !== ".ipynb") {
    await fs.mkdir(resolvedTarget, { recursive: true });
    return path.join(resolvedTarget, buildNotebookFilename(runId, now));
  }

  if (resolvedTarget.toLowerCase().endsWith(".ipynb")) {
    return resolvedTarget;
  }

  return `${resolvedTarget}.ipynb`;
}

export function buildNotebookFilename(runId: string, now: Date = new Date()): string {
  const timestamp = [
    now.getFullYear().toString(),
    pad2(now.getMonth() + 1),
    pad2(now.getDate()),
    "-",
    pad2(now.getHours()),
    pad2(now.getMinutes()),
    pad2(now.getSeconds()),
  ].join("");

  const shortId = runId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "run";
  return `run-${timestamp}-${shortId}.ipynb`;
}

async function statOrNull(filePath: string): Promise<{ isDirectory(): boolean } | null> {
  try {
    return await fs.stat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}
