//! The 아이디 of an account (decisions #33; sign-in-identifier.md §7). Set at
//! invite (or the system default at commit), changed by a `user_manage` holder
//! with a reason and a 기준일. The old value stays an alias (sign-in for
//! [`SIGN_IN_ALIAS_DAYS`], search for good) and is never reissued: its row
//! keeps `PRIMARY KEY (org_id, login)`.

use crate::{PgOrgError, PgOrgStore};
use console_identity_application::user_audit_event;
use console_kernel_core::{KernelError, TraceContext, UserId};
use console_platform_auth::{SIGN_IN_ALIAS_DAYS, normalize_login};
use console_platform_db::{with_audits, with_org_conn};
use console_platform_request_context::current_org;
use console_settings_domain::code_lists::ReasonDomain;
use serde::Serialize;
use sqlx::{Postgres, Transaction};
use time::{Date, OffsetDateTime};
use uuid::Uuid;

/// A 아이디 change as the REST face validated its shape.
#[derive(Debug, Clone)]
pub struct SignInIdChange {
    pub login: String,
    pub effective_date: Date,
    pub reason_code: String,
    pub note: Option<String>,
}

/// One 아이디 an account held, newest first in a history.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct SignInIdRecord {
    /// The 아이디 part.
    pub login: String,
    /// `<아이디>@<회사 도메인>` as a person types it.
    pub sign_in_id: String,
    pub effective_date: Date,
    pub reason_code: String,
    pub note: Option<String>,
    pub assigned_by: Option<Uuid>,
    pub assigned_by_name: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub assigned_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub retired_at: Option<OffsetDateTime>,
    /// The old 아이디 signs in until then; `None` for the current one.
    #[serde(with = "time::serde::rfc3339::option")]
    pub alias_until: Option<OffsetDateTime>,
    /// `CURRENT`, `ALIAS` (still signs in) or `RESERVED` (searchable only).
    pub state: String,
}

/// The record projection (a macro so each query stays one `&'static str`).
macro_rules! records {
    () => {
        "SELECT s.login, s.login || '@' || o.slug AS sign_in_id, s.effective_date, \
       s.reason_code, s.note, s.assigned_by, a.display_name AS assigned_by_name, s.assigned_at, \
       s.retired_at, s.alias_until, \
       CASE WHEN s.retired_at IS NULL THEN 'CURRENT' \
            WHEN s.alias_until > now() THEN 'ALIAS' ELSE 'RESERVED' END AS state \
  FROM user_sign_in_ids s \
  JOIN organizations o ON o.id = s.org_id \
  LEFT JOIN users a ON a.id = s.assigned_by AND a.org_id = s.org_id \
 WHERE s.org_id = $1 AND s.user_id = $2"
    };
}

fn coded(kernel: KernelError, code: &'static str) -> PgOrgError {
    PgOrgError::Domain(kernel.with_code(code))
}

/// The normalised 아이디, or the typed 422.
pub fn parse_login(raw: &str) -> Result<String, PgOrgError> {
    normalize_login(raw).ok_or_else(|| {
        coded(
            KernelError::validation(
                "아이디는 영문 소문자, 숫자와 . _ - 만 쓸 수 있습니다 (1-32자, 기호로 시작·끝나거나 연달아 쓸 수 없음)",
            ),
            "sign_in_id_invalid",
        )
    })
}

/// Whether anyone in the tenant holds or held `login` (never reissued).
async fn ever_held(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    login: &str,
) -> Result<bool, PgOrgError> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM user_sign_in_ids WHERE org_id = $1 AND login = $2)",
    )
    .bind(org)
    .bind(login)
    .fetch_one(tx.as_mut())
    .await?)
}

fn taken() -> PgOrgError {
    coded(
        KernelError::conflict(
            "이미 쓰이고 있거나 쓰였던 아이디입니다. 한 번 쓰인 아이디는 다시 쓰이지 않습니다",
        ),
        "sign_in_id_taken",
    )
}

/// Set the 아이디 an invite names, in the creating transaction (the default
/// trigger then sees a current row and stays out).
pub(crate) async fn insert_invite_login_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    user: Uuid,
    login: &str,
    actor: Uuid,
) -> Result<(), PgOrgError> {
    if ever_held(tx, org, login).await? {
        return Err(taken());
    }
    sqlx::query(
        "INSERT INTO user_sign_in_ids (org_id, login, user_id, effective_date, reason_code, assigned_by) \
         VALUES ($1, $2, $3, (now() AT TIME ZONE 'Asia/Seoul')::date, 'INVITE', $4)",
    )
    .bind(org)
    .bind(login)
    .bind(user)
    .bind(actor)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

/// Give a new account its default 아이디 in the creating transaction, so the
/// create response already names it (the deferred trigger then stays out).
pub(crate) async fn assign_default_login_tx(
    tx: &mut Transaction<'_, Postgres>,
    org: Uuid,
    user: Uuid,
) -> Result<(), PgOrgError> {
    sqlx::query(
        "INSERT INTO user_sign_in_ids (org_id, login, user_id, effective_date, reason_code) \
         VALUES ($1, sign_in_id_default($1, $2), $2, (now() AT TIME ZONE 'Asia/Seoul')::date, 'SYSTEM_DEFAULT')",
    )
    .bind(org)
    .bind(user)
    .execute(tx.as_mut())
    .await?;
    Ok(())
}

impl PgOrgStore {
    /// Change an account's 아이디. 404 unknown account; 409 `sign_in_id_taken`
    /// (held or held before, including its own old values); 422
    /// `sign_in_id_unchanged`, `effective_date_in_future`, reason codes.
    pub async fn change_sign_in_id(
        &self,
        actor: UserId,
        user_id: UserId,
        change: SignInIdChange,
    ) -> Result<SignInIdRecord, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        let user = *user_id.as_uuid();
        with_audits::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                // One change at a time per account: the current row is the lock.
                let current: Option<String> = sqlx::query_scalar(
                    "SELECT s.login FROM users u \
                       LEFT JOIN user_sign_in_ids s ON s.org_id = u.org_id AND s.user_id = u.id \
                                                   AND s.retired_at IS NULL \
                      WHERE u.org_id = $1 AND u.id = $2 FOR UPDATE OF u",
                )
                .bind(org_uuid)
                .bind(user)
                .fetch_optional(tx.as_mut())
                .await?
                .ok_or_else(|| PgOrgError::Domain(KernelError::not_found("user not found")))?;
                if current.as_deref() == Some(change.login.as_str()) {
                    return Err(coded(
                        KernelError::validation("지금 아이디와 같습니다"),
                        "sign_in_id_unchanged",
                    ));
                }
                let future: bool =
                    sqlx::query_scalar("SELECT $1::date > (now() AT TIME ZONE 'Asia/Seoul')::date")
                        .bind(change.effective_date)
                        .fetch_one(tx.as_mut())
                        .await?;
                if future {
                    return Err(coded(
                        KernelError::validation("기준일은 오늘이나 그 이전이어야 합니다"),
                        "effective_date_in_future",
                    ));
                }
                console_settings_adapter_postgres::validate_reason_in_tx(
                    tx.as_mut(),
                    org,
                    ReasonDomain::SignInIdChange,
                    change.reason_code.trim(),
                    change.note.as_deref(),
                )
                .await?;
                if ever_held(tx, org_uuid, &change.login).await? {
                    return Err(taken());
                }
                sqlx::query(
                    "UPDATE user_sign_in_ids SET retired_at = now(), \
                            alias_until = now() + make_interval(days => $3) \
                      WHERE org_id = $1 AND user_id = $2 AND retired_at IS NULL",
                )
                .bind(org_uuid)
                .bind(user)
                .bind(i32::try_from(SIGN_IN_ALIAS_DAYS).unwrap_or(90))
                .execute(tx.as_mut())
                .await?;
                sqlx::query(
                    "INSERT INTO user_sign_in_ids \
                       (org_id, login, user_id, effective_date, reason_code, note, assigned_by) \
                     VALUES ($1, $2, $3, $4, $5, $6, $7)",
                )
                .bind(org_uuid)
                .bind(&change.login)
                .bind(user)
                .bind(change.effective_date)
                .bind(change.reason_code.trim())
                .bind(change.note.as_deref())
                .bind(*actor.as_uuid())
                .execute(tx.as_mut())
                .await?;
                let record: SignInIdRecord =
                    sqlx::query_as(concat!(records!(), " AND s.login = $3"))
                        .bind(org_uuid)
                        .bind(user)
                        .bind(&change.login)
                        .fetch_one(tx.as_mut())
                        .await?;
                let event = user_audit_event(
                    "user.sign_in_id.change",
                    Some(actor),
                    user_id,
                    TraceContext::generate(),
                    OffsetDateTime::now_utc(),
                )?
                .with_org(org)
                .with_snapshots(
                    Some(serde_json::json!({ "login": current })),
                    Some(serde_json::json!({
                        "login": change.login,
                        "effective_date": change.effective_date.to_string(),
                        "reason_code": record.reason_code,
                        "alias_days": SIGN_IN_ALIAS_DAYS,
                    })),
                );
                Ok((record, vec![event]))
            })
        })
        .await
    }

    /// Every 아이디 the account held, newest first.
    pub async fn sign_in_id_history(
        &self,
        user_id: UserId,
    ) -> Result<Vec<SignInIdRecord>, PgOrgError> {
        let org = current_org().map_err(KernelError::from)?;
        let org_uuid = *org.as_uuid();
        with_org_conn::<_, _, PgOrgError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                Ok(
                    sqlx::query_as(concat!(records!(), " ORDER BY s.assigned_at DESC, s.login"))
                        .bind(org_uuid)
                        .bind(*user_id.as_uuid())
                        .fetch_all(tx.as_mut())
                        .await?,
                )
            })
        })
        .await
    }
}
