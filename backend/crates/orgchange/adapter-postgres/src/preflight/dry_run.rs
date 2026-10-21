use crate::*;

/// UX-R3 STRUCT org-01: the preflight runs what submit runs. A change that
/// submit would apply at once (no approval route, 시행일 today or earlier) is
/// applied here inside a savepoint and rolled back, and a refusal becomes a
/// named blocker with its fix, so 「사전 점검 통과」 is never followed by a 409.
/// A freeze stays the compute's warning (the hard stop is effectuate's).
pub(crate) async fn dry_run_apply(
    tx: Tx<'_, '_>,
    (org, actor, now): (OrgId, UserId, OffsetDateTime),
    id: Uuid,
    request: &RequestRow,
    ports: (
        Option<&dyn EmploymentTransferPort>,
        Option<&dyn OrgUnitWritePort>,
    ),
    report: &mut PreflightReport,
) -> Result<(), PgOrgChangeError> {
    if !report.blockers.is_empty() || today_kst() < request.effective_date {
        return Ok(());
    }
    if approval_routes_in_tx(tx.as_mut(), org, SettingKey::ApprovalPolicyOrgStructure).await? {
        return Ok(());
    }
    sqlx::query("SAVEPOINT org_change_dry_run")
        .execute(tx.as_mut())
        .await?;
    let outcome = apply_ops(tx, (org, actor, now), id, request, ports.0, ports.1).await;
    sqlx::query("ROLLBACK TO SAVEPOINT org_change_dry_run")
        .execute(tx.as_mut())
        .await?;
    sqlx::query("RELEASE SAVEPOINT org_change_dry_run")
        .execute(tx.as_mut())
        .await?;
    match outcome {
        Ok(_) | Err(PgOrgChangeError::Frozen(_)) => Ok(()),
        Err(PgOrgChangeError::Domain(refusal)) if refusal.kind != ErrorKind::Internal => {
            let code = refusal.code.unwrap_or("org_change_apply_refused");
            report.blockers.push(PreflightBlocker {
                code: code.to_owned(),
                label: blocker_label(code, request.effective_date).unwrap_or(refusal.message),
                dependent_kind: "employee".to_owned(),
                count: 1,
            });
            Ok(())
        }
        Err(other) => Err(other),
    }
}

/// The blocker's words: what stops the change and the fix (decisions #18).
fn blocker_label(code: &str, on: Date) -> Option<String> {
    let next = on.next_day().unwrap_or(on);
    Some(match code {
        "assignment_starts_on_move_date" => format!(
            "시행일({on})에 사업장 배치가 시작되는 사람이 있어 같은 날 옮길 수 없습니다 · 시행일을 {next}로 바꾸십시오"
        ),
        "employee_unassigned" => {
            "법인·사업장이 기록되지 않은 사람이 있습니다 · 먼저 인사카드에 기록하십시오".to_owned()
        }
        "lifecycle_schedule_conflict" => {
            "옮길 사람에게 시행일 뒤로 예약된 발령이 있습니다 · 그 예약을 먼저 정리하십시오"
                .to_owned()
        }
        "assignment_after_move" => {
            "옮길 사람에게 시행일 뒤의 사업장 배치가 있습니다 · 그 배치를 먼저 정리하십시오"
                .to_owned()
        }
        "workplace_not_open" => {
            "닫혔거나 아직 열지 않은 사업장으로는 옮길 수 없습니다 · 열린 사업장을 고르십시오"
                .to_owned()
        }
        "transfer_cross_entity" | "entity_change_needs_group_transfer" => {
            "다른 법인으로 옮기는 것은 전적입니다 · 전적으로 처리하십시오".to_owned()
        }
        _ => return None,
    })
}
