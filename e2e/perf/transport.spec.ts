// SPDX-License-Identifier: LicenseRef-Proprietary
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect } from "node:http2";
import type { AddressInfo } from "node:net";
import { expect } from "@playwright/test";
import { measure, observePaint } from "./measurement";
import { startProxy } from "./proxy";
import { test } from "./transport";

test("selected transports retain native protocol, waterfall, cookies and streamed bodies", { tag: "@perf" }, async ({ browser, request, transports }) => {
  const received: object[] = [];
  const upstream = createServer((request, response) => {
    if (request.url === "/api/v1/echo") {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        received.push({ body, cookie: request.headers.cookie, host: request.headers.host, origin: request.headers.origin });
        response.writeHead(200, { "content-type": "application/json", "set-cookie": ["one=1; Path=/", "two=2; Path=/"], connection: "keep-alive" });
        response.write('{"ok":');
        response.end("true}");
      });
    } else if (request.url === "/redirect") {
      response.writeHead(302, { location: "/" }).end();
    } else {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><main><h1>Transport probe</h1></main><span hidden data-route-ready="" data-route-key="sample"></span>
        <script>history.replaceState({__TSR_key:'sample'},'');fetch('/api/v1/echo',{method:'POST',body:'streamed body'}).then(r=>r.json()).then(()=>document.querySelector('[data-route-ready]').dataset.routeReady='/');</script>`);
    }
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const direct = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  const proxy = await startProxy(direct);
  try {
    expect((await request.get(proxy.origin, { ignoreHTTPSErrors: true })).status()).toBe(200);
    for (const { browser: engine, protocol } of transports) {
      const origin = proxy.origin;
      const context = await engine.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" });
      try {
        await context.addCookies([{ name: "session", value: "probe", url: origin }]);
        await context.addInitScript(observePaint);
        const page = await context.newPage();
        const sample = await measure(page, `${origin}/redirect`, protocol);
        expect(sample.errors).toEqual([]);
        expect(sample.protocol).toBe(protocol);
        expect(sample.waterfall).toEqual(expect.arrayContaining([
          expect.objectContaining({ path: "/api/v1/echo", protocol, start_ms: expect.any(Number), response_start_ms: expect.any(Number), end_ms: expect.any(Number) }),
        ]));
        expect(received.at(-1)).toEqual({ body: "streamed body", cookie: "session=probe", host: new URL(origin).host, origin });
        expect((await context.cookies()).map(cookie => cookie.name).sort()).toEqual(["one", "session", "two"]);
        expect((await measure(page, origin, "wrong-protocol")).errors).toContain(`expected wrong-protocol, received ${protocol}`);
      } finally { await context.close(); }
    }
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const page = await context.newPage();
      expect((await page.goto(proxy.origin))?.status()).toBe(502);
    } finally { await context.close(); }
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    upstream.close();
  }
});

test("HTTP/2 streams reach the origin without the six-connection queue", { tag: "@perf" }, async () => {
  const held: import("node:http").ServerResponse[] = [];
  const upstream = createServer((_request, response) => {
    held.push(response);
    if (held.length === 12) for (const pending of held) pending.end("released together");
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = await startProxy(`http://localhost:${(upstream.address() as AddressInfo).port}`);
  const client = connect(proxy.origin, { rejectUnauthorized: false });
  try {
    const [bodies] = await Promise.all([
      Promise.all(Array.from({ length: 12 }, (_, n) => new Promise<string>((resolve, reject) => {
        const stream = client.request({ ":path": `/chunk/${n}` });
        let body = "";
        stream.setEncoding("utf8");
        stream.on("data", chunk => { body += chunk; });
        stream.on("end", () => resolve(body)).on("error", reject);
        stream.end();
      }))),
      expect.poll(() => held.length).toBe(12),
    ]);
    expect(bodies).toEqual(Array(12).fill("released together"));
  } finally {
    client.destroy();
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("Connection-nominated headers are stripped on both proxy legs", { tag: "@perf" }, async () => {
  let headers: import("node:http").IncomingHttpHeaders = {};
  const upstream = createServer((request, response) => {
    headers = request.headers;
    response.writeHead(200, { connection: "x-response-private", "x-response-private": "secret", "x-public": "visible" }).end("ok");
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = await startProxy(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
  try {
    const result = await new Promise<import("node:http").IncomingHttpHeaders>((resolve, reject) => {
      const request = httpsRequest(proxy.origin, { rejectUnauthorized: false,
        headers: { connection: "X-Request-Private", "x-request-private": "secret", "x-public": "visible" } }, response => {
        response.resume();
        response.on("end", () => resolve(response.headers));
      });
      request.on("error", reject).end();
    });
    expect(headers["x-request-private"]).toBeUndefined();
    expect(headers["x-public"]).toBe("visible");
    expect(result["x-response-private"]).toBeUndefined();
    expect(result["x-public"]).toBe("visible");
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

test("resource timing expands beyond the initial browser buffer", { tag: "@perf" }, async ({ page }) => {
  const upstream = createServer((request, response) => {
    if (request.url !== "/") { response.end("chunk"); return; }
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><main>Timing buffer</main><script>
      Promise.all(Array.from({length: 320}, (_, n) => fetch('/chunk/' + n).then(r => r.text())))
        .then(() => document.body.dataset.done = 'yes');
    </script>`);
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  try {
    await page.addInitScript(observePaint);
    await page.goto(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}`);
    await expect(page.locator("body")).toHaveAttribute("data-done", "yes");
    expect(await page.evaluate(() => performance.getEntriesByType("resource").filter(e => new URL(e.name).pathname.startsWith("/chunk/")).length)).toBe(320);
  } finally {
    upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
