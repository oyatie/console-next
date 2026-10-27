import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { ToggleButton } from "../../../ui/button/button";
import { PageHead } from "../../../ui/page-head/page-head";

export type PeopleView = "employees" | "accounts";

/**
 * The People page head: the title (the focus target after a bulk command), the employees/accounts switch for
 * users who can read the directory, and the view's own actions at the end.
 */
export function PeopleHead({ view, directory, onView, children }: { view: PeopleView; directory: boolean; onView: (v: PeopleView) => void; children?: ReactNode }) {
  return (
    <PageHead title={t("people.tab.accounts")} tools={children} tabs={
      directory && (
        <div role="group" aria-label={t("people.tabs")} className="tabs">
          {(["employees", "accounts"] as const).map((v) => (
            <ToggleButton key={v} pressed={view === v} onClick={() => onView(v)}>
              {t(v === "employees" ? "people.tab.employees" : "people.tab.accounts")}
            </ToggleButton>
          ))}
        </div>
      )
    } />
  );
}
