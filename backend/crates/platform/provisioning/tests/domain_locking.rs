//! Domain commands let the current account owner finish its company FK writes.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
use console_kernel_core::{OrgId, UserId};
use console_platform_provisioning::{PlatformProvisioner, ProvisioningError};
use console_platform_test_support::runtime_role_pool;
use sqlx::{PgPool, postgres::PgPoolOptions};
use time::{Duration, OffsetDateTime};
use tokio::time::{sleep, timeout};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn account_owners_can_finish_company_fk_writes_while_domain_commands_wait(owner: PgPool) {
    let rt = runtime_role_pool(&owner).await;
    for (request, membership_changed) in [(true, false), (false, false), (false, true)] {
        let p = PlatformProvisioner::new(Duration::minutes(15));
        let now = OffsetDateTime::now_utc();
        let slug = if request {
            "request-lock"
        } else if !membership_changed {
            "rename-lock"
        } else {
            "rename-membership"
        };
        let opened = p
            .onboard_tenant(&rt, None, slug, "Customer", now)
            .await
            .unwrap();
        let org = OrgId::from_uuid(opened.organization.id);
        let user = opened.admin_user_id;
        let operation = PgPoolOptions::new()
            .max_connections(2)
            .after_connect(|conn, _| {
                Box::pin(async move {
                    sqlx::query("SET ROLE console_rt").execute(conn).await?;
                    Ok(())
                })
            })
            .connect_with(
                owner
                    .connect_options()
                    .as_ref()
                    .clone()
                    .application_name("domain-lock-operation"),
            )
            .await
            .unwrap();
        let mut held = owner.begin().await.unwrap();
        let account_lock = if request {
            "SELECT id FROM users WHERE id=$1 FOR NO KEY UPDATE"
        } else {
            "SELECT id FROM users WHERE id=$1 FOR UPDATE"
        };
        sqlx::query(account_lock)
            .bind(user)
            .fetch_one(held.as_mut())
            .await
            .unwrap();
        let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
            .fetch_one(held.as_mut())
            .await
            .unwrap();
        let task = tokio::spawn(async move {
            let result = if request {
                p.request_company_domain(
                    &operation,
                    UserId::from_uuid(user),
                    org,
                    "request-after",
                    "domain-lock-intent-key",
                    now,
                )
                .await
            } else {
                p.rename_tenant(
                    &operation,
                    None,
                    *org.as_uuid(),
                    Some("rename-after"),
                    None,
                    now,
                )
                .await
                .map(|_| ())
            };
            operation.close().await;
            result
        });
        timeout(std::time::Duration::from_secs(8), async {
            loop {
                let waiting: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name='domain-lock-operation' AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)))")
                    .bind(pid).fetch_one(&owner).await.unwrap();
                if waiting { break; }
                sleep(std::time::Duration::from_millis(5)).await;
            }
        }).await.expect("domain command must reach the held account");
        // KEY SHARE is the lock used by account/audit foreign-key checks.
        let mut fk = owner.begin().await.unwrap();
        sqlx::query("SELECT id FROM organizations WHERE id=$1 FOR KEY SHARE NOWAIT")
            .bind(org.as_uuid())
            .fetch_one(fk.as_mut())
            .await
            .expect("domain command cannot block the account owner's company FK write");
        fk.rollback().await.unwrap();
        if membership_changed {
            sqlx::query("INSERT INTO users(org_id,display_name,roles) VALUES($1,'New account',ARRAY['MEMBER'])")
                .bind(org.as_uuid()).execute(&owner).await.unwrap();
        }
        held.commit().await.unwrap();
        let result = timeout(std::time::Duration::from_secs(8), task)
            .await
            .unwrap()
            .unwrap();
        if membership_changed {
            assert!(matches!(result, Err(ProvisioningError::Conflict(_))));
            let state: (String, i64, i64) = sqlx::query_as("SELECT slug,(SELECT count(*) FROM notifications WHERE org_id=$1),(SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='platform.tenant.rename') FROM organizations WHERE id=$1")
                .bind(org.as_uuid()).fetch_one(&owner).await.unwrap();
            assert_eq!(state, (slug.into(), 0, 0));
        } else {
            result.unwrap();
        }
    }
    rt.close().await;
}
