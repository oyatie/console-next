//! [`super::korean_message`] exact messages, part: 인적사항 extras and 사진
//! uploads (MR-34, lane EMP-FACTS).

/// Exact English message → Korean (합니다체).
pub(super) const MESSAGES: &[(&str, &str)] = &[
    (
        "name_hanja must be 한자 (CJK ideographs), 30 characters or fewer",
        "한자 성명은 한자로 30자까지 입력할 수 있습니다.",
    ),
    (
        "name_en must be Latin letters with spaces, - ' . or , (100 characters or fewer)",
        "영문 성명은 영문자와 공백, - ' . , 만 써서 100자까지 입력할 수 있습니다.",
    ),
    (
        "nationality must be an ISO 3166-1 alpha-2 code such as KR",
        "국적은 KR처럼 두 글자 국가 코드(ISO 3166-1)로 입력해야 합니다.",
    ),
    (
        "personal_email must be a mailbox like name@example.com",
        "개인 메일은 name@example.com 형식이어야 합니다.",
    ),
    (
        "emergency_contacts holds at most 3 people",
        "비상연락처는 3명까지 입력할 수 있습니다.",
    ),
    (
        "changes.emergency_contacts must be a list of {name, relation, phone} (relation: SPOUSE, PARENT, CHILD, SIBLING, RELATIVE or OTHER)",
        "비상연락처는 이름, 관계, 전화번호 목록으로 입력해야 합니다.",
    ),
    (
        "name is required, 50 characters or fewer",
        "이름은 필수이며 50자까지 입력할 수 있습니다.",
    ),
    ("phone is required", "전화번호가 필요합니다."),
    (
        "group_service_start_date must be a YYYY-MM-DD date",
        "그룹 입사일은 YYYY-MM-DD 형식이어야 합니다.",
    ),
    (
        "group_service_start_date must be on or before the hire date (and not before 1900)",
        "그룹 입사일은 입사일과 같거나 앞서야 하며 1900년 이후여야 합니다.",
    ),
    (
        "changes.photo must be a photo upload id",
        "사진은 올린 사진의 번호(upload_id)로 지정해야 합니다.",
    ),
    (
        "the photo has not been uploaded yet; confirm the upload first",
        "사진 올리기가 아직 확인되지 않았습니다. 올리기를 먼저 확인해 주십시오.",
    ),
    (
        "no photo upload with this id exists for this employee",
        "이 직원에게 올린 사진 중 해당 번호가 없습니다.",
    ),
    (
        "a photo must be JPEG, PNG or WebP",
        "사진은 JPEG, PNG 또는 WebP 파일이어야 합니다.",
    ),
    (
        "a photo must be 1 to 5242880 bytes",
        "사진은 5MB까지 올릴 수 있습니다.",
    ),
    (
        "photo storage is not configured on this server",
        "이 서버에는 사진 저장소가 설정되어 있지 않습니다.",
    ),
    (
        "the photo upload could not be prepared; try again",
        "사진 올리기를 준비하지 못했습니다. 다시 시도해 주십시오.",
    ),
    (
        "the photo was not found in storage; upload it, then confirm again",
        "저장소에서 사진을 찾지 못했습니다. 사진을 올린 뒤 다시 확인해 주십시오.",
    ),
    (
        "the stored photo is not the size that was declared; upload it again",
        "올린 사진의 크기가 알린 크기와 다릅니다. 다시 올려 주십시오.",
    ),
];
