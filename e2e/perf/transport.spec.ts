// SPDX-License-Identifier: LicenseRef-Proprietary
import { createServer } from "node:http";
import { connect } from "node:http2";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { measure, observePaint } from "./measurement";
import { startProxy } from "./proxy";

test("paired transports retain native protocol, waterfall, cookies and streamed bodies", { tag: "@perf" }, async ({ browser }) => {
  const received: object[] = [];
  const upstream = createServer((request, response) => {
    if (request.url === "/api/v1/echo") {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        received.push({ body, cookie: request.headers.cookie, host: request.headers.host });
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
  const direct = `http://localhost:${(upstream.address() as AddressInfo).port}`;
  const proxy = await startProxy(direct);
  try {
    for (const [origin, protocol] of [[direct, "http/1.1"], [proxy.origin, "h2"]] as const) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: "block" });
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
        expect(received.at(-1)).toEqual({ body: "streamed body", cookie: "session=probe", host: new URL(origin).host });
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
