//! 근무조: dated rosters that cross 부서 within one 사업장.

use console_attendance_application::CallerScope;
use console_attendance_application::calendar::{CrewInput, CrewMember, CrewMembersInput, CrewRead};
use console_attendance_application::schedule::{Items, LayerSummary};
use console_attendance_domain::schedule::Level;
use console_kernel_core::OrgId;
use console_platform_db::{with_audits, with_org_conn};
use serde_json::json;
use sqlx::{Postgres, Row, Transaction};
use time::Date;
use uuid::Uuid;

use super::org::{load_org, load_roster};
use super::preview::authorize_scope;
use super::universe::{Universe, today_kst};
use super::{ScheduleStoreError, audit, claim_key, codes, fingerprint};
use crate::PgAttendanceStore;

const MEMBERS_SQL: &str = "SELECT m.crew_id, m.employee_id, e.employee_number, e.name, m.valid_from, m.valid_to \
     FROM attendance_crew_members m JOIN employees e ON e.id = m.employee_id AND e.org_id = m.org_id \
     WHERE m.valid_from <= $1 AND (m.valid_to IS NULL OR m.valid_to > $1) ORDER BY e.employee_number NULLS LAST, e.name";

async fn crews(
    tx: &mut Transaction<'_, Postgres>,
    u: &Universe,
    date: Date,
    only: impl Fn(Uuid, Uuid) -> bool,
) -> Result<Vec<CrewRead>, ScheduleStoreError> {
    let members = sqlx::query(MEMBERS_SQL)
        .bind(date)
        .fetch_all(tx.as_mut())
        .await?;
    let rows = sqlx::query("SELECT id, workplace_id, name, status FROM attendance_crews WHERE status = 'ACTIVE' ORDER BY name").fetch_all(tx.as_mut()).await?;
    let mut out = Vec::new();
    for r in rows {
        let (id, workplace_id): (Uuid, Uuid) = (r.try_get("id")?, r.try_get("workplace_id")?);
        if !only(id, workplace_id) {
            continue;
        }
        let mine = members
            .iter()
            .filter(|m| m.try_get::<Uuid, _>("crew_id").is_ok_and(|c| c == id));
        let layer = u
            .layers
            .iter()
            .filter(|l| l.level == Level::Crew && l.scope_id == id && l.to.is_none_or(|t| t > date))
            .max_by_key(|l| (l.from <= date, l.from, l.version))
            .map(|l| LayerSummary {
                layer_id: l.id,
                pattern_id: l.pattern_id,
                pattern_name: u
                    .patterns
                    .get(&l.pattern_id)
                    .map(|p| p.name.clone())
                    .unwrap_or_default(),
                effective_from: l.from,
                effective_to: l.to,
                version: l.version,
            });
        out.push(CrewRead {
            id,
            workplace_id,
            workplace_name: u
                .org
                .workplaces
                .get(&workplace_id)
                .map(|w| w.name.clone())
                .unwrap_or_default(),
            name: r.try_get("name")?,
            status: r.try_get("status")?,
            members: mine
                .map(|m| {
                    Ok(CrewMember {
                        employee_id: m.try_get("employee_id")?,
                        employee_number: m.try_get("employee_number")?,
                        name: m.try_get("name")?,
                        valid_from: m.try_get("valid_from")?,
                        valid_to: m.try_get("valid_to")?,
                    })
                })
                .collect::<Result<_, ScheduleStoreError>>()?,
            layer,
        });
    }
    Ok(out)
}

impl PgAttendanceStore {
    pub async fn list_crews(
        &self,
        caller: &CallerScope,
        workplace: Option<Uuid>,
        date: Option<Date>,
    ) -> Result<Items<CrewRead>, ScheduleStoreError> {
        let caller = caller.clone();
        with_org_conn::<_, _, ScheduleStoreError>(
            &self.pool,
            OrgId::from_uuid(caller.org_id),
            move |tx| {
                Box::pin(async move {
                    let date = date.unwrap_or_else(today_kst);
                    let org = load_org(tx).await?;
                    let u = Universe::load(tx, org, (date.year(), date.year())).await?;
                    let seen = |w: Uuid| {
                        caller.org_wide
                            || caller
                                .permits_branch(u.org.workplaces.get(&w).and_then(|x| x.branch_id))
                    };
                    let items = crews(tx, &u, date, |_, w| {
                        workplace.is_none_or(|x| x == w) && seen(w)
                    })
                    .await?;
                    Ok(Items { items })
                })
            },
        )
        .await
    }

    pub async fn create_crew(
        &self,
        caller: &CallerScope,
        key: &str,
        input: CrewInput,
    ) -> Result<(CrewRead, bool), ScheduleStoreError> {
        let name = input.name.trim().to_owned();
        if name.is_empty() || name.chars().count() > 40 {
            return Err(ScheduleStoreError::Invalid(codes::CREW_NAME_INVALID));
        }
        let print = fingerprint(&json!([input.workplace_id, name]));
        let (caller, key) = (caller.clone(), key.to_owned());
        with_audits::<_, _, ScheduleStoreError>(&self.pool, OrgId::from_uuid(caller.org_id), move |tx| {
            Box::pin(async move {
                let key = claim_key(tx, &caller, &key).await?;
                let org = load_org(tx).await?;
                let today = today_kst();
                let u = Universe::load(tx, org, (today.year(), today.year())).await?;
                authorize_scope(&caller, &u, &[], Level::Workplace, input.workplace_id)?;
                let prior: Option<(Uuid, String)> = sqlx::query_as("SELECT id, request_fingerprint FROM attendance_crews WHERE idempotency_key = $1")
                    .bind(&key).fetch_optional(tx.as_mut()).await?;
                let (id, fresh) = match prior {
                    Some((_, f)) if f != print => return Err(ScheduleStoreError::Conflict(codes::IDEMPOTENCY_KEY_REUSED)),
                    Some((id, _)) => (id, false),
                    None => {
                        let taken: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM attendance_crews WHERE status = 'ACTIVE' AND workplace_id = $1 AND lower(btrim(name)) = lower($2))")
                            .bind(input.workplace_id).bind(&name).fetch_one(tx.as_mut()).await?;
                        if taken {
                            return Err(ScheduleStoreError::Conflict(codes::CREW_NAME_TAKEN));
                        }
                        let id = Uuid::new_v4();
                        sqlx::query("INSERT INTO attendance_crews (id, org_id, workplace_id, name, created_by, idempotency_key, request_fingerprint) VALUES ($1, $2, $3, $4, $5, $6, $7)")
                            .bind(id).bind(caller.org_id).bind(input.workplace_id).bind(&name).bind(caller.user_id).bind(&key).bind(&print)
                            .execute(tx.as_mut()).await?;
                        (id, true)
                    }
                };
                let events = if fresh { vec![audit(&caller, "attendance.crew.create", "attendance_crew", id, json!({"name": name}))?] } else { vec![] };
                let read = crews(tx, &u, today, |c, _| c == id).await?.pop().ok_or(ScheduleStoreError::NotFound(codes::CREW_NOT_FOUND))?;
                Ok(((read, fresh), events))
            })
        })
        .await
    }

    pub async fn place_crew_members(
        &self,
        caller: &CallerScope,
        crew: Uuid,
        key: &str,
        input: CrewMembersInput,
    ) -> Result<CrewRead, ScheduleStoreError> {
        if input.employee_ids.is_empty() || input.employee_ids.len() > 500 {
            return Err(ScheduleStoreError::Invalid(codes::CREW_MEMBERS_INVALID));
        }
        let (caller, key) = (caller.clone(), key.to_owned());
        with_audits::<_, _, ScheduleStoreError>(&self.pool, OrgId::from_uuid(caller.org_id), move |tx| {
            Box::pin(async move {
                claim_key(tx, &caller, &key).await?;
                let org = load_org(tx).await?;
                let from = input.valid_from;
                let u = Universe::load(tx, org, (from.year(), from.year())).await?;
                let workplace = u.org.crews.get(&crew).map(|(w, _)| *w).ok_or(ScheduleStoreError::NotFound(codes::CREW_NOT_FOUND))?;
                authorize_scope(&caller, &u, &[], Level::Workplace, workplace)?;
                let roster = load_roster(tx, from, None).await?;
                let mut events = Vec::new();
                for e in &input.employee_ids {
                    if !roster.iter().any(|p| p.id == *e && p.workplace_id == Some(workplace)) {
                        return Err(ScheduleStoreError::Invalid(codes::EMPLOYEE_NOT_IN_WORKPLACE));
                    }
                    let current: Option<Uuid> = sqlx::query_scalar("SELECT crew_id FROM attendance_crew_members WHERE employee_id = $1 AND valid_from <= $2 AND (valid_to IS NULL OR valid_to > $2)")
                        .bind(e).bind(from).fetch_optional(tx.as_mut()).await?;
                    if current == Some(crew) {
                        continue;
                    }
                    let later: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM attendance_crew_members WHERE employee_id = $1 AND valid_from >= $2)")
                        .bind(e).bind(from).fetch_one(tx.as_mut()).await?;
                    if later {
                        return Err(ScheduleStoreError::Conflict(codes::CREW_MEMBERSHIP_OVERLAP));
                    }
                    sqlx::query("UPDATE attendance_crew_members SET valid_to = $2 WHERE employee_id = $1 AND valid_from < $2 AND (valid_to IS NULL OR valid_to > $2)")
                        .bind(e).bind(from).execute(tx.as_mut()).await?;
                    let id = Uuid::new_v4();
                    sqlx::query("INSERT INTO attendance_crew_members (id, org_id, crew_id, employee_id, valid_from, created_by) VALUES ($1, $2, $3, $4, $5, $6)")
                        .bind(id).bind(caller.org_id).bind(crew).bind(e).bind(from).bind(caller.user_id).execute(tx.as_mut()).await?;
                    events.push(audit(&caller, "attendance.crew.members", "attendance_crew", crew, json!({"employee_id": e, "valid_from": from.to_string()}))?);
                }
                let read = crews(tx, &u, from.max(today_kst()), |c, _| c == crew).await?.pop().ok_or(ScheduleStoreError::NotFound(codes::CREW_NOT_FOUND))?;
                Ok((read, events))
            })
        })
        .await
    }
}
