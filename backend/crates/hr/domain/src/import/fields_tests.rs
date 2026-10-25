// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::import::classification::employee_import_target_for_header;

#[test]
fn place_model_has_distinct_workplace_and_worksite_targets() {
    for alias in [
        "사업장",
        "사업장명",
        "사업소",
        "근무사업장",
        "workplace",
        "workplace_name",
    ] {
        assert_eq!(employee_import_target_for_header(alias), Some("workplace"));
    }
    for alias in ["근무지", "현장", "현장명", "site", "worksite"] {
        assert_eq!(
            employee_import_target_for_header(alias),
            Some("worksite_name")
        );
    }
}
