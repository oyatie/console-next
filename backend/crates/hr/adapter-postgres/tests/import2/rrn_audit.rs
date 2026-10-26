// SPDX-License-Identifier: LicenseRef-Proprietary
//! A failing access record cannot open the vault.
use crate::harness::MirrorVault;
use crate::rrn_governed::{key, loaded, proof, request};
use console_hr_adapter_postgres::rrn::reveal_binding;
use console_platform_test_support::soft_passkey::passkey_service;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_failed_access_log_returns_no_value_and_does_not_open_the_vault(pool: PgPool) {
    use console_hr_domain::import::rrn_value::{Rrn, RrnVault, SealedRrn, VaultError};
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Counted(AtomicUsize);
    impl RrnVault for Counted {
        fn seal(&self, o: Uuid, r: &Rrn) -> Result<SealedRrn, VaultError> {
            MirrorVault.seal(o, r)
        }
        fn blind_index(&self, r: &Rrn) -> Vec<u8> {
            MirrorVault.blind_index(r)
        }
        fn open(&self, o: Uuid, s: &SealedRrn) -> Result<Rrn, VaultError> {
            self.0.fetch_add(1, Ordering::SeqCst);
            MirrorVault.open(o, s)
        }
    }
    let (i, id) = loaded(pool.clone()).await;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!("CREATE FUNCTION synthetic_reveal_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.target_id='{id}' AND NEW.action='employee.rrn_reveal' THEN RAISE EXCEPTION 'synthetic access record failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_reveal_failure BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION synthetic_reveal_failure();"))).execute(&pool).await.unwrap();
    let mut key = key(&pool, &i).await;
    let body = request(
        proof(
            &pool,
            &i,
            &mut key,
            reveal_binding(id, "RRN", "IDENTITY_VERIFICATION"),
        )
        .await,
    );
    let vault = Counted(AtomicUsize::new(0));
    let result =
        i.f.hr
            .rrn_reveal(
                i.f.principal.clone(),
                id,
                body,
                Some(&vault),
                Some(&passkey_service()),
            )
            .await;
    assert!(result.is_err());
    assert_eq!(vault.0.load(Ordering::SeqCst), 0);
    assert_eq!(
        i.count(
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='employee.rrn_reveal'"
        )
        .await,
        0
    );
}
