// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { beforeAll, expect, test } from "vitest";
import { DecisionPane } from "./decision-pane";

beforeAll(() => loadCatalog("ko"));

test("DecisionPane renders side-by-side reject, optional return, and primary approve buttons", () => {
  const twoWay = renderToStaticMarkup(
    <DecisionPane opinion="" onOpinionChange={() => undefined} onApprove={() => undefined} onReject={() => undefined} />,
  );
  expect(twoWay).toContain(t("uiWorklist.opinionOptional"));
  expect(twoWay).toContain(t("uiWorklist.reject"));
  expect(twoWay).toContain(t("uiWorklist.approve"));
  expect(twoWay).not.toContain(t("uiWorklist.return"));

  const threeWay = renderToStaticMarkup(
    <DecisionPane
      opinion=""
      onOpinionChange={() => undefined}
      onApprove={() => undefined}
      onReject={() => undefined}
      onReturn={() => undefined}
      multiline
      consequence="Next approver will be notified."
    />,
  );
  expect(threeWay).toContain(t("uiWorklist.return"));
  expect(threeWay).toContain("<textarea");
  expect(threeWay).toContain("Next approver will be notified.");
});
