// The whole unplaced queue (r3:hire-21, #28): every page the server's keyset read gives, with the facts placement is
// decided with read with the person (never a roster page that stops at 1,000). Live frames re-read it (#27).
import { useQuery } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { get, read } from "../../../lib/query";
import type { Person } from "../domain/unplaced";

type Page = components["schemas"]["EmployeeImportUnplacedPage"];
type Item = Page["items"][number];

const PATH = "/api/v1/employees/import/unplaced";
/** The server's largest page. */
const PAGE = 500;

async function everyone(): Promise<Page> {
  const items: Item[] = [];
  let count = 0;
  let after: string | undefined;
  do {
    const page = await get(PATH, { params: { query: { limit: PAGE, ...(after ? { after } : {}) } } }).queryFn();
    count = page.count;
    items.push(...page.items);
    after = page.next_cursor ?? undefined;
  } while (after);
  return { count, items, next_cursor: null };
}

const unplacedAllQuery = read(PATH, everyone);

/** The whole queue, as the server answers it. */
export const useUnplacedQueue = () => useQuery(unplacedAllQuery);

/** A queued person as the screen reads them: the queue's own facts, grouped by the file's value. */
export const personOf = (q: Item): Person =>
  ({
    id: q.employee_id,
    name: q.name,
    employee_number: q.employee_number ?? undefined,
    company: q.company,
    legal_entity_id: q.legal_entity_id ?? null,
    workplace_id: q.workplace_id ?? null,
    org_unit_id: q.org_unit_id ?? null,
    reason: q.reason,
    position: q.position ?? null,
    employment_type: q.employment_type ?? null,
    hire_date: q.hire_date ?? null,
    worksite_name: q.worksite_name ?? null,
    org_unit: q.org_unit ?? null,
    // Placed at a workplace but not in the department the file named: grouped by that department text.
    source: q.reason === "unit_unknown" ? q.source_org_unit : q.source_workplace,
  }) as Person;
