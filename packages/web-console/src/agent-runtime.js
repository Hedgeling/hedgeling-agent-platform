import express from "express";
import { query, withTransaction } from "./db.js";
import { isUuid } from "./validation.js";
import { agentEnabled, activeUser, assertAgentRunScope, delegatedAgentAuth, agentOrganizationAccessMessage, accessibleOrganizations, confirmProposal, fail, authorizationStamp } from "./workspace-actions.js";
import { nextAgentTurn, providerConfiguration } from "./agent-provider.js";
import { connectAgentTools } from "./agent-mcp.js";
import { agentSkills } from "./agent-skills.js";
import { chatAccess, requireChatAccess } from "./chat-access.js";

const router = express.Router();
const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
const active = new Map();
const running = ["planning", "reading", "executing"];
const activityLabels = {
  console_list_library: 'Searching the Library',
  console_get_library_asset: 'Reading translation guidance',
  console_read_library_sources: 'Reading source examples for the Library',
  console_get_library_history: 'Checking Library history',
  console_propose_translation_instructions: 'Preparing translation instructions',
  console_propose_locale_persona: 'Preparing a locale persona',
  console_propose_glossary_term: 'Preparing a glossary term',
  console_propose_library_restore: 'Preparing a Library restore',
  console_list_library_reviews: 'Checking Library suggestions',
  console_propose_library_review: 'Preparing a Library review',
  console_get_project_locales: 'Checking the project’s languages',
  console_propose_project_locales: 'Preparing new target languages',
  console_get_extraction_config: 'Reading extraction configuration',
  console_get_extraction_settings: 'Reading saved project settings',
  console_propose_extraction_tuning: 'Preparing an extraction tuning preview',
  console_propose_tuning_apply: 'Reviewing tuned settings and re-extraction',
  console_list_source_connections: 'Checking connected repositories',
  console_propose_extraction: 'Preparing your source extraction',
  console_list_extractions: 'Looking up extraction requests',
  console_get_extraction: 'Checking extraction progress',
  console_propose_extraction_import: 'Reviewing extracted source strings',
  console_list_organizations: "Checking your organizations",
  console_get_workspace: "Looking at the workspace",
  console_list_projects: "Looking up your projects",
  console_report_workspace: "Summarizing your organization",
  console_report_jobs: "Summarizing localization jobs",
  console_get_sync_status: "Checking repository sync status",
  console_list_localization_jobs: "Looking up localization jobs",
  console_propose_organization: "Preparing an organization preview",
  console_propose_business_unit: "Preparing a business-unit preview",
  console_propose_project: "Preparing a project preview",
  console_propose_localization_job: "Preparing a localization-job draft preview",
  console_propose_organization_update: "Preparing an organization name change",
  console_propose_business_unit_update: "Preparing a business-unit name change",
  console_propose_project_update: "Preparing a project name change",
  console_propose_localization_job_update: "Preparing changes to the job draft",
};
async function event(runId, kind, data, client = { query }) {
  return (await client.query("insert into agent_events(run_id,kind,data) values($1,$2,$3) returning sequence,kind,data,created_at as \"createdAt\"", [runId, kind, data])).rows[0];
}
export async function loadRun(auth, runId, retry = 0) {
  if (!isUuid(runId)) throw fail(400, "Invalid conversation ID");
  const run = (await query("select * from agent_runs where id=$1 and user_id=$2", [runId, auth.user.id])).rows[0];
  if (!run) throw fail(404, "Conversation not found");
  await assertAgentRunScope(auth, run.organization_id);
  if (run.authorization_stamp !== await authorizationStamp(auth)) {
    // A confirmed creation updates both the run and its permission snapshot.
    // If it committed between these reads, reread that checkpoint once.
    const latest = (await query("select authorization_stamp from agent_runs where id=$1 and user_id=$2", [runId, auth.user.id])).rows[0];
    if (retry < 2 && latest?.authorization_stamp !== run.authorization_stamp) return loadRun(auth, runId, retry + 1);
    throw fail(403, "Your access changed. Start a new conversation with your current permissions.", "agent_access_changed");
  }
  return run;
}
function safeRun(run) {
  return { id: run.id, organizationId: run.organization_id, status: run.status, generation: run.generation, controllerId: run.controller_id, leaseExpiresAt: run.lease_expires_at };
}
async function guardRun(auth, id, generation) {
  const run = await loadRun(auth, id);
  await requireChatAccess(run.organization_id);
  if (run.generation !== generation || !running.includes(run.status) || new Date(run.lease_expires_at) <= new Date()) throw fail(409, "The agent is paused or its controller disconnected", "agent_paused");
  return run;
}
async function checkpoint(run, history, status, events) {
  await withTransaction(async (client) => {
    const updated = await client.query("update agent_runs set model_history=$3,status=$4,updated_at=now() where id=$1 and generation=$2 and status in ('planning','reading','executing') and lease_expires_at > now() returning id", [run.id, run.generation, JSON.stringify(history), status]);
    if (!updated.rowCount) throw fail(409, "The agent is paused", "agent_paused");
    for (const [kind, data] of events) await event(run.id, kind, data, client);
    await event(run.id, "state", { status }, client);
  });
}
async function runTurn(auth, runId) {
  // A confirmation can arrive after the checkpoint but before the previous
  // MCP session closes. Do not lose the next turn in that small window.
  if (active.has(runId)) { await active.get(runId).completion; return runTurn(auth, runId); }
  const controller = new AbortController();
  let finish;
  controller.completion = new Promise((resolve) => { finish = resolve; });
  active.set(runId, controller);
  let tools;
  let run;
  try {
    run = await loadRun(auth, runId);
    const delegated = delegatedAgentAuth(auth, run.id);
    const guard = async () => { controller.signal.throwIfAborted(); return guardRun(delegated, run.id, run.generation); };
    tools = await connectAgentTools(delegated, { organizationId: run.organization_id, runId, generation: run.generation }, guard);
    await guard();
    await event(runId, "configuration", { skills: agentSkills.map(({ id, version }) => ({ id, version })) });
    let history = run.model_history;
    for (let step = 0; step < 8; step++) {
      await guard();
      const content = await nextAgentTurn({ run, auth: delegated, history, tools: tools.tools, signal: controller.signal });
      await guard();
      const calls = content.parts.filter((p) => p.functionCall).map((p) => p.functionCall);
      const answer = content.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n").slice(0, 12000);
      history = [...history, content];
      if (!calls.length) {
        await checkpoint(run, history, "awaiting_input", [["message", { role: "assistant", text: answer || "I couldn't complete that request. Try rephrasing it or take over manually." }]]);
        return;
      }
      const parts = [];
      const events = [];
      if (answer) events.push(["message", { role: "assistant", text: answer }]);
      if (calls.length > 8) throw fail(400, "The assistant requested too many tools in one step");
      let proposal = null;
      for (const call of calls) {
        await guard();
        let result;
        if (proposal) result = { error: "Another change is awaiting confirmation. Request this action after the human responds." };
        else {
          const tool = Object.hasOwn(activityLabels, call.name) ? call.name : null;
          await event(runId, "activity", { tool, label: activityLabels[call.name] || "Checking available tools", status: "working" });
          const reply = await tools.client.callTool({ name: call.name, arguments: call.args || {} });
          result = JSON.parse(reply.content?.find((c) => c.type === "text")?.text || "{}");
          if (result.proposal) { proposal = result.proposal; events.push(["proposal", { ...proposal, uiTarget: result.uiTarget }]); }
          else events.push(["activity", { tool, label: result.error || "Workspace information loaded", status: result.error ? "failed" : "complete", ...(result.uiTarget ? { uiTarget: result.uiTarget } : {}) }]);
        }
        parts.push({ functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response: result } });
      }
      history.push({ role: "user", parts });
      await checkpoint(run, history, proposal ? "awaiting_confirmation" : "reading", events);
      if (proposal) return;
    }
    await checkpoint(run, history, "awaiting_input", [["message", { role: "assistant", text: "I've reached this turn's step limit. Review the results, then tell me how you'd like to continue." }]]);
  } catch (error) {
    if (run) {
      const message = error.status && error.status < 500 ? error.message : "The assistant could not finish this turn. You can retry or continue manually.";
      await withTransaction(async (client) => {
        const updated = await client.query("update agent_runs set status='paused',updated_at=now() where id=$1 and generation=$2 and status in ('planning','reading','executing') returning id", [runId, run.generation]);
        if (updated.rowCount) {
          if (error.code === "agent_plan_required") await event(runId, "commercial_access", { message }, client);
          await event(runId, "message", { role: "assistant", text: message }, client); await event(runId, "state", { status: "paused" }, client);
        }
      }).catch(() => {});
    }
  } finally {
    await tools?.close().catch(() => {});
    active.delete(runId);
    finish();
  }
}
async function pause(auth, runId, controllerId = null, status = "paused") {
  await loadRun(auth, runId);
  let changed = false;
  const run = await withTransaction(async (client) => {
    const row = (await client.query("select * from agent_runs where id=$1 for update", [runId])).rows[0];
    if (controllerId && row.controller_id !== controllerId) return row;
    if (["cancelled", "failed"].includes(row.status)) return row;
    await client.query("update agent_runs set status=$2,generation=generation+1,lease_expires_at=null,controller_id=null,updated_at=now() where id=$1", [runId, status]);
    await event(runId, "state", { status, controllerId: null }, client);
    changed = true;
    return { ...row, status, generation: row.generation + 1, controller_id: null, lease_expires_at: null };
  });
  if (changed) active.get(runId)?.abort();
  return run;
}
function controller(req) {
  const id = req.body?.controllerId;
  if (!isUuid(id)) throw fail(400, "A valid controller ID is required");
  return id;
}

router.use((req, _res, next) => {
  if (!agentEnabled()) return next(fail(404, "The assistant is not enabled"));
  activeUser(req.auth).then(() => next(), next);
});
router.get("/config", route(async (req, res) => {
  // A misconfigured provider reports ready:false here instead of failing the
  // whole console bootstrap; chat routes still reject with the provider error.
  let config;
  try { config = providerConfiguration(); } catch { config = { ready: false, fixture: false }; }
  const organizations = await accessibleOrganizations(req.auth);
  const agentOrganizations = new Set((await accessibleOrganizations(delegatedAgentAuth(req.auth))).map((org) => org.id));
  res.set("Cache-Control", "no-store").json({ ready: config.ready, demo: config.fixture, organizationCreation: process.env.HEDGELING_AGENT_ORG_CREATION_ENABLED === "true",
    unscopedChat: await chatAccess(null), organizations: await Promise.all(organizations.map(async (org) => ({ ...org,
      agentAccess: { allowed: agentOrganizations.has(org.id), ...(!agentOrganizations.has(org.id) ? { message: agentOrganizationAccessMessage } : {}) },
      chat: await chatAccess(org.id) }))) });
}));
router.post("/runs", route(async (req, res) => {
  const organizationId = req.body?.organizationId || null;
  if (organizationId && !isUuid(organizationId)) throw fail(400, "Invalid organization ID");
  await assertAgentRunScope(req.auth, organizationId);
  await requireChatAccess(organizationId);
  const controllerId = controller(req);
  const stamp = await authorizationStamp(req.auth);
  const run = await withTransaction(async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`agent-runs:${req.auth.user.id}`]);
    const count = (await client.query("select count(*)::int as n from agent_runs where user_id=$1 and created_at>now()-interval '1 day'", [req.auth.user.id])).rows[0].n;
    if (count >= 100) throw fail(429, "Your daily conversation limit has been reached");
    return (await client.query(`insert into agent_runs(user_id,organization_id,controller_id,lease_expires_at,authorization_stamp)
      values($1,$2,$3,now()+interval '30 seconds',$4) returning *`, [req.auth.user.id, organizationId, controllerId, stamp])).rows[0];
  });
  res.status(201).json({ run: safeRun(run) });
}));
router.get("/runs/:id", route(async (req, res) => {
  let run = await loadRun(req.auth, req.params.id);
  if (running.includes(run.status) && new Date(run.lease_expires_at) <= new Date()) run = await pause(req.auth, run.id);
  const events = (await query("select sequence,kind,data,created_at as \"createdAt\" from agent_events where run_id=$1 order by sequence limit 1000", [run.id])).rows;
  const proposals = (await query("select id,preview,fingerprint,status,expires_at as \"expiresAt\" from agent_proposals where run_id=$1 and status='pending' order by created_at", [run.id])).rows;
  res.json({ run: safeRun(run), events, proposals });
}));
router.post("/runs/:id/heartbeat", route(async (req, res) => {
  const run = await loadRun(req.auth, req.params.id);
  const updated = await query("update agent_runs set lease_expires_at=now()+interval '30 seconds' where id=$1 and controller_id=$2 returning id", [run.id, controller(req)]);
  if (!updated.rowCount) throw fail(409, "Another tab controls this conversation");
  res.json({ ok: true });
}));
router.post("/runs/:id/messages", route(async (req, res) => {
  const run = await loadRun(req.auth, req.params.id);
  await requireChatAccess(run.organization_id);
  const controllerId = controller(req);
  const text = req.body?.text;
  if (typeof text !== "string" || !text.trim() || text.length > 6000) throw fail(400, "Write a message of up to 6,000 characters");
  if (!providerConfiguration().ready) throw fail(503, "The assistant is unavailable. You can continue manually.");
  await withTransaction(async (client) => {
    const row = (await client.query("select * from agent_runs where id=$1 for update", [run.id])).rows[0];
    if (!["awaiting_input", "completed"].includes(row.status)) throw fail(409, "Finish or pause the current step before sending another message");
    if (row.model_history.length >= 100) throw fail(400, "This conversation is full. Start a new chat to continue.");
    if (row.controller_id && row.controller_id !== controllerId && new Date(row.lease_expires_at) > new Date()) throw fail(409, "Another tab controls this conversation");
    const history = [...row.model_history, { role: "user", parts: [{ text: text.trim() }] }];
    await client.query("update agent_runs set model_history=$2,status='planning',generation=generation+1,controller_id=$3,lease_expires_at=now()+interval '30 seconds',updated_at=now() where id=$1", [run.id, JSON.stringify(history), controllerId]);
    await event(run.id, "message", { role: "user", text: text.trim() }, client);
    await event(run.id, "state", { status: "planning", controllerId }, client);
  });
  res.json({ accepted: true });
  void runTurn(req.auth, run.id);
}));
router.post("/runs/:id/pause", route(async (req, res) => res.json({ run: safeRun(await pause(req.auth, req.params.id)) })));
router.post("/runs/:id/resume", route(async (req, res) => {
  const run = await loadRun(req.auth, req.params.id);
  await requireChatAccess(run.organization_id);
  const controllerId = controller(req);
  if (active.has(run.id)) throw fail(409, "The current request is still stopping. Retry in a moment.");
  const updated = await withTransaction(async (client) => {
    const row = (await client.query("select * from agent_runs where id=$1 for update", [run.id])).rows[0];
    if (row.status !== "paused") throw fail(409, "This conversation is not paused");
    const pending = (await client.query("select id from agent_proposals where run_id=$1 and status='pending' limit 1", [run.id])).rowCount;
    const status = pending ? "awaiting_confirmation" : "awaiting_input";
    await client.query("update agent_runs set status=$2,controller_id=$3,lease_expires_at=now()+interval '30 seconds',updated_at=now() where id=$1", [run.id, status, controllerId]);
    await event(run.id, "state", { status, controllerId }, client);
    return { ...row, status, controller_id: controllerId };
  });
  res.json({ run: safeRun(updated) });
}));
router.post("/runs/:id/cancel", route(async (req, res) => {
  res.json({ run: safeRun(await pause(req.auth, req.params.id, null, "cancelled")) });
}));
router.post("/proposals/:id/confirm", route(async (req, res) => {
  if (!isUuid(req.params.id)) throw fail(400, "Invalid proposal ID");
  // A machine bearer or the MCP runtime can never use the confirmation route.
  if (req.get("authorization") || !req.get("cookie")) throw fail(403, "Confirm changes from your signed-in console");
  const p = (await query("select run_id from agent_proposals where id=$1 and user_id=$2", [req.params.id, req.auth.user.id])).rows[0];
  if (p?.run_id) await requireChatAccess((await loadRun(req.auth, p.run_id)).organization_id);
  const result = await confirmProposal(req.auth, req.params.id, req.body?.fingerprint, controller(req));
  res.json(result);
}));
router.post("/proposals/:id/reject", route(async (req, res) => {
  if (!isUuid(req.params.id)) throw fail(400, "Invalid proposal ID");
  await withTransaction(async (client) => {
    const p = (await client.query("select * from agent_proposals where id=$1 and user_id=$2 for update", [req.params.id, req.auth.user.id])).rows[0];
    if (!p || p.status !== "pending") throw fail(409, "This proposal is no longer pending");
    if (p.run_id) {
      await loadRun(req.auth, p.run_id);
      const row = (await client.query("select * from agent_runs where id=$1 for update", [p.run_id])).rows[0];
      if (row.status !== "awaiting_confirmation" || row.controller_id !== controller(req) || new Date(row.lease_expires_at) <= new Date()) throw fail(409, "Resume this conversation before discarding the proposal");
      await client.query("update agent_runs set status='awaiting_input',model_history=model_history || $2::jsonb where id=$1", [p.run_id, JSON.stringify([{ role: "user", parts: [{ text: "The person rejected the proposal. Ask how to revise it; do not recreate it without new instructions." }] }])]);
      await event(p.run_id, "proposal_rejected", { proposalId: req.params.id }, client);
      await event(p.run_id, "state", { status: "awaiting_input" }, client);
    }
    await client.query("update agent_proposals set status='rejected' where id=$1", [p.id]);
  });
  res.json({ ok: true });
}));
router.post("/runs/:id/continue", route(async (req, res) => {
  const run = await loadRun(req.auth, req.params.id);
  await requireChatAccess(run.organization_id);
  const updated = await query("update agent_runs set status='planning',generation=generation+1,lease_expires_at=now()+interval '30 seconds' where id=$1 and status='awaiting_input' and controller_id=$2 returning id", [run.id, controller(req)]);
  if (!updated.rowCount) throw fail(409, "Resume this conversation before continuing");
  res.json({ accepted: true });
  void runTurn(req.auth, run.id);
}));
router.get("/runs/:id/events", route(async (req, res) => {
  const run = await loadRun(req.auth, req.params.id);
  const controllerId = String(req.query.controllerId || "");
  if (!isUuid(controllerId)) throw fail(400, "Invalid controller ID");
  let cursor = Number(req.get("last-event-id") || req.query.after || 0);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw fail(400, "Invalid event cursor");
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.flushHeaders();
  res.write("retry: 2000\n\n");
  let busy = false;
  const poll = async () => {
    if (busy || res.destroyed) return;
    busy = true;
    try {
      await loadRun(req.auth, run.id);
      const events = (await query("select sequence,kind,data from agent_events where run_id=$1 and sequence>$2 order by sequence limit 100", [run.id, cursor])).rows;
      for (const item of events) { cursor = Number(item.sequence); res.write(`id: ${cursor}\ndata: ${JSON.stringify(item)}\n\n`); }
      if (!events.length) res.write(": heartbeat\n\n");
    } catch { res.write(`event: access_changed\ndata: {}\n\n`); res.end(); }
    finally { busy = false; }
  };
  const timer = setInterval(poll, 1000);
  void poll();
  res.on("close", () => { clearInterval(timer); void pause(req.auth, run.id, controllerId).catch(() => {}); });
}));

export default router;
