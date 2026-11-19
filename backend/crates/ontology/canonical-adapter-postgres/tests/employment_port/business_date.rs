// SPDX-License-Identifier: LicenseRef-Proprietary
//! Effective instants stay within the business date whose window was checked.

use super::*;

/// P1 follow-up: the lock date derives from the fixed KST offset, not the
/// caller-supplied RFC3339 offset. A UTC instant late in one day — already the
/// next day in KST — must be refused by a lock on the KST date.
#[sqlx::test(migrator = "MIGRATOR")]
async fn a_lock_on_the_kst_business_date_refuses_a_utc_instant(owner_pool: PgPool) {
    let (org, actor, port) = fixture(&owner_pool).await;
    let (_employee, employment_id) = appointed(&owner_pool, org, actor, &port, "kst").await;

    // at(0) is 08:00Z; +12h lands at 20:00Z, whose KST (UTC+9) date is the next
    // calendar day.
    let utc_instant = at(43_200);
    let kst_date = utc_instant.to_offset(offset!(+9)).date();
    assert_ne!(
        utc_instant.date(),
        kst_date,
        "fixture must cross a KST day boundary"
    );
    seed_period_lock(&owner_pool, ORG, "payroll", kst_date).await;

    let refused = execute(
        &port,
        command(
            org,
            actor,
            EmploymentQuery::Promote {
                employment_id,
                valid_from: utc_instant,
                attributes: attributes(ORG_UNIT_SALES, JOB_LEAD, "ACTIVE"),
            },
        ),
    )
    .await
    .expect_err("a lock on the KST business date must refuse the UTC instant");

    assert!(
        matches!(&refused, EmploymentError::Frozen(error) if error.kind == ErrorKind::Conflict),
        "got {refused:?}"
    );
}

/// Sub-microsecond precision must not round an open day's appointment into a frozen day.
#[sqlx::test(migrator = "MIGRATOR")]
async fn an_appointment_cannot_round_into_the_next_locked_business_date(owner_pool: PgPool) {
    let (org, actor, port) = fixture(&owner_pool).await;
    for valid_from in [
        time::macros::datetime!(1999-11-17 23:59:59.9999996 +09:00),
        time::macros::datetime!(2026-11-17 23:59:59.9999996 +09:00),
    ] {
        let employee_id = seed_employee(
            &owner_pool,
            ORG,
            &format!("precision-freeze-{}", valid_from.year()),
        )
        .await;
        let day = valid_from.date();
        seed_period_lock(&owner_pool, ORG, "payroll", day.next_day().unwrap()).await;

        let receipt = execute(
            &port,
            command(
                org,
                actor,
                EmploymentQuery::Appoint {
                    employee_id,
                    valid_from,
                    attributes: attributes(ORG_UNIT_SALES, JOB_STAFF, "ACTIVE"),
                },
            ),
        )
        .await
        .expect("the exact appointment instant belongs to the open business date");
        let employment_id = employment_of(&receipt);
        let instants: Vec<OffsetDateTime> = sqlx::query_scalar(
                "SELECT valid_from FROM employment_heads WHERE org_id=$1 AND id=$2 \
                 UNION ALL SELECT valid_from FROM employment_revisions WHERE org_id=$1 AND employment_id=$2",
            )
            .bind(ORG)
            .bind(employment_id)
            .fetch_all(&owner_pool)
            .await
            .unwrap();
        assert_eq!(instants.len(), 2);
        for stored in instants {
            assert_eq!(
                stored.to_offset(offset!(+9)).date(),
                day,
                "an appointment must not round into the locked next business date"
            );
            assert_eq!(stored, valid_from.replace_nanosecond(999_999_000).unwrap());
        }
    }
}

/// Revisions share the same freeze-date guarantee for historical instants.
#[sqlx::test(migrator = "MIGRATOR")]
async fn a_historical_revision_cannot_advance_into_the_next_locked_business_date(
    owner_pool: PgPool,
) {
    let (org, actor, port) = fixture(&owner_pool).await;
    let employee = seed_employee(&owner_pool, ORG, "historical-revision-freeze").await;
    let opened = time::macros::datetime!(1999-11-17 00:00 +09:00);
    let appointment = execute(
        &port,
        command(
            org,
            actor,
            EmploymentQuery::Appoint {
                employee_id: employee,
                valid_from: opened,
                attributes: attributes(ORG_UNIT_SALES, JOB_STAFF, "ACTIVE"),
            },
        ),
    )
    .await
    .unwrap();
    let employment_id = employment_of(&appointment);
    let valid_from = time::macros::datetime!(1999-11-17 23:59:59.9999996 +09:00);
    seed_period_lock(
        &owner_pool,
        ORG,
        "payroll",
        valid_from.date().next_day().unwrap(),
    )
    .await;
    execute(
        &port,
        command(
            org,
            actor,
            EmploymentQuery::Promote {
                employment_id,
                valid_from,
                attributes: attributes(ORG_UNIT_SALES, JOB_LEAD, "ACTIVE"),
            },
        ),
    )
    .await
    .expect("the exact revision instant belongs to the open business date");
    let stored: OffsetDateTime = sqlx::query_scalar(
        "SELECT valid_from FROM employment_revisions WHERE org_id=$1 AND employment_id=$2 AND version=2",
    ).bind(ORG).bind(employment_id).fetch_one(&owner_pool).await.unwrap();
    assert_eq!(stored, valid_from.replace_nanosecond(999_999_000).unwrap());
}
