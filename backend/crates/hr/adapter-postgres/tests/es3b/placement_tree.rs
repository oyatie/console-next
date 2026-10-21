//! UX-R1 PLACEMENT (regression: move-01, move-02): a 부서 has no placement of
//! its own; its 사업장 and 법인 are its nearest placed ancestor's (the
//! 사업장's SITE unit). A 전보 into a 부서 under another 사업장 is a 전근; one
//! under another 법인 is refused (a 전적), whatever the depth of the 부서.

use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use super::*;

// The fixture helpers are TR-33's (`cross_entity.rs`): `department_under`
// draws the SITE unit and a 부서 with no placement of its own, `department`
// one more level under it, `written` what a refused write must leave alone.
impl Fixture {
    async fn org_unit(&self) -> Option<Uuid> {
        sqlx::query_scalar("SELECT org_unit_id FROM employees WHERE id = $1")
            .bind(self.employee)
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }

    /// `(부서, 팀)`: a 부서 under `workplace`'s SITE unit and a 팀 under it.
    async fn department_and_team(&self, entity: Uuid, workplace: Uuid) -> (Uuid, Uuid) {
        let (_, dept) = self.department_under(entity, workplace, "생산팀").await;
        (dept, self.department(dept, "조립파트").await)
    }

    async fn route_branches(&self, workplaces: &[Uuid]) -> Vec<Uuid> {
        let region = Uuid::new_v4();
        let branches: Vec<_> = workplaces.iter().map(|_| Uuid::new_v4()).collect();
        let mut sql = format!(
            "INSERT INTO regions (id, org_id, name) VALUES ('{region}', '{}', 'R');",
            self.org
        );
        for (workplace, branch) in workplaces.iter().zip(&branches) {
            sql.push_str(&format!("INSERT INTO branches (id, org_id, region_id, name) VALUES ('{branch}', '{}', '{region}', '{branch}'); UPDATE workplaces SET default_branch_id = '{branch}' WHERE id = '{workplace}';", self.org));
        }
        sql.push_str(&format!(
            "UPDATE employees SET home_branch_id = '{}' WHERE id = '{}';",
            branches[0], self.employee
        ));
        seed(&self.owner, self.org, sql).await;
        branches
    }

    async fn home_branch(&self) -> Uuid {
        sqlx::query_scalar("SELECT home_branch_id FROM employees WHERE id = $1")
            .bind(self.employee)
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_transfer_into_a_department_of_another_workplace_is_a_move(pool: PgPool) {
    // move-02: the 사업장 stayed 본사 after a 전보 into 평택공장 › 생산팀.
    let f = fixture(pool, true).await;
    let (entity, w) = f.entity(2).await;
    f.place(entity, w[0]).await;
    let branches = f.route_branches(&w).await;
    let (_, team) = f.department_and_team(entity, w[1]).await;
    let on = day(-3);
    let moved = f
        .record(event("TRANSFER", &on, json!({"to_org_unit_id": team})))
        .await
        .unwrap();
    assert_eq!(moved["to_workplace_id"], json!(w[1]));
    assert_eq!(f.org_unit().await, Some(team));
    assert_eq!(f.home_branch().await, branches[1]);
    assert_eq!(
        f.live().await,
        [
            (
                HIRE.to_owned(),
                Some(on.clone()),
                Some(w[0]),
                "HIRE".to_owned()
            ),
            (on.clone(), None, Some(w[1]), "TRANSFER".to_owned()),
        ]
    );
    // Rescinding the 전보 takes them back, with one row at the first 사업장.
    f.rescind(&moved).await;
    assert_eq!(f.home_branch().await, branches[0]);
    assert_eq!(
        f.live().await,
        [(HIRE.to_owned(), None, Some(w[0]), "HIRE".to_owned())]
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_transfer_into_a_department_of_another_entity_is_refused(pool: PgPool) {
    // move-01: the record claimed 법인 A while its 부서 was 법인 B's.
    let f = fixture(pool, true).await;
    let (a, wa) = f.entity(1).await;
    let (b, wb) = f.entity(1).await;
    f.place(a, wa[0]).await;
    let (dept, team) = f.department_and_team(b, wb[0]).await;
    let before = (f.live().await, f.written().await);
    for (unit, on) in [(dept, day(-1)), (team, day(0)), (team, day(7))] {
        let refused = f
            .record(event("TRANSFER", &on, json!({"to_org_unit_id": unit})))
            .await
            .unwrap_err();
        // TR-33's code on trunk (one code for a 전보 across 법인).
        assert_eq!(refused, (422, "transfer_cross_entity".to_owned()));
    }
    // Nothing is written: no assignment, no unit change, no event, no audit row.
    assert_eq!((f.live().await, f.written().await), before);
}
