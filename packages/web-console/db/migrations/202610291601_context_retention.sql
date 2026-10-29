-- SPDX-License-Identifier: Apache-2.0
-- Accepted project guidance outlives a conversation's retention period.
alter table context_enrichment_runs alter column proposal_id drop not null;
alter table context_enrichment_runs drop constraint context_enrichment_runs_proposal_id_fkey;
alter table context_enrichment_runs add constraint context_enrichment_runs_proposal_id_fkey
  foreign key(proposal_id) references agent_proposals(id) on delete set null;
