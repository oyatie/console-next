use super::*;

impl PgLeaveStore {
    pub async fn decide(
        &self,
        command: DecideLeaveRequestCommand,
    ) -> Result<LeaveRequestView, PgLeaveError> {
        let org = current_org().map_err(KernelError::from)?;
        let request_id = command.request_id;
        let decider = command.decider;

        // Read-first to classify before mutating: NotFound (or out-of-branch),
        // already-decided (409), or self-decision (SoD, 403). A branch-scoped
        // read means an out-of-scope request is indistinguishable from a
        // missing one — deny-by-omission.
        let existing = self
            .fetch_request_scoped(org, request_id, &command.branch_scope)
            .await?
            .ok_or_else(|| KernelError::not_found("leave request not found"))?;
        if existing.status != LeaveStatus::Pending {
            return Err(KernelError::conflict(format!(
                "leave request is already {} and cannot be decided again",
                existing.status.as_str()
            ))
            .into());
        }
        if let Some(expected_version) = command.expected_version
            && existing.request_version != expected_version
        {
            return Err(PgLeaveError::ConcurrentModification);
        }

        let decision = command.decision;
        let mut tx = self.command_pool()?.begin().await?;
        sqlx::query("SELECT set_config('app.current_org',$1,true)")
            .bind(org.to_string())
            .execute(tx.as_mut())
            .await?;
        if let Some(refusal) =
            console_platform_authz::cedar_pbac::actions::independent_people::refusal_in_tx(
                tx.as_mut(),
                Some(*existing.requester_user_id.as_uuid()),
                *decider.as_uuid(),
            )
            .await
        {
            return Err(KernelError::forbidden(
                "leave decisions require two bound, distinct natural persons",
            )
            .with_code(refusal.code(
                "leave.refuse.identity_unbound",
                "leave_decide_requester_forbidden",
            ))
            .into());
        }
        if decision.writes_ledger() && existing.charge_resolved_by == Some(decider) {
            return Err(KernelError::forbidden(
                "leave charge resolver cannot approve the same request",
            )
            .into());
        }

        console_platform_db::command_outcomes::execution::bind(&mut tx).await?;
        let row = sqlx::query(
            "SELECT * FROM leave_api.decide_request(\
             $1,$2,$3,$4,$5,$6,$7,$8)",
        )
        .bind(org.as_uuid())
        .bind(request_id.as_uuid())
        .bind(decider.as_uuid())
        .bind(command.expected_version)
        .bind(decision.as_str())
        .bind(command.comment)
        .bind(command.trace.trace_id())
        .bind(command.trace.span_id())
        .fetch_one(tx.as_mut())
        .await
        .map_err(map_leave_command_sqlx)?;
        tx.commit().await?;
        let outcome: String = row.try_get("outcome")?;
        if outcome == "charge_review_required" {
            return Err(PgLeaveError::ChargeReviewRequired(
                existing.charge_review_reasons,
            ));
        }
        if outcome != "decided" {
            return Err(PgLeaveError::Domain(KernelError::internal(
                "leave decision routine returned an unknown outcome",
            )));
        }
        self.fetch_request_scoped(org, request_id, &command.branch_scope)
            .await?
            .ok_or_else(|| {
                PgLeaveError::Domain(KernelError::internal(
                    "leave command committed but decided request was not readable",
                ))
            })
    }
}
