import crypto from "node:crypto";
import { expect, test } from "@playwright/test";

function requiredEnvironment(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required for the PKCE browser smoke test`);
  return value;
}

test("enterprise discovery emits a bound authorization-code PKCE request", async ({
  context,
  page,
}) => {
  const email = requiredEnvironment("HEDGELING_E2E_SSO_EMAIL");
  const expectedProvider = requiredEnvironment(
    "HEDGELING_E2E_IDENTITY_PROVIDER",
  );
  const expectedRedirect = requiredEnvironment(
    "HEDGELING_E2E_REDIRECT_URI",
  );
  const cognitoDomain = requiredEnvironment(
    "HEDGELING_E2E_COGNITO_DOMAIN",
  ).replace(/\/$/, "");
  const cognitoOrigin = new URL(
    /^https:\/\//i.test(cognitoDomain)
      ? cognitoDomain
      : `https://${cognitoDomain}`,
  ).origin;

  const configurationResponse = await page.request.get("/api/auth/config");
  expect(configurationResponse.ok()).toBeTruthy();
  const configuration = await configurationResponse.json();
  expect(configuration.mode).toBe("cognito");
  expect(configuration.cognitoConfigured).toBe(true);
  expect(configuration.appClientId).toBeTruthy();
  expect(configuration.userPoolId).toBeTruthy();

  await page.route(`${cognitoOrigin}/oauth2/authorize?**`, (route) => (
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>PKCE request captured</title>",
    })
  ));
  const authorizationRequest = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.origin === cognitoOrigin && url.pathname === "/oauth2/authorize";
  });

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: /Continue/ }).click();

  const requestUrl = new URL((await authorizationRequest).url());
  expect(requestUrl.origin).toBe(cognitoOrigin);
  expect(requestUrl.searchParams.get("client_id")).toBe(
    configuration.appClientId,
  );
  expect(requestUrl.searchParams.get("response_type")).toBe("code");
  expect(requestUrl.searchParams.get("redirect_uri")).toBe(expectedRedirect);
  expect(requestUrl.searchParams.get("identity_provider")).toBe(
    expectedProvider,
  );
  expect(requestUrl.searchParams.get("code_challenge_method")).toBe("S256");
  expect(
    new Set(String(requestUrl.searchParams.get("scope") || "").split(/\s+/)),
  ).toEqual(new Set(["openid", "email", "profile"]));

  const state = requestUrl.searchParams.get("state");
  const nonce = requestUrl.searchParams.get("nonce");
  const challenge = requestUrl.searchParams.get("code_challenge");
  expect(state).toMatch(/^[A-Za-z0-9_-]{24,}$/);
  expect(nonce).toMatch(/^[A-Za-z0-9_-]{24,}$/);
  expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);

  const cookies = new Map(
    (await context.cookies()).map((cookie) => [cookie.name, cookie]),
  );
  const stateCookie = cookies.get("hedgeling_sso_state");
  const verifierCookie = cookies.get("hedgeling_sso_verifier");
  const nonceCookie = cookies.get("hedgeling_sso_nonce");
  const connectionCookie = cookies.get("hedgeling_sso_connection");
  expect(stateCookie?.value).toBe(state);
  expect(nonceCookie?.value).toBe(nonce);
  expect(connectionCookie?.value).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );

  const expectedChallenge = crypto
    .createHash("sha256")
    .update(verifierCookie?.value || "")
    .digest("base64url");
  expect(challenge).toBe(expectedChallenge);

  for (const cookie of [
    stateCookie,
    verifierCookie,
    nonceCookie,
    connectionCookie,
  ]) {
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe("Lax");
    expect(cookie?.path).toBe("/api/auth/sso");
  }
});
