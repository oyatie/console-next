import { expect, test } from "vitest";
import { websiteHost } from "./api";
import { suggestedDomain } from "./domain/slug";

test("reference parsing offers only a valid website or company-email domain", () => {
  for (const raw of ["https://www.saeon.example/path", "saeon.example", "hong@saeon.example"]) {
    expect(suggestedDomain(websiteHost(raw))).toBe("saeon");
  }
  for (const raw of ["한빛정밀", "hong@@saeon.example", "hong@", "file:///saeon.example", "https://", "https://user@saeon.example", "ab.com"]) {
    expect(suggestedDomain(websiteHost(raw))).toBeNull();
  }
});
