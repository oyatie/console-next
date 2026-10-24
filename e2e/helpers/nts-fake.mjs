// SPDX-License-Identifier: LicenseRef-Proprietary
// Loopback contract replay. Start before the backend; never uses a real provider key.
import { createServer } from "node:http";
let answer = { status_code: "01", end_dt: "", valid: "01" };
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (status, data) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
  if (req.method !== "POST") return send(405, { code: "METHOD_NOT_ALLOWED" });
  let data;
  try { let raw = ""; for await (const part of req) raw += part; data = JSON.parse(raw); } catch { return send(400, { status_code: "BAD_JSON_REQUEST" }); }
  if (url.pathname === "/__control") { answer = { ...answer, ...data }; return send(200, { ok: true }); }
  if (!url.searchParams.get("serviceKey")) return send(401, { code: -4 });
  if (answer.gateway_code) return send(answer.http_status ?? 401, { code: answer.gateway_code });
  const status = (number) => ({ b_no: number, b_stt_cd: answer.status_code, b_stt: "", tax_type_cd: answer.status_code ? "01" : "", tax_type: answer.status_code ? "" : "국세청에 등록되지 않은 사업자등록번호입니다", end_dt: answer.end_dt, utcc_yn: "N", tax_type_change_dt: "", invoice_apply_dt: "", rbf_tax_type_cd: "99" });
  const validating = url.pathname === "/api/nts-businessman/v1/validate";
  if (!validating && url.pathname !== "/api/nts-businessman/v1/status") return send(404, { code: "NOT_FOUND" });
  const requests = validating ? data.businesses : data.b_no;
  if (!Array.isArray(requests) || requests.length > 100) return send(413, { status_code: "TOO_LARGE_REQUEST" });
  const rows = requests.map((r) => validating ? { b_no: r.b_no, valid: answer.valid, ...(answer.valid === "01" ? { status: status(r.b_no) } : { valid_msg: "확인할 수 없습니다" }) } : status(r));
  send(200, { status_code: "OK", request_cnt: rows.length, data: rows });
});
server.listen(Number(process.env.NTS_FAKE_PORT ?? 0), "127.0.0.1", () => {
  const { port } = server.address();
  process.stdout.write(`NTS_FAKE_URL=http://127.0.0.1:${port}\nNTS_BASE_URL=http://127.0.0.1:${port}/api/nts-businessman/v1/\n`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close());
