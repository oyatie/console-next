// SPDX-License-Identifier: LicenseRef-Proprietary
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";

test("the loopback fake replays status, validation and unavailable contracts", async () => {
  const child = spawn(process.execPath, [new URL("./nts-fake.mjs", import.meta.url).pathname], { env: { ...process.env, NTS_FAKE_PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
  try {
    const [bytes] = await once(child.stdout, "data");
    const url = bytes.toString().match(/NTS_FAKE_URL=(http[^\n]+)/)[1];
    const post = (path, body) => fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post("/api/nts-businessman/v1/status", { b_no: ["0008100009"] })).status, 401);
    let response = await post("/api/nts-businessman/v1/status?serviceKey=fixture", { b_no: ["0008100009"] });
    assert.equal((await response.json()).data[0].b_stt_cd, "01");
    await post("/__control", { status_code: "03", end_dt: "20261001" });
    response = await post("/api/nts-businessman/v1/validate?serviceKey=fixture", { businesses: [{ b_no: "0008100009", start_dt: "20200101", p_nm: "김등록" }] });
    const body = await response.json();
    assert.equal(body.data[0].status.end_dt, "20261001");
    assert.equal(JSON.stringify(body).includes("김등록"), false);
    response = await post("/api/nts-businessman/v1/status?serviceKey=fixture", { b_no: Array.from({ length: 101 }, () => "0008100009") });
    assert.equal(response.status, 413);
  } finally { child.kill("SIGTERM"); await once(child, "exit"); }
});
