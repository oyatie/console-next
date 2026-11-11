// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_attendance_application::records::Evidence;
use serde_json::json;

#[test]
fn work_output_round_trips_without_losing_legacy_evidence_kinds() {
    for kind in [
        "WORK_OUTPUT",
        "PAPER_SHEET",
        "DEVICE_FILE",
        "SUPERVISOR_CONFIRM",
        "EMPLOYEE_STATEMENT",
        "OTHER",
    ] {
        let wire = json!({"kind": kind, "note": "작업 기록 대조", "confirmer_employee_id": null});
        let evidence: Evidence = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(evidence.kind.as_str(), kind);
        assert_eq!(serde_json::to_value(evidence).unwrap(), wire);
    }
    assert!(serde_json::from_value::<Evidence>(json!({"kind": "UNKNOWN"})).is_err());
}
