import crypto from "node:crypto";

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const correlationIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

function configuredOrigin() {
  return String(process.env.HEDGELING_PUBLIC_ORIGIN || "").replace(/\/+$/, "");
}

function requestOrigin(req) {
  const explicit = configuredOrigin();
  if (explicit) return explicit;
  const host = req.get("host");
  return host ? `${req.protocol}://${host}` : "";
}

export function requestCorrelation(req, res, next) {
  const supplied = String(req.get("x-correlation-id") || "");
  req.correlationId = correlationIdPattern.test(supplied)
    ? supplied
    : crypto.randomUUID();
  res.set("X-Correlation-Id", req.correlationId);
  next();
}

export function requestOutcomeTelemetry(req, res, next) {
  const startedAt = Date.now();
  res.on("finish", () => {
    let event = null;
    if (res.statusCode === 401) event = "authentication_denied";
    else if (res.statusCode === 403) event = "authorization_denied";
    else if (res.statusCode >= 500) event = "server_error";
    if (!event) return;
    console.log(JSON.stringify({
      event,
      correlationId: req.correlationId || null,
      method: req.method,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
    }));
  });
  next();
}

export function securityHeaders(req, res, next) {
  const directives = [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "manifest-src 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "worker-src 'none'",
  ];
  if (process.env.NODE_ENV === "production") {
    directives.push("upgrade-insecure-requests");
    res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  res.set({
    "Content-Security-Policy": directives.join("; "),
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=()",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  if (
    req.path.startsWith("/api/")
    || req.path.startsWith("/scim/")
    || req.path === "/login"
    || req.path.startsWith("/operations")
  ) {
    res.set("Cache-Control", "no-store");
  }
  next();
}

export function requireSameOriginMutation(req, res, next) {
  if (safeMethods.has(req.method)) return next();
  const fetchSite = String(req.get("sec-fetch-site") || "").toLowerCase();
  if (fetchSite === "cross-site") {
    return res.status(403).json({
      error: "Cross-origin browser mutations are not allowed",
      code: "cross_origin_mutation_denied",
    });
  }
  const origin = String(req.get("origin") || "").replace(/\/+$/, "");
  if (!origin) return next();
  if (origin === requestOrigin(req)) return next();
  return res.status(403).json({
    error: "Cross-origin browser mutations are not allowed",
    code: "cross_origin_mutation_denied",
  });
}

export function validateHttpSecurityConfiguration() {
  const origin = configuredOrigin();
  if (!origin) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("HEDGELING_PUBLIC_ORIGIN is required in production");
    }
    return true;
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error("HEDGELING_PUBLIC_ORIGIN must be an absolute origin");
  }
  if (
    parsed.origin !== origin
    || parsed.username
    || parsed.password
    || (process.env.NODE_ENV === "production" && parsed.protocol !== "https:")
  ) {
    throw new Error(
      "HEDGELING_PUBLIC_ORIGIN must be an exact HTTPS origin without credentials or a path",
    );
  }
  return true;
}

export function publicError(err) {
  const invalidInput = ["22P02", "22007", "22008"].includes(err?.code);
  const duplicate = err?.code === "23505";
  const stateConflict = err?.code === "23514";
  const status = err?.status
    || (invalidInput ? 400 : duplicate || stateConflict ? 409 : 500);
  const body = {
    error: invalidInput
      ? "A request identifier or timestamp is invalid"
      : duplicate
        ? "The requested record already exists"
        : stateConflict
          ? "The request conflicts with the current record state"
          : err?.status
            ? err.publicMessage || err.message
            : "Internal error",
  };
  if (err?.status && typeof err.code === "string" && !/^\d/.test(err.code)) {
    body.code = err.code;
  }
  if (err?.status && err.details && typeof err.details === "object") {
    body.details = err.details;
  }
  return { status, body };
}

function redactedLogValue(value, maximumLength = 500) {
  return String(value || "")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]+\b/g, "[REDACTED_STRIPE_KEY]")
    .replace(/\bwhsec_[A-Za-z0-9_-]+\b/g, "[REDACTED_WEBHOOK_SECRET]")
    .replace(/\bhdlg_(?:sa|scim)_[A-Za-z0-9_-]+\b/g, "[REDACTED_CREDENTIAL]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, maximumLength);
}

export function logRequestError(err, correlationId, logger = console.error) {
  logger("[http] Request failed", {
    correlationId: redactedLogValue(correlationId, 128),
    name: redactedLogValue(err?.name || "Error", 100),
    code: err?.code ? redactedLogValue(err.code, 100) : null,
    status: err?.status || 500,
    message: redactedLogValue(err?.message || "Unknown error"),
  });
}
