// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use std::{
    sync::{Mutex, mpsc},
    time::Duration,
};
use tokio::{sync::oneshot, time::timeout};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn concurrent_record_commands_cannot_claim_the_same_number(pool: PgPool) {
    let mut f = fixture(&pool).await;
    let [id, other] = f.ids;
    let one = body(&pool, &mut f, id).await;
    let two = body(&pool, &mut f, other).await;
    let (a, b) = tokio::join!(put(app(&f, true), id, one), put(app(&f, true), other, two));
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [201, 409]);
}

async fn directory_actor(pool: &PgPool, f: &mut Fixture) {
    let org = f.principal.org_id;
    let ops = f.principal.user_id;
    let user = seed_active_user(pool, *org.as_uuid(), "SUPER_ADMIN", "directory-writer").await;
    let role: Uuid = sqlx::query_scalar("INSERT INTO access_roles(org_id,name_ko,status,version,created_by) VALUES($1,'합성 인사 담당','ACTIVE',1,$2) RETURNING id")
        .bind(org.as_uuid()).bind(ops.as_uuid()).fetch_one(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions(org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES($1,$2,1,'합성 인사 담당','ACTIVE','SETUP',$3)")
        .bind(org.as_uuid()).bind(role).bind(ops.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines(org_id,role_id,version,domain,levels) VALUES($1,$2,1,'hr_basic',ARRAY['view','edit'])")
        .bind(org.as_uuid()).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants(org_id,account_id,role_id,scope_kind,valid_from,change_mode,reason_code,granted_by,effective_in_setup) VALUES($1,$2,$3,'TENANT',now()-interval '1 day','SETUP','NEW_HIRE',$4,true)")
        .bind(org.as_uuid()).bind(user.as_uuid()).bind(role).bind(ops.as_uuid()).execute(pool).await.unwrap();
    f.principal.user_id = user;
    f.key = SoftKey::enroll(pool, org, user).await;
}

async fn count(pool: &PgPool, table: &str, org: OrgId) -> i64 {
    let sql = match table {
        "audit" => {
            "SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='employee.rrn_record'"
        }
        _ => "SELECT count(*) FROM employee_rrn WHERE org_id=$1",
    };
    sqlx::query_scalar(sql)
        .bind(org.as_uuid())
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn record_rate_uses_the_configured_rolling_hour_before_sealing(pool: PgPool) {
    let mut f = fixture(&pool).await;
    let [id, other] = f.ids;
    let org = f.principal.org_id;
    sqlx::query("INSERT INTO tenant_setting_overrides(org_id,key,value,set_by,reason_code) VALUES($1,'privacy.reveal_rate_per_hour','5',$2,'TEST')")
        .bind(org.as_uuid()).bind(f.principal.user_id.as_uuid()).execute(&pool).await.unwrap();
    // Reveal events, another actor's records and old records do not spend this actor's record budget.
    sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,after_snap,trace_id,span_id,occurred_at,created_at) SELECT $1,$2,'employee.rrn_record','employee',$3,'{}',repeat('0',32),repeat('0',16),now(),now()-interval '61 minutes' FROM generate_series(1,5)")
        .bind(org.as_uuid()).bind(f.principal.user_id.as_uuid()).bind(id.to_string()).execute(&pool).await.unwrap();
    let other_actor = seed_active_user(&pool, *org.as_uuid(), "MEMBER", "other-actor").await;
    for (actor, action) in [
        (*f.principal.user_id.as_uuid(), "employee.rrn_reveal"),
        (*other_actor.as_uuid(), "employee.rrn_record"),
    ] {
        sqlx::query("INSERT INTO audit_events(org_id,actor,action,target_type,target_id,after_snap,trace_id,span_id,occurred_at) SELECT $1,$2,$3,'employee',$4,'{}',repeat('0',32),repeat('0',16),now() FROM generate_series(1,5)")
            .bind(org.as_uuid()).bind(actor).bind(action).bind(id.to_string()).execute(&pool).await.unwrap();
    }
    let valid = body(&pool, &mut f, id).await;
    assert_eq!(put(app(&f, true), id, valid).await.0, StatusCode::CREATED);
    // Conflicts are logged attempts too, so blind-index probes also spend the budget.
    for _ in 1..5 {
        let valid = body(&pool, &mut f, other).await;
        refusal(app(&f, true), other, valid, 409, "rrn_in_use").await;
    }
    let before = count(&pool, "audit", org).await;
    let sealed = f.vault.0.load(Ordering::SeqCst);
    let valid = body(&pool, &mut f, other).await;
    refusal(app(&f, true), other, valid, 429, "rrn_record_rate_limited").await;
    assert_eq!(count(&pool, "audit", org).await, before);
    assert_eq!(count(&pool, "rrn", org).await, 1);
    assert_eq!(f.vault.0.load(Ordering::SeqCst), sealed);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_principals_wait_for_the_form_writer_lock_then_recheck_claims(pool: PgPool) {
    let mut f = fixture(&pool).await;
    let [id, other] = f.ids;
    let one = body(&pool, &mut f, id).await;
    let a = app(&f, true);
    directory_actor(&pool, &mut f).await;
    let two = body(&pool, &mut f, other).await;
    let b = app(&f, true);
    let mut blocker = pool.begin().await.unwrap();
    let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
        .fetch_one(blocker.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(format!("employee_rrn:{}", f.principal.org_id))
        .execute(blocker.as_mut())
        .await
        .unwrap();
    let a = tokio::spawn(put(a, id, one));
    let b = tokio::spawn(put(b, other, two));
    timeout(Duration::from_secs(10), async {
        loop {
            let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND $1=ANY(pg_blocking_pids(pid))")
                .bind(pid).fetch_one(&pool).await.unwrap();
            if waiting == 2 { break; }
            assert!(!a.is_finished() && !b.is_finished(), "both write transactions must wait on the shared lock");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("two principals must overlap at the writer lock");
    assert_eq!(count(&pool, "audit", f.principal.org_id).await, 2);
    assert_eq!(count(&pool, "rrn", f.principal.org_id).await, 0);
    blocker.commit().await.unwrap();
    let (a, b) = (a.await.unwrap(), b.await.unwrap());
    let mut statuses = [a.0.as_u16(), b.0.as_u16()];
    statuses.sort();
    assert_eq!(statuses, [201, 409]);
    let conflict = if a.0 == StatusCode::CONFLICT {
        a.1
    } else {
        b.1
    };
    assert_eq!(conflict["error"]["code"], "rrn_in_use");
    assert_eq!(count(&pool, "rrn", f.principal.org_id).await, 1);
}

struct PausingVault {
    vault: Arc<Vault>,
    reached: Mutex<Option<oneshot::Sender<()>>>,
    resume: Mutex<mpsc::Receiver<()>>,
}
impl RrnVault for PausingVault {
    fn seal(&self, org: Uuid, rrn: &Rrn) -> Result<SealedRrn, VaultError> {
        self.reached
            .lock()
            .unwrap()
            .take()
            .unwrap()
            .send(())
            .unwrap();
        self.resume
            .lock()
            .unwrap()
            .recv_timeout(Duration::from_secs(10))
            .unwrap();
        self.vault.seal(org, rrn)
    }
    fn blind_index(&self, rrn: &Rrn) -> Vec<u8> {
        self.vault.blind_index(rrn)
    }
    fn open(&self, _: Uuid, _: &SealedRrn) -> Result<Rrn, VaultError> {
        Err(VaultError)
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn permission_revoked_after_audit_commit_refuses_the_write(pool: PgPool) {
    let mut f = fixture(&pool).await;
    directory_actor(&pool, &mut f).await;
    let id = f.ids[0];
    let valid = body(&pool, &mut f, id).await;
    let (reached, waiting) = oneshot::channel();
    let (resume, paused) = mpsc::channel();
    let vault = Arc::new(PausingVault {
        vault: f.vault.clone(),
        reached: Mutex::new(Some(reached)),
        resume: Mutex::new(paused),
    });
    let app = router(f.hr.clone(), Some(vault), Some(passkey_service()))
        .layer(Extension(f.principal.clone()));
    // seal is synchronous; its pause must not block the test's async executor.
    let runtime = tokio::runtime::Handle::current();
    let task = tokio::task::spawn_blocking(move || runtime.block_on(put(app, id, valid)));
    timeout(Duration::from_secs(10), waiting)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(count(&pool, "audit", f.principal.org_id).await, 1);
    sqlx::query("UPDATE access_grants SET status='REVOKED',revoked_by=$2,revoked_at=now() WHERE org_id=$1 AND account_id=$2")
        .bind(f.principal.org_id.as_uuid()).bind(f.principal.user_id.as_uuid()).execute(&pool).await.unwrap();
    resume.send(()).unwrap();
    let (status, body) = task.await.unwrap();
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "forbidden");
    assert_eq!(count(&pool, "rrn", f.principal.org_id).await, 0);
}
