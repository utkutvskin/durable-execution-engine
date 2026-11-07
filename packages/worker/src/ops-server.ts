import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { METRICS_CONTENT_TYPE, type EngineMetrics, type HealthChecks } from "@dee/core";

/**
 * Configuration of `startOpsServer`: the `health` probes and the `metrics`
 * to serve, and where to listen (`host` defaults to `0.0.0.0`, `port` 0
 * picks a free one). `metricsToken` makes `/metrics` require that bearer
 * token.
 */
export interface OpsServerOptions {
  readonly health: HealthChecks;
  readonly metrics: EngineMetrics;
  readonly port: number;
  readonly host?: string;
  readonly metricsToken?: string;
  readonly onError?: (error: unknown) => void;
}

/**
 * A running ops server.
 */
export interface OpsServer {
  readonly port: number;
  readonly host: string;
  stop(): Promise<void>;
}

function json(status: number, body: unknown): { status: number; body: string; type: string } {
  return { status, body: JSON.stringify(body), type: "application/json" };
}

/**
 * Serves `GET /health` (liveness), `GET /ready` (the database answers) and
 * `GET /metrics` (Prometheus text) for a process that has no api, such as a
 * worker. Every other path answers 404 and every other method 405.
 */
export async function startOpsServer(options: OpsServerOptions): Promise<OpsServer> {
  const host = options.host ?? "0.0.0.0";
  const server: Server = createServer((request, response) => {
    void (async (): Promise<void> => {
      let result: { status: number; body: string; type: string };
      try {
        const path = (request.url ?? "/").split("?")[0] ?? "/";
        if (request.method !== "GET") {
          result = json(405, { error: { code: "method_not_allowed" } });
        } else if (path === "/health") {
          result = json(200, options.health.live());
        } else if (path === "/ready") {
          const readiness = await options.health.ready();
          result = json(readiness.ready ? 200 : 503, readiness);
        } else if (path === "/metrics") {
          const expected =
            options.metricsToken === undefined ? undefined : `Bearer ${options.metricsToken}`;
          if (expected !== undefined && request.headers.authorization !== expected) {
            result = json(401, { error: { code: "unauthorized" } });
          } else {
            result = {
              status: 200,
              body: await options.metrics.render(),
              type: METRICS_CONTENT_TYPE,
            };
          }
        } else {
          result = json(404, { error: { code: "not_found" } });
        }
      } catch (error) {
        options.onError?.(error);
        result = json(500, { error: { code: "internal_error" } });
      }
      response.writeHead(result.status, {
        "content-type": result.type,
        "x-content-type-options": "nosniff",
      });
      response.end(result.body);
    })();
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
  return {
    port,
    host,
    stop(): Promise<void> {
      return new Promise((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
}
