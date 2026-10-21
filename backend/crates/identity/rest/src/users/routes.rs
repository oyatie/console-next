use crate::access_log;
use crate::authz::authorize_org_manage;
use crate::context::principal_from_headers;
use crate::error::RestError;
use crate::policy::delegation::ensure_assignment_preview_acknowledged;
use crate::policy::delegation::require_assignment_preview_receipt;
use crate::state::IdentityRestState;
use crate::users::account_link::account_link_refusal;
use crate::users::account_link::change_account_link;
use crate::users::authz::account_scope;
use crate::users::authz::authorize_user_write;
use crate::users::authz::elevated_role_membership_changes;
use crate::users::authz::elevated_roles_in;
use crate::users::authz::parse_roles;
use crate::users::authz::refuse_added_access;
use crate::users::authz::refuse_ops_target;
use crate::users::authz::role_db_strings;
use crate::users::authz::system_roles_changed;
use crate::users::dto::CreateUserRequest;
use crate::users::dto::ListUsersRequest;
use crate::users::dto::UpdateUserRequest;
use axum::Json;
use axum::extract::Path;
use axum::extract::Query;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use console_identity_adapter_postgres::IdempotentCreate;
use console_identity_application::CreateUserCommand;
use console_identity_application::UpdateUserCommand;
use console_identity_application::UserListQuery;
use console_kernel_core::BranchId;
use console_kernel_core::KernelError;
use console_kernel_core::TraceContext;
use console_kernel_core::UserId;
use console_platform_authz::Feature;
use console_platform_db::idempotency;
use time::OffsetDateTime;

// ---------------------------------------------------------------------------
// User handlers
// ---------------------------------------------------------------------------

pub(crate) async fn create_user(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Json(body): Json<CreateUserRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    refuse_added_access(&[], Some(&body.roles), &[], Some(&body.branch_ids))?;
    let roles = parse_roles(&body.roles)?;
    let elevated_role_changes = elevated_roles_in(&roles);
    authorize_user_write(&principal, &elevated_role_changes, &[], &body.branch_ids)?;
    let idempotency_key = idempotency::validate_idempotency_key(
        headers
            .get(idempotency::IDEMPOTENCY_KEY_HEADER)
            .and_then(|value| value.to_str().ok()),
    )
    .map_err(|message| RestError::from_kernel(KernelError::validation(message)))?;
    let fingerprint = serde_json::json!(&body);
    let sign_in_id = body
        .sign_in_id
        .as_deref()
        .filter(|login| !login.trim().is_empty())
        .map(console_identity_adapter_postgres::sign_in_id::parse_login)
        .transpose()
        .map_err(RestError::from_store)?;
    let created = state
        .store
        .create_user(
            CreateUserCommand {
                actor: principal.user_id,
                display_name: body.display_name,
                employee_id: body.employee_id,
                phone: body.phone,
                team: body.team,
                roles: role_db_strings(&roles),
                branch_ids: body.branch_ids,
                sign_in_id,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            },
            idempotency_key,
            fingerprint,
        )
        .await
        .map_err(RestError::from_store)?;
    let (status, response) = match created {
        IdempotentCreate::Created(response) => (StatusCode::CREATED, response),
        IdempotentCreate::Replay(response) => (StatusCode::OK, response),
    };
    Ok((status, Json(response)))
}

pub(crate) async fn list_users(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Query(query): Query<ListUsersRequest>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::UserManage)?;
    if query.offset.is_some_and(|offset| offset < 0) {
        return Err(RestError::from_kernel(KernelError::validation(
            "offset must be non-negative",
        )));
    }
    let page = state
        .store
        .list_users(
            &account_scope(&principal),
            UserListQuery {
                include_inactive: query.include_inactive,
                limit: query.limit,
                offset: query.offset,
            },
        )
        .await
        .map_err(RestError::from_store)?;
    access_log::record_account_page_read(state.pool(), &principal, "account.list_read", &page)
        .await?;
    Ok(Json(page))
}

pub(crate) async fn get_user(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
) -> Result<impl IntoResponse, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    authorize_org_manage(&principal, Feature::UserManage)?;
    let summary = state
        .store
        .get_user(UserId::from_uuid(id), &account_scope(&principal))
        .await
        .map_err(RestError::from_store)?;
    access_log::record_account_read(state.pool(), &principal, &summary).await?;
    Ok(Json(summary))
}

pub(crate) async fn update_user(
    State(state): State<IdentityRestState>,
    headers: HeaderMap,
    Path(id): Path<uuid::Uuid>,
    Json(body): Json<UpdateUserRequest>,
) -> Result<axum::response::Response, RestError> {
    let principal = principal_from_headers(&state, &headers).await?;
    let target_id = UserId::from_uuid(id);

    // Baseline: caller may manage users in their scope, and may only see/touch a
    // target within that scope (prevents cross-branch enumeration / IDOR).
    authorize_org_manage(&principal, Feature::UserManage)?;
    let target = state
        .store
        .get_user(target_id, &account_scope(&principal))
        .await
        .map_err(RestError::from_store)?;
    if body
        .employee_id
        .is_some_and(|requested| requested != target.employee_id)
        || body.account_link_request_id.is_some()
    {
        let started = std::time::Instant::now();
        let trace = TraceContext::generate();
        let result = change_account_link(&state, &principal, target_id, body, trace.clone()).await;
        let outcome = match &result {
            Ok(response) if response.status() == StatusCode::ACCEPTED => "pending",
            Ok(_) => "approved",
            Err(_) => "refused",
        };
        metrics::counter!("identity_account_link_total", "outcome" => outcome).increment(1);
        metrics::histogram!("identity_account_link_duration_seconds", "outcome" => outcome)
            .record(started.elapsed().as_secs_f64());
        return match result {
            Ok(response) => Ok(response),
            Err(error) => {
                Err(account_link_refusal(&state, principal.user_id, target_id, trace, error).await)
            }
        };
    }
    if body.roles.is_some() || body.branch_ids.is_some() {
        refuse_ops_target(target.is_tenant_ops)?;
    }
    refuse_added_access(
        &target.roles,
        body.roles.as_deref(),
        &target.branch_ids,
        body.branch_ids.as_deref(),
    )?;

    // Role/branch escalation guard: the *new* role set and the union of current
    // + requested branch sets must both be within the caller's authority. Run
    // whenever EITHER is being changed — a request that sets only `branch_ids`
    // (roles absent) must still prove branch authority over every branch the
    // user is being added to OR removed from, or a branch-scoped admin could
    // move a visible user into (or out of) branches they do not control
    // (console-0lj).
    let roles = match &body.roles {
        Some(raw) => Some(parse_roles(raw)?),
        None => None,
    };
    let mut preview_receipt_id = None;
    if roles.is_some() || body.branch_ids.is_some() {
        let elevated_role_changes =
            elevated_role_membership_changes(&target.roles, roles.as_ref())?;
        let target_branches = body
            .branch_ids
            .as_deref()
            .unwrap_or(target.branch_ids.as_slice());
        authorize_user_write(
            &principal,
            &elevated_role_changes,
            target.branch_ids.as_slice(),
            target_branches,
        )?;

        // Only an actual assignment change needs an impact-preview receipt. A
        // profile-only edit (e.g. phone) that re-sends the user's existing roles
        // and branches is a governance no-op and must not demand a preview; any
        // real role/branch change still requires it. (The escalation guard above
        // always runs.)
        let roles_changed = roles
            .as_ref()
            .is_some_and(|r| system_roles_changed(r, &target.roles));
        let branches_changed = body.branch_ids.as_ref().is_some_and(|requested| {
            let normalize = |branches: &[BranchId]| {
                let mut out = branches.to_vec();
                out.sort();
                out.dedup();
                out
            };
            normalize(requested) != normalize(&target.branch_ids)
        });
        if roles_changed || branches_changed {
            ensure_assignment_preview_acknowledged(&principal, body.preview_acknowledged)?;
            preview_receipt_id = Some(require_assignment_preview_receipt(
                &principal,
                body.preview_receipt_id,
            )?);
        }
    }

    let trace = TraceContext::generate();
    let result = state
        .store
        .update_user(UpdateUserCommand {
            actor: principal.user_id,
            user_id: target_id,
            display_name: body.display_name,
            employee_id: body.employee_id,
            phone: body.phone,
            team: body.team,
            roles: roles.as_ref().map(role_db_strings),
            branch_ids: body.branch_ids,
            preview_receipt_id,
            trace: trace.clone(),
            occurred_at: OffsetDateTime::now_utc(),
        })
        .await;
    let summary = match result {
        Ok(summary) => summary,
        Err(error) => {
            let error = RestError::from_store(error);
            return Err(if error.code == "account_link_approval_required" {
                account_link_refusal(&state, principal.user_id, target_id, trace, error).await
            } else {
                error
            });
        }
    };
    Ok(Json(summary).into_response())
}
