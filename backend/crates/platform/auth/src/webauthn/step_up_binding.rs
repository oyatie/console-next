//! The step-up binding: which act a step-up ceremony authorizes
//! (`auth_webauthn_ceremony_bindings`, migration 0144, widened by BW-29).
//!
//! Two legacy mobile kinds carry no payload hash. Every BW-29 kind binds the
//! lowercase hex SHA-256 of its canonical payload, has the reason key
//! `passkey_step_up_<kind lower>` (a catalog key) and no replay attempt; the
//! migration's pair CHECK enforces the same shape.

use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

use super::step_up_kind::MobileStepUpActionKind;
use crate::AuthError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MobilePasskeyStepUpBinding {
    pub action_kind: MobileStepUpActionKind,
    pub object_id: Uuid,
    pub reason_key: String,
    pub replay_attempt: Option<i32>,
    /// Lowercase hex SHA-256 of the canonical payload (BW-29 kinds only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_hash: Option<String>,
}

impl<'de> Deserialize<'de> for MobilePasskeyStepUpBinding {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct BindingVisitor;

        enum Field {
            ActionKind,
            ObjectId,
            ReasonKey,
            ReplayAttempt,
            PayloadHash,
            Ignore,
        }

        impl<'de> Deserialize<'de> for Field {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                struct FieldVisitor;

                impl serde::de::Visitor<'_> for FieldVisitor {
                    type Value = Field;

                    fn expecting(
                        &self,
                        formatter: &mut std::fmt::Formatter<'_>,
                    ) -> std::fmt::Result {
                        formatter.write_str("a mobile passkey step-up binding field")
                    }

                    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
                    where
                        E: serde::de::Error,
                    {
                        Ok(match value {
                            "action_kind" => Field::ActionKind,
                            "object_id" => Field::ObjectId,
                            "reason_key" => Field::ReasonKey,
                            "replay_attempt" => Field::ReplayAttempt,
                            "payload_hash" => Field::PayloadHash,
                            _ => Field::Ignore,
                        })
                    }
                }

                deserializer.deserialize_identifier(FieldVisitor)
            }
        }

        impl<'de> serde::de::Visitor<'de> for BindingVisitor {
            type Value = MobilePasskeyStepUpBinding;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a mobile passkey step-up binding")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                let mut action_kind = None;
                let mut object_id = None;
                let mut reason_key = None;
                let mut replay_attempt = None;
                let mut payload_hash = None;

                while let Some(key) = map.next_key::<Field>()? {
                    match key {
                        Field::ActionKind => {
                            if action_kind.is_some() {
                                return Err(serde::de::Error::duplicate_field("action_kind"));
                            }
                            action_kind = Some(map.next_value()?);
                        }
                        Field::ObjectId => {
                            if object_id.is_some() {
                                return Err(serde::de::Error::duplicate_field("object_id"));
                            }
                            object_id = Some(map.next_value()?);
                        }
                        Field::ReasonKey => {
                            if reason_key.is_some() {
                                return Err(serde::de::Error::duplicate_field("reason_key"));
                            }
                            reason_key = Some(map.next_value()?);
                        }
                        Field::ReplayAttempt => {
                            if replay_attempt.is_some() {
                                return Err(serde::de::Error::duplicate_field("replay_attempt"));
                            }
                            replay_attempt = Some(map.next_value::<Option<i32>>()?);
                        }
                        Field::PayloadHash => {
                            if payload_hash.is_some() {
                                return Err(serde::de::Error::duplicate_field("payload_hash"));
                            }
                            payload_hash = Some(map.next_value::<Option<String>>()?);
                        }
                        Field::Ignore => {
                            let _ = map.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }

                Ok(MobilePasskeyStepUpBinding {
                    action_kind: action_kind
                        .ok_or_else(|| serde::de::Error::missing_field("action_kind"))?,
                    object_id: object_id
                        .ok_or_else(|| serde::de::Error::missing_field("object_id"))?,
                    reason_key: reason_key
                        .ok_or_else(|| serde::de::Error::missing_field("reason_key"))?,
                    replay_attempt: replay_attempt
                        .ok_or_else(|| serde::de::Error::missing_field("replay_attempt"))?,
                    // Optional on the wire: the legacy kinds never send it.
                    payload_hash: payload_hash.flatten(),
                })
            }
        }

        const FIELDS: &[&str] = &[
            "action_kind",
            "object_id",
            "reason_key",
            "replay_attempt",
            "payload_hash",
        ];
        deserializer.deserialize_struct("MobilePasskeyStepUpBinding", FIELDS, BindingVisitor)
    }
}

impl MobilePasskeyStepUpBinding {
    pub fn approval_decision(object_id: Uuid, replay_attempt: Option<i32>) -> Self {
        Self::new(
            MobileStepUpActionKind::ApprovalDecision,
            object_id,
            replay_attempt,
        )
    }

    pub fn poll_vote(object_id: Uuid, replay_attempt: Option<i32>) -> Self {
        Self::new(MobileStepUpActionKind::PollVote, object_id, replay_attempt)
    }

    /// A BW-29 binding: `payload_hash` is the server-recomputed hash.
    pub fn bound(
        action_kind: MobileStepUpActionKind,
        object_id: Uuid,
        payload_hash: String,
    ) -> Self {
        Self {
            payload_hash: Some(payload_hash),
            replay_attempt: None,
            ..Self::new(action_kind, object_id, None)
        }
    }

    fn new(
        action_kind: MobileStepUpActionKind,
        object_id: Uuid,
        replay_attempt: Option<i32>,
    ) -> Self {
        Self {
            action_kind,
            object_id,
            reason_key: action_kind.expected_reason_key().to_owned(),
            replay_attempt,
            payload_hash: None,
        }
    }

    pub fn validate(&self) -> Result<(), MobileStepUpBindingError> {
        if self.reason_key != self.action_kind.expected_reason_key() {
            return Err(MobileStepUpBindingError::ReasonKeyMismatch);
        }
        if self.replay_attempt.is_some_and(|attempt| attempt < 1) {
            return Err(MobileStepUpBindingError::InvalidReplayAttempt);
        }
        let hash_ok = self.payload_hash.as_deref().is_some_and(|hash| {
            hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        });
        let legacy = self.action_kind.is_legacy();
        if legacy == self.payload_hash.is_some() || (!legacy && !hash_ok) {
            return Err(MobileStepUpBindingError::PayloadHashShape);
        }
        if !legacy && self.replay_attempt.is_some() {
            return Err(MobileStepUpBindingError::InvalidReplayAttempt);
        }
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MobileStepUpBindingError {
    #[error("reason_key is not supported for action_kind")]
    ReasonKeyMismatch,

    #[error("replay_attempt must be null or a positive 1-based integer")]
    InvalidReplayAttempt,

    #[error(
        "payload_hash must be lowercase SHA-256 hex for this action_kind, and absent for legacy kinds"
    )]
    PayloadHashShape,
}

pub(super) async fn insert_mobile_step_up_binding_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    ceremony_id: Uuid,
    binding: &MobilePasskeyStepUpBinding,
) -> Result<(), AuthError> {
    sqlx::query(
        r#"
        INSERT INTO auth_webauthn_ceremony_bindings (
            ceremony_id, action_kind, object_id, reason_key, replay_attempt, payload_hash
        ) VALUES ($1, $2, $3, $4, $5, $6)
        "#,
    )
    .bind(ceremony_id)
    .bind(binding.action_kind.as_wire())
    .bind(binding.object_id)
    .bind(&binding.reason_key)
    .bind(binding.replay_attempt)
    .bind(&binding.payload_hash)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

pub(super) async fn load_mobile_step_up_binding_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    ceremony_id: Uuid,
) -> Result<Option<MobilePasskeyStepUpBinding>, AuthError> {
    let row = sqlx::query(
        r#"
        SELECT action_kind, object_id, reason_key, replay_attempt, payload_hash
        FROM auth_webauthn_ceremony_bindings
        WHERE ceremony_id = $1
        "#,
    )
    .bind(ceremony_id)
    .fetch_optional(tx.as_mut())
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };
    let action_kind: String = row.try_get("action_kind")?;
    Ok(Some(MobilePasskeyStepUpBinding {
        action_kind: MobileStepUpActionKind::from_wire(&action_kind)?,
        object_id: row.try_get("object_id")?,
        reason_key: row.try_get("reason_key")?,
        replay_attempt: row.try_get("replay_attempt")?,
        payload_hash: row.try_get("payload_hash")?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mobile_step_up_binding_replay_attempt_is_required_but_nullable() {
        let object_id = Uuid::nil();
        let missing_replay_attempt = json!({
            "action_kind": "APPROVAL_DECISION",
            "object_id": object_id,
            "reason_key": "operations_passkey_approval_decision"
        });

        let error = serde_json::from_value::<MobilePasskeyStepUpBinding>(missing_replay_attempt)
            .expect_err("replay_attempt must be present, even when null");
        assert!(error.to_string().contains("replay_attempt"));

        let online_binding: MobilePasskeyStepUpBinding = serde_json::from_value(json!({
            "action_kind": "APPROVAL_DECISION",
            "object_id": object_id,
            "reason_key": "operations_passkey_approval_decision",
            "replay_attempt": null
        }))
        .unwrap();
        assert_eq!(online_binding.replay_attempt, None);

        let replay_binding: MobilePasskeyStepUpBinding = serde_json::from_value(json!({
            "action_kind": "POLL_VOTE",
            "object_id": object_id,
            "reason_key": "operations_passkey_poll_vote",
            "replay_attempt": 1
        }))
        .unwrap();
        assert_eq!(replay_binding.replay_attempt, Some(1));
    }

    #[test]
    fn mobile_step_up_binding_rejects_zero_replay_attempt() {
        let binding: MobilePasskeyStepUpBinding = serde_json::from_value(json!({
            "action_kind": "APPROVAL_DECISION",
            "object_id": Uuid::nil(),
            "reason_key": "operations_passkey_approval_decision",
            "replay_attempt": 0
        }))
        .unwrap();

        assert!(matches!(
            binding.validate(),
            Err(MobileStepUpBindingError::InvalidReplayAttempt)
        ));
    }

    #[test]
    fn every_kind_round_trips_and_derives_its_reason_key() {
        for kind in MobileStepUpActionKind::ALL {
            assert_eq!(
                MobileStepUpActionKind::from_wire(kind.as_wire()).unwrap(),
                kind
            );
            let wire: String = serde_json::from_value(json!(kind)).unwrap();
            assert_eq!(wire, kind.as_wire());
            if !kind.is_legacy() {
                let derived = format!("passkey_step_up_{}", kind.as_wire().to_lowercase());
                assert_eq!(kind.expected_reason_key(), derived);
            }
        }
        assert!(MobileStepUpActionKind::from_wire("ROOT").is_err());
    }

    #[test]
    fn bw29_kinds_require_a_payload_hash_and_legacy_kinds_refuse_one() {
        let hash = "ab".repeat(32);
        let kind = MobileStepUpActionKind::ExceptionDecide;
        let bound = MobilePasskeyStepUpBinding::bound(kind, Uuid::nil(), hash.clone());
        bound.validate().unwrap();
        for bad in [
            String::new(),
            "AB".repeat(32),
            "ab".repeat(31),
            "zz".repeat(32),
        ] {
            let binding = MobilePasskeyStepUpBinding::bound(kind, Uuid::nil(), bad);
            assert!(matches!(
                binding.validate(),
                Err(MobileStepUpBindingError::PayloadHashShape)
            ));
        }
        let unhashed = MobilePasskeyStepUpBinding {
            payload_hash: None,
            ..bound.clone()
        };
        assert!(unhashed.validate().is_err());
        let replayed = MobilePasskeyStepUpBinding {
            replay_attempt: Some(1),
            ..bound
        };
        assert!(replayed.validate().is_err());
        let legacy = MobilePasskeyStepUpBinding {
            payload_hash: Some(hash),
            ..MobilePasskeyStepUpBinding::poll_vote(Uuid::nil(), None)
        };
        assert!(matches!(
            legacy.validate(),
            Err(MobileStepUpBindingError::PayloadHashShape)
        ));
    }

    #[test]
    fn legacy_bindings_keep_their_wire_shape() {
        let binding = MobilePasskeyStepUpBinding::approval_decision(Uuid::nil(), None);
        let wire = serde_json::to_value(&binding).unwrap();
        assert!(wire.get("payload_hash").is_none(), "{wire}");
        assert_eq!(
            serde_json::from_value::<MobilePasskeyStepUpBinding>(wire).unwrap(),
            binding
        );
        let hash = "0f".repeat(32);
        let bound = MobilePasskeyStepUpBinding::bound(
            MobileStepUpActionKind::SettingsChange,
            Uuid::nil(),
            hash.clone(),
        );
        let wire = serde_json::to_value(&bound).unwrap();
        assert_eq!(wire["payload_hash"], json!(hash));
        assert_eq!(
            serde_json::from_value::<MobilePasskeyStepUpBinding>(wire).unwrap(),
            bound
        );
    }
}
