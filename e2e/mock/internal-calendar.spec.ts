// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Page } from "@playwright/test";
import type { components } from "@console/api";
import { expectAxe, fits } from "../a11y";
import { screens } from "../states/registry";
import { installFaultClock } from "../states/fault-clock";
import { AT, authz, failure, id } from "./fixtures";
import { mockRoute } from "./route";
import { mockScreen } from "./screen";
type S = components["schemas"];
const path = "/api/v1/collaboration/calendar/events", branch = id(33);
const day = new Date(Date.now() + 9 * 3600000).toISOString().slice(0,10);
const event = (title: string, suffix: number): S["CalendarEventResponse"] => ({
  id: id(suffix), scope_type: "PERSONAL", title, description: "Review the internal schedule", all_day: false, status: "ACTIVE",
  starts_at: day + "T09:00:00+09:00", ends_at: day + "T10:00:00+09:00", created_at: AT, updated_at: AT,
  policy: { scope_type: "PERSONAL", enforcement: "server", visibility: "creator_only" },
});
async function mount(page: Page, role: "member"|"manager"|"org"|"none") {
  await page.addInitScript(() => localStorage.setItem("console.locale","en"));
  const screen = await mockScreen(page,screens[0],"populated");
  const grant = (feature: string): S["MeAuthzCapability"] => ({ feature, permission: "allow", org_wide: role === "org",
    branch_scope: role === "org" ? {kind:"all"} : {kind:"branches",branches:[branch]}, scoped: role !== "org" });
  await mockRoute(page,"get","/api/v1/me/authz",{status:200,json:{...authz,capabilities: role === "none" ? [] : [
    grant("served_calendar"),...(role === "member" ? [] : [grant("notice_manage")])] }});
  return screen;
}
for (const width of [1440,390]) test(`inspect a day, load additional events and read their internal audience at ${width}px`,async({page})=>{
  const screen=await mount(page,"member");
  await page.setViewportSize({width,height:900});
  const first=event("Schedule review",8), second=event("Personal meeting",9);
  const reads:string[]=[];
  await mockRoute(page,"get",path,req=>{
    const query=new URL(req.url()).searchParams;expect(query.get("limit")).toBe("100");reads.push(query.get("cursor")??"");
    expect(Date.parse(query.get("from")!)).toBeLessThan(Date.parse(first.starts_at));expect(Date.parse(query.get("to")!)).toBeGreaterThan(Date.parse(first.ends_at));
    return {status:200,json:query.has("cursor")?{items:[second],next_cursor:null}:{items:[first],next_cursor:"next-month-page"}};
  });
  await page.goto("/calendar");
  const grid=page.getByRole("grid",{name:"Calendar"});
  const date=grid.locator(`[data-date="${day}"]`);
  await expect(date).toContainText("1 event");
  await page.getByRole("button",{name:"Load more events"}).first().click();await expect(date).toContainText("2 events");
  await date.focus();await page.keyboard.press("Enter");
  await page.getByRole("button",{name:"Personal meeting"}).click();
  await expect(page.getByText("Only me",{exact:true})).toBeVisible();
  await expect(page.getByText("Review the internal schedule")).toBeVisible();
  await fits(page,"internal calendar");await expectAxe(page,"internal calendar");
  expect(reads).toEqual(["","next-month-page"]);expect(screen.unexpected).toEqual([]);
});
test("personal events need no publishing grant and write only the new internal event",async({page})=>{
  const screen=await mount(page,"member");let items:S["CalendarEventResponse"][]=[];
  await mockRoute(page,"get",path,()=>({status:200,json:{items,next_cursor:null}}));
  await mockRoute(page,"post",path,req=>{
    const body:S["CreateCalendarEventRequest"]=req.postDataJSON();expect(body.scope_type).toBe("PERSONAL");expect(body).not.toHaveProperty("scope_ref");
    expect(body.all_day).toBe(true);expect(body.starts_at).toBe(day+"T00:00:00+09:00");expect(Date.parse(body.ends_at)-Date.parse(body.starts_at)).toBe(86400000);
    expect(req.headers()["idempotency-key"]).toBeTruthy();
    const row={...event(body.title,12),starts_at:body.starts_at,ends_at:body.ends_at,all_day:body.all_day};items=[row];return {status:200,json:row};
  });
  await page.goto("/calendar");await expect(page.getByText("No events scheduled",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Add event"}).click();const dialog=page.getByRole("dialog");
  await expect(dialog.getByRole("option",{name:"Only me"})).toBeAttached();await expect(dialog.getByRole("option",{name:"Entire organization"})).toHaveCount(0);
  await dialog.getByRole("textbox",{name:"Event title"}).fill("Fieldwork");await dialog.getByRole("checkbox",{name:"All day"}).check();
  await dialog.getByRole("button",{name:"Create event"}).click();await expect(page.getByRole("status").filter({hasText:"Created Fieldwork"}).first()).toBeVisible();
  expect(items).toHaveLength(1);expect(screen.unexpected).toEqual([]);
});
test("branch publication resolves an active allowed branch and omits wider audiences",async({page})=>{
  const screen=await mount(page,"manager");const rows=[event("Branch planning",18)];let writes=0;
  await mockRoute(page,"get",path,()=>({status:200,json:{items:writes?rows:[],next_cursor:null}}));
  await mockRoute(page,"get","/api/v1/branches",{status:200,json:[{id:branch,name:"Central",region_id:id(37),created_at:AT,deactivated_at:null},{id:id(38),name:"Outside",region_id:id(37),created_at:AT,deactivated_at:null}]});
  await mockRoute(page,"post",path,req=>{writes++;const body=req.postDataJSON();expect(body.scope_type).toBe("DEPARTMENT");expect(body.scope_ref).toBe(branch);return {status:200,json:rows[0]!};});
  await page.goto("/calendar");await page.getByRole("button",{name:"Add event"}).click();const dialog=page.getByRole("dialog");
  await dialog.getByRole("textbox",{name:"Event title"}).fill("Branch planning");await dialog.getByRole("combobox",{name:"Audience"}).selectOption("DEPARTMENT");
  const select=dialog.getByRole("combobox",{name:"Branch"});await select.selectOption(branch);await expect(select.getByRole("option",{name:"Outside"})).toHaveCount(0);
  await expect(dialog.getByRole("option",{name:"Team",exact:true})).toHaveCount(0);await expect(dialog.getByRole("option",{name:"Entire organization"})).toHaveCount(0);
  await dialog.getByRole("button",{name:"Create event"}).click();await expect(dialog).toHaveCount(0);expect(writes).toBe(1);expect(screen.unexpected).toEqual([]);
});
test("refused route avoids calendar data and controls",async({page})=>{
  const screen=await mount(page,"none");await page.goto("/calendar");await expect(page.getByRole("main")).toContainText(/access|permission/i);
  await expect(page.getByRole("button",{name:"Add event"})).toHaveCount(0);expect(screen.unexpected).toEqual([]);
});
test("retry an unavailable month and move to the next internal calendar period",async({page})=>{
  const screen=await mount(page,"member");let ready=false;const dates:string[]=[];
  await installFaultClock(page,req=>new URL(req.url()).pathname===path);
  await mockRoute(page,"get",path,req=>{if(!ready)return {status:503,json:failure("unavailable")};dates.push(new URL(req.url()).searchParams.get("from")!);return {status:200,json:{items:[],next_cursor:null}};});
  await page.goto("/calendar");const retry=page.getByRole("button",{name:"Reload",exact:true});await expect(retry).toBeVisible();ready=true;await retry.click();
  await expect(page.getByText("No events scheduled",{exact:true})).toBeVisible();await page.getByRole("button",{name:/next month/i}).click();await expect.poll(()=>new Set(dates).size).toBe(2);expect(screen.unexpected).toEqual([]);
});
