// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { isDate } from "../../../ui/date/days";
import { useQueries } from "@tanstack/react-query";
import type { components } from "@console/api/schema";
import { isMessageId, t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Chip } from "../../../ui/chip";
import { lifecycleTemplateQuery, type TemplatePreviewQuery } from "../api/lifecycle-trail";
import { lifecycleTrailError, trailItemLabel, ownerLabel, trailGroup } from "../present";
import { ItemWindow } from "./lifecycle-trail";
import { filingLabel } from "../../../reference/statutory/present";

export type TemplateItem = components["schemas"]["LifecycleTemplateItem"];

/** The composer supplies the sections; the template supplies every item and rule, with register windows or readable rules. */
export function trailPreviewSections(items: readonly TemplateItem[]) {
  const sections: Partial<Record<"documents" | "deadlines" | "tasks", ReactNode>> = {};
  for (const section of ["documents", "deadlines", "tasks"] as const) {
    const groups = (section === "documents" ? ["documents"] : section === "deadlines" ? ["filing"] : ["payment", "access", "return"]) as ReturnType<typeof trailGroup>[];
    const contents = groups.flatMap((group) => {
      const rows = items.filter((item) => trailGroup(item.kind) === group);
      return rows.length ? [<div key={group} role="group" aria-label={t(`lifecycle.trail.group.${group}`)}>
        <h4>{t(`lifecycle.trail.group.${group}`)}</h4>
        <ul className="list-plain">{rows.map((item, index) => <li key={index} className="form" data-trail-preview-item={item.item_key}>
          <b>{item.insurer && item.filing_kind ? `${filingLabel(item.insurer)} ${filingLabel(item.filing_kind)}` : trailItemLabel(item.label_key ?? null, item.label)}</b>
          {item.legal_review_required && <Chip>{t("lifecycle.trail.unverified")}</Chip>}
          {item.due_disposition === "PRE_CONSOLE" ? <Chip>{t("lifecycle.trail.preConsole")}</Chip> : <ItemWindow item={{ opens_on: item.opens_on ?? null, opens_in_days: item.opens_in_days ?? null, due_date: item.due_on ?? null, due_in_days: item.due_in_days ?? null, due_disposition: item.due_disposition ?? "UNKNOWN", basis: { legal_review_required: item.legal_review_required } }} rules={item.due_disposition == null || item.due_rule_kind === "WITHOUT_DELAY" ? previewRules(item) : undefined} />}
          {(item.instrument || item.article || item.owner_line) && <details><summary>{t("statutory.basis")}{item.owner_line && <> · {t("lifecycle.trail.owner", { line: ownerLabel(item.owner_line) })}</>}</summary>{item.instrument} {item.article}</details>}
        </li>)}</ul>
      </div>] : [];
    });
    if (contents.length) sections[section] = contents;
  }
  return sections;
}

export function useTrailPreview(keys: readonly string[], query?: TemplatePreviewQuery) {
  const results = useQueries({ queries: keys.map((key) => lifecycleTemplateQuery(key, { ...query, effective_date: query?.effective_date && isDate(query.effective_date) ? query.effective_date : undefined })) });
  if (results.some((q) => q.isPending || q.error)) return { documents: results.map((q, i) => <QueryState key={keys[i]} q={q} own={lifecycleTrailError}>{() => null}</QueryState>) };
  return trailPreviewSections(results.flatMap((q) => q.data ?? []));
}

function previewRules(item: TemplateItem) {
  const anchor = (name: string | null | undefined) => {
    const key = `lifecycle.trail.anchor.${name}`;
    return isMessageId(key) ? t(key) : t("lifecycle.trail.opensUnknown");
  };
  const value = item.due_rule_value;
  const kind = item.due_rule_kind === "DAYS" ? "DAYS_AFTER" : item.due_rule_kind ?? "UNKNOWN";
  const counted = kind === "DAYS_AFTER" || kind === "DAYS_BEFORE" || kind === "MONTHS_AFTER" || kind === "DAY_OF_NEXT_MONTH";
  const ruleKey = `lifecycle.trail.rule.${kind}`;
  const due = counted && value != null
    ? t(`lifecycle.trail.rule.counted.${kind}`, { value, anchor: anchor(item.due_anchor) })
    : isMessageId(ruleKey) ? t(ruleKey) : t("statutory.unknown");
  const offset = item.opens_offset_days;
  const opens = !item.opens_anchor ? t("lifecycle.trail.opensUnknown") : offset == null || offset === 0 ? anchor(item.opens_anchor)
    : t(`lifecycle.trail.${offset < 0 ? "opensBefore" : "opensAfter"}`, { value: Math.abs(offset), anchor: anchor(item.opens_anchor) });
  return { opens, due };
}
