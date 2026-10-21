import { expect, test } from "vitest";
import { sha256Hex } from "./step-up";

test("the payload hash is the lowercase hex SHA-256 of the UTF-8 text", async () => {
  expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  expect(await sha256Hex("PERIOD_UNLOCK\nx\nRETRO_CORRECTION\n2026-10-05T00:00:00Z")).toMatch(/^[0-9a-f]{64}$/);
});
