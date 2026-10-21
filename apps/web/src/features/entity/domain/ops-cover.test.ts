import { describe, expect, it } from "vitest";
import { opsCorrectionLine } from "./ops-cover";

describe("opsCorrectionLine", () => {
  it("is the server's line, with the number in canonical digits", () => {
    expect(opsCorrectionLine("crn", "000111-0012348", "d0c")).toBe("ENTITY_IDENTIFIER_CORRECTION\ncrn\n0001110012348\nd0c");
    expect(opsCorrectionLine("brn", "000-00-00048", "d0c")).toBe("ENTITY_IDENTIFIER_CORRECTION\nbrn\n0000000048\nd0c");
    expect(opsCorrectionLine("biz_kind", "CORPORATION", "d0c")).toBe("ENTITY_IDENTIFIER_CORRECTION\nbiz_kind\nCORPORATION\nd0c");
  });
  it("binds the value: another number is another line", () => {
    expect(opsCorrectionLine("brn", "0000000048", "d0c")).not.toBe(opsCorrectionLine("brn", "0000000000", "d0c"));
  });
});
