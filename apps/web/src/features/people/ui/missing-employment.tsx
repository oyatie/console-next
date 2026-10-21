import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { Banner } from "../../../ui/banner/banner";
import { buttonClass } from "../../../ui/button/button-class";

/** Re-import already creates a missing employment profile from a reviewed employment-type diff. */
export function MissingEmployment({ number }: { number?: string | null }) {
  return <Banner tone="warn" title={t("people.employment.missing.title")} actions={<Link to="/people/import" className={buttonClass()}>{t("people.employment.missing.open")}</Link>}>
    {t("people.employment.missing.body", { number: number ?? "—" })}
  </Banner>;
}
