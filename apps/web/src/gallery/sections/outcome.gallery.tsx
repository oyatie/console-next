// SPDX-License-Identifier: LicenseRef-Proprietary
import { tg } from "@console/i18n/gallery";
import { ACCESS_ENFORCEMENT, ATTENDANCE_LAYER_STATE, ATTENDANCE_MARK, CHANGE_REQUEST_STATUS, ENTITY_LIFECYCLE, ENTITY_PHASE, IDENTIFIER_CORRECTION_STATUS, IMPORT_RECONCILE_STATE, IMPORT_SIGNOFF_STATE, JOB_TITLE_STATUS, LEAVE_TYPE, ORG_BULK_PLAN_STATUS, ORG_CHANGE_STATUS, PERIOD_UNLOCK_STATE, SETTLEMENT_CERTIFICATION_STATE, STRUCTURE_RECORD_STATE, SUPPORT_SESSION_STATE } from "../../lib/labels";
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
        {[ATTENDANCE_MARK, ORG_BULK_PLAN_STATUS, ATTENDANCE_LAYER_STATE, CHANGE_REQUEST_STATUS, ACCESS_ENFORCEMENT, IMPORT_RECONCILE_STATE, IMPORT_SIGNOFF_STATE, PERIOD_UNLOCK_STATE, JOB_TITLE_STATUS, ENTITY_LIFECYCLE, ENTITY_PHASE, IDENTIFIER_CORRECTION_STATUS, STRUCTURE_RECORD_STATE, SETTLEMENT_CERTIFICATION_STATE].map(e => (
          <div key={e.type} className="row" data-enum={e.type}>
            {e.values.map(value => <EnumValue key={value} e={e} value={value} />)}
          </div>
        ))}
        <div data-enum={SUPPORT_SESSION_STATE.type}><EnumValue e={SUPPORT_SESSION_STATE} value="FUTURE_SESSION" /></div>
        <div className="stack" data-enum="unknown">
          <div><EnumValue e={ORG_CHANGE_STATUS} value="FUTURE_STATUS" /></div>
          <div><EnumValue e={LEAVE_TYPE} value="WORK_INJURY" /></div>
          <div><EnumValue e={LEAVE_TYPE} value="FUTURE_LEAVE" /></div>
        </div>
      </div>
    </Section>
  );
}
