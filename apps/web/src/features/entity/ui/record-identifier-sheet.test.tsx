import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { i18n, loadCatalog } from "@console/i18n";
import type { LegalEntity } from "@console/api/pending";
import type { useCommand } from "../../../lib/react/command";
import type { correctIdentifier } from "../api";
import { IdentifierSheet } from "./record-identifier-sheet";

const command = vi.hoisted(() => vi.fn((_options: unknown) => ({})));
vi.mock("../../../lib/react/command", () => ({ useCommand: command }));
vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: () => null }));

type Correction = Awaited<ReturnType<typeof correctIdentifier>>;
type Save = Parameters<typeof useCommand<undefined, Correction>>[0];

beforeAll(async () => {
  await loadCatalog("en");
  i18n.set("en");
});
beforeEach(() => command.mockClear());

function open(field: "crn" | "brn") {
  const onClose = vi.fn();
  const e = {
    id: "entity", current: { name: "Example" }, workplaces: [],
    registrations: [{ id: "registration" }],
  } as unknown as LegalEntity;
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <IdentifierSheet e={e} field={field} registrationId="registration" operating onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onClose, save: command.mock.calls[1]![0] as Save };
}

test.each(["crn", "brn"] as const)("a PENDING %s correction stays open and announces the approval receipt", (field) => {
  const { onClose, save } = open(field);
  const pending = { status: "PENDING", exception_id: "exception", payload_hash: "a".repeat(64) } as const;
  save.onSuccess!(pending, undefined);
  expect(onClose).not.toHaveBeenCalled();
  expect(save.announce!(pending, undefined)).toBe(
    "Correction requested; the identifier is unchanged until another eligible person approves. Exception: exception",
  );
});

test.each(["crn", "brn"] as const)("an applied %s correction closes and announces the saved identifier", (field) => {
  const { onClose, save } = open(field);
  const applied = { change_mode: "GOVERNED", record: {} } as Correction;
  save.onSuccess!(applied, undefined);
  expect(onClose).toHaveBeenCalledOnce();
  expect(save.announce!(applied, undefined)).toMatch(/^Corrected the /);
});
