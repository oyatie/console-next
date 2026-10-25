// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
import { OnboardDialog } from "./onboard-form";

const state = vi.hoisted(() => ({ inputs: ["Example", "example", ""], next: 0 }));
// Base-worktree runs share node_modules; load this checkout's catalogs instead of its workspace symlink.
vi.mock("@console/i18n", async () => await import("../../../../../../packages/i18n/src/index"));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => typeof initial === "string" ? [state.inputs[state.next++] ?? initial, vi.fn()] : react.useState(initial) };
});
vi.mock("../../../ui/dialog", () => ({ Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => open ? <div role="dialog">{children}</div> : null }));
vi.mock("@tanstack/react-query", async (original) => ({ ...await original<typeof import("@tanstack/react-query")>(), useQuery: () => ({ isFetching: false, data: { available: true } }) }));
vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock("../../../lib/react/command-error", () => ({ CommandError: () => null }));
beforeAll(() => Promise.all([loadCatalog("ko"), loadCatalog("en")]));

const noop = () => undefined;
const render = (locale: "ko" | "en") => {
  i18n.set(locale);
  state.next = 0;
  return renderToStaticMarkup(<OnboardDialog open existing={[]} onClose={noop} onIssued={noop} onLost={noop} />);
};

test.each(["ko", "en"] as const)("%s domain preview describes the input below its full-width control", (locale) => {
  const html = render(locale);
  const input = html.match(/<input\b[^>]*value="example"[^>]*\/>/);
  expect(input).not.toBeNull();
  const hint = input![0].match(/aria-describedby="([^"]+)"/)?.[1];
  expect(hint).toBeDefined();
  expect(html).toContain(`${input![0]}</div><p data-hint="field" id="${hint}"`);
  expect(html).toContain(`<span>${t("tenants.form.preview", { slug: "example" })}</span></p>`);
  expect(html).not.toContain('<output for=');
});

test.each(["ko", "en"] as const)("%s onboarding labels have no parentheticals and one optional marker", (locale) => {
  const html = render(locale);
  const labels = [...html.matchAll(/<label\b[^>]*>(.*?)<\/label>/g)].map((label) => label[1]!);
  expect(labels).toHaveLength(3);
  for (const label of labels) expect(label).not.toMatch(/[()]/);
  expect(labels.join(" ").match(/선택|optional/gi)).toHaveLength(1);
});

test.each(["ko", "en"] as const)("%s onboarding has one submit verb and the shared Cancel word", (locale) => {
  const html = render(locale);
  expect(html).toContain(`>${t("common.cancel")}</button>`);
  expect(html).not.toContain(`>${t("common.back")}</button>`);
  const submit = html.match(/<button\b[^>]*type="submit"[^>]*>([^<]*)<\/button>/)?.[1];
  expect(submit).toBe(locale === "ko" ? "개설" : "Open");
  expect(submit).not.toBe(t("tenants.create"));
  expect(submit).not.toMatch(/하고|\band\b/i);
});
