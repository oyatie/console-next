// SPDX-License-Identifier: LicenseRef-Proprietary
//! Dated membership changes share the payroll freeze lock with period writers and attendance close.
use super::{PgPayrollError, PgPayrollStore, RlsPayGroupFacts, event};
use console_kernel_core::{KernelError, OrgId, UserId};
use console_platform_authz::{Feature, cedar_pbac::visible::load_facts};
use console_platform_db::{PeriodLockDomain, lock_period_lock_key, with_audit};
use serde::{Deserialize, Serialize};
use sqlx::{Postgres, Transaction};
use time::Date;
use uuid::Uuid;

time::serde::format_description!(date, Date, "[year]-[month]-[day]");

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MembershipSearch {
    pub pay_group_id: Uuid,
    #[serde(with = "date")]
    pub effective_from: Date,
    pub q: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AssignMembership {
    pub pay_group_id: Uuid,
    pub employee_id: Uuid,
    #[serde(with = "date")]
    pub effective_from: Date,
    /// A stale choice must not overwrite a concurrent move. The UI sends null for an unassigned person.
    #[serde(deserialize_with = "explicit_group")]
    pub expected_pay_group_id: Option<Uuid>,
}

fn explicit_group<'de, D: serde::Deserializer<'de>>(value: D) -> Result<Option<Uuid>, D::Error> {
    Option::deserialize(value)
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct MembershipCandidate {
    pub employee_id: Uuid,
    pub name: String,
    pub employee_number: Option<String>,
    pub current_pay_group_id: Option<Uuid>,
}

async fn accessible_groups(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    target: Uuid,
) -> Result<Vec<Uuid>, PgPayrollError> {
    let groups = load_facts(tx, org, *actor.as_uuid())
        .await?
        .visible_pay_groups(tx, Feature::PayrollRunManage, &RlsPayGroupFacts)
        .await?;
    if !groups.contains(&target) {
        return Err(
            KernelError::forbidden("pay group is outside payroll management access").into(),
        );
    }
    Ok(groups)
}

// Share the dated employment and source-group authorization predicates between selection and write.
const CANDIDATES: &str = "SELECT e.id AS employee_id, person.name,
  e.employee_number, m.pay_group_id AS current_pay_group_id
  FROM employees e JOIN person_employees_current person ON person.org_id=e.org_id AND person.id=e.id
  JOIN pay_groups g ON g.org_id=e.org_id AND g.id=$2
  LEFT JOIN employee_pay_group_assignments m ON m.org_id=e.org_id AND m.employee_id=e.id AND m.superseded_at IS NULL
    AND m.effective_from<=$3 AND (m.effective_to_exclusive IS NULL OR m.effective_to_exclusive>$3)
  WHERE e.org_id=$1 AND e.merged_into_employee_id IS NULL AND e.employment_status <> 'VOIDED'
    AND NOT (e.employment_status='EXITED' AND e.exit_on IS NULL)
    AND (e.hire_on IS NULL OR e.hire_on<=$3) AND (e.exit_on IS NULL OR e.exit_on>=$3)
    AND EXISTS (SELECT 1 FROM employment_assignments a WHERE a.org_id=e.org_id AND a.employee_id=e.id
      AND a.legal_entity_id=g.legal_entity_id AND a.superseded_at IS NULL AND a.valid_from<=$3 AND (a.valid_to IS NULL OR a.valid_to>$3))
    AND (m.pay_group_id IS NULL OR m.pay_group_id=ANY($4))";

impl PgPayrollStore {
    pub async fn membership_candidates(
        &self,
        org: OrgId,
        actor: UserId,
        input: MembershipSearch,
    ) -> Result<Vec<MembershipCandidate>, PgPayrollError> {
        let audit = event(
            org,
            actor,
            "payroll.pay_group_member_search",
            input.pay_group_id,
        )?;
        with_audit(&self.pool, audit, move |tx| Box::pin(async move {
            let groups = accessible_groups(tx, org, actor, input.pay_group_id).await?;
            let q = input.q.trim();
            if !(1..=100).contains(&q.chars().count()) {
                return Err(KernelError::validation("enter a name or employee number").with_field("q").into());
            }
            let sql = format!("SELECT * FROM ({CANDIDATES}) c WHERE strpos(lower(c.name),lower($5))>0 OR c.employee_number=$5
                ORDER BY c.employee_number=$5 DESC NULLS LAST,c.name,c.employee_id LIMIT 30");
            Ok(sqlx::query_as(sqlx::AssertSqlSafe(sql.as_str())).bind(org.as_uuid()).bind(input.pay_group_id)
                .bind(input.effective_from).bind(groups).bind(q).fetch_all(tx.as_mut()).await?)
        })).await
    }

    pub async fn assign_membership(
        &self,
        org: OrgId,
        actor: UserId,
        input: AssignMembership,
    ) -> Result<(), PgPayrollError> {
        let audit = event(
            org,
            actor,
            "payroll.pay_group_member_assign",
            input.pay_group_id,
        )?;
        with_audit(&self.pool, audit, move |tx| {
            Box::pin(async move {
                lock_period_lock_key(tx, PeriodLockDomain::Payroll, *org.as_uuid()).await?;
                let groups = accessible_groups(tx, org, actor, input.pay_group_id).await?;
                assign_in_tx(tx, org, actor, &groups, &input, true).await
            })
        })
        .await
    }
}

pub(super) async fn assign_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    groups: &[Uuid],
    input: &AssignMembership,
    check_expected: bool,
) -> Result<(), PgPayrollError> {
    let AssignMembership {
        pay_group_id: target,
        employee_id: employee,
        effective_from: date,
        expected_pay_group_id,
    } = *input;
    let sql = format!("SELECT current_pay_group_id FROM ({CANDIDATES}) c WHERE employee_id=$5");
    let source: Option<Uuid> = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.as_str()))
        .bind(org.as_uuid())
        .bind(target)
        .bind(date)
        .bind(groups)
        .bind(employee)
        .fetch_optional(tx.as_mut())
        .await?
        .ok_or_else(|| {
            KernelError::validation("employee is unavailable for this legal entity and date")
                .with_field("employee_id")
        })?;
    if source == Some(target) {
        return Ok(());
    }
    if check_expected && source != expected_pay_group_id {
        return Err(KernelError::conflict(
            "pay group membership changed; select the employee again",
        )
        .with_code("membership_changed")
        .into());
    }
    let end: Option<Date> = sqlx::query_scalar("SELECT min(boundary) FROM (
        SELECT min(effective_from) AS boundary FROM employee_pay_group_assignments WHERE org_id=$1 AND employee_id=$2 AND superseded_at IS NULL AND effective_from>$3
        UNION ALL SELECT effective_to_exclusive FROM employee_pay_group_assignments WHERE org_id=$1 AND employee_id=$2 AND superseded_at IS NULL
        AND effective_from<=$3 AND effective_to_exclusive>$3) dates").bind(org.as_uuid()).bind(employee).bind(date).fetch_one(tx.as_mut()).await?;
    let affected = [Some(target), source];
    let frozen: bool = sqlx::query_scalar("SELECT EXISTS(
        SELECT 1 FROM period_locks pl WHERE org_id=$1 AND domain='payroll' AND period_lock_effective(pl)
            AND (pay_group_id IS NULL OR pay_group_id=ANY($4)) AND period_end>=$2 AND ($3::date IS NULL OR period_start<$3)
        UNION ALL SELECT 1 FROM payroll_draft_runs r WHERE r.org_id=$1 AND r.kind='REGULAR'
            AND r.status NOT IN ('STAGED','BLOCKED_LEGAL_GATE','READY_FOR_REVIEW','VOID')
            AND r.period_end>=$2 AND ($3::date IS NULL OR r.period_start<$3)
            AND (r.pay_group_id=ANY($4) OR EXISTS (
                SELECT 1 FROM payroll_draft_lines line
                JOIN pay_groups paid ON paid.org_id=line.org_id AND paid.id=r.pay_group_id
                JOIN pay_groups target ON target.org_id=paid.org_id AND target.id=$6
                    AND target.legal_entity_id=paid.legal_entity_id
                WHERE line.org_id=r.org_id AND line.run_id=r.id AND line.employee_id=$5
                    AND line.calculation_status<>'VOID')))")
        .bind(org.as_uuid()).bind(date).bind(end).bind(&affected[..]).bind(employee).bind(target).fetch_one(tx.as_mut()).await?;
    if frozen {
        return Err(KernelError::conflict(
            "the membership overlaps a frozen payroll period or closed run",
        )
        .with_code("pay_group_membership_frozen")
        .into());
    }
    sqlx::query("UPDATE employee_pay_group_assignments SET
        superseded_at=CASE WHEN effective_from=$3 THEN now() END,
        effective_to_exclusive=CASE WHEN effective_from<$3 THEN $3 ELSE effective_to_exclusive END
        WHERE org_id=$1 AND employee_id=$2 AND superseded_at IS NULL AND effective_from<=$3 AND (effective_to_exclusive IS NULL OR effective_to_exclusive>$3)")
        .bind(org.as_uuid()).bind(employee).bind(date).execute(tx.as_mut()).await?;
    sqlx::query("INSERT INTO employee_pay_group_assignments(org_id,employee_id,pay_group_id,effective_from,effective_to_exclusive,created_by)
        VALUES($1,$2,$3,$4,$5,$6)").bind(org.as_uuid()).bind(employee).bind(target).bind(date).bind(end).bind(actor.as_uuid()).execute(tx.as_mut()).await?;
    Ok(())
}
