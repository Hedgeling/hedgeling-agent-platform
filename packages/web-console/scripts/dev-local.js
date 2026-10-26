import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateLocalDatabase } from "../src/local-auth.js";
import { migrateDatabase } from "../src/migrations.js";
import { pool, withTransaction } from "../src/db.js";

// This command only prepares a disposable, local database. It never reads
// AWS secrets, loads a repository .env, or creates platform administrators.
if (process.env.NODE_ENV === "production") throw new Error("dev:local cannot run in production");
validateLocalDatabase();
await migrateDatabase();
const userId = process.env.HEDGELING_LOCAL_USER_ID || await withTransaction(async (client) => {
  const organization = await client.query(
    `insert into organizations(slug, name) values('hedgeling-local', 'Local troubleshooting')
     on conflict(slug) do update set name = excluded.name returning id`,
  );
  const orgId = organization.rows[0].id;
  const unit = await client.query(
    `insert into business_units(organization_id, slug, name) values($1, 'default', 'Default')
     on conflict(organization_id, slug) do update set name = excluded.name returning id`, [orgId],
  );
  await client.query(
    `insert into projects(slug, name, business_unit_id) values('hedgeling-local', 'Local project', $1)
     on conflict(slug) do nothing`, [unit.rows[0].id],
  );
  const user = await client.query(
    `insert into users(email, display_name) values('developer@hedgeling.example', 'Local developer')
     on conflict((lower(email))) do update set display_name = excluded.display_name
     returning id, status, platform_staff`,
  );
  const row = user.rows[0];
  if (row.status !== 'active' || row.platform_staff) throw new Error("Local fixture user must be active and must not be platform staff");
  await client.query(
    `insert into organization_memberships(organization_id, user_id, status, activated_at)
     values($1, $2, 'active', now()) on conflict(organization_id, user_id) do nothing`, [orgId, row.id],
  );
  await client.query(
    `insert into role_assignments(principal_type, principal_id, role_id, scope_type, scope_id, inherit_to_children)
     select 'user', $1, r.id, 'organization', $2, true from roles r
     where r.key = 'organization_owner' and r.organization_id is null
       and not exists(select 1 from role_assignments a where a.principal_type = 'user'
         and a.principal_id = $1 and a.role_id = r.id and a.scope_type = 'organization'
         and a.scope_id = $2 and a.revoked_at is null)`, [row.id, orgId],
  );
  return row.id;
});
await pool.end();

const token = crypto.randomBytes(32).toString("base64url");
const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
const port = process.env.PORT || "8080";
const env = {
  ...process.env, NODE_ENV: "development", HEDGELING_AUTH_MODE: "local",
  HEDGELING_TRUST_PROXY_HOPS: "0", HEDGELING_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
  HEDGELING_LOCAL_USER_ID: userId, HEDGELING_LOCAL_AUTH_TOKEN: token,
  HEDGELING_LOCAL_AUTH_EXPIRES_AT: expiresAt,
  HEDGELING_SELF_SERVICE_SIGNUP_ENABLED: "false",
};
for (const key of Object.keys(env)) {
  if (key.startsWith("COGNITO_") || ["ADMIN_PASSWORD", "HEDGELING_ADMIN_PASSWORD", "HEDGELING_DEV_AUTH"].includes(key)) delete env[key];
}
console.log(`Local console: http://127.0.0.1:${port}/local-login`);
console.log(`User: ${userId}; session expires ${expiresAt}`);
console.log(`Local login token (keep private): ${token}`);
const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url))], {
  env, stdio: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
