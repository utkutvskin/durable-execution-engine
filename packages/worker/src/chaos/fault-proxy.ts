import { createServer, connect, type Server, type Socket } from "node:net";

/**
 * A TCP proxy placed between a client and Postgres so a chaos run can break
 * the network on purpose.
 */
export interface FaultProxy {
  /** The local port clients connect to. */
  readonly port: number;
  /** Connections accepted so far, including ones that were refused. */
  readonly accepted: number;
  /** Connections destroyed on purpose by `sever`, `refuseNext` or `dropResponseToNextCommits`. */
  readonly severed: number;
  /** Destroys every open connection, as a network partition or a restarted server would. */
  sever(): void;
  /** Destroys the next `count` new connections as soon as they are accepted. */
  refuseNext(count: number): void;
  /**
   * For the next `count` commits that pass through: the commit reaches the
   * server and is executed, but its response is swallowed and the connection
   * is destroyed, so the client cannot know whether the transaction applied.
   */
  dropResponseToNextCommits(count: number): void;
  /** Delays every chunk by `delayMs()` milliseconds, preserving order. */
  setLatency(delayMs: () => number): void;
  close(): Promise<void>;
}

interface Pair {
  readonly client: Socket;
  readonly upstream: Socket;
  swallowNextResponse: boolean;
}

const COMMIT_STATEMENT = /commit\0/i;

/**
 * Starts a `FaultProxy` that forwards to `upstreamHost:upstreamPort` and
 * listens on an ephemeral local port.
 */
export async function startFaultProxy(
  upstreamHost: string,
  upstreamPort: number,
): Promise<FaultProxy> {
  const pairs = new Set<Pair>();
  let refusals = 0;
  let commitsToDrop = 0;
  let latency: () => number = () => 0;
  let accepted = 0;
  let severed = 0;

  function destroy(pair: Pair): void {
    if (pairs.delete(pair)) {
      severed += 1;
    }
    pair.client.destroy();
    pair.upstream.destroy();
  }

  async function delayed(): Promise<void> {
    const delay = latency();
    if (delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  const server: Server = createServer((client) => {
    accepted += 1;
    client.on("error", () => undefined);
    if (refusals > 0) {
      refusals -= 1;
      severed += 1;
      client.destroy();
      return;
    }
    const upstream = connect(upstreamPort, upstreamHost);
    upstream.on("error", () => undefined);
    const pair: Pair = { client, upstream, swallowNextResponse: false };
    pairs.add(pair);
    const gone = (): void => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("close", gone);
    upstream.on("close", gone);

    let towardServer: Promise<void> = Promise.resolve();
    client.on("data", (chunk: Buffer) => {
      towardServer = towardServer.then(async () => {
        await delayed();
        if (commitsToDrop > 0 && COMMIT_STATEMENT.test(chunk.toString("latin1"))) {
          commitsToDrop -= 1;
          pair.swallowNextResponse = true;
        }
        if (!upstream.destroyed) {
          upstream.write(chunk);
        }
      });
    });

    let towardClient: Promise<void> = Promise.resolve();
    upstream.on("data", (chunk: Buffer) => {
      towardClient = towardClient.then(async () => {
        await delayed();
        if (pair.swallowNextResponse) {
          destroy(pair);
          return;
        }
        if (!client.destroyed) {
          client.write(chunk);
        }
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fault proxy has no port");
  }

  return {
    port: address.port,
    get accepted(): number {
      return accepted;
    },
    get severed(): number {
      return severed;
    },
    sever(): void {
      for (const pair of [...pairs]) {
        destroy(pair);
      }
    },
    refuseNext(count: number): void {
      refusals += count;
    },
    dropResponseToNextCommits(count: number): void {
      commitsToDrop += count;
    },
    setLatency(delayMs: () => number): void {
      latency = delayMs;
    },
    async close(): Promise<void> {
      for (const pair of [...pairs]) {
        pair.client.destroy();
        pair.upstream.destroy();
      }
      pairs.clear();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
