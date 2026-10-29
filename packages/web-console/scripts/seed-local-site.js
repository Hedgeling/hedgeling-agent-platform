import { withTransaction } from '../src/db.js';
import { validateLocalDatabase } from '../src/local-auth.js';

// Explicit local test access. No Stripe subscription or hosted data is touched.
export async function seedLocalSite(userId) {
  validateLocalDatabase();
  if (process.env.NODE_ENV === 'production' || new URL(process.env.DATABASE_URL).pathname !== '/hedgeling_workbench') {
    throw new Error('Local site seed requires the dedicated hedgeling_workbench database.');
  }
  await withTransaction(async db => {
    const org = (await db.query("select id from organizations where slug='hedgeling-local'")).rows[0]?.id;
    if (!org) throw new Error('Create the local owner workspace first.');
    await db.query("update organizations set name='Local sandbox' where id=$1 and name='Local troubleshooting'", [org]);
    const account = (await db.query(`insert into billing_accounts(organization_id,metadata)
      values($1,'{"localTest":true,"externalBilling":false}') on conflict(organization_id)
      do update set organization_id=excluded.organization_id returning id`, [org])).rows[0].id;
    await db.query(`insert into subscriptions(billing_account_id,plan_id,state,current_period_start,current_period_end,metadata)
      select $1,id,'active',now(),now()+interval '1 year','{"localTest":true,"externalBilling":false}'
      from product_plans where key='business-v1'
      and not exists(select 1 from subscriptions where billing_account_id=$1 and state<>'canceled')`, [account]);
    await db.query(`insert into organization_entitlement_overrides(organization_id,entitlement_key,enabled,limits,reason,granted_by_user_id)
      select $1,'agent_chat',true,'{"dailyUserTokens":10000000,"periodOrganizationTokens":50000000}',
        'Local development only; real provider usage still applies',$2
      where not exists(select 1 from organization_entitlement_overrides where organization_id=$1 and entitlement_key='agent_chat' and superseded_at is null)`, [org, userId]);
    await db.query(`insert into locales(project_id,locale)
      select p.id,l.locale from projects p cross join (values('fr-CA'),('ru-RU'),('de')) l(locale)
      where p.slug='hedgeling-local' on conflict(project_id,locale) do nothing`);
    await db.query("update projects set source_locale='en' where slug='hedgeling-local' and source_locale is null");
  });
}
