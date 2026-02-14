import http from "node:http";

export interface SingleQueryRequest {
  prompt: string;
  model?: string;
}

export interface BatchedQueryRequest {
  prompts: string[];
  model?: string;
}

export interface LLMBridgeHandlers {
  onSingleQuery: (request: SingleQueryRequest) => Promise<string>;
  onBatchedQuery: (request: BatchedQueryRequest) => Promise<string[]>;
}

export class LLMBridgeServer {
  private readonly server: http.Server;
  private listenPromise: Promise<void> | null = null;

  constructor(private readonly handlers: LLMBridgeHandlers) {
    this.server = http.createServer(async (req, res) => {
      try {
        if (req.method !== "POST") {
          this.sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        const body = await this.readBody(req);

        if (req.url === "/llm_query") {
          const payload = body as Partial<SingleQueryRequest>;
          if (typeof payload.prompt !== "string") {
            this.sendJson(res, 400, { error: "Invalid payload: prompt is required" });
            return;
          }

          const response = await this.handlers.onSingleQuery({
            prompt: payload.prompt,
            model: payload.model,
          });

          this.sendJson(res, 200, { response });
          return;
        }

        if (req.url === "/llm_query_batched") {
          const payload = body as Partial<BatchedQueryRequest>;
          if (!Array.isArray(payload.prompts)) {
            this.sendJson(res, 400, { error: "Invalid payload: prompts is required" });
            return;
          }

          const prompts = payload.prompts.map((item) => String(item));
          const responses = await this.handlers.onBatchedQuery({
            prompts,
            model: payload.model,
          });

          this.sendJson(res, 200, { responses });
          return;
        }

        this.sendJson(res, 404, { error: "Not found" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.sendJson(res, 500, { error: message });
      }
    });
  }

  async start(host = "127.0.0.1", port = 0): Promise<void> {
    if (this.listenPromise) {
      return this.listenPromise;
    }

    this.listenPromise = new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, host, () => {
        this.server.off("error", reject);
        resolve();
      });
    });

    return this.listenPromise;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    this.listenPromise = null;
  }

  get url(): string {
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("LLM bridge server is not running");
    }

    return `http://${address.address}:${address.port}`;
  }

  private async readBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];

    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) {
      return {};
    }

    return JSON.parse(raw);
  }

  private sendJson(res: http.ServerResponse, statusCode: number, body: Record<string, unknown>): void {
    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}
