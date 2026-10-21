import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { EntityName } from "../../../reference/entity/ui/entity-name";
import { unitPath } from "../../../reference/org/present";
import type { PlaceOption } from "../domain/register-place";

/** The same certificate name and secondary alias in every placement picker. */
export function PlacePath({ option, units }: { option: PlaceOption; units: components["schemas"]["OrgUnitHead"][] }) {
  return <><EntityName entity={option.entityRecord} />{t("uiChoice.pathSeparator")}{unitPath(units, option.unit)}</>;
}
