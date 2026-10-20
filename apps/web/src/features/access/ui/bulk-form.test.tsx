import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog, t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { BulkForm, type BulkDraft } from "./bulk-form";
import { blankLine } from "../domain/grants";

beforeAll(() => loadCatalog("ko"));

test("primary commit is disabled (filled style, with DisabledReason) when 0 people picked", () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const draft: BulkDraft = {
    line: blankLine("k1"),
    when: null,
    reason: { code: "OTHER", memo: "test" },
  };
  const html = renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <BulkForm
        roles={[]}
        setup={false}
        today="2026-10-20"
        value={draft}
        onChange={() => {}}
        tried={false}
        gaps={[]}
        picked={0}
        onPickScope={() => {}}
      >
        <Button variant="primary">{t("access.bulk.preview", { count: 0 })}</Button>
      </BulkForm>
    </QueryClientProvider>,
  );
  expect(html).toContain("0명 미리보기");
  const buttonMatch = html.match(/<button[^>]*>[^<]*0명 미리보기[^<]*<\/button>/);
  expect(buttonMatch).not.toBeNull();
  const button = buttonMatch![0];
  expect(button).toContain('aria-disabled="true"');
  expect(button).toContain("btn--primary");
  const idMatch = button.match(/aria-describedby="([^"]+)"/);
  expect(idMatch).not.toBeNull();
  expect(html).toContain(`id="${idMatch![1]}"`);
  expect(html).toContain("부여할 사람을 한 명 이상 선택하십시오.");
});
