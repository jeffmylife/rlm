import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";

export interface PythonExecResult {
  stdout: string;
  stderr: string;
  locals: Record<string, string>;
  execution_time: number;
}

export interface PythonWorkerInitOptions {
  context?: unknown;
  contextFilePath?: string;
  bridgeUrl: string;
}

interface WorkerResponse {
  ok: boolean;
  error?: string;
  stdout?: string;
  stderr?: string;
  locals?: Record<string, string>;
  execution_time?: number;
  value?: string;
}

export class PythonReplWorker {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly stdoutReader: readline.Interface;
  private readonly pending: Array<{
    resolve: (response: WorkerResponse) => void;
    reject: (error: Error) => void;
  }> = [];
  private closed = false;

  constructor(scriptPath = path.resolve(process.cwd(), "python/uv_repl_worker.py")) {
    const launcher = (process.env.RLM_PYTHON_LAUNCHER ?? "uv").trim();
    const launch = resolvePythonLaunch(scriptPath, launcher);

    this.child = spawn(launch.command, launch.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.stdoutReader = readline.createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    });

    this.stdoutReader.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      const pendingRequest = this.pending.shift();
      if (!pendingRequest) {
        return;
      }

      try {
        const parsed = JSON.parse(line) as WorkerResponse;
        pendingRequest.resolve(parsed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pendingRequest.reject(new Error(`Failed to parse worker response: ${message}`));
      }
    });

    this.child.stderr.on("data", (chunk) => {
      process.stderr.write(`[python-worker] ${chunk.toString()}`);
    });

    this.child.on("exit", (code, signal) => {
      this.closed = true;
      while (this.pending.length > 0) {
        const pendingRequest = this.pending.shift();
        if (!pendingRequest) {
          break;
        }

        pendingRequest.reject(
          new Error(`Python worker exited unexpectedly (code=${code}, signal=${signal})`),
        );
      }
    });
  }

  async init(context: unknown, bridgeUrl: string): Promise<void>;
  async init(options: PythonWorkerInitOptions): Promise<void>;
  async init(
    contextOrOptions: unknown | PythonWorkerInitOptions,
    bridgeUrl?: string,
  ): Promise<void> {
    if (
      bridgeUrl === undefined &&
      typeof contextOrOptions === "object" &&
      contextOrOptions !== null &&
      "bridgeUrl" in contextOrOptions
    ) {
      const typed = contextOrOptions as PythonWorkerInitOptions;
      await this.request({
        cmd: "init",
        context: typed.context,
        context_file_path: typed.contextFilePath,
        bridge_url: typed.bridgeUrl,
      });
      return;
    }

    await this.request({
      cmd: "init",
      context: contextOrOptions,
      bridge_url: bridgeUrl,
    });
  }

  async exec(code: string): Promise<PythonExecResult> {
    const response = await this.request({ cmd: "exec", code });
    return {
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      locals: response.locals ?? {},
      execution_time: response.execution_time ?? 0,
    };
  }

  async finalVar(name: string): Promise<string> {
    const response = await this.request({ cmd: "final_var", name });
    return response.value ?? "";
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      await this.request({ cmd: "close" });
    } catch {
      // Ignore close errors and force shutdown below.
    }

    this.stdoutReader.close();
    this.child.kill();
    this.closed = true;
  }

  private async request(payload: Record<string, unknown>): Promise<WorkerResponse> {
    if (this.closed) {
      throw new Error("Python worker is not available");
    }

    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, "utf8", (error) => {
        if (error) {
          this.pending.pop();
          reject(error);
          return;
        }
      });
    }).then((response) => {
      if (!response.ok) {
        throw new Error(response.error ?? "Unknown worker error");
      }
      return response;
    });
  }
}

function resolvePythonLaunch(
  scriptPath: string,
  launcher: string,
): { command: string; args: string[] } {
  switch (launcher) {
    case "python":
      return { command: "python", args: [scriptPath] };
    case "python3":
      return { command: "python3", args: [scriptPath] };
    case "uv":
      return { command: "uv", args: ["run", "python", scriptPath] };
    default:
      return { command: launcher, args: [scriptPath] };
  }
}
