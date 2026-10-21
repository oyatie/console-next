import { PORTS } from "./slot";

/** Publish the fixed E2E document through the dev/test application fixture API. */
export async function publishTestTerms(version: `e2e-v${number}` = "e2e-v1") {
  const response = await fetch(`http://127.0.0.1:${PORTS.backend}/__e2e/terms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version }),
  });
  if (response.status !== 204) throw new Error(`E2E terms fixture expected 204, got ${response.status}`);
}
