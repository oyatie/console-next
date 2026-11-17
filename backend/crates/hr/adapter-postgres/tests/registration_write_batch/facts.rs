// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_observes_each_intake_fact_only_for_its_hire(pool: PgPool) {
    let f = fixture::fixture(pool.clone()).await;
    let requests: Vec<_> = (0..4)
        .map(|n| {
            let mut body = f.body(&format!("observed-fact-{n}"), "REGULAR");
            body.name = format!("Synthetic employee {n}");
            body.position = "Synthetic position".into();
            body.site = "Synthetic site".into();
            body.home_branch_id = None;
            body.hire_date = Some((today_kst() - time::Duration::days(1)).to_string());
            match n {
                0 => {
                    body.base_pay_won = Some(3_000_000);
                    body.pay_unit = Some("MONTHLY".into());
                }
                1 => body.id_type = Some("RRN".into()),
                2 => body.birth_date = Some("1990-01-01".into()),
                _ => {}
            }
            normalize_create_employee_request(body).unwrap()
        })
        .collect();
    let hashes = hashes(&requests);
    let inputs = inputs(&requests, &hashes);
    let mut tx = transaction(&f).await;
    create_employees_core(
        &mut tx,
        *f.principal.org_id.as_uuid(),
        f.principal.user_id,
        &inputs,
    )
    .await
    .unwrap();
    for (n, input) in inputs.iter().enumerate() {
        let items: Vec<(String, String, Option<serde_json::Value>)> = sqlx::query_as(
            "SELECT t.checklist_item,i.status,i.observed_ref FROM lifecycle_cases c \
             JOIN lifecycle_case_items i ON i.org_id=c.org_id AND i.case_id=c.id \
             JOIN case_template_items t ON t.template_key=c.template_key \
               AND t.version=c.template_version AND t.item_key=i.item_key \
             WHERE c.org_id=$1 AND c.employee_id=$2 AND c.kind='HIRE' \
               AND t.checklist_item IN ('PAY_RECORDED','ID_REGISTERED','BIRTH_DATE_RECORDED')",
        )
        .bind(f.principal.org_id.as_uuid())
        .bind(input.employee_id)
        .fetch_all(tx.as_mut())
        .await
        .unwrap();
        assert_eq!(items.len(), 3);
        for (fact, status, reference) in items {
            let observed = match fact.as_str() {
                "PAY_RECORDED" => n == 0,
                "ID_REGISTERED" => n == 1,
                "BIRTH_DATE_RECORDED" => n == 2,
                _ => unreachable!(),
            };
            assert_eq!(status, if observed { "DONE_OBSERVED" } else { "OPEN" });
            assert_eq!(
                reference,
                observed.then(|| serde_json::json!({
                    "table": if n == 0 { "employee_employment_profiles" } else { "employees" },
                    "id": input.employee_id,
                }))
            );
        }
    }
    tx.commit().await.unwrap();
}
