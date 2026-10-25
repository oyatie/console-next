// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { EmploymentRecord } from "./employment-record";

vi.mock("./lifecycle-trail", () => ({
  LifecycleTrail: ({ onRecord }: { onRecord?: (target: string) => void }) => <output data-hire-trail data-record={Boolean(onRecord)} />,
}));
vi.mock("./facts-card", () => ({
  FactsCard: ({ readOnly }: { readOnly?: boolean }) => <output data-employment-facts data-read-only={Boolean(readOnly)} />,
}));
vi.mock("./contracts-card", () => ({
  ContractsCard: ({ editable = true }: { editable?: boolean }) => <output data-contract-history data-editable={editable} />,
}));

const employee = { id: "person" } as ComponentProps<typeof EmploymentRecord>["e"];

test.each([true, false])("the hire trail and employment history stay visible when editable=%s", (editable) => {
  const html = renderToStaticMarkup(<EmploymentRecord e={employee} editable={editable} />);
  for (const fact of ["data-hire-trail", "data-employment-facts", "data-contract-history"]) expect(html).toContain(fact);
  expect(html).toContain(`data-record="${editable}"`);
  expect(html).toContain(`data-read-only="${!editable}"`);
  expect(html).toContain(`data-editable="${editable}"`);
});
