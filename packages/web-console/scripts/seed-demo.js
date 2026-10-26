import { pool, query, withTransaction } from "../src/db.js";
import { migrateDatabase } from "../src/migrations.js";

// Explicit one-off bootstrap, never invoked by the web server or deployment job.
// Email addresses are supplied privately in the task override, not in source.
try {
  if (process.env.HEDGELING_DEMO_SEED_ENABLED !== "true") throw new Error("Demo seed is disabled");
  if ((await query("select current_database() as name")).rows[0].name !== "hedgeling_demo") throw new Error("Demo seed requires the isolated hedgeling_demo database");
  const emails = JSON.parse(process.env.HEDGELING_DEMO_OWNER_EMAILS || "[]");
  if (!Array.isArray(emails) || !emails.length || emails.length > 10 || emails.some((email) => typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) throw new Error("Supply the invited demo owner emails");
  // Only a fresh, verified demo database can establish the production baseline.
  const fresh = !(await query("select to_regclass('organizations') as relation")).rows[0].relation;
  if (fresh) process.env.HEDGELING_ALLOW_SCHEMA_BASELINE = "true";
  await migrateDatabase();
  await withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext('hedgeling:demo-seed'))");
    const org = (await client.query(`insert into organizations(slug,name,metadata)
      values('hackathon-demo','Hackathon demo','{"synthetic":true}')
      on conflict(slug) do update set slug=excluded.slug returning id`)).rows[0].id;
    await client.query("insert into organization_identity_policies(organization_id) values($1) on conflict do nothing", [org]);
    for (const email of new Set(emails.map((value) => value.toLowerCase().trim()))) {
      const user = (await client.query(`insert into users(email,display_name) values($1,$2)
        on conflict((lower(email))) do update set email=excluded.email returning id,status,platform_staff`, [email, email.split("@")[0]])).rows[0];
      if (user.status !== "active" || user.platform_staff) throw new Error("Demo owner must be an active non-staff user");
      await client.query(`insert into organization_memberships(organization_id,user_id,status,activated_at)
        values($1,$2,'active',now()) on conflict(organization_id,user_id) do nothing`, [org, user.id]);
      await client.query(`insert into role_assignments(principal_type,principal_id,role_id,scope_type,scope_id,inherit_to_children)
        select 'user',$1,r.id,'organization',$2,true from roles r
        where r.key='organization_owner' and r.organization_id is null
        and not exists(select 1 from role_assignments a where a.principal_type='user' and a.principal_id=$1
          and a.role_id=r.id and a.scope_type='organization' and a.scope_id=$2 and a.revoked_at is null)`, [user.id, org]);
    }
    // Synthetic access only: no Stripe customer, subscription, card or charge.
    const account = (await client.query(`insert into billing_accounts(organization_id,metadata)
      values($1,'{"demo":true,"externalBilling":false}') on conflict(organization_id)
      do update set organization_id=excluded.organization_id returning id`, [org])).rows[0].id;
    await client.query(`insert into subscriptions(billing_account_id,plan_id,state,current_period_start,current_period_end,metadata)
      select $1,id,'active',now(),now()+interval '30 days','{"demo":true,"externalBilling":false}'
      from product_plans where key='business-v1'
      and not exists(select 1 from subscriptions where billing_account_id=$1 and state<>'canceled')`, [account]);
  });
  console.log("Demo schema, workspace and invited owner memberships are ready; no external billing was created.");
} finally { await pool.end(); }
