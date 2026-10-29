// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { firstSignIn, go, kstDate, registerEmployee, takeCode, tenantOnboardSubmit, tenantSlugField, unique, vendorPage } from "./flows";
import { apiOf, bearerOf } from "./helpers/api";
import { psql, settled } from "./idle-fixture";
import { SETUP_DEPARTMENT, setupCompany } from "./setup-flows";
import { inviteAccount } from "./access-flows";

test("entity evidence and both CSV layouts record their exact subject references", { tag: ["@hr", "@regression"] }, async ({ browser }) => {
  test.setTimeout(300_000);
  const vendor = await vendorPage(browser);
  await go(vendor, "/platform");
  await vendor.getByRole("button", { name: "고객 계정 개설" }).click();
  await vendor.getByLabel("고객 이름").fill("법인접속기록");
  const slug = unique("entityaccess");
  await tenantSlugField(vendor).fill(slug);
  await tenantOnboardSubmit(vendor).click();
  const admin = await firstSignIn(browser, await takeCode(vendor));
  const bearer = bearerOf(admin);
  await setupCompany(admin, "법인접속기록", "본사");
  await registerEmployee(admin, { name: "윤하준", number: "E-1", unit: SETUP_DEPARTMENT, hired: kstDate(-60) });
  await go(admin, "/account");
  await settled(admin);
  const api = apiOf(admin, bearer);
  const entityResponse = await api("/legal-entities");
  expect(entityResponse.status()).toBe(200);
  const entities = await entityResponse.json() as { items: { id: string; current: { version: number; representatives: string[] | null; directors: unknown[] | null }; registrations: { id: string }[]; workplaces: { id: string; current: { version: number; opened_on: string } }[] }[] };
  const entity = entities.items[0]!;
  const registration = entity.registrations[0]!;
  const workplace = entity.workplaces[0]!;
  const revisedWorkplace = await api(`/workplaces/${workplace.id}`, "PUT", {
    expected_version: workplace.current.version, effective_from: kstDate(), reason_code: "CORRECTION",
    name: "본사", registration_id: registration.id, same_address_as_registration: true,
    opened_on: workplace.current.opened_on, status: "CONTINUING",
    mobile: "010-1234-5678", email: "workplace@example.com",
  }, { "Idempotency-Key": crypto.randomUUID() });
  expect(revisedWorkplace.status(), await revisedWorkplace.text()).toBe(200);
  workplace.current.version = ((await revisedWorkplace.json()) as { record: { current: { version: number } } }).record.current.version;
  const workplaceSubjects = [`workplace_revisions:${workplace.id}:${workplace.current.version}`];
  const historySubjects = (sql: string) => JSON.parse(psql(slug, sql).split("\n").find(line => line.startsWith("["))!) as string[];
  const entityHistorySubjects = historySubjects(`SELECT json_agg(ref ORDER BY ref) FROM (
    SELECT 'legal_entity_representatives:${entity.id}:' || r.version || ':' || p.seq AS ref
    FROM legal_entity_revisions r JOIN legal_entity_representatives p ON p.revision_id=r.id
    WHERE r.legal_entity_id='${entity.id}'::uuid AND r.version=(SELECT min(version) FROM legal_entity_revisions WHERE legal_entity_id=r.legal_entity_id)
    UNION SELECT 'users:' || actor_id FROM legal_entity_revisions WHERE legal_entity_id='${entity.id}'::uuid
  ) subjects;`);
  psql(slug, `INSERT INTO business_registration_co_owners(org_id,revision_id,seq,name)
    SELECT org_id,id,1,'공동 사업자' FROM business_registration_revisions WHERE registration_id='${registration.id}'::uuid;`);
  const registrationHistorySubjects = historySubjects(`SELECT json_agg(ref ORDER BY ref) FROM (
    SELECT 'business_registration_co_owners:${registration.id}:' || r.version || ':' || p.seq AS ref
    FROM business_registration_revisions r JOIN business_registration_co_owners p ON p.revision_id=r.id WHERE r.registration_id='${registration.id}'::uuid
    UNION SELECT 'users:' || actor_id FROM business_registration_revisions WHERE registration_id='${registration.id}'::uuid
  ) subjects;`);
  const workplaceHistorySubjects = historySubjects(`SELECT json_agg(ref ORDER BY ref) FROM (
    SELECT 'workplace_revisions:${workplace.id}:' || version AS ref FROM workplace_revisions
    WHERE workplace_id='${workplace.id}'::uuid AND version=${workplace.current.version}
    UNION SELECT 'users:' || actor_id FROM workplace_revisions WHERE workplace_id='${workplace.id}'::uuid
    UNION SELECT 'users:' || actor_id FROM workplace_insurance_revisions WHERE workplace_id='${workplace.id}'::uuid
  ) subjects;`);
  const refs = [
    ...workplaceSubjects,
    ...(entity.current.representatives ?? []).map((_, i) => `legal_entity_representatives:${entity.id}:${entity.current.version}:${i + 1}`),
    ...(entity.current.directors ?? []).map((_, i) => `legal_entity_directors:${entity.id}:${entity.current.version}:${i + 1}`),
    ...registrationHistorySubjects.filter(ref => ref.startsWith("business_registration_co_owners:")),
  ].sort();
  const upload = await admin.request.post("/api/v1/entity-documents", {
    headers: { Authorization: bearer() },
    multipart: { kind: "BIZ_REG_CERT", file: { name: "증명.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) } },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const doc = await upload.json() as { id: string };
  // Fixture attachment keeps the assertion focused on the read journeys.
  psql(slug, `UPDATE entity_documents SET legal_entity_id='${entity.id}'::uuid WHERE id='${doc.id}'::uuid;`);
  const records = (action: string) => {
    const output = psql(slug, `SELECT COALESCE(json_agg(json_build_object('actor',actor,'ip',ip,'occurred_at',occurred_at,'after',after_snap) ORDER BY occurred_at,id),'[]'::json) FROM audit_events WHERE org_id=current_setting('app.current_org')::uuid AND action='${action}';`);
    return JSON.parse(output.split("\n").find(line => line.startsWith("["))!) as { actor: string; ip: string; occurred_at: string; after: { subject_ids: string[]; subject_count: number; session_id: string; export_purpose?: string } }[];
  };
  for (const [path, action, subjects] of [
    [`/legal-entities/${entity.id}`, "legal_entity.read", refs],
    ["/legal-entities", "legal_entity.list_read", refs],
    [`/workplaces/${workplace.id}`, "workplace.read", workplaceSubjects],
    ["/workplaces", "workplace.list_read", workplaceSubjects],
    [`/legal-entities/${entity.id}/workplaces`, "workplace.list_read", workplaceSubjects],
    [`/workplaces/${workplace.id}/revisions`, "workplace.history_read", workplaceHistorySubjects],
    [`/legal-entities/${entity.id}/revisions`, "legal_entity.history_read", entityHistorySubjects],
    [`/business-registrations/${registration.id}/revisions`, "business_registration.history_read", registrationHistorySubjects],
    [`/legal-entities/${entity.id}/documents`, "entity_document.list_read", [`entity_documents:${doc.id}`]],
    [`/entity-documents/${doc.id}`, "entity_document.metadata_read", [`entity_documents:${doc.id}`]],
    [`/entity-documents/${doc.id}/content`, "entity_document.read", [`entity_documents:${doc.id}`]],
  ] as const) {
    const before = records(action).length;
    const response = await api(path);
    expect(response.status(), await response.text()).toBe(200);
    const rows = records(action);
    expect(rows).toHaveLength(before + 1);
    const row = rows.at(-1)!;
    expect(row.after.subject_ids).toEqual(subjects);
    expect(row.after.subject_count).toBe(subjects.length);
    expect(row.actor).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.after.session_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.ip).toBeTruthy();
    expect(Date.parse(row.occurred_at)).not.toBeNaN();
    expect((await admin.request.get(`/api/v1${path}`)).status()).toBe(401);
    expect(records(action)).toHaveLength(rows.length);
  }
  const people = await (await api("/employees?limit=10")).json() as { items: { id: string }[] };
  for (const layout of ["standard", "register"]) {
    const before = records("employee.export").length;
    const response = await api(`/employees/export.csv?export_purpose=INTERNAL_REVIEW&layout=${layout}`);
    expect(response.status(), await response.text()).toBe(200);
    const rows = records("employee.export");
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)!.after.subject_ids.sort()).toEqual(people.items.map(person => person.id).sort());
    expect(rows.at(-1)!.after.export_purpose).toBe("INTERNAL_REVIEW");
  }
  for (const [route, action] of [["legal-entities", "legal_entity.history_read"], ["business-registrations", "business_registration.history_read"], ["workplaces", "workplace.history_read"]]) {
    const before = records(action!).length;
    const response = await api(`/${route}/00000000-0000-4000-8000-000000000001/revisions`);
    expect(response.status(), await response.text()).toBe(404);
    const rows = records(action!);
    expect(rows).toHaveLength(before + 1);
    expect(rows.at(-1)!.after.subject_ids).toEqual([]);
    expect(rows.at(-1)!.after).toHaveProperty("refusal_code");
  }
  const reader = await firstSignIn(browser, await inviteAccount(admin, "접속기록 조회자", "oversight"));
  const readerBearer = bearerOf(reader);
  await go(reader, "/account");
  await settled(reader);
  const readerApi = apiOf(reader, readerBearer);
  for (const path of [`/workplaces/${workplace.id}`, "/workplaces", `/legal-entities/${entity.id}/workplaces`, `/workplaces/${workplace.id}/revisions`]) {
    const response = await readerApi(path);
    expect(response.status(), await response.text()).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("workplace@example.com");
    expect(body).not.toContain("010-1234-5678");
    expect(body).not.toContain("+821012345678");
    if (path.endsWith("/revisions")) {
      const history = JSON.parse(body) as { items: { changes: { field: string }[] }[] };
      expect(history.items.flatMap(entry => entry.changes).map(change => change.field)).not.toContain("mobile");
      expect(history.items.flatMap(entry => entry.changes).map(change => change.field)).not.toContain("email");
    }
  }
});
