// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { fmtDateTime } from "@console/i18n/format";
import { loadCatalog, t } from "@console/i18n";
import type { Card } from "./use-card";
import type { Quick } from "./use-quick";
import { ContactSheet, EmergencyContacts } from "./emergency-contacts";

const { searchState, correctEmployeeMock, commandState } = vi.hoisted(() => ({
  searchState: { act: "contact.add" as string | undefined },
  correctEmployeeMock: vi.fn(),
  commandState: { run: undefined as (() => unknown) | undefined },
}));

vi.mock("@tanstack/react-router", () => ({
  getRouteApi: () => ({
    useSearch: () => searchState,
    useNavigate: () => vi.fn(),
  }),
}));

vi.mock("../api", () => ({
  correctEmployee: (...args: unknown[]) => correctEmployeeMock(...args),
  mySub: () => "00000000-0000-0000-0000-000000000099",
}));

vi.mock("../../../lib/react/command", () => ({
  useCommand: (opts: { run: () => unknown }) => {
    commandState.run = opts.run;
    return {
      isPending: false,
      isError: false,
      error: null,
      mutate: () => opts.run(),
    };
  },
}));

vi.mock("../../../ui/sheet/sheet", () => ({
  Sheet: (p: { title: string; notice?: unknown; consequence: unknown; actions: unknown; children: unknown }) => (
    <section aria-label={p.title}>
      {p.children as never}
      {p.notice as never}
      {p.consequence as never}
      {p.actions as never}
    </section>
  ),
}));

beforeAll(async () => {
  await loadCatalog("ko");
});

beforeEach(() => {
  searchState.act = "contact.add";
  correctEmployeeMock.mockReset();
  commandState.run = undefined;
});

function makeCard(contacts: unknown[] = []): Card {
  return {
    d: {} as Card["d"],
    e: {
      id: "00000000-0000-0000-0000-000000000001",
      name: "김하늘",
      employee_number: "E-100",
      company: "한빛",
      org_unit_id: null,
      legal_entity_id: null,
      workplace_id: null,
      updated_at: "2026-10-20T00:00:00Z",
    } as Card["e"],
    manage: true,
    editable: true,
    readable: true,
    request: false,
    users: false,
    events: { data: { items: [] } } as unknown as Card["events"],
    personal: {
      data: {
        employee_id: "00000000-0000-0000-0000-000000000001",
        updated_at: "2026-10-20T00:00:00Z",
        name_hanja: null,
        name_en: null,
        nationality: null,
        personal_email: null,
        emergency_contacts: contacts as NonNullable<Card["personal"]["data"]>["emergency_contacts"],
        photo: null,
        group_service_start_date: null,
      },
    } as unknown as Card["personal"],
    register: {} as Card["register"],
    facts: {} as Card["facts"],
    records: {} as Card["records"],
    planned: undefined,
    title: () => undefined,
    setup: false,
    place: { entity: "한빛", workplace: "본사", path: [] },
  };
}

const quickStub: Quick = {
  save: vi.fn(),
  pending: false,
  error: null,
} as unknown as Quick;

describe("EmergencyContacts privacy basis and notification confirmation", () => {
  test.each([false, undefined])("labels an unconfirmed contact with a warning chip (%s)", (contact_notified) => {
    searchState.act = undefined;
    const html = renderToStaticMarkup(<EmergencyContacts c={makeCard([
      { name: "이두리", relation: "PARENT", phone: "+8221234567", contact_notified, basis: null },
    ])} quick={quickStub} />);
    expect(html).toContain('<span class="chip chip--warn">당사자 안내 미확인</span>');
    expect(html).not.toContain(t("empContact.need.notice"));
  });

  test("does not warn for a confirmed contact", () => {
    searchState.act = undefined;
    const html = renderToStaticMarkup(<EmergencyContacts c={makeCard([
      { name: "이두리", relation: "PARENT", phone: "+8221234567", contact_notified: true, basis: null },
    ])} quick={quickStub} />);
    expect(html).not.toContain("당사자 안내 미확인");
    expect(html).not.toContain(t("empContact.need.notice"));
  });

  test("the personal card describes emergency response without asking for contact consent", () => {
    const basis = t("empCard.personal.basis");
    expect(basis).toContain("비상연락처는 응급 상황 대비로 기록합니다");
    expect(basis).toContain("검토 전 · 동의 기반 아님");
    expect(basis).not.toContain("비상연락처·사진은 동의를 받아");
  });

  test("renders conservative basis labelled 검토 전 (not consent) and requires confirmation that the contact was told", () => {
    const html = renderToStaticMarkup(<EmergencyContacts c={makeCard()} quick={quickStub} />);
    expect(html).toContain("검토 전");
    expect(html).toContain("동의 기반 아님");
    expect(html).toContain("연락처 당사자 안내 확인");
    expect(html).toContain("직원이 이 비상연락처 대상자에게 등록 사실을 알렸음을 확인했습니다");
    expect(html).toContain('type="checkbox"');
  });

  test("refuses save without employee confirmation and sends typed confirmation when checked", () => {
    const unconfirmedHtml = renderToStaticMarkup(
      <ContactSheet
        c={makeCard()}
        list={[]}
        at={null}
        onClose={() => {}}
        initialDraft={{ name: "이하나", relation: "SPOUSE", phone: "010-1234-5678", notified: false, tried: true }}
      />,
    );
    expect(unconfirmedHtml).toContain("연락처 당사자에게 알렸는지 확인하십시오");
    expect(unconfirmedHtml).toContain('aria-disabled="true"');
    expect(() => commandState.run?.()).toThrow("emergency_contact_notice_unconfirmed");
    expect(correctEmployeeMock).not.toHaveBeenCalled();

    renderToStaticMarkup(
      <ContactSheet
        c={makeCard()}
        list={[]}
        at={null}
        onClose={() => {}}
        initialDraft={{ name: "이하나", relation: "SPOUSE", phone: "010-1234-5678", notified: true }}
      />,
    );
    commandState.run?.();
    expect(correctEmployeeMock).toHaveBeenCalledTimes(1);
    const [empId, updatedAt, changes, reason] = correctEmployeeMock.mock.calls[0]!;
    expect(empId).toBe("00000000-0000-0000-0000-000000000001");
    expect(updatedAt).toBe("2026-10-20T00:00:00Z");
    expect(changes).toEqual({
      emergency_contacts: [{ name: "이하나", relation: "SPOUSE", phone: "+821012345678", contact_notified: true }],
    });
    expect(reason).toBe("QUICK_EDIT");

  });

  test("preserves an untouched legacy contact and strips server-owned evidence", () => {
    const list = [{
      name: "이두리", relation: "PARENT" as const, phone: "+8221234567",
      basis: null, basis_label: null, contact_notified: false,
      recorded_by: "old-recorder", recorded_at: "2026-10-19T00:00:00Z",
    }];
    renderToStaticMarkup(
      <ContactSheet c={makeCard(list)} list={list} at={null} onClose={() => {}}
        initialDraft={{ name: "이하나", relation: "SPOUSE", phone: "010-1234-5678", notified: true }} />,
    );
    commandState.run?.();
    expect(correctEmployeeMock.mock.calls[0]?.[2]).toEqual({ emergency_contacts: [
      { name: "이두리", relation: "PARENT", phone: "+8221234567", contact_notified: false },
      { name: "이하나", relation: "SPOUSE", phone: "+821012345678", contact_notified: true },
    ] });
  });

  test("editing a confirmed contact requires a fresh employee confirmation", () => {
    const list = [{ name: "이하나", relation: "SPOUSE" as const, phone: "+821012345678", contact_notified: true }];
    renderToStaticMarkup(<ContactSheet c={makeCard(list)} list={list} at={0} onClose={() => {}} />);
    expect(() => commandState.run?.()).toThrow("emergency_contact_notice_unconfirmed");
    expect(correctEmployeeMock).not.toHaveBeenCalled();
  });

  test("displays recorded basis, recorder, and timestamp labelled 검토 전 on existing emergency contacts", () => {
    searchState.act = undefined;
    const html = renderToStaticMarkup(
      <EmergencyContacts
        c={makeCard([
          {
            name: "이하나",
            relation: "SPOUSE",
            phone: "+821012345678",
            basis: "VITAL_INTEREST_PENDING_COUNSEL",
            recorded_by: "00000000-0000-0000-0000-000000000099",
            recorded_by_name: "김인사",
            recorded_at: "2026-10-20T05:00:00Z",
            contact_notified: true,
          },
        ])}
        quick={quickStub}
      />,
    );
    expect(html).not.toContain("VITAL_INTEREST_PENDING_COUNSEL");
    expect(html).toContain("응급 상황 대비");
    expect(html).toContain("검토 전");
    expect(html).not.toContain("00000000-0000-0000-0000-000000000099");
    expect(html).toContain("김인사");
    expect(html).not.toContain("2026-10-20T05:00:00Z");
    expect(html).toContain(fmtDateTime("2026-10-20T05:00:00Z"));
    expect(html).toContain("KST");
  });
});
