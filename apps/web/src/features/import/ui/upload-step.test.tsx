import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { UploadStep } from "./upload-step";

const command = vi.hoisted(() => ({ options: {} as { forget?: boolean } }));
vi.mock("../../../lib/react/command", () => ({ useCommand: (options: { forget?: boolean }) => {
  command.options = options;
  return { isPending: true, error: null, mutate: vi.fn(), reset: vi.fn() };
} }));
beforeAll(() => loadCatalog("ko"));

test("pending roster reads lock their source and dates and forget the raw workbook result", () => {
  const html = renderToStaticMarkup(<UploadStep paste onPreview={() => undefined} />);
  expect(html).toMatch(/<fieldset[^>]*disabled=""[\s\S]*직원 목록[\s\S]*<\/fieldset>/);
  expect(command.options.forget).toBe(true);
});
