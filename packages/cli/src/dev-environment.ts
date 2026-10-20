import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  migrateUp,
  silentLogger,
  type ClockSource,
  type Logger,
  type Pool,
  type ScheduleManager,
} from "@dee/core";
import { createApiKeyStore, createApiServer } from "@dee/api";
import { createUiHandler } from "@dee/ui";
import { startEngine, type Engine } from "@dee/worker";
import type { WorkflowModule } from "./modules.js";
import { createApiClient, type RunClient } from "./run-client.js";

/**
 * Configuration of `startDevEnvironment`. `port` 0 picks a free port.
 * `migrate` (default true) applies pending migrations first. `loopIntervalMs`
 * is how often the timer, schedule and janitor loops run.
 */
export interface DevEnvironmentOptions {
  readonly pool: Pool;
  readonly module: WorkflowModule;
  readonly port: number;
  readonly host?: string;
  readonly namespace?: string;
  readonly queueName?: string;
  readonly migrate?: boolean;
  readonly loopIntervalMs?: number;
  readonly pollIntervalMs?: number;
  readonly clock?: ClockSource;
  readonly logger?: Logger;
  readonly onError?: (error: unknown) => void;
}

/**
 * The running environment: an api with the web ui mounted at `/ui`, and an
 * engine that runs the workflows of the module.
 */
export interface DevEnvironment {
  readonly url: string;
  readonly apiKey: string;
  readonly namespace: string;
  readonly namespaceId: string;
  readonly client: RunClient;
  readonly engine: Engine;
  readonly schedules: ScheduleManager;
  /** Stops accepting requests, then drains the engine. The pool stays open. */
  stop(): Promise<void>;
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeAllConnections();
  });
}

/**
 * Starts what `wf dev` runs against `options.pool`: the api with the ui and
 * an engine for `options.module`, in one process. It issues a fresh api key
 * for the namespace (created when missing) and returns it with a `RunClient`
 * that already uses it.
 */
export async function startDevEnvironment(options: DevEnvironmentOptions): Promise<DevEnvironment> {
  if (options.migrate !== false) {
    await migrateUp(options.pool);
  }
  const namespace = options.namespace ?? "default";
  const issued = await createApiKeyStore(options.pool).issue(namespace, "wf dev");
  const queueName = options.queueName ?? "default";
  const engine = startEngine({
    pool: options.pool,
    queueName,
    workflows: options.module.workflows,
    steps: options.module.steps,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.loopIntervalMs === undefined ? {} : { loopIntervalMs: options.loopIntervalMs }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });
  const api = createApiServer(options.pool, {
    queueName,
    sideHandler: createUiHandler(),
    logger: options.logger ?? silentLogger,
  });
  const host = options.host ?? "127.0.0.1";
  let port: number;
  try {
    port = await listen(api.server, options.port, host);
  } catch (error) {
    await engine.stop();
    throw error;
  }
  const url = `http://${host}:${String(port)}`;
  return {
    url,
    apiKey: issued.key,
    namespace,
    namespaceId: issued.namespaceId,
    client: createApiClient({ baseUrl: url, apiKey: issued.key }),
    engine,
    schedules: engine.schedules,
    async stop(): Promise<void> {
      await close(api.server);
      await engine.stop();
    },
  };
}
