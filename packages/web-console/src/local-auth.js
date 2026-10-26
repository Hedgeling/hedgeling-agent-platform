import crypto from "node:crypto";
import { query } from "./db.js";
import { isUuid } from "./validation.js";

export const LOCAL_SESSION_COOKIE = "hedgeling_local_session";
const loopback = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function validateLocalDatabase(env = process.env) {
  let url;
  try { url = new URL(env.DATABASE_URL); } catch { /* handled below */ }
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol)
    || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    || [...url.searchParams.keys()].some((key) => ["host", "hostaddr", "port", "service"].includes(key))) {
    throw new Error("Local troubleshooting requires DATABASE_URL pointing to a disposable loopback PostgreSQL database");
  }
}

export function validateLocalAuthentication(env = process.env, now = Date.now()) {
  if (env.NODE_ENV !== "development") throw new Error("Local authentication requires NODE_ENV=development");
  validateLocalDatabase(env);
  if (Number(env.HEDGELING_TRUST_PROXY_HOPS || 0) !== 0) {
    throw new Error("Local authentication does not support proxies");
  }
  if (!isUuid(env.HEDGELING_LOCAL_USER_ID)) throw new Error("HEDGELING_LOCAL_USER_ID must identify a local development user");
  if (!/^[A-Za-z0-9_-]{43,}$/.test(env.HEDGELING_LOCAL_AUTH_TOKEN || "")) {
    throw new Error("HEDGELING_LOCAL_AUTH_TOKEN must be a randomly generated token of at least 32 bytes");
  }
  const expiresAt = Date.parse(env.HEDGELING_LOCAL_AUTH_EXPIRES_AT || "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 8 * 60 * 60 * 1000) {
    throw new Error("Local authentication must expire within eight hours");
  }
}

export function localRequestAllowed(req, env = process.env) {
  if (env.HEDGELING_AUTH_MODE !== "local" || env.NODE_ENV !== "development") return false;
  if (!loopback.has(req.socket?.remoteAddress) || !loopback.has(req.socket?.localAddress)) return false;
  if (["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto"].some((name) => req.get(name))) return false;
  try {
    const url = new URL(`http://${req.get("host")}`);
    return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}

export function requireLocalRequest(req, res, next) {
  if (!localRequestAllowed(req)) return res.status(403).json({ error: "Local troubleshooting is restricted to direct loopback connections" });
  next();
}

export async function authenticateLocal(req, supplied, database = { query }) {
  if (!localRequestAllowed(req)) return null;
  try { validateLocalAuthentication(); } catch { return null; }
  const expected = Buffer.from(process.env.HEDGELING_LOCAL_AUTH_TOKEN);
  const actual = Buffer.from(String(supplied || ""));
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  const result = await database.query(
    `select id, email, display_name as "displayName", status, platform_staff as "platformStaff"
     from users where id = $1 and status = 'active' and platform_staff = false`,
    [process.env.HEDGELING_LOCAL_USER_ID],
  );
  const user = result.rows[0];
  return user ? { method: "local", principalType: "user", principalId: user.id, user, localTroubleshooting: true } : null;
}

export function localSessionToken(req) {
  return String(req.get("cookie") || "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${LOCAL_SESSION_COOKIE}=`))?.slice(LOCAL_SESSION_COOKIE.length + 1) || "";
}

export async function localSignIn(req, res) {
  const auth = await authenticateLocal(req, req.body?.token);
  if (!auth) return res.status(401).json({ error: "Local session is invalid or expired; restart dev:local to issue a new token" });
  res.cookie(LOCAL_SESSION_COOKIE, req.body.token, {
    httpOnly: true, sameSite: "strict", secure: false, path: "/",
    expires: new Date(process.env.HEDGELING_LOCAL_AUTH_EXPIRES_AT),
  });
  res.json({ ok: true });
}
