// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{PgPool, Rig, Uuid};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn first_contact_writers_leave_a_decryptable_contact(owner: PgPool) {
    use console_platform_db::with_org_conn;
    use console_platform_provisioning::{
        ProvisioningError,
        ops_self_recovery::{
            ExposeSecret, RecoveryChannel, decrypt_recovery_contact_tx, upsert_recovery_contact,
        },
    };
    let rig = Rig::new(owner).await;
    let uid = *rig.ops.as_uuid();
    let org = rig.org;
    let now = time::OffsetDateTime::now_utc();
    let save = |value| {
        upsert_recovery_contact(
            &rig.rt,
            &rig.cipher,
            org,
            uid,
            RecoveryChannel::Email,
            value,
            now,
        )
    };
    let (first, second) = tokio::join!(save("first@example.com"), save("second@example.com"));
    first.unwrap();
    second.unwrap();
    let cipher = rig.cipher;
    let saved = with_org_conn::<_, _, ProvisioningError>(&rig.rt, org, move |tx| {
        Box::pin(async move { decrypt_recovery_contact_tx(tx, &cipher, org, uid).await })
    })
    .await
    .unwrap()
    .unwrap();
    assert!(["first@example.com", "second@example.com"].contains(&saved.1.expose_secret()));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn recovery_identifier_accepts_current_and_unexpired_aliases_only(owner: PgPool) {
    let rig = Rig::new(owner).await;
    let uid = rig.ops.as_uuid();
    let org = rig.org.as_uuid();
    for (alias, deadline) in [("oldlogin", "tomorrow"), ("expiredlogin", "yesterday")] {
        sqlx::query("INSERT INTO user_sign_in_ids(org_id,user_id,login,effective_date,reason_code,retired_at,alias_until)
                     VALUES($1,$2,$3,current_date,'RENAME',now()-interval '2 days',$4::text::timestamptz)")
            .bind(org).bind(uid).bind(alias).bind(deadline).execute(&rig.owner).await.unwrap();
    }
    for (slug, deadline) in [
        ("old-company", "tomorrow"),
        ("expired-company", "yesterday"),
    ] {
        sqlx::query(
            "INSERT INTO organization_domains(org_id,slug,retired_at,alias_until)
                      VALUES($1,$2,now()-interval '2 days',$3::text::timestamptz)",
        )
        .bind(org)
        .bind(slug)
        .bind(deadline)
        .execute(&rig.owner)
        .await
        .unwrap();
    }
    let (login, current_domain) = rig.ops_identifier.split_once('@').unwrap();
    for (input, domain, expected) in [
        (login, current_domain, Some(*uid)),
        ("OLDLOGIN", current_domain, Some(*uid)),
        (login, "old-company", Some(*uid)),
        ("oldlogin", "old-company", Some(*uid)),
        ("expiredlogin", current_domain, None),
        (login, "expired-company", None),
    ] {
        let actual: Option<Uuid> =
            sqlx::query_scalar("SELECT user_id FROM platform_resolve_recovery_identifier($1,$2)")
                .bind(input)
                .bind(domain)
                .fetch_optional(&rig.rt)
                .await
                .unwrap();
        assert_eq!(actual, expected);
    }
}
