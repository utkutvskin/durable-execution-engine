import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { stripTypeScriptTypes } from "node:module";

/**
 * Where the ui is mounted on the api's origin.
 */
export const UI_BASE_PATH = "/ui";

interface Asset {
  readonly contentType: string;
  readonly body: string;
}

const CLIENT_DIRECTORY = new URL("./client/", import.meta.url);
const ASSET_NAME = /^[a-z][a-z-]*\.(?:js|css)$/;

function loadAssets(): ReadonlyMap<string, Asset> {
  const assets = new Map<string, Asset>();
  for (const name of readdirSync(CLIENT_DIRECTORY)) {
    const source = (): string => readFileSync(new URL(name, CLIENT_DIRECTORY), "utf8");
    if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      assets.set(name.replace(/\.ts$/, ".js"), {
        contentType: "text/javascript; charset=utf-8",
        body: stripTypeScriptTypes(source(), { mode: "strip" }),
      });
    } else if (name.endsWith(".css")) {
      assets.set(name, { contentType: "text/css; charset=utf-8", body: source() });
    }
  }
  return assets;
}

function respond(response: ServerResponse, status: number, asset: Asset): void {
  response.writeHead(status, {
    "content-type": asset.contentType,
    "content-length": Buffer.byteLength(asset.body),
    "cache-control": "no-cache",
    "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'",
    "x-content-type-options": "nosniff",
  });
  response.end(asset.body);
}

/**
 * Creates the handler that serves the run explorer: the html shell at `/ui`
 * and its scripts and styles at `/ui/assets/<name>`. The browser modules are
 * written in TypeScript and are served with their types stripped, so there
 * is no build step. The handler returns true when it answered the request
 * and false for anything else, which makes it usable as the api's
 * `sideHandler`.
 */
export function createUiHandler(): (request: IncomingMessage, response: ServerResponse) => boolean {
  const assets = loadAssets();
  const index: Asset = {
    contentType: "text/html; charset=utf-8",
    body: readFileSync(new URL("index.html", CLIENT_DIRECTORY), "utf8"),
  };

  return (request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return false;
    }
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (path === "/") {
      response.writeHead(302, { location: `${UI_BASE_PATH}/` });
      response.end();
      return true;
    }
    if (path === UI_BASE_PATH || path === `${UI_BASE_PATH}/`) {
      respond(response, 200, index);
      return true;
    }
    const name = path.startsWith(`${UI_BASE_PATH}/assets/`)
      ? path.slice(`${UI_BASE_PATH}/assets/`.length)
      : undefined;
    if (name === undefined || !ASSET_NAME.test(name)) {
      return false;
    }
    const asset = assets.get(name);
    if (asset === undefined) {
      respond(response, 404, { contentType: "text/plain; charset=utf-8", body: "not found" });
      return true;
    }
    respond(response, 200, asset);
    return true;
  };
}
