export function auditActor(auth) {
  if (auth?.principalType === "service_account" && auth?.serviceAccount?.id) {
    return {
      actorType: "service_account",
      actorId: auth.serviceAccount.id,
      effectiveUserId: null,
    };
  }
  if (auth?.principalType === "system_agent" && auth?.principalId) {
    return {
      actorType: "system_agent",
      actorId: auth.principalId,
      effectiveUserId: null,
    };
  }
  if (auth?.user?.id) {
    return {
      actorType: "user",
      actorId: auth.user.id,
      effectiveUserId: auth.user.id,
    };
  }
  return {
    actorType: "platform",
    actorId: null,
    effectiveUserId: null,
  };
}

export async function insertAuditEvent(client, {
  auth,
  organizationId = null,
  action,
  resourceType,
  resourceId = null,
  requestId = null,
  ipAddress = null,
  beforeState = null,
  afterState = null,
  metadata = {},
}) {
  const actor = auditActor(auth);
  await client.query(
    `insert into audit_events(
       organization_id, actor_type, actor_id, effective_user_id, action,
       resource_type, resource_id, request_id, ip_address, before_state,
       after_state, metadata
     ) values($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      organizationId,
      actor.actorType,
      actor.actorId,
      actor.effectiveUserId,
      action,
      resourceType,
      resourceId,
      requestId,
      ipAddress,
      beforeState == null ? null : JSON.stringify(beforeState),
      afterState == null ? null : JSON.stringify(afterState),
      JSON.stringify({ ...(metadata || {}), ...(auth?.localTroubleshooting ? { localTroubleshooting: true } : {}) }),
    ],
  );
}

export async function auditRequest(client, req, event) {
  return insertAuditEvent(client, {
    auth: req.auth,
    organizationId: event.organizationId ?? req.authorizedOrganizationId ?? null,
    requestId: req.get?.("x-request-id") || null,
    ipAddress: req.ip || null,
    ...event,
  });
}
