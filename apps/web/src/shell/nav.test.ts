import { describe, expect, it } from "vitest";
import { activeLink, tenantNav } from "./nav";

// `orgWide` defaults to what a SUPER_ADMIN/EXECUTIVE allow gets; a built-in ADMIN's all-branch allow is not org-wide.
const cap = (feature: string, permission: "request_only" | "limited" | "allow" = "allow", kind: "all" | "branches" = "all", orgWide = kind === "all" && permission === "allow") =>
  ({ feature, permission, branch_scope: kind === "all" ? { kind } : { kind, branches: ["b1"] }, org_wide: orgWide }) as never;
const links = (menu: ReturnType<typeof tenantNav>) => menu.flatMap((g) => g.links.map((l) => l.to));

describe("tenantNav", () => {
  it("keeps Home and owned request outcomes available while grants load", () => {
    expect(tenantNav(undefined)).toEqual([expect.objectContaining({ hub: "shell.hub.work" }), expect.objectContaining({ hub: "shell.hub.admin" })]);
    expect(links(tenantNav(undefined))).toEqual(["/", "/requests", "/audit/support-access"]);
  });
  it("lists every link when the projection fails; the server still enforces", () => {
    expect(links(tenantNav(undefined, true))).toEqual(["/", "/requests", "/org", "/org/entities", "/people", "/statutory", "/attendance", "/people/requests", "/people/exits", "/people/period-locks", "/audit/support-access", "/access"]);
  });
  it("gates each link on its read grant", () => {
    expect(links(tenantNav([cap("org_change_read")]))).toEqual(["/", "/requests", "/org", "/org/entities", "/audit/support-access"]);
    expect(links(tenantNav([cap("employee_directory_read")]))).toEqual(["/", "/requests", "/people", "/attendance", "/people/requests", "/audit/support-access"]);
    expect(links(tenantNav([cap("org_change_read"), cap("employee_directory_read")]))).toEqual(["/", "/requests", "/org", "/org/entities", "/people", "/attendance", "/people/requests", "/audit/support-access"]);
    expect(links(tenantNav([cap("period_lock_manage")]))).toEqual(["/", "/requests", "/people/period-locks", "/audit/support-access"]);
    expect(links(tenantNav([cap("user_manage")]))).toEqual(["/", "/requests", "/people", "/audit/support-access", "/access"]);
  });
  it("lists people and requests for a full directory read on any branches (BW-22), or the accounts view", () => {
    // A limited read gets neither; a branch-tier allow reads its branches' people and files requests.
    expect(links(tenantNav([cap("employee_directory_read", "limited")]))).toEqual(["/", "/requests", "/audit/support-access"]);
    expect(links(tenantNav([cap("employee_directory_read", "allow", "branches")]))).toEqual(["/", "/requests", "/people", "/attendance", "/people/requests", "/audit/support-access"]);
    // A built-in ADMIN: allow on all branches, but not org-wide.
    const admin = [cap("employee_directory_read", "allow", "all", false), cap("employee_directory_manage", "allow", "all", false), cap("user_manage", "allow", "all", false)];
    expect(links(tenantNav(admin))).toEqual(["/", "/requests", "/people", "/statutory", "/attendance", "/people/requests", "/audit/support-access", "/access"]);
    expect(links(tenantNav([cap("user_manage", "allow", "all", false)]))).toEqual(["/", "/requests", "/people", "/audit/support-access", "/access"]);
  });
  it("lists statutory work only for a full HR management grant", () => {
    expect(links(tenantNav([cap("employee_directory_manage", "allow", "branches")]))).toEqual(["/", "/requests", "/statutory", "/audit/support-access"]);
    for (const permission of ["limited", "request_only"] as const)
      expect(links(tenantNav([cap("employee_directory_manage", permission)]))).toEqual(["/", "/requests", "/audit/support-access"]);
  });
  it("lists 근태 for the attendance write grant on any branches, or a full directory read", () => {
    expect(links(tenantNav([cap("attendance_exception_manage", "allow", "branches")]))).toEqual(["/", "/requests", "/attendance", "/audit/support-access"]);
    expect(links(tenantNav([cap("attendance_exception_manage", "limited")]))).toEqual(["/", "/requests", "/audit/support-access"]);
  });
  it("lists exits for any exit grant", () => {
    expect(links(tenantNav([cap("exit_case_hq_confirm")]))).toEqual(["/", "/requests", "/people/exits", "/audit/support-access"]);
    expect(links(tenantNav([cap("exit_case_report", "request_only")]))).toEqual(["/", "/requests", "/audit/support-access"]);
  });
  it("hides an org-wide screen from a holder the server's org-wide gate refuses", () => {
    expect(links(tenantNav([cap("period_lock_manage", "allow", "branches")]))).toEqual(["/", "/requests", "/audit/support-access"]);
    expect(links(tenantNav([cap("period_lock_manage", "limited")]))).toEqual(["/", "/requests", "/audit/support-access"]);
  });
  it("treats request_only as no read access and drops an empty hub", () => {
    const menu = tenantNav([cap("org_change_read", "request_only"), cap("org_change_draft")]);
    expect(menu.map((g) => g.hub)).toEqual(["shell.hub.work", "shell.hub.admin"]);
  });
  it("lights only the deepest link a path sits under", () => {
    const people = tenantNav(undefined, true).find((g) => g.hub === "shell.hub.people")!.links;
    expect(activeLink("/people/period-locks", people)).toBe("/people/period-locks");
    expect(activeLink("/people/exits/x1", people)).toBe("/people/exits");
    expect(activeLink("/people/e1", people)).toBe("/people");
    expect(activeLink("/people", people)).toBe("/people");
    expect(activeLink("/org/changes/c1", people)).toBe("/org");
    expect(activeLink("/", people)).toBeUndefined();
  });
});
