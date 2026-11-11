-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
SET LOCAL lock_timeout = '2s';

-- Keep existing contracts and writers valid; absent schedule facts are not a full-time default.
ALTER TABLE employee_contracts
    ADD COLUMN daily_minutes INTEGER
        CHECK (daily_minutes IS NULL OR (daily_minutes BETWEEN 1 AND 1440));
ALTER TABLE employee_contracts
    ADD COLUMN scheduled_days_per_week INTEGER
        CHECK (scheduled_days_per_week IS NULL OR (scheduled_days_per_week BETWEEN 1 AND 7));
ALTER TABLE employee_contracts
    ADD COLUMN weekly_paid_minutes INTEGER
        CHECK (weekly_paid_minutes IS NULL OR (weekly_paid_minutes BETWEEN 0 AND 10080));
ALTER TABLE employee_contracts
    ADD COLUMN terms_effective_from DATE
        CHECK (terms_effective_from IS NULL OR (
            terms_effective_from >= start_date
            AND (end_date IS NULL OR terms_effective_from <= end_date)));

COMMENT ON COLUMN employee_contracts.daily_minutes IS 'pd:personal — 1일 소정근로시간(분); NULL은 미확인';
COMMENT ON COLUMN employee_contracts.scheduled_days_per_week IS 'pd:personal — 1주 소정근로일수; NULL은 미확인';
COMMENT ON COLUMN employee_contracts.weekly_paid_minutes IS 'pd:personal — 소정근로시간 외에 유급으로 처리되는 주당 시간(분), 근로기준법 시행령 제6조제2항제3호; NULL은 미확인, 0은 없음';
COMMENT ON COLUMN employee_contracts.terms_effective_from IS 'pd:personal — 임금·근로시간 조건 적용일; NULL은 계약 시작일부터 적용';
