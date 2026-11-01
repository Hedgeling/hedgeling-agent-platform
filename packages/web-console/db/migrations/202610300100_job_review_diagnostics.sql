-- SPDX-License-Identifier: Apache-2.0
-- Bounded validation reasons and counts only; never persist rejected provider text.
alter table job_quality_runs add column error_detail jsonb;
