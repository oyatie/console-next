//! Dated record history, diffed against the state in force on each revision date.
//! Restricted personal fields are omitted unless the caller may write them.
use console_entity_application::{Actor, RevisionEntry};
use console_entity_domain::Refusal;
use console_platform_db::with_org_conn;
use serde_json::{Map, Value};
use sqlx::Row;
use uuid::Uuid;

pub(crate) use crate::history_diff::diff;
use crate::history_diff::{Recorded, predecessor};
use crate::{PgEntityError, PgEntityStore, Tx};

/// Bookkeeping columns: never listed as a change.
const META: &str = "ARRAY['org_id','id','legal_entity_id','registration_id','workplace_id','insurer','version',\
    'command_id','effective_from','change_mode','reason_code','actor_id','payload_digest','settings_snapshot',\
    'created_at','head_office_address_id','business_address_id','address_id','mail_address_id']";

/// One address as display text (road address, then 상세).
const ADDR: &str = "(SELECT a.road_addr_part1 || COALESCE(', ' || a.detail, '') FROM entity_addresses a WHERE a.id = {})";

#[derive(Clone, Copy)]
pub(crate) enum Record {
    Entity,
    Registration,
    Workplace,
}

fn sql(record: Record) -> String {
    let addr = |col: &str| ADDR.replace("{}", col);
    let (table, key, extra) = match record {
        Record::Entity => (
            "legal_entity_revisions",
            "legal_entity_id",
            format!(
                "'head_office_address', {}, \
                 'representatives', CASE WHEN $2 THEN (SELECT jsonb_agg(p.name ORDER BY p.seq) FROM legal_entity_representatives p WHERE p.revision_id = r.id) END, \
                 'directors', CASE WHEN $2 THEN (SELECT jsonb_agg(d.role || ' ' || d.name || COALESCE(' ' || d.appointed_on::text, '') ORDER BY d.seq) \
                                                 FROM legal_entity_directors d WHERE d.revision_id = r.id) END",
                addr("r.head_office_address_id")
            ),
        ),
        Record::Registration => (
            "business_registration_revisions",
            "registration_id",
            format!(
                "'classification_reason', CASE WHEN $2 THEN r.classification_reason END, 'business_address', {}, \
                 'business_types', (SELECT jsonb_agg(t.sector_as_printed || ' / ' || t.item_as_printed || COALESCE(' (' || t.ksic_code || ')', '') ORDER BY t.seq) \
                                    FROM business_registration_business_types t WHERE t.revision_id = r.id), \
                 'co_owners', CASE WHEN $2 THEN (SELECT jsonb_agg(o.name ORDER BY o.seq) FROM business_registration_co_owners o WHERE o.revision_id = r.id) END",
                addr("r.business_address_id")
            ),
        ),
        Record::Workplace => (
            "workplace_revisions",
            "workplace_id",
            format!(
                "'address', {}, 'mail_address', {}, \
                 'representative_name', CASE WHEN $2 THEN r.representative_name END",
                addr("r.address_id"),
                addr("r.mail_address_id")
            ),
        ),
    };
    let skip = match record {
        Record::Registration => format!(
            "AND r.reason_code <> '{}'",
            crate::revision_copy::LEGAL_NAME_DERIVED
        ),
        _ => String::new(),
    };
    let meta = if matches!(record, Record::Registration) {
        format!(
            "{META} || CASE WHEN (SELECT e.biz_kind FROM legal_entities e JOIN business_registrations b ON b.legal_entity_id=e.id WHERE b.id=r.registration_id) = 'INDIVIDUAL' THEN ARRAY[]::text[] ELSE ARRAY['trade_name'] END"
        )
    } else {
        META.to_owned()
    };
    let rows = format!(
        "SELECT '' AS chain, r.version, r.effective_from, r.created_at, r.change_mode, r.reason_code, \
                u.display_name AS actor_name, r.actor_id, \
                (to_jsonb(r) - ({meta})) || jsonb_build_object({extra}) AS state, NULL::jsonb AS before_state \
         FROM {table} r LEFT JOIN person_accounts_current u ON u.id = r.actor_id WHERE r.{key} = $1 {skip} UNION ALL {}",
        ledger(record)
    );
    let combined = match record {
        // 4대보험 relations are dated changes of the 사업장 too: one chain per insurer.
        Record::Workplace => format!(
            "{rows} UNION ALL \
             SELECT i.insurer, i.version, i.effective_from, i.created_at, i.change_mode, i.reason_code, u.display_name, i.actor_id, \
                    (SELECT jsonb_object_agg('insurance.' || i.insurer || '.' || k, v) FROM jsonb_each(to_jsonb(i) - {META}) e(k, v)), NULL \
             FROM workplace_insurance_revisions i LEFT JOIN person_accounts_current u ON u.id = i.actor_id WHERE i.workplace_id = $1 \
             ORDER BY created_at, version"
        ),
        _ => format!("{rows} ORDER BY created_at, version"),
    };
    let target = match record {
        Record::Entity => "legal_entity",
        Record::Registration => "business_registration",
        Record::Workplace => "workplace",
    };
    format!(
        "SELECT h.*,a.actor_kind,a.command_id FROM ({combined}) h LEFT JOIN LATERAL (SELECT actor_kind,command_id FROM audit_events WHERE target_type='{target}' AND target_id=$1::text AND actor=h.actor_id AND created_at=h.created_at AND outcome='ALLOWED' ORDER BY id DESC LIMIT 1) a ON true ORDER BY h.created_at,h.version"
    )
}

/// The ledgered changes of the record (MR-17 identifier corrections, MR-18
/// registration links): each row carries its own before and after.
fn ledger(record: Record) -> String {
    let (cols, table, key) = match record {
        Record::Entity | Record::Registration => (
            "'identifier', 0, (c.created_at AT TIME ZONE 'Asia/Seoul')::date, c.created_at, c.change_mode, c.reason_code, \
             u.display_name, c.actor_id, jsonb_build_object(c.field, c.new_value), jsonb_build_object(c.field, c.old_value)",
            "entity_identifier_corrections",
            if matches!(record, Record::Entity) {
                "c.legal_entity_id = $1 AND c.registration_id IS NULL"
            } else {
                "c.registration_id = $1"
            },
        ),
        Record::Workplace => (
            "'registration', 0, c.effective_from, c.created_at, c.change_mode, c.reason_code, u.display_name, c.actor_id, \
             jsonb_build_object('registration_id', c.to_registration_id, 'sub_serial', c.to_sub_serial), \
             jsonb_build_object('registration_id', c.from_registration_id, 'sub_serial', c.from_sub_serial)",
            "workplace_registration_changes",
            "c.workplace_id = $1",
        ),
    };
    format!(
        "SELECT {cols} FROM {table} c LEFT JOIN person_accounts_current u ON u.id = c.actor_id WHERE {key}"
    )
}

/// Seal the same delta history displays, using only this revision and its dated predecessor.
pub(crate) async fn seal_changed_fields(
    tx: &mut Tx<'_>,
    mut event: console_kernel_core::AuditEvent,
    record: Record,
    version: i32,
) -> Result<console_kernel_core::AuditEvent, PgEntityError> {
    let query = format!(
        "WITH states AS NOT MATERIALIZED ({}) \
         SELECT c.state, (SELECT p.state FROM states p WHERE p.chain=c.chain AND p.version<c.version \
           ORDER BY (p.effective_from<=c.effective_from) DESC, \
             CASE WHEN p.effective_from<=c.effective_from THEN p.effective_from END DESC NULLS LAST, \
             p.created_at DESC,p.version DESC LIMIT 1) AS before_state \
         FROM states c WHERE c.chain='' AND c.version=$3",
        sql(record)
    );
    let id = Uuid::parse_str(&event.target_id).map_err(|e| sqlx::Error::Protocol(e.to_string()))?;
    let row = sqlx::query(sqlx::AssertSqlSafe(query))
        .bind(id)
        .bind(true)
        .bind(version)
        .fetch_one(tx.as_mut())
        .await?;
    let mut after: Value = row.try_get("state")?;
    let mut before: Option<Value> = row.try_get("before_state")?;
    for state in [Some(&mut after), before.as_mut()].into_iter().flatten() {
        if let Some(m) = state.as_object_mut() {
            evidence(m);
        }
    }
    let empty = Map::new();
    let fields: Vec<_> = diff(
        before.as_ref().and_then(Value::as_object).unwrap_or(&empty),
        after.as_object().unwrap_or(&empty),
    )
    .into_iter()
    .map(|change| change.field)
    .collect();
    let snapshot = event
        .after
        .as_mut()
        .and_then(Value::as_object_mut)
        .ok_or_else(|| sqlx::Error::Protocol("revision audit snapshot is not an object".into()))?;
    snapshot.insert("changed_fields".into(), serde_json::json!(fields));
    Ok(event)
}

/// The evidence link is the revision's provenance, never a changed fact.
fn evidence(state: &mut Map<String, Value>) -> Option<Uuid> {
    state
        .remove("evidence_document_id")
        .and_then(|v| v.as_str().and_then(|s| Uuid::parse_str(s).ok()))
}

async fn history(
    tx: &mut Tx<'_>,
    record: Record,
    id: Uuid,
    personal: bool,
) -> Result<Vec<RevisionEntry>, PgEntityError> {
    let (exists_sql, missing) = match record {
        Record::Entity => (
            "SELECT EXISTS (SELECT 1 FROM legal_entities WHERE id = $1)",
            "legal_entity_not_found",
        ),
        Record::Registration => (
            "SELECT EXISTS (SELECT 1 FROM business_registrations WHERE id = $1)",
            "registration_not_found",
        ),
        Record::Workplace => (
            "SELECT EXISTS (SELECT 1 FROM workplaces WHERE id = $1)",
            "workplace_not_found",
        ),
    };
    let exists: bool = sqlx::query_scalar(exists_sql)
        .bind(id)
        .fetch_one(tx.as_mut())
        .await?;
    if !exists {
        return Err(Refusal::not_found(missing).into());
    }
    // Audited: `sql` composes only this module's constants (no input reaches it).
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql(record)))
        .bind(id)
        .bind(personal)
        .fetch_all(tx.as_mut())
        .await?;
    // Per chain, every state recorded so far with the date it holds from.
    let mut seen: std::collections::HashMap<String, Recorded> = Default::default();
    let mut out = Vec::with_capacity(rows.len());
    let mut cited = std::collections::HashSet::new();
    for r in &rows {
        let chain: String = r.try_get("chain")?;
        let effective_from: time::Date = r.try_get("effective_from")?;
        let mut state = match r.try_get::<Value, _>("state")? {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        // Shown where a certificate was recorded, never on a later copy of
        // that row (the N-1 binary's rename copy carries the column forward).
        let evidence_document_id = evidence(&mut state).filter(|d| cited.insert(*d));
        let earlier = seen.entry(chain).or_default();
        let before = match r.try_get::<Option<Value>, _>("before_state")? {
            Some(Value::Object(m)) => m,
            _ => predecessor(earlier, effective_from)
                .cloned()
                .unwrap_or_default(),
        };
        out.push(RevisionEntry {
            version: r.try_get("version")?,
            effective_from,
            recorded_at: r.try_get("created_at")?,
            actor_name: r.try_get("actor_name")?,
            actor_kind: r.try_get("actor_kind")?,
            command_id: r.try_get("command_id")?,
            change_mode: r.try_get("change_mode")?,
            reason_code: r.try_get("reason_code")?,
            changes: diff(&before, &state),
            evidence_document_id,
        });
        earlier.push((effective_from, state));
    }
    out.reverse();
    Ok(out)
}

impl PgEntityStore {
    /// # Errors
    /// `legal_entity_not_found`, or database faults.
    pub async fn entity_history(
        &self,
        actor: &Actor,
        id: Uuid,
        personal: bool,
    ) -> Result<Vec<RevisionEntry>, PgEntityError> {
        with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move { history(tx, Record::Entity, id, personal).await })
        })
        .await
    }

    /// # Errors
    /// `registration_not_found`, or database faults.
    pub async fn registration_history(
        &self,
        actor: &Actor,
        id: Uuid,
        personal: bool,
    ) -> Result<Vec<RevisionEntry>, PgEntityError> {
        with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move { history(tx, Record::Registration, id, personal).await })
        })
        .await
    }

    /// The 사업장's revisions and its 4대보험 revisions, interleaved by when
    /// they were recorded.
    ///
    /// # Errors
    /// `workplace_not_found`, or database faults.
    pub async fn workplace_history(
        &self,
        actor: &Actor,
        id: Uuid,
        personal: bool,
    ) -> Result<Vec<RevisionEntry>, PgEntityError> {
        with_org_conn(&self.pool, actor.org, move |tx| {
            Box::pin(async move { history(tx, Record::Workplace, id, personal).await })
        })
        .await
    }
}
