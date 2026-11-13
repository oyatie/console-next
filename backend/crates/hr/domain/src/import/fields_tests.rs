// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{EmployeeImportCatalogue, employee_import_catalogue};
use crate::import::classification::employee_import_target_for_header;

#[test]
fn catalogue_is_cached_and_its_version_tracks_content() {
    let source = include_str!("../../data/employee.json");
    let catalogue = employee_import_catalogue();
    assert!(std::ptr::eq(catalogue, employee_import_catalogue()));
    assert_eq!(catalogue.version.len(), "sha256:".len() + 64);
    assert_eq!(
        catalogue.version,
        EmployeeImportCatalogue::parse(source).unwrap().version
    );
    let changed = source.replace("SYN-0001", "SYN-0002");
    assert_ne!(
        catalogue.version,
        EmployeeImportCatalogue::parse(&changed).unwrap().version
    );
    let served = serde_json::to_value(catalogue).unwrap();
    assert_eq!(served["version"], catalogue.version);
    assert_eq!(
        served["fields"].as_array().unwrap().len(),
        catalogue.fields.len()
    );
}

#[test]
fn typed_catalogue_rejects_unknown_types_formats_and_code_owners() {
    let source = include_str!("../../data/employee.json");
    for (before, after) in [
        ("\"value_type\": \"text\"", "\"value_type\": \"unknown\""),
        ("\"format\": \"text\"", "\"format\": \"unknown\""),
        ("\"source\": \"tenant\"", "\"source\": \"unknown\""),
    ] {
        let changed = source.replacen(before, after, 1);
        assert!(EmployeeImportCatalogue::parse(&changed).is_err(), "{after}");
    }
}

#[test]
fn typed_catalogue_rejects_missing_metadata_and_inline_code_lists() {
    let source = include_str!("../../data/employee.json");
    for key in [
        "target",
        "aliases",
        "classification",
        "required",
        "label_ids",
        "value_type",
        "format",
        "example",
    ] {
        let mut data: serde_json::Value = serde_json::from_str(source).unwrap();
        data["fields"][0].as_object_mut().unwrap().remove(key);
        let changed = data.to_string();
        assert!(EmployeeImportCatalogue::parse(&changed).is_err(), "{key}");
    }
    let changed = source.replacen("\"example\":", "\"codes\": [], \"example\":", 1);
    assert!(EmployeeImportCatalogue::parse(&changed).is_err());
}

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
