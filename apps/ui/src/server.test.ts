import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUiHandler } from "./server.js";

describe("ui handler", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const handler = createUiHandler();
    server = createServer((request, response) => {
      if (!handler(request, response)) {
        response.writeHead(418);
        response.end("not the ui");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  });

  it("serves the html shell at /ui with a strict content security policy", async () => {
    const response = await fetch(`${baseUrl}/ui/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await response.text()).toContain('<div id="app">');
  });

  it("redirects the root to /ui/", async () => {
    const response = await fetch(`${baseUrl}/`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/ui/");
  });

  it("serves browser modules with their types stripped", async () => {
    const response = await fetch(`${baseUrl}/ui/assets/timeline.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    const code = await response.text();
    expect(code).toContain("export function buildTimeline");
    expect(code).not.toContain("interface ");
    expect(code).not.toContain(": TimelineItem[]");
  });

  it("serves every module the shell imports and the stylesheet", async () => {
    for (const name of [
      "main.js",
      "app.js",
      "api.js",
      "run-view.js",
      "runs-view.js",
      "dead-letters-view.js",
      "dom.js",
      "styles.css",
    ]) {
      const response = await fetch(`${baseUrl}/ui/assets/${name}`);
      expect(response.status, name).toBe(200);
    }
  });

  it("answers 404 for an asset that does not exist and ignores names with path syntax", async () => {
    expect((await fetch(`${baseUrl}/ui/assets/missing.js`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/ui/assets/..%2Fserver.ts`)).status).toBe(418);
    expect((await fetch(`${baseUrl}/ui/assets/timeline.test.js`)).status).toBe(418);
  });

  it("leaves other paths and methods to the api", async () => {
    expect((await fetch(`${baseUrl}/v1/runs`)).status).toBe(418);
    expect((await fetch(`${baseUrl}/ui/`, { method: "POST" })).status).toBe(418);
  });
});
