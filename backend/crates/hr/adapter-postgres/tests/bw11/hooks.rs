//! C8: the apply function runs EXIT's hooks around the employee write, in the
//! same transaction, and a refusing `before_apply` leaves the employee as it was.

use std::sync::{Arc, Mutex};

use console_hr_adapter_postgres::HrError;
use console_hr_adapter_postgres::lifecycle::normalize::normalize_lifecycle_transition;
use console_hr_adapter_postgres::lifecycle::prepare::prepare_lifecycle_event;
use console_hr_adapter_postgres::lifecycle::record::apply_lifecycle_head;
use console_hr_application::lifecycle::hooks::{LifecycleApplyEvent, LifecycleApplyHooks};
use console_kernel_core::KernelError;
use console_platform_db::with_org_conn;
use serde_json::json;
use sqlx::{PgConnection, PgPool};
use time::macros::date;
use uuid::Uuid;

use crate::{fixture, promote};

#[derive(Default)]
struct Recording {
    calls: Mutex<Vec<String>>,
    refuse: bool,
}

async fn position(tx: &mut PgConnection, employee: Uuid) -> String {
    sqlx::query_scalar("SELECT position FROM employees WHERE id = $1")
        .bind(employee)
        .fetch_one(tx)
        .await
        .unwrap()
}

impl LifecycleApplyHooks<PgConnection> for Recording {
    async fn before_apply(
        &self,
        tx: &mut PgConnection,
        event: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        let seen = position(tx, event.employee_id).await;
        self.calls.lock().unwrap().push(format!(
            "before {} {} {seen}",
            event.event_type, event.effective_date
        ));
        if self.refuse {
            return Err(KernelError::conflict("the hook refuses"));
        }
        Ok(())
    }

    async fn after_apply(
        &self,
        tx: &mut PgConnection,
        event: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        let seen = position(tx, event.employee_id).await;
        self.calls.lock().unwrap().push(format!("after {seen}"));
        Ok(())
    }

    async fn on_rescind(
        &self,
        _tx: &mut PgConnection,
        _event: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        self.calls.lock().unwrap().push("rescind".to_owned());
        Ok(())
    }
}

async fn apply_promote(pool: &PgPool, refuse: bool) -> (Vec<String>, String, bool) {
    let f = fixture(pool.clone()).await;
    let hooks = Arc::new(Recording {
        refuse,
        ..Recording::default()
    });
    let (org, employee) = (f.principal.org_id, f.employee);
    let user = *f.principal.user_id.as_uuid();
    let transition =
        normalize_lifecycle_transition(promote("과장", "2026-02-01", json!({}))).unwrap();
    let held = Arc::clone(&hooks);
    let applied = with_org_conn::<_, _, HrError>(&f.owner, org, move |tx| {
        Box::pin(async move {
            let prepared = prepare_lifecycle_event(
                tx,
                *org.as_uuid(),
                employee,
                transition,
                date!(2026 - 10 - 04),
            )
            .await?;
            apply_lifecycle_head(
                tx,
                held.as_ref(),
                *org.as_uuid(),
                Uuid::new_v4(),
                user,
                employee,
                &prepared.transition,
                &prepared.target,
            )
            .await
        })
    })
    .await;
    let mut conn = f.owner.acquire().await.unwrap();
    let after = position(&mut conn, employee).await;
    let calls = hooks.calls.lock().unwrap().clone();
    (calls, after, applied.is_ok())
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_hooks_run_before_and_after_the_employee_write(pool: PgPool) {
    let (calls, after, ok) = apply_promote(&pool, false).await;
    assert!(ok);
    assert_eq!(calls, ["before PROMOTE 2026-02-01 사원", "after 과장"]);
    assert_eq!(after, "과장");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_refusing_before_apply_rolls_the_event_back(pool: PgPool) {
    let (calls, after, ok) = apply_promote(&pool, true).await;
    assert!(!ok);
    assert_eq!(calls, ["before PROMOTE 2026-02-01 사원"]);
    assert_eq!(after, "사원");
}
