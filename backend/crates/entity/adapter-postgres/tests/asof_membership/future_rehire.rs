// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_future_rehire_waits_for_the_current_hire_and_keeps_the_original_period(owner: PgPool) {
    let w = world(&owner, "asof-future-rehire").await;
    let p = source_person(&owner, &w, "future-rehire").await;
    let original_hire = w.d - Duration::days(100);
    let last_day = w.d - Duration::days(60);
    let hired = w.d + Duration::days(10);
    lifecycle(&owner, &w, p, "ONBOARD", original_hire).await;
    lifecycle(&owner, &w, p, "TERMINATE", last_day).await;
    sqlx::query("UPDATE employees SET employment_status='EXITED',exit_date=$2 WHERE id=$1")
        .bind(p)
        .bind(last_day.to_string())
        .execute(&owner)
        .await
        .unwrap();
    let mut tx = owner.begin().await.unwrap();
    assert!(
        start_rehire_period(
            &mut tx,
            *w.actor.org.as_uuid(),
            p,
            &RehirePeriod {
                employment_status: "PRE_HIRE",
                hire_date: &hired.to_string(),
                company: "Rehire Corp",
                org_unit: "B",
                org_unit_id: w.units[1],
                position: "Staff",
            },
        )
        .await
        .unwrap()
    );
    tx.commit().await.unwrap();
    sqlx::query(
        "INSERT INTO employee_lifecycle_events (org_id,employee_id,event_type,from_status,to_status, \
          to_org_unit_id,to_org_unit,to_workplace_id,effective_date,comment,created_by,state) VALUES \
         ($1,$2,'REHIRE','EXITED','PRE_HIRE',$3,$3::text,$4,$5,'Future rehire',$7,'APPLIED'), \
         ($1,$2,'ONBOARD','PRE_HIRE','ACTIVE',$3,$3::text,$4,$6,'Future onboarding',$7,'SCHEDULED')",
    )
    .bind(*w.actor.org.as_uuid()).bind(p).bind(w.units[1]).bind(w.workplaces[1])
    .bind(w.d.to_string()).bind(hired.to_string()).bind(*w.actor.user.as_uuid())
    .execute(&owner).await.unwrap();
    assert_eq!(
        counts(&w.store.org_structure(&w.actor).await.unwrap(), &w),
        [0, 0]
    );
    let cutoff = known(&owner).await;
    for known_at in [None, Some(cutoff)] {
        for (date, expected) in [
            (original_hire, [1, 0]),
            (last_day, [1, 0]),
            (last_day + Duration::days(1), [0, 0]),
            (w.d, [0, 0]),
            (hired - Duration::days(1), [0, 0]),
            (hired, [0, 1]),
        ] {
            assert_eq!(
                counts(&read(&w, &w.actor, date, known_at).await, &w),
                expected,
                "at {date}, known {known_at:?}"
            );
        }
    }
}
