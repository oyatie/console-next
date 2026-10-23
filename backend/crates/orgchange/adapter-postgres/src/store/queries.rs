use crate::*;

impl PgOrgChangeStore {
    /// The caller's org tree as a flat list: the Company root, then every
    /// Site/Department/Team head (dissolved units included, marked so), in the
    /// chart's tree order. RLS confines it to the caller's tenant.
    pub async fn list_org_units(&self) -> Result<OrgUnitListView, PgOrgChangeError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn(&self.pool, org, |tx| {
            Box::pin(async move {
                let mut items = Vec::new();
                if let Some(root) = company_root(tx, org).await? {
                    items.push(root);
                }
                let counts = unit_headcounts(tx).await?;
                let positions = unit_positions(tx).await?;
                let rows = sqlx::query(latest_revision_sql!(""))
                    .fetch_all(tx.as_mut())
                    .await?;
                let mut heads = Vec::with_capacity(rows.len());
                for row in &rows {
                    heads.extend(unit_head_from_row(row)?);
                }
                // The chart's order, so every picker lists units as the chart shows them.
                for head in in_tree_order(heads, &positions) {
                    let headcount = counts.get(&head.id).copied().unwrap_or(0);
                    items.push(head_view(head, org, headcount));
                }
                Ok(OrgUnitListView { items })
            })
        })
        .await
    }

    /// One node: head + revision history (newest first) + active members.
    /// The Company root id is accepted; anything else not visible is 404.
    pub async fn get_org_unit(&self, id: Uuid) -> Result<OrgUnitDetailView, PgOrgChangeError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn(&self.pool, org, |tx| {
            Box::pin(async move {
                let not_found =
                    || PgOrgChangeError::from(KernelError::not_found("org unit was not found"));
                let is_root = id == *org.as_uuid();
                let (head, revisions) = if is_root {
                    let head = company_root(tx, org).await?.ok_or_else(not_found)?;
                    // Legal revision history is on the entity record, not the tenant root.
                    let revisions = Vec::new();
                    (head, revisions)
                } else {
                    let head = load_unit_head(tx, id).await?.ok_or_else(not_found)?;
                    let kind = head.kind;
                    let headcount = unit_members(tx, id).await?;
                    let rows = sqlx::query(
                        "SELECT r.version, r.attributes, r.actor_id, \
                         u.display_name AS actor_name, r.created_at, h.name AS head_name, a.actor_kind, a.command_id \
                         FROM org_unit_revisions r LEFT JOIN users u ON u.id = r.actor_id \
                         LEFT JOIN employees h ON h.id::text = r.attributes->>'head_employee_id' \
                         LEFT JOIN LATERAL (SELECT a.actor_kind, a.command_id FROM audit_events a \
                           WHERE a.org_id = r.org_id AND a.target_type = 'org_unit' \
                             AND a.target_id = r.org_unit_id::text AND a.actor = r.actor_id \
                             AND a.created_at = r.created_at AND (a.outcome IS NULL OR a.outcome = 'ALLOWED') \
                           ORDER BY (a.command_id = r.command_id) DESC NULLS LAST, a.id DESC LIMIT 1) a ON true \
                         WHERE r.org_unit_id = $1 ORDER BY r.version DESC",
                    )
                    .bind(id)
                    .fetch_all(tx.as_mut())
                    .await?;
                    let mut revisions = Vec::with_capacity(rows.len());
                    for row in &rows {
                        let attributes: Value = row.try_get("attributes")?;
                        let created_at: OffsetDateTime = row.try_get("created_at")?;
                        let parent_id = attr_text(&attributes, "parent_id")
                            .and_then(|v| Uuid::parse_str(&v).ok())
                            .or_else(|| (kind == OrgUnitKind::Site).then_some(*org.as_uuid()));
                        revisions.push(OrgUnitRevisionView {
                            version: row.try_get("version")?,
                            name: attr_text(&attributes, "name").unwrap_or_default(),
                            parent_id,
                            status: if attr_text(&attributes, "status").as_deref()
                                == Some("dissolved")
                            {
                                OrgUnitStatus::Dissolved
                            } else {
                                OrgUnitStatus::Active
                            },
                            effective_from: attr_date(&attributes, created_at),
                            actor_id: row.try_get("actor_id")?,
                            actor_name: row.try_get("actor_name")?,
                            actor_kind: row.try_get("actor_kind")?,
                            command_id: row.try_get("command_id")?,
                            created_at,
                            code: attr_text(&attributes, "code"),
                            head_employee_id: attr_uuid(&attributes, "head_employee_id"),
                            head_name: row.try_get("head_name")?,
                            merged_into: attr_uuid(&attributes, "merged_into"),
                        });
                    }
                    (head_view(head, org, headcount), revisions)
                };
                let member_rows = sqlx::query(
                    "SELECT id, name, employee_number, position FROM employees \
                     WHERE employment_status <> 'EXITED' \
                       AND ($2 OR org_unit_id = $1 OR org_unit = $1::text) \
                     ORDER BY name, id LIMIT 200",
                )
                .bind(id)
                .bind(is_root)
                .fetch_all(tx.as_mut())
                .await?;
                let mut items = Vec::with_capacity(member_rows.len());
                for row in &member_rows {
                    items.push(OrgUnitMemberView {
                        employee_id: row.try_get("id")?,
                        name: row.try_get("name")?,
                        employee_number: row.try_get("employee_number")?,
                        position: row.try_get("position")?,
                    });
                }
                let headcount = head.headcount;
                Ok(OrgUnitDetailView {
                    head,
                    revisions,
                    members: OrgUnitMembersView { headcount, items },
                })
            })
        })
        .await
    }

    pub async fn list(&self, filter: ListFilter) -> Result<OrgChangePage, PgOrgChangeError> {
        let org = current_org().map_err(KernelError::from)?;
        let limit = filter.limit.unwrap_or(50).clamp(1, 200);
        let offset = filter.offset.unwrap_or(0).clamp(0, 100_000);
        let statuses: Option<Vec<&'static str>> = (!filter.statuses.is_empty()).then(|| {
            filter
                .statuses
                .iter()
                .copied()
                .map(OrgChangeStatus::as_db)
                .collect()
        });
        let kind = filter.kind.map(OrgChangeKind::as_db);
        let drafted_by = filter.drafted_by;
        with_org_conn(&self.pool, org, |tx| {
            Box::pin(async move {
                let rows = sqlx::query(SELECT_REQUEST_PAGE)
                    .bind(&statuses)
                    .bind(kind)
                    .bind(drafted_by)
                    .bind(limit)
                    .bind(offset)
                    .bind(filter.effective_from)
                    .bind(filter.effective_to)
                    .fetch_all(tx.as_mut())
                    .await?;
                let total: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM org_change_requests \
                     WHERE ($1::text[] IS NULL OR status = ANY($1)) \
                       AND ($2::text IS NULL OR kind = $2) \
                       AND ($3::uuid IS NULL OR drafted_by = $3) \
                       AND ($4::date IS NULL OR effective_date >= $4) \
                       AND ($5::date IS NULL OR effective_date <= $5)",
                )
                .bind(&statuses)
                .bind(kind)
                .bind(drafted_by)
                .bind(filter.effective_from)
                .bind(filter.effective_to)
                .fetch_one(tx.as_mut())
                .await?;
                let mut items = Vec::with_capacity(rows.len());
                for row in &rows {
                    items.push(summary_from_row(row)?);
                }
                Ok(OrgChangePage { items, total })
            })
        })
        .await
    }

    pub async fn get(&self, id: Uuid) -> Result<OrgChangeDetail, PgOrgChangeError> {
        let org = current_org().map_err(KernelError::from)?;
        with_org_conn(&self.pool, org, |tx| {
            Box::pin(async move {
                load_detail(tx, id)
                    .await?
                    // RLS conceals other tenants' rows: out-of-scope is
                    // indistinguishable from absent (deny-by-omission).
                    .ok_or_else(|| {
                        KernelError::not_found("org-change request was not found").into()
                    })
            })
        })
        .await
    }

    /// The 법인 list = active member orgs of every group the actor holds a
    /// live grant for (fail-closed empty; design gap-analysis §2).
    ///
    /// L5-ORG: each row also carries Company/OrgUnit canonical reference fields
    /// on the preserved `/api/v1/org-entities` namespace (no parallel `/companies`).
    pub async fn org_entities(
        &self,
        actor: UserId,
    ) -> Result<Vec<OrgEntitySummary>, PgOrgChangeError> {
        let group_ids: Vec<Uuid> = sqlx::query_scalar(
            "SELECT DISTINCT grants.group_id \
             FROM group_role_grants_for_user($1) AS grants \
             JOIN groups g ON g.id = grants.group_id \
             WHERE g.status = 'ACTIVE' \
             ORDER BY grants.group_id",
        )
        .bind(*actor.as_uuid())
        // rls-arming: ok identity-only SECURITY DEFINER grants resolver + safe groups metadata
        .fetch_all(&self.pool)
        .await?;
        let mut by_org = std::collections::BTreeMap::new();
        for group_id in group_ids {
            for member in
                console_platform_group::group_member_orgs(&self.pool, group_id, actor).await?
            {
                by_org.insert(
                    *member.org_id.as_uuid(),
                    (member.slug, member.name, member.status, member.org_id),
                );
            }
        }
        let mut out = Vec::with_capacity(by_org.len());
        for (org_uuid, (slug, name, status, org_id)) in by_org {
            // company_revisions / org_unit_source_bindings / regions / branches
            // are FORCE RLS — arm app.current_org per member tenant (not the
            // bare pool used for the identity-only grants resolver above).
            let (company_resolved, org_units) = with_org_conn(&self.pool, org_id, |tx| {
                Box::pin(async move {
                    // SELECT-only: writer-ownership does not charge reads.
                    // Tenant identity resolves without a retired company revision.
                    // Kept local so this adapter never depends on the Company
                    // owner adapter (adapter→adapter is illegal).
                    let company_resolved: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM organizations WHERE id = $1)",
                    )
                    .bind(*org_id.as_uuid())
                    .fetch_one(tx.as_mut())
                    .await?;
                    let org_units = load_org_unit_references_tx(tx, org_id).await?;
                    Ok::<_, PgOrgChangeError>((company_resolved, org_units))
                })
            })
            .await?;
            out.push(OrgEntitySummary {
                org_id: org_uuid,
                slug,
                name,
                status,
                company_id: org_uuid,
                company_resolution_status: if company_resolved {
                    CanonicalResolutionStatus::Resolved
                } else {
                    CanonicalResolutionStatus::Unbound
                },
                org_units,
            });
        }
        Ok(out)
    }
}
