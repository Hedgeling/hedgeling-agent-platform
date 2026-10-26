const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return uuidPattern.test(String(value || ""));
}

export function optionalTimestamp(value, fieldName = "expiresAt") {
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw Object.assign(new Error(`${fieldName} must be an ISO-8601 timestamp`), { status: 400 });
  }
  const timestamp = Date.parse(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(timestamp)) {
    throw Object.assign(new Error(`${fieldName} must be an ISO-8601 timestamp`), { status: 400 });
  }
  if (timestamp <= Date.now()) {
    throw Object.assign(new Error(`${fieldName} must be in the future`), { status: 400 });
  }
  return new Date(timestamp).toISOString();
}
