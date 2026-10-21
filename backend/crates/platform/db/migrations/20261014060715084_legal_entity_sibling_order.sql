-- Expand only; released migrations are immutable.
-- org-sibling-order: the 법인 order inside the tenant, the last sibling set
-- without one (사업장: workplaces.sort_order, 부서: org_unit_positions, 0299).
-- A label like those: written in place in both phases and audited, never
-- dated; the knowledge history (0321) keeps what was known when. N-1 ignores
-- the column and keeps creation order.
SET LOCAL lock_timeout = '2s';

-- NULL sorts after every set position (then by creation), so a new 법인 lands last.
ALTER TABLE legal_entities ADD COLUMN sort_order INTEGER NULL CHECK (sort_order IS NULL OR sort_order >= 0);
COMMENT ON COLUMN legal_entities.sort_order IS 'pd:none — position among the tenant''s 법인 (label); NULL = after the ordered ones';
GRANT UPDATE (sort_order) ON legal_entities TO console_rt;

-- Live propagation (§13.21): a 법인 order re-reads the 법인 lists, and a
-- 사업장 order the 법인 reads that embed their 사업장 (the org_unit frame
-- 0312 emits reaches only the structure reads).
INSERT INTO realtime_topic_map (target_type, action, resource_type, carries_id) VALUES
    ('tenant', 'org_structure.reorder', 'legal_entity', false),
    ('legal_entity', 'org_structure.reorder', 'workplace', false);
