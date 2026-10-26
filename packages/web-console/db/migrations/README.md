# Ordered database migrations

`schema.sql` is the current bootstrap snapshot for a new database. Existing
databases advance through immutable files in this directory.

Migration filenames must use:

```text
YYYYMMDDHHMM_description.sql
```

Rules:

- never edit a migration after it has been applied;
- make the first release additive and compatible with the previous app;
- backfill in bounded, resumable batches;
- validate constraints and build large indexes in an approved database change,
  not implicitly during application startup;
- remove old columns or constraints only after every running task no longer
  depends on them; and
- update `schema.sql` in the same change so new databases receive the final
  shape.

The first production cutover from whole-schema replay is explicit and runs the
frozen candidate image inside the private ECS network:

```sh
IMAGE_URI=ACCOUNT.dkr.ecr.us-east-1.amazonaws.com/hedgeling-web-console:FULL_COMMIT \
CONFIRM_SCHEMA_BASELINE=ordered-migrations-v1-baseline \
infra/aws/baseline-ordered-migrations.sh
```

Run it once in a reviewed maintenance window after the preflight schema timing
and backup checkpoint. Normal production startup refuses to create the
baseline marker. After the marker exists, startup applies only unapplied,
checksum-verified ordered migrations.
