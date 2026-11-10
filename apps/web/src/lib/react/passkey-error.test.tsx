// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "@console/api";
import { loadCatalog } from "@console/i18n";
import { PasskeyError } from "./passkey-error";

beforeAll(() => loadCatalog("ko"));

test("passkey commands use their surface's refusal copy and retain the code", () => {
  const html = renderToStaticMarkup(<PasskeyError error={new ApiError(403, "account_link_self_forbidden", "server fallback")}
    own={() => "다른 담당자에게 요청하십시오"} />);
  expect(html).toContain("다른 담당자에게 요청하십시오");
  expect(html).toContain("account_link_self_forbidden");
  expect(html).not.toContain("server fallback");
});
