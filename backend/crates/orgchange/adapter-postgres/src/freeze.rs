use crate::*;

// ---------------------------------------------------------------------------
// Apply executor — replays the approved proposal inside the caller's tx.
// ---------------------------------------------------------------------------

/// The freeze domains §3.9.1 names — 급여 마감 and 회계 결산. One list, so the
/// preflight chip and the apply gate can never check a different set.
pub(crate) const FREEZE_DOMAINS: [PeriodLockDomain; 2] =
    [PeriodLockDomain::Payroll, PeriodLockDomain::Accounting];

/// Console-facing name of a freeze domain. The platform refusal message is
/// English and shared with the financial surface; the preflight chip sits in a
/// Korean list (`OrgChangeModal.tsx`), so it names the domain in Korean.
pub(crate) const fn freeze_domain_label(domain: PeriodLockDomain) -> &'static str {
    match domain {
        PeriodLockDomain::Payroll => "급여 마감",
        PeriodLockDomain::Accounting => "회계 결산",
    }
}

/// §3.9.1 변경 동결 창 — refuse a live org mutation whose effective date falls
/// inside a closed payroll or accounting period, in which case the run whose
/// scope and attribution it would rewrite is already sealed.
///
/// This is the platform period-lock mechanism (migration 0107,
/// `console_platform_db::period_lock`), not a second freeze concept: the lookup
/// runs in the caller's already-armed transaction, so RLS confines it to the
/// caller's own tenant and the refusal rolls the whole apply back.
pub(crate) async fn assert_change_window_open(
    tx: Tx<'_, '_>,
    effective_date: Date,
) -> Result<(), PgOrgChangeError> {
    for domain in FREEZE_DOMAINS {
        match assert_period_open(tx, domain, effective_date).await {
            Ok(()) => {}
            // Conflict = that window is closed. The platform phrases its own
            // refusal in English for the financial back office; this crate's
            // conflicts reach the approval modal verbatim (`orgApi.ts` →
            // `OrgChangeModal.tsx`) beside 발효일/SoD refusals that are Korean,
            // so the freeze refusal is named the same way there.
            Err(refusal) if refusal.kind == ErrorKind::Conflict => {
                return Err(PgOrgChangeError::Frozen(KernelError::conflict(format!(
                    "{} 기간에 포함된 발효일({effective_date})에는 조직 변경을 적용할 수 없습니다.",
                    freeze_domain_label(domain)
                ))));
            }
            Err(other) => return Err(other.into()),
        }
    }
    Ok(())
}

/// Inverse of `DeactivateRegion`'s active-branch guard (console-k6wm / identity
/// lx6 sibling). Called by both `CreateBranch` and `RenameBranch` region_id arms
/// so the region-active invariant cannot drift between the two write paths.
/// Missing region → conflict (matches other apply_op not-found style);
/// deactivated → conflict (409). A CHECK/partial index cannot express this
/// cross-row rule.
pub(crate) async fn require_active_region_tx(
    tx: Tx<'_, '_>,
    region_id: Uuid,
) -> Result<(), PgOrgChangeError> {
    let row: Option<(Uuid, Option<OffsetDateTime>)> =
        sqlx::query_as("SELECT id, deactivated_at FROM regions WHERE id = $1 FOR UPDATE")
            .bind(region_id)
            .fetch_optional(tx.as_mut())
            .await?;
    let Some((_, deactivated_at)) = row else {
        return Err(KernelError::conflict("region was not found").into());
    };
    if deactivated_at.is_some() {
        return Err(KernelError::conflict("비활성화된 지역에는 지점을 배정할 수 없습니다.").into());
    }
    Ok(())
}
