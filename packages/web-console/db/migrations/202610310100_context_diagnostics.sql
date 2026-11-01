-- SPDX-License-Identifier: Apache-2.0
-- Keep bounded validation reasons/counts, never rejected provider text.
alter table context_enrichment_runs add column error_detail jsonb;
