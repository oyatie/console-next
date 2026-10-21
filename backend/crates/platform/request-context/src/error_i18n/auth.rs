//! [`super::korean_message`] exact messages, part: Idempotency-Key and authentication / authorization.

/// Exact English message → Korean (합니다체).
pub(super) const MESSAGES: &[(&str, &str)] = &[
    // Idempotency-Key (org change, users, lifecycle events, exit cases)
    (
        "Idempotency-Key header is required",
        "Idempotency-Key 헤더가 필요합니다.",
    ),
    (
        "Idempotency-Key must be 16..200 characters",
        "Idempotency-Key는 16~200자여야 합니다.",
    ),
    (
        "idempotency key was reused with a different request",
        "같은 Idempotency-Key로 다른 요청을 보낼 수 없습니다.",
    ),
    (
        "idempotency key already used with a different employee payload",
        "같은 멱등 키로 다른 직원 정보를 보낼 수 없습니다.",
    ),
    (
        "employee number or idempotency key is already in use",
        "사번 또는 멱등 키가 이미 사용 중입니다.",
    ),
    // Authentication / authorization (auth, platform, every tenant route)
    (
        "missing or malformed bearer token",
        "인증 토큰이 없거나 형식이 올바르지 않습니다.",
    ),
    ("invalid bearer token", "인증 토큰이 유효하지 않습니다."),
    (
        "token tier is not valid for this route",
        "이 경로에서 사용할 수 없는 토큰입니다.",
    ),
    (
        "enroll a passkey before performing this action",
        "이 작업을 하려면 먼저 패스키를 등록해야 합니다.",
    ),
    (
        "enroll a passkey before creating tenants",
        "테넌트를 만들려면 먼저 패스키를 등록해야 합니다.",
    ),
    (
        "invalid or expired one-time code",
        "일회용 코드가 올바르지 않거나 만료되었습니다.",
    ),
    (
        "resetting credentials requires a step-up assertion of your passkey",
        "자격 증명을 초기화하려면 먼저 본인 패스키로 확인해야 합니다.",
    ),
    (
        "removing a passkey requires a step-up assertion of your passkey",
        "패스키를 삭제하려면 먼저 본인 패스키로 확인해야 합니다.",
    ),
    (
        "reissuing a tenant admin code requires a step-up assertion of your passkey",
        "관리자 코드를 다시 발급하려면 먼저 본인 패스키로 확인해야 합니다.",
    ),
    ("passkey step-up failed", "본인 패스키 확인에 실패했습니다."),
    ("passkey sign-in failed", "패스키로 로그인하지 못했습니다."),
    (
        "passkey ceremony failed",
        "패스키 확인 중 서버 오류가 발생했습니다.",
    ),
    (
        "issuing a sign-in code requires a step-up assertion of your passkey",
        "로그인 코드를 발급하려면 먼저 본인 패스키로 확인해야 합니다.",
    ),
    (
        "adding a passkey requires a step-up assertion of an existing passkey",
        "패스키를 추가하려면 먼저 등록된 패스키로 확인해야 합니다.",
    ),
    (
        "minting an enrollment handoff requires a step-up assertion of an existing passkey",
        "다른 기기에서 패스키를 등록하려면 먼저 등록된 패스키로 확인해야 합니다.",
    ),
    (
        "deactivating an account requires a fresh passkey step-up",
        "계정을 비활성화하려면 먼저 본인 패스키로 확인해야 합니다.",
    ),
    (
        "creating a group account requires a step-up assertion of your passkey",
        "그룹 계정을 만들려면 먼저 본인 패스키로 확인해야 합니다.",
    ),
    (
        "assigning an organization to a group requires a step-up assertion of your passkey",
        "조직을 그룹에 배정하려면 먼저 본인 패스키로 확인해야 합니다.",
    ),
    (
        "force-removing a tenant requires a step-up assertion of your passkey",
        "테넌트와 데이터를 삭제하려면 먼저 본인 패스키로 확인해야 합니다.",
    ),
    (
        "enroll a passkey before reissuing tenant admin codes",
        "관리자 코드를 다시 발급하려면 먼저 패스키를 등록해야 합니다.",
    ),
    (
        "passkey step-up is not configured for the platform API",
        "플랫폼 API에 본인 패스키 확인이 설정되어 있지 않습니다.",
    ),
    (
        "passkey step-up is not configured for identity API",
        "계정 API에 본인 패스키 확인이 설정되어 있지 않습니다.",
    ),
    (
        "branch_id is required for a branch-scoped user",
        "지점 소속 사용자에게는 지점(branch_id)을 지정해야 합니다.",
    ),
    (
        "too many requests; please retry later",
        "요청이 너무 많습니다. 잠시 후 다시 시도해 주십시오.",
    ),
    (
        "role is not allowed to use feature",
        "이 기능을 사용할 권한이 없습니다.",
    ),
    (
        "resource branch is outside principal scope",
        "담당 지점 범위를 벗어난 대상입니다.",
    ),
    (
        "principal has no branch scope",
        "담당 지점이 지정되지 않았습니다.",
    ),
    (
        "feature is unavailable in v1",
        "현재 버전에서는 사용할 수 없는 기능입니다.",
    ),
    (
        "not allowed to manage users in that branch",
        "해당 지점의 사용자를 관리할 권한이 없습니다.",
    ),
    (
        "not allowed to change elevated roles",
        "상위 역할을 변경할 권한이 없습니다.",
    ),
    (
        "request references an unknown region or branch",
        "존재하지 않는 지역 또는 지점을 참조했습니다.",
    ),
    ("user not found", "사용자를 찾을 수 없습니다."),
    (
        "direct region/branch mutation is disabled; submit an OrgProposal instead",
        "지역·지점은 직접 변경할 수 없습니다. 조직 변경 기안을 제출해 주십시오.",
    ),
];
