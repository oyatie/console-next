import { t } from "@console/i18n";
import s from "./roster.module.css";

/** The header already offers registration and import once each. */
export function RosterFirstRun() {
  return (
    <section className={s.firstRun} aria-labelledby="first-run">
      <h2 id="first-run" className={s.firstTitle}>{t("roster.first.title")}</h2>
    </section>
  );
}
