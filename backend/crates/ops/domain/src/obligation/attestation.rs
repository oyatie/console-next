// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{Event, GateProposal, Kind, Obligation, Refusal, State, is_structured_counsel_url};

impl Obligation {
    /// Unversioned records predate independently authenticated decisions. Keep their evidence and
    /// reopen launch gates so an operator can submit them under the current rule.
    pub fn replay_legacy(current: Option<&Self>, event: &Event) -> Result<Self, Refusal> {
        if matches!(event, Event::Countersigned { .. })
            || current.is_some_and(|item| item.requires_reattestation)
        {
            return Err(Refusal::Invalid);
        }
        let mut item = Self::apply(current, event, false)?;
        if item.kind == Kind::LaunchGate && !item.is_open() {
            item.state = State::InReview;
            item.requires_reattestation = true;
        }
        Ok(item)
    }

    /// Both live checks and replay use the operator recorded by the verified request context.
    pub fn apply_record(
        current: Option<&Self>,
        event: &Event,
        actor: &str,
        seq: u64,
    ) -> Result<Self, Refusal> {
        let Some(item) = current.filter(|item| item.kind == Kind::LaunchGate) else {
            return Self::evolve(current, event);
        };
        if !item.is_open() {
            return Err(Refusal::Final);
        }
        if let Event::Countersigned { proposal_seq } = event {
            let pending = item.pending_signoff.as_ref().ok_or(Refusal::Incomplete)?;
            if pending.seq != *proposal_seq || item.signer.as_deref() == Some(actor) {
                return Err(Refusal::Invalid);
            }
            let mut result = item.clone();
            result.state = pending.outcome;
            result.co_signer = Some(actor.to_owned());
            result.pending_signoff = None;
            return Ok(result);
        }
        let mut decision = event.clone();
        let (signer, co_signer, counsel, reason) = match &mut decision {
            Event::Done {
                signer,
                co_signer,
                counsel_url,
                evidence_ref,
                ..
            } => (
                signer,
                co_signer,
                counsel_url
                    .as_deref()
                    .filter(|v| !v.trim().is_empty())
                    .or(evidence_ref.as_deref()),
                None,
            ),
            Event::Waived {
                signer,
                co_signer,
                counsel_url,
                reason,
            } => (signer, co_signer, counsel_url.as_deref(), reason.clone()),
            _ if item.pending_signoff.is_some() => return Err(Refusal::Invalid),
            _ => return Self::evolve(current, event),
        };
        if signer.is_some()
            || co_signer.is_some()
            || item.pending_signoff.is_some() && item.signer.as_deref() != Some(actor)
        {
            return Err(Refusal::Invalid);
        }
        if !is_structured_counsel_url(counsel.ok_or(Refusal::Incomplete)?) {
            return Err(Refusal::Invalid);
        }
        *signer = Some(actor.to_owned());
        let mut proposal = Self::apply(current, &decision, false)?;
        proposal.requires_reattestation = false;
        if proposal.state == State::Waived {
            proposal.signed_on = None;
        }
        proposal.pending_signoff = Some(GateProposal {
            seq,
            outcome: proposal.state,
            reason,
        });
        proposal.state = State::InReview;
        Ok(proposal)
    }
}
