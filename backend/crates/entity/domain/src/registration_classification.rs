//! NTS allocation table, transcribed from the cited publication into versioned data.

use std::sync::LazyLock;

#[derive(Debug)]
pub struct Classification {
    pub code: &'static str,
    pub label: &'static str,
    pub biz_kinds: Vec<&'static str>,
    pub head_office: bool,
}

#[must_use]
pub fn classifications() -> &'static [Classification] {
    &CODES
}

static CODES: LazyLock<Vec<Classification>> = LazyLock::new(|| {
    include_str!("../data/brn_classification-2026-10-13.tsv")
        .lines()
        .filter_map(|line| {
            let mut cols = line.split('\t');
            Some(Classification {
                code: cols.next()?,
                label: cols.next()?,
                biz_kinds: cols.next()?.split(',').collect(),
                head_office: cols.next()? == "true",
            })
        })
        .collect()
});

#[must_use]
pub fn classification(brn: &str) -> Option<&'static Classification> {
    let mid: u8 = brn.get(3..5)?.parse().ok()?;
    CODES.iter().find(|row| {
        let (start, end) = row.code.split_once('-').unwrap_or((row.code, row.code));
        start
            .parse::<u8>()
            .ok()
            .zip(end.parse::<u8>().ok())
            .is_some_and(|(a, b)| (a..=b).contains(&mid))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nts_classes_cover_every_allocated_middle_code() {
        assert!(
            classifications()
                .iter()
                .any(|r| r.code == "85" && !r.head_office)
        );
        for mid in [81, 86, 87, 88] {
            let r = classification(&format!("220{mid:02}00000")).unwrap();
            assert!(r.head_office);
            assert_eq!(r.biz_kinds, ["CORPORATION"]);
        }
        for mid in [1, 79, 90, 99] {
            let r = classification(&format!("220{mid:02}00000")).unwrap();
            assert!(r.head_office);
            assert_eq!(r.biz_kinds, ["INDIVIDUAL"]);
        }
        assert!(!classification("0008512347").unwrap().head_office);
        assert_eq!(
            classification("0008162515").unwrap().biz_kinds.as_slice(),
            &["CORPORATION"]
        );
        for mid in 1..=99 {
            assert!(classification(&format!("220{mid:02}00000")).is_some());
        }
        assert!(classification("2200000000").is_none());
    }
    #[test]
    fn exported_synthetic_registration_fixtures_follow_the_nts_classification() {
        use console_kernel_core::kr::{BizRegNo, CorpRegNo};
        use std::{collections::HashSet, fs, path::PathBuf};

        let root = PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("fixture manifest directory"),
        )
        .join("../../../../");
        let path = root.join("e2e/registration-identifiers.json");
        let source = match fs::read_to_string(path) {
            Ok(source) => source,
            Err(_) => {
                assert!(
                    !root.join("playwright.config.ts").is_file(),
                    "public export is missing its synthetic registration fixtures"
                );
                return;
            }
        };
        let fixtures: serde_json::Value =
            serde_json::from_str(&source).expect("synthetic registration fixtures are valid JSON");
        assert_eq!(fixtures.as_object().expect("fixture map").len(), 3);
        let mut brns = HashSet::new();
        let mut crns = HashSet::new();
        let mut pairs = HashSet::new();
        for (name, is_head_office) in [
            ("primary", true),
            ("second", true),
            ("branch_primary", false),
        ] {
            let fixture = &fixtures[name];
            assert_eq!(fixture["synthetic"], true);
            let kind = fixture["biz_kind"].as_str().expect("fixture business kind");
            assert_eq!(kind, "CORPORATION");
            let brn = BizRegNo::parse(fixture["brn"].as_str().expect("fixture BRN"))
                .expect("synthetic BRN parses");
            assert!(brn.warnings().is_empty(), "synthetic BRN checksum");
            let rule = classification(brn.as_str()).expect("synthetic BRN class exists");
            assert!(rule.biz_kinds.contains(&kind));
            assert_eq!(rule.head_office, is_head_office);
            let corp_kind = crate::codes::BizKind::parse(kind).expect("fixture kind is supported");
            let classified = crate::registration_number::validate_classification(
                Some(corp_kind),
                is_head_office,
                None,
                Some((rule.biz_kinds.as_slice(), rule.head_office)),
            );
            assert!(classified.is_ok());
            assert!(
                brns.insert(brn.as_str().to_owned()),
                "synthetic BRNs are unique"
            );

            let crn = CorpRegNo::parse(fixture["crn"].as_str().expect("fixture CRN"))
                .expect("synthetic CRN parses");
            assert!(crn.checksum_matches(), "synthetic CRN checksum");
            assert_eq!(crn.registry_office_code().len(), 4);
            assert_eq!(crn.corp_kind_code().len(), 2);
            assert!(
                crn.registry_office_code()
                    .bytes()
                    .all(|b| b.is_ascii_digit())
            );
            assert!(crn.corp_kind_code().bytes().all(|b| b.is_ascii_digit()));
            assert!(
                crns.insert(crn.as_str().to_owned()),
                "synthetic CRNs are unique"
            );
            assert!(
                pairs.insert((brn.as_str().to_owned(), crn.as_str().to_owned())),
                "synthetic BRN/CRN pairs are unique"
            );
        }
        assert_eq!(brns.len(), 3);
        assert_eq!(crns.len(), 3);
        assert_eq!(pairs.len(), 3);
    }

    #[test]
    fn class_wrong_synthetic_brn_is_refused_by_the_registration_classifier() {
        let corp = crate::codes::BizKind::Corporation;
        let mismatch = classifications()
            .iter()
            .find(|row| !row.biz_kinds.contains(&corp.as_str()) || !row.head_office)
            .expect("NTS table has a non-head or non-corporation class");
        let middle = mismatch
            .code
            .split_once('-')
            .map_or(mismatch.code, |(start, _)| start);
        let brn = format!("000{middle}00000");
        let rule =
            classification(&brn).expect("synthetic mismatch class resolves from the NTS table");
        let refusal = crate::registration_number::validate_classification(
            Some(corp),
            true,
            None,
            Some((rule.biz_kinds.as_slice(), rule.head_office)),
        )
        .expect_err("a synthetic class mismatch requires an explicit reason");
        assert_eq!(
            refusal.fields[0].code,
            "registration_classification_reason_required"
        );
    }

    #[test]
    fn backend_synthetic_registration_fixtures_follow_the_nts_classification() {
        use console_kernel_core::kr::{BizRegNo, CorpRegNo};
        use std::{
            collections::HashMap,
            fs,
            path::{Path, PathBuf},
        };

        fn collect_fixture_files(dir: &Path, inside: bool, files: &mut Vec<PathBuf>) {
            let entries = fs::read_dir(dir).expect("backend fixture directories are readable");
            for entry in entries {
                let path = entry.expect("backend fixture entry is readable").path();
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                if path.is_dir() {
                    if matches!(name, ".git" | "target" | "node_modules" | "vendor") {
                        continue;
                    }
                    let fixture_dir = matches!(
                        name,
                        "test"
                            | "tests"
                            | "fixture"
                            | "fixtures"
                            | "seed"
                            | "seeds"
                            | "bench"
                            | "benches"
                            | "fuzz"
                            | "fuzzing"
                    );
                    collect_fixture_files(&path, inside || fixture_dir, files);
                } else if inside {
                    let extension = path
                        .extension()
                        .and_then(|value| value.to_str())
                        .unwrap_or("");
                    if matches!(
                        extension,
                        "rs" | "json"
                            | "sql"
                            | "yaml"
                            | "yml"
                            | "toml"
                            | "csv"
                            | "tsv"
                            | "txt"
                            | "md"
                            | "py"
                    ) && path
                        .metadata()
                        .is_ok_and(|metadata| metadata.len() <= 1_048_576)
                    {
                        files.push(path);
                    }
                }
            }
        }

        fn string_literals(line: &str) -> Vec<String> {
            let bytes = line.as_bytes();
            let mut values = Vec::new();
            let mut cursor = 0;
            while cursor < bytes.len() {
                if bytes[cursor] != b'"' {
                    cursor += 1;
                    continue;
                }
                let start = cursor + 1;
                cursor = start;
                let mut escaped = false;
                while cursor < bytes.len() {
                    if escaped {
                        escaped = false;
                    } else if bytes[cursor] == b'\\' {
                        escaped = true;
                    } else if bytes[cursor] == b'"' {
                        break;
                    }
                    cursor += 1;
                }
                if cursor < bytes.len() {
                    if let Some(value) = line.get(start..cursor) {
                        values.push(value.to_owned());
                    }
                    cursor += 1;
                }
            }
            values
        }

        fn digits(value: &str) -> Option<String> {
            let mut out = String::new();
            for ch in value.chars() {
                if ch.is_ascii_digit() {
                    out.push(ch);
                } else if ch != '-' && ch != ' ' {
                    return None;
                }
            }
            Some(out)
        }

        fn number_candidates(value: &str) -> Vec<String> {
            if let Some(digits) = digits(value)
                && matches!(digits.len(), 10 | 13)
            {
                return vec![digits];
            }

            let mut out = Vec::new();
            let mut candidate = String::new();
            for ch in value.chars().chain(std::iter::once(' ')) {
                if ch.is_ascii_digit() {
                    candidate.push(ch);
                } else if ch != '-' {
                    if matches!(candidate.len(), 10 | 13) {
                        out.push(std::mem::take(&mut candidate));
                    } else {
                        candidate.clear();
                    }
                }
            }
            out
        }

        fn helper_parameters(lines: &[&str]) -> HashMap<String, (bool, bool)> {
            let mut helpers = HashMap::new();
            let mut signature: Option<(String, String)> = None;
            for line in lines {
                if signature.is_none() {
                    let trimmed = line.trim_start();
                    if trimmed.starts_with("//") || trimmed.starts_with("*") {
                        continue;
                    }
                    if let Some((binding, params)) = trimmed
                        .strip_prefix("let ")
                        .and_then(|rest| rest.split_once("= |"))
                        && let Some(params) = params.split('|').next()
                        && params.contains("brn:")
                    {
                        helpers.insert(binding.trim().to_owned(), (params.contains("crn:"), true));
                    }
                    let Some(fn_pos) = line.find("fn ") else {
                        continue;
                    };
                    let after_fn = &line[fn_pos + 3..];
                    let Some(open) = after_fn.find('(') else {
                        continue;
                    };
                    let name = after_fn[..open].trim().to_owned();
                    let params = after_fn[open + 1..].to_owned();
                    signature = Some((name, params));
                } else if let Some((_, params)) = signature.as_mut() {
                    params.push(' ');
                    params.push_str(line);
                }

                let Some((name, params)) = signature.as_ref() else {
                    continue;
                };
                if params.contains(')') {
                    if params.contains("brn:") {
                        helpers.insert(name.clone(), (params.contains("crn:"), true));
                    }
                    signature = None;
                }
            }
            helpers.insert("certificate".to_owned(), (false, true));
            helpers.insert("corporation".to_owned(), (true, false));
            helpers
        }

        fn validate_brn(
            raw: &str,
            kind: crate::codes::BizKind,
            head_office: bool,
            path: &Path,
            line: usize,
        ) {
            let brn = BizRegNo::parse(raw).unwrap_or_else(|_| {
                panic!("synthetic BRN does not parse at {}:{line}", path.display())
            });
            assert!(
                brn.as_str().starts_with("000"),
                "fixture BRN outside the unissued 000 range at {}:{line}",
                path.display()
            );
            assert!(
                brn.warnings().is_empty(),
                "synthetic BRN checksum at {}:{line}",
                path.display()
            );
            let rule = classification(brn.as_str()).unwrap_or_else(|| {
                panic!(
                    "synthetic BRN class is missing at {}:{line}",
                    path.display()
                )
            });
            let result = crate::registration_number::validate_classification(
                Some(kind),
                head_office,
                None,
                Some((rule.biz_kinds.as_slice(), rule.head_office)),
            );
            assert!(
                result.is_ok(),
                "fixture registration classification failed at {}:{line} (kind={kind:?}, head_office={head_office}, classified_head_office={}, classified_kind_count={})",
                path.display(),
                rule.head_office,
                rule.biz_kinds.len()
            );
        }

        let root = PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR").expect("fixture manifest directory"),
        )
        .join("../../../../");
        let backend = root.join("backend");
        let mut files = Vec::new();
        collect_fixture_files(&backend, false, &mut files);
        let mut checked = 0;
        let mut paired = 0;

        for path in files {
            let Ok(source) = fs::read_to_string(&path) else {
                continue;
            };
            let lines: Vec<_> = source.lines().collect();
            let helpers = helper_parameters(&lines);
            let mut tuple_rows = false;
            let mut const_crn: Option<String> = None;
            let mut const_brn: Option<String> = None;

            for (index, line) in lines.iter().enumerate() {
                if line.contains("for (name, crn, brn) in [") {
                    tuple_rows = true;
                }
                let literals = string_literals(line);
                let helper_call = helpers.keys().any(|name| {
                    line.contains(&format!("{name}(")) && !line.trim_start().starts_with("fn ")
                });
                let context =
                    lines[index.saturating_sub(2)..=(index + 2).min(lines.len() - 1)].join(" ");
                let function_context = lines[..=index]
                    .iter()
                    .rev()
                    .find(|line| line.contains("fn "))
                    .copied()
                    .unwrap_or("");
                let phone_field = line.contains("main_phone")
                    || line.contains("phone:")
                    || line.contains("\"phone\"");
                let registration_line = tuple_rows
                    || helper_call
                    || line.contains("\"brn\"")
                    || line.contains("brn:")
                    || line.contains("BRN")
                    || line.contains("registration")
                    || function_context.to_ascii_lowercase().contains("brn");
                let registration_line = registration_line && !phone_field;
                let individual = context.contains("BizKind::Individual")
                    || context.contains("\"biz_kind\": \"INDIVIDUAL\"")
                    || context.contains("biz_kind: Some(\"INDIVIDUAL\")")
                    || function_context.to_ascii_lowercase().contains("individual");
                let kind = crate::codes::BizKind::parse(if individual {
                    "INDIVIDUAL"
                } else {
                    "CORPORATION"
                })
                .expect("fixture kind is supported");
                let head_office = !(function_context
                    .contains("cannot_turn_the_primary_into_a_branch")
                    && (line.contains("(\"brn\", ") || context.contains(".brn.as_ref()"))
                    || context.contains("let mut branch = certificate")
                    || context.contains("BRANCH_TEST_BRN")
                    || context.contains("is_head_office: Some(false)")
                    || context.contains("\"is_head_office\": false"));

                let mut row_crn = None;
                let mut row_brn = None;
                for raw in &literals {
                    for value in number_candidates(raw) {
                        if value.len() == 13 && (tuple_rows || helper_call || line.contains("CRN"))
                        {
                            assert!(
                                value.starts_with("000"),
                                "fixture CRN outside the unissued 000 range at {}:{}",
                                path.display(),
                                index + 1
                            );
                            row_crn = Some(value.clone());
                        }
                        if value.len() == 10 && registration_line {
                            validate_brn(&value, kind, head_office, &path, index + 1);
                            checked += 1;
                            if tuple_rows || helper_call {
                                row_brn = Some(value.clone());
                            }
                        }
                        if value.len() == 13 && line.contains("const CRN") {
                            const_crn = Some(value.clone());
                        }
                        if value.len() == 10 && line.contains("const BRN") {
                            const_brn = Some(value.clone());
                        }
                    }
                }

                if let (Some(crn), Some(brn)) = (row_crn, row_brn) {
                    let crn = CorpRegNo::parse(&crn).expect("paired synthetic CRN parses");
                    assert!(
                        crn.checksum_matches(),
                        "paired synthetic CRN checksum at {}:{}",
                        path.display(),
                        index + 1
                    );
                    validate_brn(
                        &brn,
                        crate::codes::BizKind::Corporation,
                        true,
                        &path,
                        index + 1,
                    );
                    paired += 1;
                }
                if tuple_rows && line.contains(']') {
                    tuple_rows = false;
                }
            }

            if let (Some(crn), Some(brn)) = (const_crn, const_brn) {
                let crn = CorpRegNo::parse(&crn).expect("paired synthetic CRN parses");
                assert!(crn.checksum_matches(), "paired synthetic CRN checksum");
                validate_brn(&brn, crate::codes::BizKind::Corporation, true, &path, 0);
                paired += 1;
            }
        }

        // These fuzz corpus records carry individual registration bodies. They
        // are binary inputs with a one-byte dispatcher before their JSON body.
        let corpus = backend.join("fuzz/corpus/entity-bodies");
        let mut fuzz_checked = 0;
        if corpus.is_dir() {
            for entry in fs::read_dir(corpus).expect("fuzz corpus directory is readable") {
                let path = entry.expect("fuzz corpus entry is readable").path();
                if !path.is_file() {
                    continue;
                }
                let bytes = fs::read(&path).expect("fuzz corpus seed is readable");
                let Some(body) = bytes.get(1..) else {
                    continue;
                };
                let Ok(value) = serde_json::from_slice::<serde_json::Value>(body) else {
                    continue;
                };
                let Some(raw) = value.get("brn").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                let kind = match path.file_name().and_then(|name| name.to_str()) {
                    Some("seed-004" | "seed-006") => crate::codes::BizKind::parse("INDIVIDUAL")
                        .expect("fuzz fixture kind is supported"),
                    _ => crate::codes::BizKind::parse(
                        value
                            .get("biz_kind")
                            .and_then(serde_json::Value::as_str)
                            .expect("fuzz BRN fixture declares its business kind"),
                    )
                    .expect("fuzz fixture kind is supported"),
                };
                validate_brn(raw, kind, true, &path, 0);
                fuzz_checked += 1;
            }
        }

        eprintln!(
            "BE BRN class check: literals={} paired={} fuzz={}",
            checked, paired, fuzz_checked
        );
        assert!(
            checked >= 69,
            "BE synthetic BRN scan covered the fixture set"
        );
        assert!(paired >= 6, "BE synthetic BRN/CRN pairs were checked");
        assert_eq!(fuzz_checked, 2, "BE registration fuzz seeds were checked");
    }
}
