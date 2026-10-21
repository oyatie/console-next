import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import type { ImportReport } from "../domain/contract";
import s from "./import.module.css";

const ITEMS = ["sex", "address", "careers", "exit_reason"] as const;

/**
 * What the employee register still lacks for the people this import brought in (r3:hire-16, records-02): each item with its
 * count, and the way to fill them (the roster's bulk edit). Absent for a run applied before the report carried it.
 */
export function RegisterGaps({ gaps }: { gaps: NonNullable<ImportReport["register_gaps"]> }) {
  const open = ITEMS.filter((k) => gaps[k] > 0);
  return (
    <Card titleId="import-gaps" title={t("import.gaps.title")}>
      {open.length === 0 ? (
        <p>{t("import.gaps.none")}</p>
      ) : (
        <>
          <p className="muted">{t("import.gaps.note", { people: gaps.people })}</p>
          <div className={s.filters}>
            {open.map((k) => <Chip key={k} tone="warn">{t(`import.gaps.${k}`, { n: gaps[k] })}</Chip>)}
          </div>
          <div className="form__actions">
            <Link to="/people" search={{}} className={buttonClass("secondary")}>{t("import.gaps.fill")}</Link>
          </div>
        </>
      )}
    </Card>
  );
}
