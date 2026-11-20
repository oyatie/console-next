// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { CalendarDays, FileText } from "lucide-react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import type { ReadState } from "../../lib/react/query-view";
import { Button, Check } from "../button/button";
import { SelectInput } from "../field/select-input";
import { KeyValue, StatRow } from "../key-value/key-value";
import { Masked } from "../record/masked";
import { Tag } from "../record/record-section";
import { PhoneHub } from "./phone-hub";
import fx from "./pattern-fixture.module.css";

const READY: ReadState = { isPending: false, error: null, data: { empNo: "10587" }, refetch() {} };

/** Synthetic no-network showcase for PhoneHub (`P12`). */
export default function PhoneHubExample({ q = READY }: { q?: ReadState }) {
  const [styleChoice, setStyleChoice] = useState("console");
  const [notify, setNotify] = useState(true);
  const identitySub = `${tg("sample.position")} · ${tg("sample.team")}`;
  const logSummary = `${tg("sample.dept")} · ${tg("search.person")} · ${t("enum.idType.RRN")} · 11-03`;

  return (
    <PhoneHub
      q={q}
      head={{ title: t("account.title"), titleId: "phone-hub-title" }}
      identity={
        <div>
          <div className={fx.identityHead}>
            <strong className={fx.identityName}>{tg("search.person")}</strong>
            <Tag kind="rev">{tg("facts.active")}</Tag>
          </div>
          <div className={fx.identitySub}>{identitySub}</div>
        </div>
      }
      stats={
        <StatRow
          label={t("account.title")}
          items={[
            { key: "no", label: t("empCard.empno.field"), value: "10587" },
            { key: "dept", label: t("empCard.f.unit"), value: tg("sample.team") },
            { key: "hire", label: t("empCard.f.hire"), value: "2019-03-14" },
          ]}
        />
      }
      links={[
        {
          key: "leave",
          icon: <CalendarDays size={20} aria-hidden="true" />,
          label: t("requests.title"),
          meta: `${t("enum.importTarget.leave_remaining")} 9.5`,
          href: "/account",
        },
        {
          key: "pay",
          icon: <FileText size={20} aria-hidden="true" />,
          label: t("payroll.title"),
          meta: `2026-10 · ${t("payroll.create.payDate")} 11-25`,
          href: "/account",
        },
      ]}
      sections={[
        {
          key: "edit",
          title: t("account.profile"),
          children: (
            <div className={fx.bandPad}>
              <KeyValue
                label={t("account.profile")}
                items={[
                  {
                    key: "phone",
                    label: t("empCard.f.phone"),
                    value: <Masked>{tg("pat.record.phoneVal")}</Masked>,
                    action: (
                      <Button size="sm" variant="secondary">
                        {tg("facts.fix")}
                      </Button>
                    ),
                  },
                  {
                    key: "style",
                    label: t("account.experience"),
                    value: (
                      <SelectInput
                        aria-label={t("account.experience")}
                        value={styleChoice}
                        onChange={e => setStyleChoice(e.target.value)}
                      >
                        <option value="console">{t("account.experience.console")}</option>
                        <option value="baseline">{t("account.experience.baseline")}</option>
                      </SelectInput>
                    ),
                  },
                  {
                    key: "notify",
                    label: t("accessLog.action.employee.field_reveal"),
                    value: (
                      <Check checked={notify} onChange={setNotify}>
                        {t("accessLog.flag.sensitive_read")}
                      </Check>
                    ),
                  },
                ]}
              />
            </div>
          ),
        },
        {
          key: "log",
          title: t("accessLog.table"),
          children: <div className={fx.hubRow}>{logSummary}</div>,
        },
      ]}
    />
  );
}
