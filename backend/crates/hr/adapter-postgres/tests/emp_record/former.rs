// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::fixture::{education, fixture};
use console_hr_adapter_postgres::record::{
    CreateRecordRequest, UpdateRecordRequest, VoidRecordRequest,
};
use console_hr_domain::record::Section;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn former_employee_record_create_update_and_void_are_refused(pool: PgPool) {
    let f = fixture(pool).await;
    let id = f.employee("FORMER").await;
    let (row, _) =
        f.hr.create_record(
            f.principal.clone(),
            id,
            Section::Education,
            Uuid::new_v4(),
            CreateRecordRequest {
                fields: education("합성대학교"),
            },
        )
        .await
        .unwrap();
    sqlx::query(
        "UPDATE employees SET employment_status='EXITED', exit_date='2026-10-10' WHERE id=$1",
    )
    .bind(id)
    .execute(&f.owner)
    .await
    .unwrap();
    let create =
        f.hr.create_record(
            f.principal.clone(),
            id,
            Section::Education,
            Uuid::new_v4(),
            CreateRecordRequest {
                fields: education("다른대학교"),
            },
        )
        .await
        .unwrap_err();
    let update =
        f.hr.update_record(
            f.principal.clone(),
            id,
            Section::Education,
            row.id,
            Uuid::new_v4(),
            UpdateRecordRequest {
                expected_version: row.version,
                fields: education("합성대학교 본교"),
                reason: Some("오기 정정".into()),
            },
        )
        .await
        .unwrap_err();
    let void =
        f.hr.void_record(
            f.principal.clone(),
            id,
            Section::Education,
            row.id,
            Uuid::new_v4(),
            VoidRecordRequest {
                expected_version: row.version,
                reason: "중복".into(),
            },
        )
        .await
        .unwrap_err();
    for error in [create, update, void] {
        assert_eq!(
            (error.status.as_u16(), error.code),
            (409, "employee_exited_read_only")
        );
    }
}
