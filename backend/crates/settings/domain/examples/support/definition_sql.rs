// SPDX-License-Identifier: LicenseRef-Proprietary
use console_settings_domain::{SettingKey, SettingKind};

fn bigint(v: Option<i64>) -> String {
    v.map_or_else(|| "NULL::BIGINT".to_owned(), |v| format!("{v}::BIGINT"))
}

fn label<T: serde::Serialize>(v: T) -> String {
    serde_json::to_value(v)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned()
}

pub fn row(key: SettingKey) -> String {
    let def = key.def();
    let (kind, min, max, codes) = match def.kind {
        SettingKind::Int { min, max, .. } => ("int", min, max, "NULL::TEXT[]".to_owned()),
        SettingKind::Bool => ("bool", None, None, "NULL::TEXT[]".to_owned()),
        SettingKind::Code { allowed } => {
            let list: Vec<String> = allowed.iter().map(|c| format!("'{c}'")).collect();
            (
                "code",
                None,
                None,
                format!("ARRAY[{}]::TEXT[]", list.join(", ")),
            )
        }
    };
    let default = def.default.and_then(|v| def.ordinal(v));
    format!(
        "('{}', '{kind}', {}, {}, {}, '{}', '{}', {codes})",
        key.as_str(),
        bigint(min),
        bigint(max),
        bigint(default),
        label(def.looser_when),
        label(def.governance),
    )
}

pub fn generated(keys: &[SettingKey]) -> String {
    let rows: Vec<String> = keys.iter().map(|&key| row(key)).collect();
    format!(
        "INSERT INTO setting_definitions\n    (key, kind, min_value, max_value, default_ordinal, looser_when, governance, codes)\nVALUES\n{}\nON CONFLICT (key) DO UPDATE SET\n    kind = EXCLUDED.kind, min_value = EXCLUDED.min_value, max_value = EXCLUDED.max_value,\n    default_ordinal = EXCLUDED.default_ordinal, looser_when = EXCLUDED.looser_when,\n    governance = EXCLUDED.governance, codes = EXCLUDED.codes;\n",
        rows.join(",\n")
    )
}
