import { pool, query, withTransaction } from '../src/db.js';

// Operator-only seed for the isolated synthetic demo, never invoked at startup.
// Repository identity comes from private deployment configuration, not the model.
try {
  if (process.env.HEDGELING_DEMO_SEED_ENABLED !== 'true') throw new Error('Demo seed is disabled');
  if ((await query('select current_database() as name')).rows[0].name !== 'hedgeling_demo') throw new Error('An isolated demo database is required');
  const source = JSON.parse(process.env.HEDGELING_DEMO_SOURCE || '{}');
  if (source.connectionId !== 'hackathon-source' || source.owner !== 'Hedgeling' || source.repository !== 'hedgeling-meta-hackathon'
    || !Number.isSafeInteger(source.repositoryId) || source.repositoryId <= 0) throw new Error('Supply the verified synthetic GitHub connection');
  await withTransaction(async client => {
    await client.query("select pg_advisory_xact_lock(hashtext('hedgeling:demo-extraction-seed'))");
    const org = (await client.query("select id,metadata from organizations where slug='hackathon-demo' for update")).rows[0];
    if (!org || org.metadata?.synthetic !== true) throw new Error('The synthetic demo workspace must already exist');
    const existingUnit = (await client.query("select id,metadata from business_units where organization_id=$1 and slug='source-demo'", [org.id])).rows[0];
    if (existingUnit && existingUnit.metadata?.extractionDemo !== true) throw new Error('The demo unit slug is already in use');
    const unit = existingUnit || (await client.query(`insert into business_units(organization_id,slug,name,metadata)
      values($1,'source-demo','Source demo','{"extractionDemo":true}') returning id`, [org.id])).rows[0];
    const existing = (await client.query("select id,business_unit_id,name,source_locale from projects where slug='extraction-demo'")).rows[0];
    if (existing && (existing.business_unit_id !== unit.id || existing.name !== 'Source extraction demo' || existing.source_locale !== 'en-US')) throw new Error('The demo project slug is already in use');
    const project = existing || (await client.query(`insert into projects(business_unit_id,slug,name,source_locale)
      values($1,'extraction-demo','Source extraction demo','en-US') returning id`, [unit.id])).rows[0];
    const bound = (await client.query('select * from extraction_connections where project_id=$1 and connection_id=$2', [project.id, source.connectionId])).rows[0];
    if (bound) {
      if (String(bound.repository_id) !== String(source.repositoryId) || bound.repository_owner !== source.owner
        || bound.repository_name !== source.repository || JSON.stringify(bound.allowed_roots) !== JSON.stringify(['examples/source'])
        || !bound.active || bound.default_ref !== 'main') throw new Error('The existing connection changed; review it before reseeding');
    } else {
      await client.query(`insert into extraction_connections(project_id,connection_id,repository_id,repository_owner,repository_name,allowed_roots,default_ref)
        values($1,$2,$3,$4,$5,array['examples/source'],'main')`, [project.id, source.connectionId, source.repositoryId, source.owner, source.repository]);
    }
  });
  console.log('Synthetic source project ready; only examples/source is allowed. No extraction or import started.');
} finally { await pool.end(); }
