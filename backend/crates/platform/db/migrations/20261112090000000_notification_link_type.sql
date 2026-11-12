-- SPDX-License-Identifier: LicenseRef-Proprietary
-- migration-class: expand
-- migration-backfill: Adds the "type" tag two writers left off stored notification links; each link keeps its target. Application rollback reads the tagged form unchanged.
SET LOCAL lock_timeout = '2s';

-- The 운영 시작 and account-link notices were stored as {"screen": …} or
-- {"kind": …, "id": …} without the tag every reader decodes by, so one such
-- row failed the whole notice list it was in. The writers now store the tag.
UPDATE notifications SET link = jsonb_build_object('type', 'screen') || link
 WHERE NOT link ? 'type' AND link ? 'screen';
UPDATE notifications SET link = jsonb_build_object('type', 'object') || link
 WHERE NOT link ? 'type' AND link ? 'kind' AND link ? 'id';
