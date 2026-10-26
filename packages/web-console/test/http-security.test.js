import assert from "node:assert/strict";
import test from "node:test";
import {
  logRequestError,
  publicError,
  requestCorrelation,
  requestOutcomeTelemetry,
  requireSameOriginMutation,
  securityHeaders,
  validateHttpSecurityConfiguration,
} from "../src/http-security.js";

function withEnv(values, callback) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function request({
  method = "GET",
  path = "/api/me",
  protocol = "https",
  headers = {},
} = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    method,
    path,
    protocol,
    get: (name) => normalized[name.toLowerCase()] || "",
  };
}

function response() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    set(name, value) {
      if (typeof name === "object") Object.assign(this.headers, name);
      else this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

test("security middleware emits strict production browser headers", () => withEnv({
  NODE_ENV: "production",
}, () => {
  const req = request();
  const res = response();
  let called = false;
  securityHeaders(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.match(res.headers["Content-Security-Policy"], /frame-ancestors 'none'/);
  assert.match(res.headers["Content-Security-Policy"], /upgrade-insecure-requests/);
  assert.equal(
    res.headers["Strict-Transport-Security"],
    "max-age=31536000; includeSubDomains",
  );
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(res.headers["Cache-Control"], "no-store");
}));

test("correlation IDs accept bounded safe values and replace unsafe input", () => {
  const acceptedRequest = request({ headers: { "x-correlation-id": "incident:OPS-42" } });
  const acceptedResponse = response();
  requestCorrelation(acceptedRequest, acceptedResponse, () => {});
  assert.equal(acceptedRequest.correlationId, "incident:OPS-42");
  assert.equal(acceptedResponse.headers["X-Correlation-Id"], "incident:OPS-42");

  const replacedRequest = request({ headers: { "x-correlation-id": "bad\nheader" } });
  const replacedResponse = response();
  requestCorrelation(replacedRequest, replacedResponse, () => {});
  assert.match(replacedRequest.correlationId, /^[0-9a-f-]{36}$/);
  assert.equal(replacedResponse.headers["X-Correlation-Id"], replacedRequest.correlationId);
});

test("cross-origin browser mutations fail before authentication or provider work", () => (
  withEnv({ HEDGELING_PUBLIC_ORIGIN: "https://console.example.com" }, () => {
    const denied = request({
      method: "POST",
      headers: {
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    });
    const deniedResponse = response();
    requireSameOriginMutation(
      denied,
      deniedResponse,
      () => assert.fail("cross-origin mutation must not continue"),
    );
    assert.equal(deniedResponse.statusCode, 403);
    assert.equal(deniedResponse.body.code, "cross_origin_mutation_denied");

    const allowed = request({
      method: "POST",
      headers: { origin: "https://console.example.com" },
    });
    let called = false;
    requireSameOriginMutation(allowed, response(), () => { called = true; });
    assert.equal(called, true);

    const providerRequest = request({ method: "POST" });
    called = false;
    requireSameOriginMutation(providerRequest, response(), () => { called = true; });
    assert.equal(called, true);
  })
));

test("production public origin must be an exact HTTPS origin", () => {
  withEnv({
    NODE_ENV: "production",
    HEDGELING_PUBLIC_ORIGIN: null,
  }, () => assert.throws(validateHttpSecurityConfiguration, /required in production/));
  withEnv({
    NODE_ENV: "production",
    HEDGELING_PUBLIC_ORIGIN: "http://console.example.com",
  }, () => assert.throws(validateHttpSecurityConfiguration, /exact HTTPS origin/));
  withEnv({
    NODE_ENV: "production",
    HEDGELING_PUBLIC_ORIGIN: "https://console.example.com/path",
  }, () => assert.throws(validateHttpSecurityConfiguration, /exact HTTPS origin/));
  withEnv({
    NODE_ENV: "production",
    HEDGELING_PUBLIC_ORIGIN: "https://console.example.com",
  }, () => assert.equal(validateHttpSecurityConfiguration(), true));
  withEnv({
    NODE_ENV: "development",
    HEDGELING_PUBLIC_ORIGIN: null,
  }, () => assert.equal(validateHttpSecurityConfiguration(), true));
});

test("unknown server errors are logged internally but not disclosed to clients", () => {
  assert.deepEqual(publicError(new Error("password=super-secret internal SQL")), {
    status: 500,
    body: { error: "Internal error" },
  });
  assert.deepEqual(
    publicError(Object.assign(new Error("Provider temporarily unavailable"), {
      status: 503,
      code: "provider_unavailable",
    })),
    {
      status: 503,
      body: {
        error: "Provider temporarily unavailable",
        code: "provider_unavailable",
      },
    },
  );
  assert.deepEqual(
    publicError(Object.assign(new Error("database host secret.internal failed"), {
      status: 503,
      code: "service_not_ready",
      publicMessage: "Service is not ready",
    })),
    {
      status: 503,
      body: {
        error: "Service is not ready",
        code: "service_not_ready",
      },
    },
  );
});

test("request telemetry records only security-relevant outcomes without paths or bodies", () => {
  const req = request({ method: "POST", path: "/api/organizations/private-id" });
  req.correlationId = "incident:OPS-42";
  const res = Object.assign(response(), {
    listeners: {},
    on(event, callback) {
      this.listeners[event] = callback;
    },
  });
  const lines = [];
  const originalLog = console.log;
  console.log = (value) => lines.push(value);
  try {
    requestOutcomeTelemetry(req, res, () => {});
    res.statusCode = 403;
    res.listeners.finish();
  } finally {
    console.log = originalLog;
  }
  assert.equal(lines.length, 1);
  const event = JSON.parse(lines[0]);
  assert.equal(event.event, "authorization_denied");
  assert.equal(event.correlationId, "incident:OPS-42");
  assert.equal(event.method, "POST");
  assert.equal(event.status, 403);
  assert.equal("path" in event, false);
});

test("request error logs redact credentials and bound provider messages", () => {
  const lines = [];
  logRequestError(
    new Error(
      "failed postgresql://operator:database-secret@db.internal/app "
      + "with sk_live_secretvalue and hdlg_sa_public_secretvalue "
      + "Bearer access-token-value "
      + "x".repeat(600),
    ),
    "incident:OPS-42",
    (...items) => lines.push(items),
  );
  assert.equal(lines.length, 1);
  const details = lines[0][1];
  assert.equal(details.correlationId, "incident:OPS-42");
  assert.equal(details.message.includes("database-secret"), false);
  assert.equal(details.message.includes("sk_live_"), false);
  assert.equal(details.message.includes("hdlg_sa_"), false);
  assert.equal(details.message.includes("access-token-value"), false);
  assert.ok(details.message.length <= 500);
});
