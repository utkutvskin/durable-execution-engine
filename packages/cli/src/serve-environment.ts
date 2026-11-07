import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createQuotaStore,
  type Logger,
  type Pool,
  type Tracing,
  type WorkflowRegistry,
} from "@dee/core";
import { createApiKeyStore, createApiServer } from "@dee/api";
import { createUiHandler } from "@dee/ui";
import type { ServeLimits } from "./commands/runtime-flags.js";

/**
 * Configuration of `startServeEnvironment`. `port` 0 picks a free port.
 * `apiKey` is a key chosen by the operator (from `WF_API_KEY`); without one,
 * the namespace keeps the keys it has, and only a namespace without any gets
 * a freshly issued one.
 */
export interface ServeEnvironmentOptions {
  readonly pool: Pool;
  readonly namespace: string;
  readonly queueName: string;
  readonly port: number;
  readonly host: string;
  readonly apiKey?: string | undefined;
  readonly limits: ServeLimits;
  readonly logger: Logger;
  readonly tracing?: Tracing | undefined;
  readonly workflows?: WorkflowRegistry | undefined;
}

/**
 * How the namespace got its key: `adopted` from the environment, `issued`
 * fresh (the plain `issuedKey` exists only in this result) or `existing`
 * when the namespace already had one.
 */
export type KeySource = "adopted" | "issued" | "existing";

/**
 * The running api process: no worker, only the api with the web ui.
 */
export interface ServeEnvironment {
  readonly url: string;
  readonly namespace: string;
  readonly namespaceId: string;
  readonly keySource: KeySource;
  readonly issuedKey: string | undefined;
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
 * Starts what `wf serve` runs against `options.pool`: the api and the web ui,
 * with the limits applied to the namespace and the key resolved as described
 * on `ServeEnvironmentOptions`. It does not migrate and runs no engine.
 */
export async function startServeEnvironment(
  options: ServeEnvironmentOptions,
): Promise<ServeEnvironment> {
  const keys = createApiKeyStore(options.pool);
  const namespaceId = await keys.ensureNamespace(options.namespace);
  let keySource: KeySource;
  let issuedKey: string | undefined;
  if (options.apiKey !== undefined) {
    await keys.adopt(options.namespace, options.apiKey, "wf serve");
    keySource = "adopted";
  } else if (await keys.hasActiveKey(options.namespace)) {
    keySource = "existing";
  } else {
    issuedKey = (await keys.issue(options.namespace, "wf serve")).key;
    keySource = "issued";
  }
  if (Object.keys(options.limits.quota).length > 0) {
    const quotas = createQuotaStore(options.pool);
    const current = await quotas.get(namespaceId);
    await quotas.set(namespaceId, { ...current, ...options.limits.quota });
  }
  const api = createApiServer(options.pool, {
    queueName: options.queueName,
    apiKeys: keys,
    sideHandler: createUiHandler(),
    logger: options.logger,
    ...(options.tracing === undefined ? {} : { tracing: options.tracing }),
    ...(options.workflows === undefined ? {} : { workflows: options.workflows }),
    ...(options.limits.maxQueueDepth === undefined
      ? {}
      : { maxQueueDepth: options.limits.maxQueueDepth }),
    ...(options.limits.metricsToken === undefined
      ? {}
      : { metricsToken: options.limits.metricsToken }),
    ...(options.limits.metricsCacheMs === undefined
      ? {}
      : { metricsCacheMs: options.limits.metricsCacheMs }),
  });
  const port = await listen(api.server, options.port, options.host);
  return {
    url: `http://${options.host}:${String(port)}`,
    namespace: options.namespace,
    namespaceId,
    keySource,
    issuedKey,
    stop: () => close(api.server),
  };
}
