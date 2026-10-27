// SPDX-License-Identifier: LicenseRef-Proprietary
import { tg } from "@console/i18n/gallery";
import { LEAVE_TYPE, ORG_CHANGE_STATUS } from "../../lib/labels";
import { EnumValue } from "../../ui/enum-value";
import { Section } from "../Section";

export const order = 11;

export default function OutcomeGallery() {
  return (
    <Section title={tg("col.status")}>
      <div className="stack" data-outcome-status>
        <div className="row" data-enum={ORG_CHANGE_STATUS.type}>
          {ORG_CHANGE_STATUS.values.map(value => <EnumValue key={value} e={ORG_CHANGE_STATUS} value={value} />)}
        </div>
        <div className="row" data-enum="unknown">
          <EnumValue e={ORG_CHANGE_STATUS} value="FUTURE_STATUS" />
          <EnumValue e={LEAVE_TYPE} value="WORK_INJURY" />
          <EnumValue e={LEAVE_TYPE} value="FUTURE_LEAVE" />
        </div>
      </div>
    </Section>
  );
}
