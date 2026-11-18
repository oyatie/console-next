// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_settings_domain::{Governance, SettingKey};
use std::collections::BTreeSet;

fn inserted_keys(sql: &str) -> BTreeSet<String> {
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
            assert!(
                rest.trim_start().starts_with('('),
                "use an explicit column list for setting definitions"
            );
            let (columns, _) = rest.split_once(')').unwrap();
            assert_eq!(
                columns
                    .trim_start_matches([' ', '('])
                    .split(',')
                    .next()
                    .unwrap()
                    .trim(),
                "key",
                "generate rows with key as the first column"
            );
            let values = lower.find("values")?;
            Some(
                normalized[values + "values".len()..]
                    .split('(')
                    .filter_map(|tuple| {
                        let first = tuple.split(',').next()?.trim();
                        first
                            .strip_prefix('\'')?
                            .strip_suffix('\'')
                            .map(str::to_owned)
                    })
                    .collect::<BTreeSet<_>>(),
            )
        })
        .flatten()
        .collect()
}

#[test]
fn every_writable_registry_key_has_a_migration_row() {
    let migrations =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../platform/db/migrations");
    let keys: BTreeSet<_> = std::fs::read_dir(migrations)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "sql"))
        .flat_map(|path| inserted_keys(&std::fs::read_to_string(path).unwrap()))
        .collect();
    let missing: Vec<_> = SettingKey::ALL
        .iter()
        .filter(|key| key.def().governance != Governance::ReadOnly && !keys.contains(key.as_str()))
        .map(|key| key.as_str())
        .collect();
    assert!(
        missing.is_empty(),
        "settings keys missing migration rows: {missing:?}"
    );
}

#[test]
fn only_definition_inserts_supply_keys() {
    assert_eq!(
        inserted_keys(
            "-- INSERT INTO setting_definitions(key) VALUES ('comment');\nCREATE FUNCTION setting_definition() AS $$ SELECT ('snapshot', 'bool') $$;\nINSERT INTO public.setting_definitions\n(key, kind) VALUES ('first', 'bool'), ('second', 'int');"
        ),
        BTreeSet::from(["first".into(), "second".into()])
    );
}
