//! One tenant for the AX-5 suite, built through the real router: the ops
//! account (a SUPER_ADMIN title + the ops flag, as the first account is),
//! 법인 A (본사 · 인사부 · 총무부) and 법인 B (물류센터 · 영업부), three people —
//! a1 placed in A (인사부), a2 unplaced (총무부, no 법인/사업장 assignment and
//! no home branch: the imported-row shape of governance-01), b1 placed in B — and HR accounts with
//! no legacy role, each granted 인사 실무 over one scope node.
#![allow(dead_code)]

use console_kernel_core::FixedClock;
use console_kernel_core::OrgId;
use console_kernel_core::kr::synthetic;
use console_platform_test_support::soft_passkey::SoftKey;
use http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::go_live::go_live;
use crate::support::{Ctx, add_user, address, ctx, employee_body, entity_body, structure};

pub struct World {
    pub pool: PgPool,
    pub org: Uuid,
    pub ops: Ctx,
    key: SoftKey,
    pub le_a: String,
    pub le_b: String,
    pub dept_x: String,
    pub dept_y: String,
    pub dept_b: String,
    pub branch_a: String,
    pub branch_b: String,
    pub a1: String,
    pub a2: String,
    pub b1: String,
    role: Value,
}

pub const ADMIN: &[&str] = &["SUPER_ADMIN"];

fn id(v: &Value, at: &str) -> String {
    v.pointer(at)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("no {at} in {v}"))
        .to_owned()
}

impl World {
    pub async fn ok(&self, method: &str, uri: &str, body: Value) -> Value {
        let (status, out) = self.ops.call(method, uri, Some(body)).await;
        assert!(status.is_success(), "{method} {uri}: {status} {out}");
        out
    }

    async fn dept(&self, name: &str, workplace: &str) -> String {
        let body = json!({ "kind": "DEPARTMENT", "name": name, "workplace_id": workplace });
        id(
            &self.ok("POST", "/api/v1/org-structure/units", body).await,
            "/id",
        )
    }

    /// Register one person in `unit`; placed in (`le`, `wp`) when given.
    pub async fn person(
        &self,
        n: &str,
        branch: &str,
        unit: &str,
        at: Option<(&str, &str)>,
    ) -> String {
        let made = self
            .ok("POST", "/api/v1/employees", employee_body(n, branch, unit))
            .await;
        let emp = id(&made, "/employee/id");
        if let Some((le, wp)) = at {
            let bind = json!({ "employee_id": emp, "legal_entity_id": le, "workplace_id": wp,
                               "valid_from": "2026-01-02" });
            self.ok("POST", "/api/v1/employment-assignments", bind)
                .await;
        }
        emp
    }

    /// A new account with no legacy role, holding 인사 실무 over one node.
    pub async fn holder(&mut self, kind: &str, node: Option<&str>) -> Ctx {
        let user = add_user(&self.pool, self.org, &[]).await;
        let op = json!({
            "op": "grant", "account_id": user.as_uuid(), "role_id": self.role["id"],
            "scope": { "kind": kind, "node_id": node, "include_descendants": true },
            "effective_in_setup": true,
        });
        let body = json!({ "reason_code": "PROMOTION_OR_REASSIGNMENT", "operations": [op] });
        let preview = self.ok("POST", "/api/v1/access/grants/preview", body).await;
        assert_eq!(preview["refused"], 0, "{preview}");
        let step_up = self.key.step_up(&self.pool).await;
        let apply = json!({ "receipt_id": preview["receipt_id"], "step_up": step_up });
        self.ok("POST", "/api/v1/access/grants/apply", apply).await;
        let mut tx = self.pool.begin().await.unwrap();
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(self.org.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
        let (grant, activates_at): (Uuid, time::OffsetDateTime) = sqlx::query_as(
            "SELECT p.grant_id, p.activates_at FROM user_role_grants_pending p
             JOIN access_grants g ON g.org_id=p.org_id AND g.id=p.grant_id
             WHERE p.org_id=$1 AND g.account_id=$2 AND g.status='PENDING'",
        )
        .bind(self.org)
        .bind(user.as_uuid())
        .fetch_one(tx.as_mut())
        .await
        .unwrap();
        console_platform_access::pending::activate_in_tx(
            &mut tx,
            OrgId::from_uuid(self.org),
            grant,
            &FixedClock(activates_at),
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        ctx(&self.pool, self.org, user, &[], None).await
    }
}

pub async fn world(pool: PgPool) -> World {
    let (org, ops) = crate::support::tenant(&pool, ADMIN).await;
    sqlx::query("UPDATE users SET is_tenant_ops = true WHERE id = $1")
        .bind(ops.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
    let key = SoftKey::enroll(&pool, OrgId::from_uuid(org), ops).await;
    let ops_ctx = ctx(&pool, org, ops, ADMIN, None).await;
    let (le_a, wp_a, branch_a, _) = structure(&ops_ctx).await;
    let (le_b, wp_b, branch_b) = entity_b(&ops_ctx).await;
    let lines = json!([{ "domain": "hr_basic", "levels": ["edit"] },
                       { "domain": "appointment", "levels": ["edit"] }]);
    let (status, role) = ops_ctx
        .call(
            "POST",
            "/api/v1/access/roles",
            Some(json!({ "name_ko": "인사 실무", "lines": lines })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{role}");
    let mut w = World {
        pool,
        org,
        ops: ops_ctx,
        key,
        le_a,
        le_b,
        dept_x: String::new(),
        dept_y: String::new(),
        dept_b: String::new(),
        branch_a,
        branch_b,
        a1: String::new(),
        a2: String::new(),
        b1: String::new(),
        role,
    };
    w.dept_x = w.dept("인사부", &wp_a).await;
    w.dept_y = w.dept("총무부", &wp_a).await;
    w.dept_b = w.dept("영업부", &wp_b).await;
    let (le_a, le_b, ba, bb) = (
        w.le_a.clone(),
        w.le_b.clone(),
        w.branch_a.clone(),
        w.branch_b.clone(),
    );
    w.a1 = w
        .person("A-001", &ba, &w.dept_x.clone(), Some((&le_a, &wp_a)))
        .await;
    w.a2 = w.person("A-002", &ba, &w.dept_y.clone(), None).await;
    // The imported shape (governance-01): no home branch, no assignment
    // (the home branch is command-only; the fixture writes past its guard).
    let mut tx = w.pool.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(&mut *tx)
        .await
        .unwrap();
    sqlx::query("UPDATE employees SET home_branch_id = NULL WHERE id = $1::uuid")
        .bind(&w.a2)
        .execute(&mut *tx)
        .await
        .unwrap();
    // MR-22 places a registration at its 부서's 사업장; an imported row has no such row.
    sqlx::query("DELETE FROM employment_assignments WHERE employee_id = $1::uuid")
        .bind(&w.a2)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    w.b1 = w
        .person("B-001", &bb, &w.dept_b.clone(), Some((&le_b, &wp_b)))
        .await;
    go_live(&w.pool, org).await;
    w
}

/// 법인 B (주식회사 다라) with its 사업자등록 and one 사업장.
async fn entity_b(ops: &Ctx) -> (String, String, String) {
    let mut body = entity_body();
    body["name"] = json!("주식회사 다라");
    body["crn"] = json!("000111-0005671");
    let (status, le) = ops.call("POST", "/api/v1/legal-entities", Some(body)).await;
    assert_eq!(status, StatusCode::CREATED, "{le}");
    let le = id(&le, "/record/id");
    let (status, reg) = ops
        .call("POST", &format!("/api/v1/legal-entities/{le}/registrations"), Some(json!({
            "brn": synthetic::brn(81, 4321), "trade_name": "주식회사 다라", "opened_on": "2021-01-04",
            "business_address": address(), "unit_taxation": false, "tax_office_label": "삼성세무서",
            "tax_type": "01", "business_types": [{ "is_main": true, "sector": "운수업", "item": "물류" }],
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{reg}");
    let (status, wp) = ops
        .call("POST", &format!("/api/v1/legal-entities/{le}/workplaces"), Some(json!({
            "name": "물류센터", "registration_id": reg["record"]["id"], "same_address_as_registration": true,
            "opened_on": "2021-01-04", "is_head_office": true, "kind_code": "HEAD_OFFICE",
            "insurance": { "shortcut": "ALL_ESTABLISHED_NUMBERS_LATER" },
        })))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{wp}");
    (
        le,
        id(&wp, "/record/id"),
        id(&wp, "/record/default_branch_id"),
    )
}
