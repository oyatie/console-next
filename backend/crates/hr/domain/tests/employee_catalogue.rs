// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]

use console_hr_domain::import::classification::employee_import_target_for_header;
use console_hr_domain::import::fields::EMPLOYEE_IMPORT_FIELD_DEFINITIONS;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, fs, path::Path, process::Command};

#[path = "support/quality_base.rs"]
mod quality_base;
use quality_base::quality_ref;

fn catalogue() -> Value {
    serde_json::from_str(
        &fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("data/employee.json"))
            .unwrap(),
    )
    .unwrap()
}

fn historical_fields() -> Vec<Value> {
    let mut fields = serde_json::from_str::<Value>(include_str!("fixtures/employee_fields.json"))
        .unwrap()["fields"]
        .as_array()
        .unwrap()
        .clone();
    let git = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .output()
            .unwrap()
    };
    let base_ref = quality_ref(&git, std::env::var("QUALITY_BASE").ok());
    let base = git(&["merge-base", "HEAD", &base_ref]);
    assert!(
        base.status.success(),
        "catalogue history needs a valid base"
    );
    let base = String::from_utf8(base.stdout).unwrap();
    let path = "backend/crates/hr/domain/data/employee.json";
    let listed = git(&["ls-tree", "--name-only", base.trim(), "--", path]);
    assert!(listed.status.success());
    if !listed.stdout.is_empty() {
        let previous = git(&["show", &format!("{}:{path}", base.trim())]);
        assert!(previous.status.success());
        let previous: Value = serde_json::from_slice(&previous.stdout).unwrap();
        fields.extend(previous["fields"].as_array().unwrap().iter().cloned());
    }
    fields
}

fn removed_keys(fields: &[Value]) -> Vec<String> {
    historical_fields()
        .iter()
        .filter(|old| {
            !fields.iter().any(|field| {
                field["target"] == old["target"]
                    || field["aliases"]
                        .as_array()
                        .unwrap()
                        .contains(&old["target"])
            })
        })
        .map(|old| old["target"].as_str().unwrap().to_owned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

#[test]
fn declared_catalogue_matches_every_importer_field() {
    let data = catalogue();
    assert_eq!(data["object"], "employee");
    let fields = data["fields"].as_array().unwrap();
    assert_eq!(fields.len(), EMPLOYEE_IMPORT_FIELD_DEFINITIONS.len());
    for (declared, used) in fields.iter().zip(EMPLOYEE_IMPORT_FIELD_DEFINITIONS.iter()) {
        assert_eq!(declared["target"], used.target);
        assert_eq!(declared["aliases"], json!(used.aliases));
        assert_eq!(declared["required"], used.required);
        assert_eq!(declared["classification"], json!(used.classification));
    }
}

#[test]
fn existing_headers_and_storage_classifications_are_preserved() {
    let data = catalogue();
    let fields = data["fields"].as_array().unwrap();
    for old in historical_fields() {
        let field = fields
            .iter()
            .find(|f| {
                f["target"] == old["target"]
                    || f["aliases"].as_array().unwrap().contains(&old["target"])
            })
            .unwrap();
        for key in ["classification", "required"] {
            assert_eq!(field[key], old[key], "{}: {key}", old["target"]);
        }
        let current = field["aliases"].as_array().unwrap();
        let aliases: Vec<&str> = if let Some(digests) = old["alias_digests"].as_array() {
            digests
                .iter()
                .map(|digest| {
                    let alias = current.iter().filter_map(Value::as_str).find(|alias| {
                        Sha256::digest(alias.as_bytes())
                            .iter()
                            .map(|byte| format!("{byte:02x}"))
                            .collect::<String>()
                            == digest.as_str().unwrap()
                    });
                    assert!(
                        alias.is_some(),
                        "{}: missing historical header digest {digest}",
                        old["target"]
                    );
                    alias.unwrap()
                })
                .collect()
        } else {
            old["aliases"]
                .as_array()
                .unwrap()
                .iter()
                .map(|alias| {
                    assert!(current.contains(alias));
                    alias.as_str().unwrap()
                })
                .collect()
        };
        for alias in aliases {
            assert_eq!(
                employee_import_target_for_header(alias),
                field["target"].as_str()
            );
        }
    }
}

#[test]
fn every_field_has_unique_key_localized_labels_type_format_and_example() {
    let data = catalogue();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../");
    let mut keys = std::collections::BTreeSet::new();
    for field in data["fields"].as_array().unwrap() {
        let key = field["target"].as_str().unwrap();
        assert!(keys.insert(key), "duplicate key {key}");
        for locale in ["ko", "en"] {
            let messages = fs::read_to_string(
                root.join(format!("packages/i18n/src/catalogs/{locale}/import.ts")),
            )
            .unwrap();
            let message = field["label_ids"][locale].as_str().unwrap();
            assert!(
                messages.contains(&format!("\"{message}\":")),
                "{locale}: {key}"
            );
        }
        assert!(!field["example"].as_str().unwrap().is_empty(), "{key}");
        assert!(!field["format"].as_str().unwrap().is_empty(), "{key}");
        assert!(
            ["text", "date", "decimal", "code"].contains(&field["value_type"].as_str().unwrap())
        );
    }
}

#[test]
fn coded_fields_reference_the_owning_catalogue_without_inline_codes() {
    let data = catalogue();
    for field in data["fields"].as_array().unwrap() {
        assert!(field.get("codes").is_none());
        if field["value_type"] == "code" {
            let owner = &field["code_catalogue"];
            assert!(code_owner_exists(owner), "unresolved owner: {owner}");
        } else {
            assert!(field["code_catalogue"].is_null());
        }
        if ["job", "position"].contains(&field["target"].as_str().unwrap()) {
            assert_eq!(field["value_type"], "code");
            assert_eq!(field["code_catalogue"]["source"], "tenant");
            assert_eq!(field["code_catalogue"]["resource"], "job_titles");
            assert!(["JOB", "TITLE"].contains(&field["code_catalogue"]["kind"].as_str().unwrap()));
        }
    }
}

#[test]
fn stable_keys_cannot_disappear_without_a_synonym() {
    let data = catalogue();
    assert!(removed_keys(data["fields"].as_array().unwrap()).is_empty());
}

#[test]
fn drift_gate_rejects_removed_key_and_accepts_its_synonym() {
    let data = catalogue();
    let mut fields = data["fields"].as_array().unwrap().clone();
    let removed = fields.remove(0);
    assert_eq!(removed_keys(&fields), [removed["target"].as_str().unwrap()]);
    fields[0]["aliases"]
        .as_array_mut()
        .unwrap()
        .push(removed["target"].clone());
    assert!(removed_keys(&fields).is_empty());
}

#[test]
fn business_registration_example_is_unallocated_and_checksum_invalid() {
    let data = catalogue();
    let example = data["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|field| field["target"] == "company_brn")
        .unwrap()["example"]
        .as_str()
        .unwrap();
    assert!(example.starts_with("000-"));
    let digits: Vec<u32> = example.chars().filter_map(|c| c.to_digit(10)).collect();
    assert_eq!(digits.len(), 10);
    let sum: u32 = digits[..9]
        .iter()
        .zip([1, 3, 7, 1, 3, 7, 1, 3, 5])
        .map(|(digit, weight)| digit * weight)
        .sum::<u32>()
        + digits[8] * 5 / 10;
    assert_ne!((10 - sum % 10) % 10, digits[9]);
}

fn code_owner_exists(owner: &Value) -> bool {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let resource = owner["resource"].as_str().unwrap();
    match owner["source"].as_str().unwrap() {
        "domain" => {
            let Some((module, symbol)) = resource.rsplit_once("::") else {
                return false;
            };
            let Ok(source) = fs::read_to_string(
                root.join("src")
                    .join(format!("{}.rs", module.replace("::", "/"))),
            ) else {
                return false;
            };
            [
                format!("pub fn {symbol}("),
                format!("pub const {symbol}:"),
                format!("{symbol}, \""),
            ]
            .iter()
            .any(|declaration| source.contains(declaration))
        }
        "tenant" => fs::read_dir(root.join("../../platform/db/migrations"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "sql"))
            .any(|entry| {
                fs::read_to_string(entry.path())
                    .unwrap()
                    .contains(&format!("CREATE TABLE {resource} ("))
            }),
        "refdata" => fs::read_dir(root.join("../../refdata/lists/data"))
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .unwrap()
                    .starts_with(&format!("{resource}-"))
            }),
        _ => false,
    }
}

#[test]
fn code_owner_drift_gate_rejects_missing_resources() {
    for owner in catalogue()["fields"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|field| field["code_catalogue"].as_object())
    {
        let mut owner = Value::Object(owner.clone());
        owner["resource"] = json!("missing_catalogue");
        assert!(!code_owner_exists(&owner));
    }
    assert!(!code_owner_exists(
        &json!({"source": "domain", "resource": "profile::enums::MissingType"})
    ));
}
