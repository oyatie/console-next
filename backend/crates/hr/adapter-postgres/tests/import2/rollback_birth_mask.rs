// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

/// The importer treats this header as restricted personal data; an English birth date header is not.
const BIRTH_HEADER: &str = "생년월일";
const NAME: &str = "Birthday Person";

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_rollback_preview_serves_a_filled_birth_date_as_its_mask(pool: PgPool) {
    let i = importer(pool).await;
    i.load(
        "before.xlsx",
        &[table(
            "Roster",
            0,
            &[
                &["Employee Number", "Employee Name", "Hire Date"],
                &["BIRTH-01", NAME, "2024-03-04"],
            ],
        )],
        decisions(),
    )
    .await;
    let run = i
        .preview(
            "birth.xlsx",
            &[table(
                "Roster",
                0,
                &[
                    &[
                        "Employee Number",
                        "Employee Name",
                        "Hire Date",
                        BIRTH_HEADER,
                    ],
                    &["BIRTH-01", NAME, "2024-03-04", "1990-01-01"],
                ],
            )],
            &Default::default(),
        )
        .await
        .unwrap()
        .run_id;
    let dry = i.dry_run(run, decisions()).await;
    i.apply(run, &dry.dry_run_digest).await.unwrap();
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    let served = serde_json::to_value(&preview).unwrap();
    assert!(!served.to_string().contains("1990-01-01"), "{served}");
    let birth = served["rows"][0]["fields"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["field"] == "birth_date")
        .unwrap_or_else(|| panic!("{served}"))
        .clone();
    assert_eq!(birth["current"], "••••-••-••");
    // The rollback restores the record, not the mask it served.
    i.f.hr
        .rollback_import(
            i.f.principal.clone(),
            run,
            command(&preview.preview_digest),
            None,
            SOLO,
        )
        .await
        .unwrap();
    let id = i.person(NAME).await.0;
    let birth: Option<time::Date> =
        sqlx::query_scalar("SELECT birth_date FROM employees WHERE id=$1")
            .bind(id)
            .fetch_one(&i.owner)
            .await
            .unwrap();
    assert_eq!(birth, None);
}
