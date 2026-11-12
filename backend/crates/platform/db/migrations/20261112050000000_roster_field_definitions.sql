-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- The fields a tenant adds to its personnel card: their definitions only (values come later).
SET LOCAL lock_timeout = '2s';

-- Tenant, type and section are fixed once added (no UPDATE grant on them); a field is
-- retired, never deleted. First release: two card sections and managers-only
-- visibility, each a CHECK so widening it later touches no row.
CREATE TABLE roster_field_definitions (
    org_id      UUID        NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
    id          UUID        NOT NULL DEFAULT gen_random_uuid(),
    label       TEXT        NOT NULL
        CONSTRAINT roster_field_definitions_label_shape CHECK (btrim(label) = label AND char_length(label) BETWEEN 1 AND 60),
    label_key   TEXT        GENERATED ALWAYS AS (lower(label)) STORED,
    value_type  TEXT        NOT NULL
        CONSTRAINT roster_field_definitions_value_type CHECK (value_type IN ('TEXT', 'INTEGER', 'DECIMAL', 'DATE', 'CHOICE')),
    section     TEXT        NOT NULL
        CONSTRAINT roster_field_definitions_section CHECK (section IN ('PERSONAL', 'JOB')),
    visibility  TEXT        NOT NULL DEFAULT 'MANAGERS'
        CONSTRAINT roster_field_definitions_visibility CHECK (visibility = 'MANAGERS'),
    choices     JSONB       NOT NULL DEFAULT '[]'::jsonb
        CONSTRAINT roster_field_definitions_choices_shape CHECK (
            jsonb_typeof(choices) = 'array'
            AND (value_type = 'CHOICE') = (jsonb_array_length(choices) > 0)
            AND jsonb_array_length(choices) <= 50),
    active      BOOLEAN     NOT NULL DEFAULT true,
    created_by  UUID        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, id),
    CONSTRAINT roster_field_definitions_org_label_key UNIQUE (org_id, label_key),
    FOREIGN KEY (created_by, org_id) REFERENCES users (id, org_id) ON DELETE RESTRICT
);

ALTER TABLE roster_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE roster_field_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON roster_field_definitions
    USING (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
    WITH CHECK (org_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT ON roster_field_definitions TO console_rt;
GRANT UPDATE (label, choices, active) ON roster_field_definitions TO console_rt;

COMMENT ON TABLE roster_field_definitions IS 'Fields a tenant adds to its personnel card; retired, never deleted; never a pay item';
COMMENT ON COLUMN roster_field_definitions.org_id IS 'pd:none — tenant';
COMMENT ON COLUMN roster_field_definitions.id IS 'pd:none — field id; the stable name values and imports refer to';
COMMENT ON COLUMN roster_field_definitions.label IS 'pd:none — the field''s name on the card';
COMMENT ON COLUMN roster_field_definitions.label_key IS 'pd:none — lower(label): the label is unique per tenant ignoring case, retired fields included';
COMMENT ON COLUMN roster_field_definitions.value_type IS 'pd:none — TEXT, INTEGER, DECIMAL, DATE or CHOICE; fixed once added';
COMMENT ON COLUMN roster_field_definitions.section IS 'pd:none — card section: PERSONAL (인적사항) or JOB (재직·배치); fixed once added';
COMMENT ON COLUMN roster_field_definitions.visibility IS 'pd:none — who reads its values: MANAGERS (not the person themselves)';
COMMENT ON COLUMN roster_field_definitions.choices IS 'pd:none — a CHOICE field''s options [{id, label}]; an option keeps its id when relabelled and is never removed';
COMMENT ON COLUMN roster_field_definitions.active IS 'pd:none — false retires the field: hidden from new entry, its values kept';
COMMENT ON COLUMN roster_field_definitions.created_by IS 'pd:personal — user who added the field';
COMMENT ON COLUMN roster_field_definitions.created_at IS 'pd:none — when the field was added';
