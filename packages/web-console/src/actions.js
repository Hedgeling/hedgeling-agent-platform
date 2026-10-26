import express from "express";
import { listProjects } from "./workspace-read.js";
import { runReport } from "./reporting.js";
import { ACTION_CONTRACT_VERSION, CONSOLE_ACTIONS, validateActionInput } from "@hedgeling/api-contract";
import { requireProjectPermission } from "./authorization.js";
import { query } from "./db.js";
import { readSyncStatus } from "./repo-sync.js";
import { executeWorkspaceAction, fail } from "./workspace-actions.js";

export async function invokeConsoleAction(name, input, auth, context = {}, dependencies = {}) {
  const action = CONSOLE_ACTIONS.find((entry) => entry.name === name);
  if (!action) throw fail(404, "Unknown console action");
  const error = validateActionInput(action, input);
  if (error) throw fail(400, error, "action_input_invalid");
  if (action.scope === "agent_domain") return executeWorkspaceAction(name, input, auth, context);
  if (action.scope === "reporting") return runReport(name, input, auth, context);
  if (name === "projects.list") return listProjects(auth, input, context, dependencies.listProjects);
  const req = { auth, body: input, query: {}, params: {} };
  await new Promise((resolve, reject) => {
    let status = 403;
    const res = { status(code) { status = code; return this; }, json(body) { reject(fail(status, body.error, body.code)); } };
    (dependencies.authorizeProject || requireProjectPermission)(action.permission)(req, res, (error) => error ? reject(error) : resolve());
  });
  if (Object.hasOwn(context, "organizationId") && req.authorizedProject.organizationId !== context.organizationId) throw fail(403, "The project is outside this conversation's organization");
  const syncStatus = dependencies.syncStatus || ((projectId) => readSyncStatus(query, { projectId }));
  return { projectId: req.authorizedProject.id, ...await syncStatus(req.authorizedProject.id) };
}

export function createActionsRouter(dependencies = {}) {
  const router = express.Router();
  router.get("/", (_req, res) => res.json({ version: ACTION_CONTRACT_VERSION, actions: CONSOLE_ACTIONS }));
  for (const action of CONSOLE_ACTIONS) {
    router.post(`/${action.name}`, (req, res, next) => {
      // Scope comes from the declared input only, never competing URL fields.
      if (Object.keys(req.query).length) return res.status(400).json({ error: "Action requests do not accept query parameters" });
      const error = validateActionInput(action, req.body);
      if (error) return res.status(400).json({ error, code: "action_input_invalid" });
      next();
    },
    async (req, res, next) => {
      try {
        const result = await invokeConsoleAction(action.name, req.body, req.auth, {}, dependencies);
        res.json({ version: ACTION_CONTRACT_VERSION, action: action.name, correlationId: req.correlationId, result });
      } catch (error) { next(error); }
    });
  }
  return router;
}

export default createActionsRouter();
