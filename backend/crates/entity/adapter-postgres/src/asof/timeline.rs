//! Timeline metadata and comparison share the chart's tenant snapshot and current scope.
use super::timeline_changes::changes;
use crate::{PgEntityError, PgEntityStore, structure::compose};
use console_entity_application::{
    Actor, ReadOptions, ReadPoint, StructureDiff, compare, with_gone,
};
use console_platform_db::with_org_snapshot;
use time::Date;
use uuid::Uuid;

impl PgEntityStore {
    /// # Errors
    /// Database faults; both reads are in one tenant-armed repeatable-read transaction.
    pub async fn structure_diff(
        &self,
        actor: &Actor,
        a: Date,
        b: Date,
        q: ReadOptions,
    ) -> Result<StructureDiff, PgEntityError> {
        let granted = actor.scope.granted().map(<[Uuid]>::to_vec);
        with_org_snapshot(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let before = compose(
                    tx,
                    granted.as_deref(),
                    ReadOptions {
                        as_of: Some(a),
                        ..q
                    },
                )
                .await?;
                let after = compose(
                    tx,
                    granted.as_deref(),
                    ReadOptions {
                        as_of: Some(b),
                        ..q
                    },
                )
                .await?;
                let visible =
                    super::timeline_scope::visible(tx, granted.as_deref(), a, b, q).await?;
                let changes = changes(tx, a, b, q)
                    .await?
                    .into_iter()
                    .filter(|c| {
                        Date::parse(
                            &c.meta.effective_date,
                            &time::macros::format_description!("[year]-[month]-[day]"),
                        )
                        .is_ok_and(|date| {
                            c.references
                                .iter()
                                .any(|id| super::timeline_scope::at(&visible, id, date))
                        })
                    })
                    .collect::<Vec<_>>();
                let mut marks = compare(&before, &after);
                for n in &mut marks {
                    n.changes = changes
                        .iter()
                        .filter(|c| c.affected.contains(&n.id))
                        .map(|c| c.meta.clone())
                        .collect();
                }
                Ok(StructureDiff {
                    a: a.to_string(),
                    b: b.to_string(),
                    structure: with_gone(&before, after),
                    marks,
                    changes: changes.into_iter().map(|c| c.meta).collect(),
                })
            })
        })
        .await
    }

    /// # Errors
    /// Database faults. Only effective dates belonging to visible nodes are returned.
    pub async fn structure_change_dates(
        &self,
        actor: &Actor,
        from: Date,
        to: Date,
        q: ReadOptions,
    ) -> Result<Vec<String>, PgEntityError> {
        let granted = actor.scope.granted().map(<[Uuid]>::to_vec);
        with_org_snapshot(&self.pool, actor.org, move |tx| Box::pin(async move {
            let visible = super::timeline_scope::visible(tx,granted.as_deref(),from,to,q).await?;
            let ids: Vec<_> = visible.keys().copied().collect();
            let p = ReadPoint::new(crate::today_kst(tx).await?, q);
            let events: Vec<(Uuid, Date)> = sqlx::query_as(
                "SELECT DISTINCT subject,d FROM ( \
                    SELECT legal_entity_id AS subject,effective_from AS d FROM legal_entity_revisions WHERE legal_entity_id = ANY($1) AND created_at <= COALESCE($4::timestamptz,now()) \
                    UNION SELECT workplace_id,effective_from FROM workplace_revisions WHERE workplace_id = ANY($1) AND created_at <= COALESCE($4::timestamptz,now()) \
                    UNION SELECT org_unit_id,COALESCE(entity_try_iso_date(attributes->>'effective_from'), (created_at AT TIME ZONE 'Asia/Seoul')::date) FROM org_unit_revisions WHERE org_unit_id = ANY($1) AND created_at <= COALESCE($4::timestamptz,now()) \
                    UNION SELECT subject,valid_from FROM org_unit_placements CROSS JOIN LATERAL unnest(ARRAY[org_unit_id,workplace_id]) AS subjects(subject) WHERE (org_unit_id = ANY($1) OR workplace_id = ANY($1)) AND created_at <= COALESCE($4::timestamptz,now()) \
                    UNION SELECT subject,valid_to FROM org_unit_placements CROSS JOIN LATERAL unnest(ARRAY[org_unit_id,workplace_id]) AS subjects(subject) WHERE (org_unit_id = ANY($1) OR workplace_id = ANY($1)) AND valid_to_recorded_at <= COALESCE($4::timestamptz,now()) \
                    UNION SELECT subject,entity_try_iso_date(x.effective_date) FROM (SELECT (jsonb_populate_record(NULL::employee_lifecycle_events,entity_known_row(to_jsonb(e),$4))).* FROM employee_lifecycle_events e) x \
                        CROSS JOIN LATERAL unnest(ARRAY[x.from_org_unit_id,x.to_org_unit_id,x.to_workplace_id]) AS subjects(subject) \
                        WHERE (x.from_org_unit_id = ANY($1) OR x.to_org_unit_id = ANY($1) OR x.to_workplace_id = ANY($1)) AND x.state NOT IN ('CANCELLED','APPLY_FAILED') \
                    UNION SELECT subject,valid_from FROM employment_assignments CROSS JOIN LATERAL unnest(ARRAY[legal_entity_id,workplace_id]) AS subjects(subject) WHERE (legal_entity_id = ANY($1) OR workplace_id = ANY($1)) AND created_at <= COALESCE($4::timestamptz,now()) \
                    UNION SELECT subject,valid_to FROM employment_assignments CROSS JOIN LATERAL unnest(ARRAY[legal_entity_id,workplace_id]) AS subjects(subject) WHERE (legal_entity_id = ANY($1) OR workplace_id = ANY($1)) AND valid_to_recorded_at <= COALESCE($4::timestamptz,now()) \
                ) days WHERE subject IS NOT NULL AND d BETWEEN $2 AND $3 ORDER BY d",
            ).bind(&ids).bind(from).bind(to).bind(p.known_at).fetch_all(tx.as_mut()).await?;
            let mut dates: Vec<Date> = events.into_iter()
                .filter(|(id,date)| super::timeline_scope::at(&visible,id,*date))
                .map(|(_,date)| date).collect();
            for c in changes(tx,from.previous_day().unwrap_or(from),to,q).await? {
                if let Ok(d)=Date::parse(&c.meta.effective_date,&time::macros::format_description!("[year]-[month]-[day]"))
                    && c.references.iter().any(|id|super::timeline_scope::at(&visible,id,d)) {dates.push(d);}
            }
            dates.sort(); dates.dedup(); Ok(dates.into_iter().map(|d|d.to_string()).collect())
        })).await
    }
}
