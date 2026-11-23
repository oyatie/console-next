// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Dispatch, SetStateAction } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { EMPLOYMENT_TYPE, label } from "../../../lib/labels";
import { entityName } from "../../../reference/entity/domain/names";
import { FilterRail, type FilterRailTreeNode } from "../../../ui/filter-rail/filter-rail";
import type { Review, StatusView } from "../domain/roster";
import type { EmpType } from "./roster-console-data";

type LegalEntity = components["schemas"]["LegalEntity"];
type EmployeeFacets = components["schemas"]["EmployeeFacets"];

export function RosterConsoleRail({
  entities,
  facets,
  unit,
  idsActive = false,
  expandedEntities,
  toggleEntityExpand,
  empTypes,
  setEmpTypes,
  review,
  registerMissingCount,
  addressMissingOnly,
  setAddressMissingOnly,
  probationOnly,
  setProbationOnly,
  soonDays,
  contractSoonCount,
  activeFilterCount,
  q,
  status,
  setFilter,
  resetAll,
  phoneTools,
}: {
  entities: readonly LegalEntity[];
  facets: EmployeeFacets | undefined;
  unit: string | null | undefined;
  idsActive?: boolean;
  expandedEntities: ReadonlySet<string>;
  toggleEntityExpand: (id: string) => void;
  empTypes: ReadonlySet<EmpType>;
  setEmpTypes: Dispatch<SetStateAction<Set<EmpType>>>;
  review: readonly Review[];
  registerMissingCount: number;
  addressMissingOnly: boolean;
  setAddressMissingOnly: (checked: boolean) => void;
  probationOnly: boolean;
  setProbationOnly: (checked: boolean) => void;
  soonDays: number | undefined;
  contractSoonCount: number;
  activeFilterCount: number;
  q: string;
  status: StatusView;
  setFilter: (patch: { unit?: string | null; review?: Review[] }) => void;
  resetAll: () => void;
  phoneTools?: React.ReactNode;
}) {
  const entityCountMap = new Map((facets?.legal_entity ?? []).map(x => [x.value, x.count]));
  const workplaceCountMap = new Map((facets?.workplace ?? []).map(x => [x.value, x.count]));
  const activeEntityId = unit?.startsWith("le:") ? unit.slice(3) : undefined;
  const activeWorkplaceId = unit?.startsWith("wp:") ? unit.slice(3) : undefined;

  const treeNodes: FilterRailTreeNode[] = entities.map((ent, idx) => {
    const entSelected = activeEntityId === ent.id;
    const isExpanded = expandedEntities.has(ent.id) || (expandedEntities.size === 0 && idx === 0);
    return {
      id: ent.id,
      label: entityName(ent),
      checked: entSelected,
      count: entityCountMap.get(ent.id),
      expanded: isExpanded,
      expandLabel: t(isExpanded ? "people.rail.collapse" : "people.rail.expand", { name: entityName(ent) }),
      onToggleExpand: () => toggleEntityExpand(ent.id),
      onChange: checked => setFilter({ unit: checked ? `le:${ent.id}` : null }),
      children: ent.workplaces.map(wp => ({
        id: wp.id,
        label: wp.current?.name ?? wp.id,
        checked: activeWorkplaceId === wp.id,
        count: workplaceCountMap.get(wp.id),
        onChange: checked => setFilter({ unit: checked ? `wp:${wp.id}` : null }),
      })),
    };
  });

  return (
    <FilterRail
      label={t("people.filter.label")}
      toggleLabel={t("people.rail.toggle")}
      activeCount={activeFilterCount}
      phoneTools={phoneTools}
      org={
        entities.length > 0
          ? {
              title: t("people.rail.org"),
              all: {
                label: t("people.rail.allEntities"),
                checked: !unit,
                onChange: checked => {
                  if (checked) setFilter({ unit: null });
                },
              },
              nodes: treeNodes,
            }
          : undefined
      }
      groups={[
        {
          id: "empType",
          title: t("people.rail.empType"),
          items: (["REGULAR", "CONTRACT", "PART_TIME"] as const).map(code => ({
            id: code,
            label: label(EMPLOYMENT_TYPE, code),
            checked: empTypes.has(code),
            onChange: checked =>
              setEmpTypes(prev => {
                const next = new Set(prev);
                if (checked) next.add(code);
                else next.delete(code);
                return next;
              }),
          })),
        },
        {
          id: "missing",
          title: t("people.rail.missing"),
          items: [
            {
              id: "missingAny",
              label: t("people.rail.missingAny"),
              checked: review.includes("register"),
              count: registerMissingCount > 0 ? fmtNumber(registerMissingCount) : undefined,
              onChange: checked =>
                setFilter({
                  review: checked ? [...review.filter(x => x !== "register"), "register"] : review.filter(x => x !== "register"),
                }),
            },
            {
              id: "missingAddr",
              label: t("people.rail.missingAddress"),
              checked: addressMissingOnly,
              onChange: setAddressMissingOnly,
            },
          ],
        },
        {
          id: "upcoming",
          title: t("people.rail.upcoming"),
          items: [
            {
              id: "probation",
              label: t("people.rail.probationEnding"),
              checked: probationOnly,
              onChange: setProbationOnly,
            },
            ...(soonDays !== undefined
              ? [
                  {
                    id: "contract",
                    label: t("people.rail.contractEnding"),
                    checked: review.includes("contractSoon"),
                    count: contractSoonCount > 0 ? fmtNumber(contractSoonCount) : undefined,
                    onChange: (checked: boolean) =>
                      setFilter({
                        review: checked
                          ? [...review.filter(x => x !== "contractSoon" && x !== "contractPast"), "contractSoon"]
                          : review.filter(x => x !== "contractSoon"),
                      }),
                  },
                ]
              : []),
          ],
        },
      ]}
      reset={{
        label: t("people.rail.clear"),
        disabled: activeFilterCount === 0 && !idsActive && !q && status === "current",
        onReset: resetAll,
      }}
    />
  );
}
