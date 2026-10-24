import { afterEach, beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { i18n, loadCatalog, t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { AsOfControl } from "./asof-control";
import { nearestDate } from "./dates";

beforeAll(() => Promise.all([loadCatalog("ko"), loadCatalog("en")]));
afterEach(() => i18n.set("ko"));
const today = "2026-10-09";
const render = (props: Partial<Parameters<typeof AsOfControl>[0]> = {}) => renderToStaticMarkup(<AsOfControl today={today} value={today} onChange={() => undefined} {...props} />);

test("previous and next dates exclude this date and accept unsorted repeated markers", () => {
  const dates = ["2026-11-01", "2026-09-01", today, "2026-09-01", "2026-02-30"];
  expect(nearestDate(dates, today, "previous")).toBe("2026-09-01");
  expect(nearestDate(dates, today, "next")).toBe("2026-11-01");
  expect(nearestDate(dates, "2026-09-01", "previous")).toBeUndefined();
  expect(nearestDate(dates, "2026-11-01", "next")).toBeUndefined();
  expect(nearestDate([], today, "next")).toBeUndefined();
});

test("empty change navigation remains focusable and described by visible reasons", () => {
  const html = render({ changeDates: [] });
  expect(html).toContain(t("asof.noPrevious"));
  expect(html).toContain(t("asof.noNext"));
  expect(html).toContain(t("asof.noChanges"));
  expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
  expect(html).not.toMatch(/\sdisabled=/);
  expect(html).toContain('type="button"');
  expect(html).toMatch(/aria-disabled="true" aria-describedby="[^"]+"/);
});

test("date markers are unique, sorted and selectable with native non-submit buttons", () => {
  const html = render({ changeDates: ["2026-11-01", today, today, "2026-09-01"] });
  expect(html.match(/data-change-date=/g)).toHaveLength(3);
  expect(html.indexOf('data-change-date="2026-09-01"')).toBeLessThan(html.indexOf(`data-change-date="${today}"`));
  expect(html.indexOf(`data-change-date="${today}"`)).toBeLessThan(html.indexOf('data-change-date="2026-11-01"'));
  expect(html).toMatch(new RegExp(`data-change-date="${today}" aria-pressed="true"[^>]*type="button"`));
  expect(html).toContain(t("asof.today"));
});

test.each(["ko", "en"] as const)("%s dated bands show one date line and a return action without a read-only claim", (locale) => {
  i18n.set(locale);
  const past = "2026-09-01", future = "2026-11-01", knownAt = "2026-09-15";
  const cases = [
    { props: { value: past }, title: t("asof.past", { date: fmtDate(past) }) },
    { props: { value: past, entity: true }, title: t("asof.recordPast", { date: fmtDate(past) }) },
    { props: { value: future }, title: t("asof.future", { date: fmtDate(future) }) },
    { props: { value: past, knownAt }, title: t("asof.known", { date: fmtDate(past), known: fmtDate(knownAt) }) },
  ];
  for (const { props, title } of cases) {
    const html = render(props);
    const band = html.slice(html.indexOf('data-placement="page"'));
    expect(band.match(/<strong[^>]*>(.*?)<\/strong>/)?.[1]).toBe(title);
    expect(band.split(fmtDate(props.value))).toHaveLength(2);
    expect(band).toContain(t("asof.returnToday"));
    expect(band).not.toContain(t("asof.readOnly"));
    expect(band).not.toContain('class="prose ');
    expect(html).not.toMatch(/오늘\(|지금 상태|지금 재직/);
  }
  expect(render({ value: past, knownAt })).toContain(t("asof.knownAt"));
  expect(render()).not.toContain('data-placement="page"');
  expect(render()).not.toContain(t("asof.readOnly"));
  expect(render({ knownAt: "" })).not.toContain('aria-invalid="true"');
});

test("invalid knowledge and as-of dates expose the valid-date remedy on the field", () => {
  const known = render({ knownAt: "2026-02-30" });
  expect(known).toContain(t("asof.dateInvalid"));
  expect(known).toContain('aria-invalid="true"');
  const date = render({ value: "2026-02-30" });
  expect(date).toContain(t("asof.dateInvalid"));
  expect(date).toContain('aria-invalid="true"');
});


test("knowledge timestamp deep links remain exact and loading ribbon does not claim empty", () => {
  const knownAt = "2026-09-15T12:34:56+09:00";
  const html = render({ knownAt, value: "2026-09-01", loadingDates: true });
  expect(html).toContain(t("asof.known", { date: fmtDate("2026-09-01"), known: fmtDateTime(knownAt) }));
  expect(html).toContain('value="2026. 09. 15."');
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain(t("asof.noChanges"));
});


test("malformed knowledge timestamps with a valid calendar prefix expose the date remedy", () => {
  for (const knownAt of ["2026-10-09Tgarbage", "2026-10-09T24:00:00Z", "2026-10-09T12:34:56"]) {
    const html = render({ knownAt });
    expect(html).toContain(t("asof.dateInvalid"));
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(t("asof.returnToday"));
  }
});

test("loading change dates reserve both navigation controls without claiming an empty ribbon", () => {
  const html = render({ loadingDates: true });
  expect(html).toContain(t("asof.previous"));
  expect(html).toContain(t("asof.next"));
  expect(html.match(/aria-disabled="true"/g)).toHaveLength(2);
  expect(html).not.toContain(t("asof.noChanges"));
});

test("refreshing cached dates reserves the ribbon until the new markers arrive", () => {
  const html = render({ changeDates: ["2020-03-02", today], loadingDates: true });
  expect(html).toContain('aria-busy="true"');
  expect(html).not.toContain("data-change-date=");
  expect(html).not.toContain(t("asof.noChanges"));
});

test("the selected date retains its slot when an earlier change arrives", () => {
  for (const changeDates of [[today], ["2020-03-02", today]]) {
    expect(render({ changeDates })).toMatch(new RegExp(`style="grid-column:5" data-change-date="${today}"`));
  }
});
