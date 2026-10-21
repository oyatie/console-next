use crate::*;

/// The note a moved person's event carries: the change's code and reason, so
/// their 인사 이력 names the org change that moved them.
pub(crate) fn move_cause(id: Uuid, request: &RequestRow) -> PeopleMoveCause {
    let reason: String = request.reason.chars().take(900).collect();
    PeopleMoveCause {
        request_id: id,
        on: request.effective_date,
        note: format!("조직 변경 {} · {reason}", request.code),
    }
}

/// `unit` and every unit under it, as today's revision heads place them (read
/// after the move's own revision, so the subtree is the moved one).
pub(crate) async fn subtree(tx: Tx<'_, '_>, unit: Uuid) -> Result<Vec<Uuid>, PgOrgChangeError> {
    Ok(sqlx::query_scalar(
        "WITH RECURSIVE heads AS ( \
           SELECT DISTINCT ON (org_unit_id) org_unit_id AS id, attributes->>'parent_id' AS parent \
           FROM org_unit_revisions ORDER BY org_unit_id, version DESC), \
         down AS ( \
           SELECT $1::uuid AS id, 0 AS depth \
           UNION ALL SELECT h.id, down.depth + 1 FROM down JOIN heads h ON h.parent = down.id::text \
           WHERE down.depth < 32) \
         SELECT id FROM down",
    )
    .bind(unit)
    .fetch_all(tx.as_mut())
    .await?)
}

/// Moves people through the owners' port inside the apply transaction. A port
/// refusal keeps its kind and code (a 법인 crossed, a later scheduled event
/// the move would break); the caller's whole change rolls back.
pub(crate) async fn move_people(
    tx: Tx<'_, '_>,
    (org, actor): (OrgId, UserId),
    cause: PeopleMoveCause,
    what: PeopleMove,
    port: Option<&dyn EmploymentTransferPort>,
) -> Result<PeopleMoved, PgOrgChangeError> {
    let port = port.ok_or_else(|| {
        PgOrgChangeError::from(KernelError::internal(
            "employment transfer port is not wired; people cannot move with the change",
        ))
    })?;
    port.move_people(tx, org, actor, cause, what)
        .await
        .map_err(PgOrgChangeError::from)
}
