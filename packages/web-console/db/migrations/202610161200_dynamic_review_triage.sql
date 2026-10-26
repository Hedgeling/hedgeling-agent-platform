-- dynamic-data spec 08 (console review triage): dynamic rows are segregated,
-- not interleaved. The console derives is_dynamic + data_source from the
-- pseudo-file scheme (<sourceName>://…) at push/import time — DERIVED columns,
-- never client-supplied. `reach` (location count + overflow) is the dynamic
-- queue's sort key and updates on every push (repo-owned truth). `dynamic_enum`
-- + `enum_field` back the per-field source×locale grid view; `mask_names`
-- carries spec 06's per-placeholder mask names so the review UI can render
-- typed chips ({0:currency}) with mismatch highlighting.
alter table source_strings
  add column if not exists is_dynamic boolean not null default false,
  add column if not exists data_source text,
  add column if not exists reach integer,
  add column if not exists dynamic_enum boolean not null default false,
  add column if not exists enum_field text,
  add column if not exists mask_names text[];

-- Facet indexes: the default queue filters is_dynamic = false; the per-source
-- dynamic facets filter (project, data_source) and sort by reach descending.
create index if not exists idx_source_strings_dynamic_facet
  on source_strings(project_id, is_dynamic, data_source);
create index if not exists idx_source_strings_dynamic_reach
  on source_strings(project_id, data_source, reach desc)
  where is_dynamic;
