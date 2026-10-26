import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  authenticationConfiguration,
  cognitoProfileLookupStatus,
  platformOperationsAccess,
  requireAuthentication,
  requirePlatformAdmin,
  requirePlatformOperationsAccess,
  validateAuthenticationConfiguration,
} from "../src/auth.js";
import { authRateLimit, resetAuthRateLimitsForTests } from "../src/auth-rate-limit.js";
import {
  confirmSignUp,
  resendSignupCode,
  setCognitoLoginTestClient,
  signOut,
  signUp,
} from "../src/cognito-login.js";

function request(authorization = "", { method = "POST", path = "/", html = false } = {}) {
  return {
    method,
    path,
    originalUrl: path,
    accepts: (type) => html && type === "html",
    get: (name) => name.toLowerCase() === "authorization" ? authorization : "",
  };
}

function response() {
  return Object.assign(new EventEmitter(), {
    headers: {},
    statusCode: 200,
    body: null,
    redirectLocation: null,
    redirect(code, location) {
      this.statusCode = code;
      this.redirectLocation = location;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
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
  });
}

function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("Cognito profile failures distinguish invalid authentication from service outages", () => {
  assert.equal(cognitoProfileLookupStatus({ name: "NotAuthorizedException" }), 401);
  assert.equal(cognitoProfileLookupStatus({ cognitoProfileStatus: 403 }), 401);
  assert.equal(cognitoProfileLookupStatus({ cognitoProfileStatus: 400 }, "get-user"), 401);
  assert.equal(cognitoProfileLookupStatus({ cognitoProfileStatus: 400 }, "userinfo"), 503);
  assert.equal(cognitoProfileLookupStatus({ name: "CredentialsProviderError" }), 503);
  assert.equal(cognitoProfileLookupStatus({ $metadata: { httpStatusCode: 429 } }), 503);
  assert.equal(cognitoProfileLookupStatus(new TypeError("fetch failed")), 503);
});

test("removed Basic and hybrid modes fail closed", () => {
  for (const mode of ["basic", "hybrid", "unknown"]) withEnv({ HEDGELING_AUTH_MODE: mode }, () => {
    assert.throws(() => validateAuthenticationConfiguration(), /removed/);
    const res = response();
    requireAuthentication(request(), res, () => assert.fail("removed mode authenticated"));
    assert.equal(res.statusCode, 503);
  });
});

test("missing Cognito configuration never falls back to privileged authentication", () => withEnv({
  HEDGELING_AUTH_MODE: null, COGNITO_USER_POOL_ID: null, COGNITO_APP_CLIENT_ID: null,
}, () => assert.throws(() => validateAuthenticationConfiguration(), /COGNITO_USER_POOL_ID/)));

test("Basic credentials are rejected even when configured", () => withEnv({
  HEDGELING_AUTH_MODE: "cognito", ADMIN_PASSWORD: "old-password",
}, () => {
  const res = response();
  requireAuthentication(request(`Basic ${Buffer.from("admin:old-password").toString("base64")}`), res,
    () => assert.fail("Basic Auth must not authenticate"));
  assert.equal(res.statusCode, 401);
  assert.match(res.headers["WWW-Authenticate"], /Bearer/);
  assert.throws(() => validateAuthenticationConfiguration(), /Remove retained Basic/);
}));

test("Cognito redirects browser navigation and returns 401 to API callers", () => withEnv({
  HEDGELING_AUTH_MODE: "cognito",
}, () => {
  const browser = response();
  requireAuthentication(request("", { method: "GET", path: "/", html: true }), browser, () => assert.fail());
  assert.equal(browser.redirectLocation, "/login?next=%2F");
  const api = response();
  requireAuthentication(request("", { method: "GET", path: "/api/me", html: true }), api, () => assert.fail());
  assert.equal(api.statusCode, 401);
}));

test("Production rejects development auth and Cognito without UserInfo", () => {
  withEnv({
    NODE_ENV: "production",
    HEDGELING_AUTH_MODE: "cognito",
    COGNITO_USER_POOL_ID: "us-east-1_example",
    COGNITO_APP_CLIENT_ID: "client",
    COGNITO_USERINFO_URL: "https://auth.example.test/userInfo",
    HEDGELING_DEV_AUTH: "true",
  }, () => assert.throws(
    () => validateAuthenticationConfiguration({ warn: () => {} }),
    /has been removed/,
  ));

  withEnv({
    NODE_ENV: "production",
    HEDGELING_AUTH_MODE: "cognito",
    HEDGELING_DEV_AUTH: null,
    COGNITO_USER_POOL_ID: "us-east-1_example",
    COGNITO_APP_CLIENT_ID: "client-id",
    COGNITO_USERINFO_URL: null,
  }, () => assert.throws(
    () => validateAuthenticationConfiguration({ warn: () => {} }),
    /COGNITO_USERINFO_URL/,
  ));
});

test("Production warns when trusted proxy hops are not configured", () => withEnv({
  NODE_ENV: "production",
  HEDGELING_AUTH_MODE: "cognito",
  COGNITO_USER_POOL_ID: "us-east-1_example",
  COGNITO_APP_CLIENT_ID: "client",
  COGNITO_USERINFO_URL: "https://auth.example.test/userInfo",
  HEDGELING_DEV_AUTH: null,
  HEDGELING_TRUST_PROXY_HOPS: null,
}, () => {
  const warnings = [];
  assert.equal(validateAuthenticationConfiguration({ warn: (message) => warnings.push(message) }), true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /rate limits may group all users/);
}));

test("Authentication configuration rejects invalid trusted proxy hops", () => withEnv({
  NODE_ENV: "production",
  HEDGELING_AUTH_MODE: "cognito",
  COGNITO_USER_POOL_ID: "us-east-1_example",
  COGNITO_APP_CLIENT_ID: "client",
  COGNITO_USERINFO_URL: "https://auth.example.test/userInfo",
  HEDGELING_DEV_AUTH: null,
  HEDGELING_TRUST_PROXY_HOPS: "not-a-number",
}, () => assert.throws(
  () => validateAuthenticationConfiguration({ warn: () => {} }),
  /non-negative integer/,
)));

test("Platform gate distinguishes ordinary Cognito users from platform staff", () => {
  const ordinaryReq = { auth: { user: { platformStaff: false } } };
  const ordinaryRes = response();
  requirePlatformAdmin(ordinaryReq, ordinaryRes, () => assert.fail("should not authorize"));
  assert.equal(ordinaryRes.statusCode, 403);

  const adminReq = { auth: { user: { platformStaff: true } } };
  let called = false;
  requirePlatformAdmin(adminReq, response(), () => { called = true; });
  assert.equal(called, true);
});

test("payment operations separate view and management groups", () => withEnv({
  HEDGELING_COGNITO_PAYMENT_OPERATIONS_VIEW_GROUP: "payments-read",
  HEDGELING_COGNITO_PAYMENT_OPERATIONS_MANAGE_GROUP: "payments-manage",
}, () => {
  const reader = {
    principalType: "user",
    user: { platformStaff: false },
    cognito: { groups: ["payments-read"] },
  };
  const manager = {
    principalType: "user",
    user: { platformStaff: false },
    cognito: { groups: ["payments-manage"] },
  };
  assert.deepEqual(platformOperationsAccess(reader), { view: true, manage: false });
  assert.deepEqual(platformOperationsAccess(manager), { view: true, manage: true });
  assert.deepEqual(
    platformOperationsAccess({ principalType: "service_account" }),
    { view: false, manage: false },
  );

  let called = false;
  requirePlatformOperationsAccess(
    { method: "GET", auth: reader },
    response(),
    () => { called = true; },
  );
  assert.equal(called, true);
  const mutationResponse = response();
  requirePlatformOperationsAccess(
    { method: "POST", auth: reader },
    mutationResponse,
    () => assert.fail("read-only operator should not mutate"),
  );
  assert.equal(mutationResponse.statusCode, 403);
  called = false;
  requirePlatformOperationsAccess(
    { method: "POST", auth: manager },
    response(),
    () => { called = true; },
  );
  assert.equal(called, true);
}));

test("Authentication configuration omits secrets", () => withEnv({
  HEDGELING_AUTH_MODE: "cognito",
  COGNITO_USER_POOL_ID: "us-east-1_example",
  COGNITO_APP_CLIENT_ID: "client-id",
  ADMIN_PASSWORD: "must-not-leak",
  HEDGELING_SELF_SERVICE_SIGNUP_ENABLED: null,
  HEDGELING_SELF_SERVICE_TRIAL_DAYS: null,
  HEDGELING_TERMS_VERSION: null,
  HEDGELING_PRIVACY_VERSION: null,
  HEDGELING_TERMS_URL: null,
  HEDGELING_PRIVACY_URL: null,
}, () => {
  assert.deepEqual(authenticationConfiguration(), {
    mode: "cognito",
    cognitoConfigured: true,
    userPoolId: "us-east-1_example",
    appClientId: "client-id",
    selfServiceSignupEnabled: false,
    trialDays: 14,
    termsVersion: "2026-07-30",
    privacyVersion: "2026-07-30",
    termsUrl: null,
    privacyUrl: null,
  });
}));

test("Production self-service signup requires Cognito and published HTTPS legal documents", () => {
  const base = {
    NODE_ENV: "production",
    HEDGELING_AUTH_MODE: "cognito",
    COGNITO_USER_POOL_ID: "us-east-1_example",
    COGNITO_APP_CLIENT_ID: "client-id",
    COGNITO_USERINFO_URL:
      "https://example.auth.us-east-1.amazoncognito.com/oauth2/userInfo",
    HEDGELING_SELF_SERVICE_SIGNUP_ENABLED: "true",
    HEDGELING_SELF_SERVICE_TRIAL_DAYS: "14",
    HEDGELING_TERMS_VERSION: "terms-v1",
    HEDGELING_PRIVACY_VERSION: "privacy-v1",
    HEDGELING_TERMS_URL: null,
    HEDGELING_PRIVACY_URL: null,
    ADMIN_PASSWORD: null,
    HEDGELING_ADMIN_PASSWORD: null,
  };
  withEnv(base, () => assert.throws(
    () => validateAuthenticationConfiguration({ warn: () => {} }),
    /HEDGELING_TERMS_URL must be an absolute HTTPS URL/,
  ));
  withEnv({
    ...base,
    HEDGELING_TERMS_URL: "https://example.com/terms",
    HEDGELING_PRIVACY_URL: "http://example.com/privacy",
  }, () => assert.throws(
    () => validateAuthenticationConfiguration({ warn: () => {} }),
    /HEDGELING_PRIVACY_URL must be an absolute HTTPS URL/,
  ));
  withEnv({
    ...base,
    HEDGELING_TERMS_URL: "https://example.com/terms",
    HEDGELING_PRIVACY_URL: "https://example.com/privacy",
  }, () => assert.equal(
    validateAuthenticationConfiguration({ warn: () => {} }),
    true,
  ));
});

test("Self-service signup sends normalized Cognito commands and current legal versions", async () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    COGNITO_APP_CLIENT_ID: process.env.COGNITO_APP_CLIENT_ID,
    HEDGELING_SELF_SERVICE_SIGNUP_ENABLED:
      process.env.HEDGELING_SELF_SERVICE_SIGNUP_ENABLED,
    HEDGELING_TERMS_VERSION: process.env.HEDGELING_TERMS_VERSION,
    HEDGELING_PRIVACY_VERSION: process.env.HEDGELING_PRIVACY_VERSION,
  };
  process.env.NODE_ENV = "test";
  process.env.COGNITO_APP_CLIENT_ID = "self-service-client";
  process.env.HEDGELING_SELF_SERVICE_SIGNUP_ENABLED = "true";
  process.env.HEDGELING_TERMS_VERSION = "terms-v2";
  process.env.HEDGELING_PRIVACY_VERSION = "privacy-v3";
  const commands = [];
  setCognitoLoginTestClient({
    send: async (command) => {
      commands.push(command);
      return command.constructor.name === "SignUpCommand"
        ? {
          UserConfirmed: false,
          CodeDeliveryDetails: {
            Destination: "a***@example.com",
            DeliveryMedium: "EMAIL",
          },
        }
        : {};
    },
  });
  try {
    const signupResponse = response();
    await signUp({
      body: {
        displayName: " Ada Lovelace ",
        email: " ADA@Example.com ",
        password: "correct horse battery staple",
        acceptedTerms: true,
        acceptedPrivacy: true,
        termsVersion: "terms-v2",
        privacyVersion: "privacy-v3",
      },
    }, signupResponse);
    assert.equal(signupResponse.statusCode, 202);
    assert.equal(commands[0].input.Username, "ada@example.com");
    assert.equal(commands[0].input.ClientMetadata.terms_version, "terms-v2");
    assert.equal(commands[0].input.UserAttributes[1].Value, "Ada Lovelace");

    await confirmSignUp({
      body: { email: "ADA@example.com", code: "123456" },
    }, response());
    await resendSignupCode({
      body: { email: "ADA@example.com" },
    }, response());
    assert.equal(commands[1].input.ConfirmationCode, "123456");
    assert.equal(commands[2].input.Username, "ada@example.com");
  } finally {
    setCognitoLoginTestClient(null);
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("Authentication rate limiter fails closed after its configured threshold", () => {
  resetAuthRateLimitsForTests();
  const middleware = authRateLimit({ key: "test", limit: 2, windowMs: 60_000 });
  const req = { ip: "192.0.2.10" };
  const first = response();
  const second = response();
  const third = response();
  let calls = 0;
  middleware(req, first, () => { calls += 1; });
  middleware(req, second, () => { calls += 1; });
  middleware(req, third, () => { calls += 1; });
  assert.equal(calls, 2);
  assert.equal(third.statusCode, 429);
  assert.match(third.body.error, /Too many/);
});

test("signup rate limiting retains a coarse IP ceiling across changing emails", () => {
  resetAuthRateLimitsForTests();
  const volume = authRateLimit({
    key: "signup-volume-test",
    limit: 2,
    windowMs: 60_000,
  });
  const identity = authRateLimit({
    key: "signup-identity-test",
    limit: 2,
    windowMs: 60_000,
    identity: (req) => req.body.email,
  });
  const run = (email) => {
    const req = { ip: "192.0.2.10", body: { email } };
    const res = response();
    let called = false;
    volume(req, res, () => {
      identity(req, res, () => { called = true; });
    });
    return { called, res };
  };

  assert.equal(run("first@example.com").called, true);
  assert.equal(run("second@example.com").called, true);
  const blocked = run("third@example.com");
  assert.equal(blocked.called, false);
  assert.equal(blocked.res.statusCode, 429);
});

test("Login rate limiting counts failures, resets on success, and separates users behind one IP", () => {
  resetAuthRateLimitsForTests();
  const middleware = authRateLimit({
    key: "login-failures-test",
    limit: 2,
    windowMs: 60_000,
    countFailuresOnly: true,
    identity: (req) => req.body.username,
  });
  const run = (username, statusCode) => {
    const req = { ip: "192.0.2.10", body: { username } };
    const res = response();
    let called = false;
    middleware(req, res, () => { called = true; });
    if (called) {
      res.statusCode = statusCode;
      res.emit("finish");
    }
    return { called, res };
  };

  assert.equal(run("first@example.com", 401).called, true);
  assert.equal(run("second@example.com", 401).called, true);
  assert.equal(run("first@example.com", 200).called, true);
  assert.equal(run("first@example.com", 401).called, true);
  assert.equal(run("first@example.com", 401).called, true);
  const blocked = run("first@example.com", 401);
  assert.equal(blocked.called, false);
  assert.equal(blocked.res.statusCode, 429);
  assert.equal(run("second@example.com", 401).called, true);
});

test("Sign-out revokes the Cognito refresh token and clears scoped cookies", async () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousClientId = process.env.COGNITO_APP_CLIENT_ID;
  process.env.NODE_ENV = "test";
  process.env.COGNITO_APP_CLIENT_ID = "test-client";
  const commands = [];
  setCognitoLoginTestClient({ send: async (command) => { commands.push(command); } });
  try {
    const req = {
      get(name) {
        return name.toLowerCase() === "cookie"
          ? "hedgeling_refresh_token=refresh-token"
          : "";
      },
    };
    const res = response();
    await signOut(req, res);
    assert.equal(commands.length, 1);
    assert.equal(commands[0].input.Token, "refresh-token");
    assert.equal(commands[0].input.ClientId, "test-client");
    assert.ok(res.headers["Set-Cookie"].some((value) => (
      value.startsWith("hedgeling_local_session=") && value.includes("Max-Age=0")
    )));
    assert.ok(res.headers["Set-Cookie"].some((value) => (
      value.startsWith("hedgeling_refresh_token=")
      && value.includes("Path=/api/auth/refresh")
      && value.includes("Max-Age=0")
    )));
    assert.ok(res.headers["Set-Cookie"].some((value) => (
      value.startsWith("hedgeling_identity_connection=")
      && value.includes("Path=/")
      && value.includes("Max-Age=0")
    )));
  } finally {
    setCognitoLoginTestClient(null);
    if (previousNodeEnv == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousClientId == null) delete process.env.COGNITO_APP_CLIENT_ID;
    else process.env.COGNITO_APP_CLIENT_ID = previousClientId;
  }
});
