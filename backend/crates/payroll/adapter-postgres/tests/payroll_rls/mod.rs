// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{MyPayrollLine, PgPool, Uuid};

pub(super) fn assert_my_payroll_line_is_readiness_not_won(line: &MyPayrollLine) {
    let value = serde_json::to_value(line).unwrap();
    let object = value
        .as_object()
        .expect("MyPayrollLine serializes as a JSON object");
    let won_keys: Vec<&String> = object.keys().filter(|key| key.contains("won")).collect();
    assert!(
        won_keys.is_empty(),
        "MyPayrollLine is readiness, not won; unexpected keys {won_keys:?} in {value}"
    );
    for key in [
        "regular_hours",
        "overtime_hours",
        "night_hours",
        "holiday_hours",
        "gross_pay_source_present",
        "net_pay_source_present",
    ] {
        assert!(
            object.contains_key(key),
            "MyPayrollLine must keep hours / *_source_present ({key} missing) in {value}"
        );
    }
}

pub(super) async fn seed_org(owner_pool: &PgPool, org: Uuid, tag: &str) {
    sqlx::query(
        "INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    )
    .bind(org)
    .bind(format!(
        "org-{}",
        tag.chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() {
                    character.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect::<String>()
    ))
    .bind(format!("Org {tag}"))
    .execute(owner_pool)
    .await
    .unwrap();
}
