// SPDX-License-Identifier: LicenseRef-Proprietary
use console_kernel_core::{OrgId, UserId};
use console_platform_provisioning::{
    BootstrapCredentialStore, OpsRecoveryActor, OpsRecoveryCommand as C, OpsRecoveryOutcome,
    PlatformProvisioner, ProvisioningError,
};
use console_platform_test_support::{runtime_role_pool, seed_active_user, soft_passkey::SoftKey};
use sqlx::PgPool;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

pub struct Harness {
    pub owner: PgPool,
    pub runtime: PgPool,
    pub p: PlatformProvisioner,
    pub org: OrgId,
    pub ops: UserId,
    pub a: UserId,
    pub b: UserId,
    pub old_key: Option<SoftKey>,
}
pub fn open() -> C {
    C::Open {
        authoriser_role: "REPRESENTATIVE".into(),
        authoriser_name: "Synthetic Controller".into(),
        proofing_method: "TEST_ORIGINAL_PROOFING".into(),
        evidence_ref: "synthetic-evidence-ticket".into(),
    }
}
pub fn code(result: Result<OpsRecoveryOutcome, ProvisioningError>, expected: &str) {
    assert!(
        matches!(&result, Err(ProvisioningError::OpsRecovery(actual)) if *actual == expected)
            || (expected == "ops_recovery_hold_active"
                && matches!(
                    &result,
                    Err(ProvisioningError::OpsRecoveryHoldActive(Some(_)))
                )),
        "expected {expected}, got {result:?}"
    );
}
impl Harness {
    pub async fn new(owner: PgPool, second_operator: bool, enrolled: bool) -> Self {
        let runtime = runtime_role_pool(&owner).await;
        let p = PlatformProvisioner::new(Duration::hours(1));
        let a = seed_active_user(
            &owner,
            *OrgId::platform().as_uuid(),
            "SUPER_ADMIN",
            "recovery-a",
        )
        .await;
        let b = seed_active_user(
            &owner,
            *OrgId::platform().as_uuid(),
            "SUPER_ADMIN",
            "recovery-b",
        )
        .await;
        SoftKey::enroll(&owner, OrgId::platform(), a).await;
        if second_operator {
            SoftKey::enroll(&owner, OrgId::platform(), b).await;
        }
        let created = p
            .onboard_tenant(
                &runtime,
                Some(a),
                "recovery-tenant",
                "Synthetic recovery tenant",
                OffsetDateTime::now_utc(),
            )
            .await
            .unwrap();
        let org = OrgId::from_uuid(created.organization.id);
        let ops = UserId::from_uuid(created.admin_user_id);
        let old_key = if enrolled {
            Some(SoftKey::enroll(&owner, org, ops).await)
        } else {
            None
        };
        Self {
            owner,
            runtime,
            p,
            org,
            ops,
            a,
            b,
            old_key,
        }
    }
    pub async fn credential(&self, user: UserId) -> Uuid {
        sqlx::query_scalar("SELECT id FROM auth_webauthn_credentials WHERE user_id=$1 ORDER BY created_at,id LIMIT 1")
            .bind(user.as_uuid()).fetch_one(&self.owner).await.unwrap()
    }
    pub async fn command(
        &self,
        user: UserId,
        actor_org: OrgId,
        id: Uuid,
        command: C,
    ) -> Result<OpsRecoveryOutcome, ProvisioningError> {
        self.command_with_credential(user, actor_org, id, command, self.credential(user).await)
            .await
    }
    pub async fn command_with_credential(
        &self,
        user: UserId,
        actor_org: OrgId,
        id: Uuid,
        command: C,
        credential: Uuid,
    ) -> Result<OpsRecoveryOutcome, ProvisioningError> {
        let assertion = Uuid::new_v4();
        // HTTP tests exercise the verification boundary; these fixtures are trusted verified assertions.
        sqlx::query("INSERT INTO step_up_assertions(ceremony_id,org_id,user_id,credential_row_id,action_kind,object_id,payload_hash,user_verified) VALUES($1,$2,$3,$4,'OPERATOR_RECOVERY',$5,$6,true)")
            .bind(assertion).bind(actor_org.as_uuid()).bind(user.as_uuid()).bind(credential).bind(id).bind(command.payload_hash(self.org,id).unwrap()).execute(&self.owner).await.unwrap();
        self.p
            .write_ops_recovery(
                &self.runtime,
                OpsRecoveryActor {
                    user,
                    org: actor_org,
                    assertion,
                },
                self.org,
                id,
                command,
                &Uuid::new_v4().to_string(),
                OffsetDateTime::now_utc(),
            )
            .await
    }
    pub async fn vendor(
        &self,
        user: UserId,
        id: Uuid,
        command: C,
    ) -> Result<OpsRecoveryOutcome, ProvisioningError> {
        self.command(user, OrgId::platform(), id, command).await
    }
    pub async fn refusal(&self, user: UserId, id: Uuid, command: C, expected: &str) {
        code(self.vendor(user, id, command).await, expected);
    }
    pub async fn open(&self) -> Uuid {
        let id = Uuid::new_v4();
        self.vendor(self.a, id, open()).await.unwrap();
        id
    }
    pub async fn approved(&self) -> Uuid {
        let id = self.open().await;
        self.vendor(self.b, id, C::Approve).await.unwrap();
        id
    }
    pub async fn force_hold_elapse(&self, id: Uuid) {
        sqlx::query("UPDATE ops_recovery_requests SET hold_until=clock_timestamp()-interval '1 second' WHERE org_id=$1 AND id=$2")
            .bind(self.org.as_uuid()).bind(id).execute(&self.owner).await.unwrap();
    }
    pub async fn recovery_codes(&self) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM auth_bootstrap_credentials WHERE id IN (SELECT code_credential_id FROM ops_recovery_requests WHERE org_id=$1)")
            .bind(self.org.as_uuid()).fetch_one(&self.owner).await.unwrap()
    }
    pub async fn seed_session(&self) -> Uuid {
        let family: Uuid = sqlx::query_scalar("INSERT INTO auth_refresh_token_families(user_id,created_at,org_id) VALUES($1,clock_timestamp(),$2) RETURNING id")
            .bind(self.ops.as_uuid()).bind(self.org.as_uuid()).fetch_one(&self.owner).await.unwrap();
        sqlx::query("INSERT INTO auth_refresh_tokens(family_id,user_id,token_hash,issued_at,expires_at,org_id) VALUES($1,$2,$3,clock_timestamp(),clock_timestamp()+interval '1 day',$4)")
            .bind(family).bind(self.ops.as_uuid()).bind(vec![42_u8;32]).bind(self.org.as_uuid()).execute(&self.owner).await.unwrap();
        family
    }
    pub async fn assert_completed(&self, id: Uuid, token: &str) {
        let (ops, audit, notices, leaks): (i64, i64, i64, i64) = sqlx::query_as("SELECT (SELECT count(*) FROM users WHERE org_id=$1 AND is_tenant_ops AND is_active AND id=$2),(SELECT count(*) FROM audit_events WHERE org_id=$1 AND target_id=$3 AND action IN ('platform.tenant.ops_recovery.open','platform.tenant.ops_recovery.approve','platform.tenant.ops_recovery.issue')),(SELECT count(*) FROM notifications WHERE org_id=$1 AND recipient_user_id=$2 AND category='tenant.ops_recovery'),(SELECT count(*) FROM audit_events WHERE org_id=$1 AND (coalesce(after_snap::text,'') LIKE '%'||$4||'%' OR coalesce(before_snap::text,'') LIKE '%'||$4||'%'))")
            .bind(self.org.as_uuid()).bind(self.ops.as_uuid()).bind(id.to_string()).bind(token).fetch_one(&self.owner).await.unwrap();
        assert_eq!((ops, audit, notices, leaks), (1, 3, 2, 0));
        assert_eq!(self.recovery_codes().await, 1);
        let persisted: String = sqlx::query_scalar("SELECT response::text FROM api_idempotency_keys WHERE org_id=$1 AND operation='platform.tenant.ops_recovery.issue'")
            .bind(self.org.as_uuid()).fetch_one(&self.owner).await.unwrap();
        assert!(
            !persisted.contains(token),
            "idempotency receipts never retain the secret"
        );
    }
    pub async fn assert_expiry(&self, id: Uuid, token: &str) {
        let ttl = self
            .p
            .read_ops_recovery(&self.runtime, self.org, true, OffsetDateTime::now_utc())
            .await
            .unwrap()
            .code_ttl_minutes;
        let span: i64 = sqlx::query_scalar("SELECT extract(epoch from b.expires_at-b.issued_at)::bigint FROM auth_bootstrap_credentials b JOIN ops_recovery_requests r ON r.code_credential_id=b.id WHERE r.org_id=$1 AND r.id=$2")
            .bind(self.org.as_uuid()).bind(id).fetch_one(&self.owner).await.unwrap();
        assert_eq!(span, Duration::minutes(ttl).whole_seconds());
        sqlx::query("UPDATE auth_bootstrap_credentials SET issued_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' WHERE id=(SELECT code_credential_id FROM ops_recovery_requests WHERE org_id=$1 AND id=$2)")
            .bind(self.org.as_uuid()).bind(id).execute(&self.owner).await.unwrap();
        assert!(matches!(
            BootstrapCredentialStore
                .redeem_otp(&self.runtime, token, OffsetDateTime::now_utc())
                .await,
            Err(ProvisioningError::InvalidBootstrapCredential)
        ));
    }
}
