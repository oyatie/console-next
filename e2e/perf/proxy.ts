// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Agent, request, type IncomingHttpHeaders } from "node:http";
import { createSecureServer, type ServerHttp2Session } from "node:http2";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// HTTP/2 forbids connection-specific HTTP/1 headers, including names listed by Connection.
function endToEnd(headers: IncomingHttpHeaders) {
  const hop = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer",
    ...(headers.connection ?? "").toLowerCase().split(",").map(name => name.trim())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !name.startsWith(":") && !hop.has(name)));
}

/** Loopback-only TLS termination; the origin's streaming bodies and cache headers pass through. */
export async function startProxy(upstream: string, port = 0) {
  const target = new URL(upstream);
  const certDir = mkdtempSync(path.join(tmpdir(), "route-load-tls-"));
  const key = path.join(certDir, "key.pem"), cert = path.join(certDir, "cert.pem");
  let credentials;
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-keyout", key, "-out", cert], { stdio: "ignore" });
    credentials = { key: readFileSync(key), cert: readFileSync(cert) };
  } finally { rmSync(certDir, { recursive: true, force: true }); }
  // Multiplexed browser streams must not queue behind the origin client's default socket limit.
  const agent = new Agent({ keepAlive: true, maxSockets: Infinity });
  const sessions = new Set<ServerHttp2Session>(), sockets = new Set<Socket>();
  const server = createSecureServer({ ...credentials, minVersion: "TLSv1.2" }, (incoming, outgoing) => {
    const forwarded = request({ hostname: target.hostname, port: target.port, path: incoming.url,
      method: incoming.method, headers: { ...endToEnd(incoming.headers), host: incoming.headers[":authority"] ?? incoming.headers.host }, agent }, response => {
      outgoing.writeHead(response.statusCode ?? 502, endToEnd(response.headers));
      response.on("error", () => outgoing.destroy());
      response.pipe(outgoing);
    });
    forwarded.on("error", () => {
      if (outgoing.headersSent) outgoing.destroy();
      else outgoing.writeHead(502).end("Upstream unavailable");
    });
    incoming.on("error", () => forwarded.destroy());
    outgoing.on("close", () => forwarded.destroy());
    incoming.pipe(forwarded);
  });
  server.on("session", session => {
    sessions.add(session);
    session.on("error", () => session.destroy());
    session.on("close", () => sessions.delete(session));
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    origin: `https://localhost:${(server.address() as AddressInfo).port}`,
    close: async () => {
      for (const session of sessions) session.destroy();
      for (const socket of sockets) socket.destroy();
      agent.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const proxy = await startProxy(process.argv[2]!, Number(process.argv[3]));
  console.log(`[perf-proxy] ready ${proxy.origin}`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void proxy.close(); });
}
