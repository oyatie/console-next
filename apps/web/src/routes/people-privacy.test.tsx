// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog } from "@console/i18n";
import { rrnStatusQuery } from "../features/people/api/record";
import { RrnValue } from "../features/people/ui/rrn-value";
import { RrnCard } from "../features/identifiers/ui/rrn-card";
import { MaskedValue } from "../features/people/ui/masked-value";
import type { Card } from "../features/people/ui/use-card";

beforeAll(() => loadCatalog("ko"));

const c = { e: { id: "person", name: "한기록", employee_number: "1001" } } as Card;
const masked = "••••••-•••••••";
const shared = vi.hoisted(() => vi.fn());
vi.mock("../features/people/ui/masked-value", async (original) => {
  const actual = await original<typeof import("../features/people/ui/masked-value")>();
  return { ...actual, MaskedValue: (props: Parameters<typeof actual.MaskedValue>[0]) => { shared(props); return <actual.MaskedValue {...props} />; } };
});

test("the card and identifiers render the same server mask through one reveal component", async () => {
  const client = new QueryClient();
  await client.prefetchQuery({ ...rrnStatusQuery(c.e.id), queryFn: async () => ({ employee_id: c.e.id, recorded: true, masked, source: "IMPORT" }) });
  const render = (child: React.ReactNode) => renderToStaticMarkup(<QueryClientProvider client={client}>{child}</QueryClientProvider>);
  shared.mockClear();
  for (const view of [<RrnValue key="card" employeeId={c.e.id} who={c.e.name} masked={masked} />, <RrnCard key="identifiers" employeeId={c.e.id} who={c.e.name} />]) {
    const out = render(view);
    expect(out).toContain(masked);
    expect(out).not.toMatch(/[●*]|\d{6}-\d/);
  }
  expect(shared).toHaveBeenCalledTimes(2);
});

test("a field without a server reveal stays masked and offers no local opening", () => {
  const out = renderToStaticMarkup(<MaskedValue masked="••••-••-••" {...{ value: "1965-01-01" }} field="생년월일" who="한기록" />);
  expect(out).toContain("••••-••-••");
  expect(out).not.toContain("1965");
  expect(out).not.toContain("<button");
});
