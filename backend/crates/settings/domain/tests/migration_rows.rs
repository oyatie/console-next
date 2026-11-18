// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_settings_domain::{Governance, SettingKey};
use std::collections::BTreeMap;

#[path = "../examples/support/definition_sql.rs"]
mod definition_sql;

fn inserted_rows(sql: &str) -> BTreeMap<String, String> {
    let uncommented = sql
        .lines()
        .map(|line| line.split("--").next().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    uncommented
        .split(';')
        .filter_map(|statement| {
            let normalized = statement.split_whitespace().collect::<Vec<_>>().join(" ");
            let lower = normalized.to_ascii_lowercase();
            let rest = lower
                .strip_prefix("insert into setting_definitions")
                .or_else(|| lower.strip_prefix("insert into public.setting_definitions"))?;
            let (columns, _) = rest.trim_start().split_once(')').unwrap();
            assert_eq!(
                columns.trim_start_matches('(').replace(' ', ""),
                "key,kind,min_value,max_value,default_ordinal,looser_when,governance,codes",
                "generate definition rows with the setting_definitions example"
            );
            let values = lower.find("values").unwrap();
            Some(
                normalized[values + "values".len()..]
                    .split("ON CONFLICT")
                    .next()
                    .unwrap()
                    .split('(')
                    .skip(1)
                    .map(|tuple| {
                        let tuple = tuple.split_once(')').unwrap().0;
                        let key = tuple.split(',').next().unwrap().trim_matches('\'');
                        (key.to_owned(), format!("({tuple})"))
                    })
                    .collect::<BTreeMap<_, _>>(),
            )
        })
        .flatten()
        .collect()
}

#[test]
fn every_writable_registry_definition_matches_its_latest_migration_row() {
    let migrations =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../platform/db/migrations");
    let mut paths: Vec<_> = std::fs::read_dir(migrations)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "sql"))
        .collect();
    paths.sort_by_key(|path| {
        let version = path
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .split('_')
            .next()
            .unwrap();
        let number: u64 = version.parse().unwrap();
        if version.len() == 14 {
            number * 1000
        } else {
            number
        }
    });
    let rows: BTreeMap<_, _> = paths
        .iter()
        .flat_map(|path| inserted_rows(&std::fs::read_to_string(path).unwrap()))
        .collect();
    for &key in SettingKey::ALL {
        let actual = rows.get(key.as_str());
        if key.def().governance == Governance::ReadOnly && actual.is_none() {
            continue;
        }
        assert_eq!(
            actual,
            Some(&definition_sql::row(key)),
            "stale or missing migration row for {}; generate its row in a new migration",
            key.as_str()
        );
    }
}

#[test]
fn only_definition_inserts_supply_rows_and_latest_values_win() {
    let key = SettingKey::DisplayPageSize;
    let current = definition_sql::generated(&[key]);
    let previous = current.replace("500::BIGINT", "1000::BIGINT");
    let sql = format!(
        "-- {current}\nCREATE FUNCTION setting_definition() AS $$ SELECT ('snapshot', 'bool') $$;\n{previous}\n{}",
        current.replace(
            "INSERT INTO setting_definitions",
            "INSERT INTO public.setting_definitions"
        )
    );
    assert_eq!(
        inserted_rows(&sql),
        BTreeMap::from([(key.as_str().into(), definition_sql::row(key))])
    );
}

#[test]
fn generated_rows_preserve_every_definition_value() {
    for &key in SettingKey::ALL {
        let current = definition_sql::generated(&[key]);
        let row = definition_sql::row(key);
        assert_eq!(inserted_rows(&current).get(key.as_str()), Some(&row));
        // Each field must participate in comparison, even when the key still exists.
        for field in row.trim_matches(['(', ')']).split(", ").skip(1) {
            let changed = current.replacen(field, "'drift'", 1);
            assert_ne!(inserted_rows(&changed).get(key.as_str()), Some(&row));
        }
    }
}
