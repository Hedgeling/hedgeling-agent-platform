-- P-06 (review workflow): the console mislabeled every non-Gemini machine
-- translation as 'gemini' and dropped the P-02 provider metadata the
-- confidence-fed review queue depends on. Widen the source vocabulary, carry
-- provider/model/confidence on translations, and add the reviewer decision
-- fields (human_status 'rejected' + review_note).
alter table translations drop constraint if exists translations_source_check;
alter table translations add constraint translations_source_check
  check (source in ('gemini', 'mt', 'mt-carryover', 'human', 'stub'));

alter table translations
  add column if not exists provider text,
  add column if not exists model text,
  add column if not exists confidence double precision,
  add column if not exists review_note text;

alter table translation_revisions drop constraint if exists translation_revisions_revision_source_check;
alter table translation_revisions add constraint translation_revisions_revision_source_check
  check (revision_source in ('gemini', 'mt', 'mt-carryover', 'human', 'stub'));
