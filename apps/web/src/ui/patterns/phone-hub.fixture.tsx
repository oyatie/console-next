// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { CalendarDays, FileText } from "lucide-react";
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

  return (
    <PhoneHub
      q={q}
      head={{ title: tg("pat.hub.head"), titleId: "phone-hub-title" }}
      identity={
        <div>
          <div className={fx.identityHead}>
            <strong className={fx.identityName}>{tg("search.person")}</strong>
            <Tag kind="rev">{tg("facts.active")}</Tag>
          </div>
          <div className={fx.identitySub}>{tg("pat.hub.role")}</div>
        </div>
      }
      stats={
        <StatRow
          label={tg("pat.hub.head")}
          items={[
            { key: "no", label: tg("pat.hub.empNo"), value: "10587" },
            { key: "dept", label: tg("pat.hub.dept"), value: tg("sample.team") },
            { key: "hire", label: tg("pat.hub.hire"), value: "2019-03-14" },
          ]}
        />
      }
      links={[
        {
          key: "leave",
          icon: <CalendarDays size={20} aria-hidden="true" />,
          label: tg("pat.hub.linkLeave"),
          meta: tg("pat.hub.linkLeaveMeta"),
          href: "/account",
        },
        {
          key: "pay",
          icon: <FileText size={20} aria-hidden="true" />,
          label: tg("pat.hub.linkPay"),
          meta: tg("pat.hub.linkPayMeta"),
          href: "/account",
        },
      ]}
      sections={[
        {
          key: "edit",
          title: tg("pat.hub.secEdit"),
          children: (
            <div className={fx.bandPad}>
              <KeyValue
                label={tg("pat.hub.secEdit")}
                items={[
                  {
                    key: "phone",
                    label: tg("pat.record.phone"),
                    value: <Masked>{tg("pat.record.phoneVal")}</Masked>,
                    action: (
                      <Button size="sm" variant="secondary">
                        {tg("facts.fix")}
                      </Button>
                    ),
                  },
                  {
                    key: "style",
                    label: tg("pat.hub.style"),
                    value: (
                      <SelectInput
                        aria-label={tg("pat.hub.style")}
                        value={styleChoice}
                        onChange={e => setStyleChoice(e.target.value)}
                      >
                        <option value="console">{tg("pat.hub.styleLong")}</option>
                        <option value="baseline">{tg("pat.hub.styleAlt")}</option>
                      </SelectInput>
                    ),
                  },
                  {
                    key: "notify",
                    label: tg("pat.hub.secLog"),
                    value: (
                      <Check checked={notify} onChange={setNotify}>
                        {tg("pat.hub.agree")}
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
          title: tg("pat.hub.secLog"),
          children: <div className={fx.hubRow}>{tg("pat.hub.logRow")}</div>,
        },
      ]}
    />
  );
}
