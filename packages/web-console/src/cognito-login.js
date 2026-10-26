import {
  ConfirmSignUpCommand,
  ConfirmForgotPasswordCommand,
  CognitoIdentityProviderClient,
  ForgotPasswordCommand,
  InitiateAuthCommand,
  ResendConfirmationCodeCommand,
  RevokeTokenCommand,
  RespondToAuthChallengeCommand,
  SignUpCommand,
} from "@aws-sdk/client-cognito-identity-provider";

let cognitoClientOverride = null;

export function setCognitoLoginTestClient(testClient) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Cognito login test client is only available in NODE_ENV=test");
  }
  cognitoClientOverride = testClient;
}

function client() {
  if (cognitoClientOverride) return cognitoClientOverride;
  const region = process.env.COGNITO_REGION || String(process.env.COGNITO_USER_POOL_ID || "").split("_")[0];
  if (!region) throw Object.assign(new Error("COGNITO_REGION is not configured"), { status: 503 });
  return new CognitoIdentityProviderClient({ region });
}

function appClientId() {
  const value = process.env.COGNITO_APP_CLIENT_ID || "";
  if (!value) throw Object.assign(new Error("COGNITO_APP_CLIENT_ID is not configured"), { status: 503 });
  return value;
}

function selfServiceSignupEnabled() {
  return process.env.HEDGELING_SELF_SERVICE_SIGNUP_ENABLED === "true";
}

function requireSelfServiceSignup() {
  if (!selfServiceSignupEnabled()) {
    throw Object.assign(new Error("Self-service signup is not enabled"), { status: 404 });
  }
}

function signupEmail(req) {
  return typeof req.body?.email === "string"
    ? req.body.email.trim().toLowerCase()
    : "";
}

function signupError(error) {
  if (error?.name === "InvalidPasswordException") {
    return { status: 400, message: "The password does not meet the account security requirements" };
  }
  if (["CodeMismatchException", "ExpiredCodeException"].includes(error?.name)) {
    return { status: 400, message: "The confirmation code is invalid or expired" };
  }
  if (error?.name === "LimitExceededException") {
    return { status: 429, message: "Too many attempts. Please wait before trying again" };
  }
  if ([
    "InvalidParameterException",
    "NotAuthorizedException",
  ].includes(error?.name)) {
    return { status: 400, message: "The account request could not be completed" };
  }
  return {
    status: 503,
    message: "The account service is temporarily unavailable",
  };
}

export async function signUp(req, res) {
  requireSelfServiceSignup();
  const email = signupEmail(req);
  const displayName = typeof req.body?.displayName === "string"
    ? req.body.displayName.trim()
    : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!email || !displayName || !password) {
    return res.status(400).json({ error: "Name, email, and password are required" });
  }
  if (displayName.length > 200) {
    return res.status(400).json({ error: "Name cannot exceed 200 characters" });
  }
  if (req.body?.acceptedTerms !== true || req.body?.acceptedPrivacy !== true) {
    return res.status(400).json({ error: "The Terms of Service and Privacy Policy must be accepted" });
  }
  const expectedTermsVersion = process.env.HEDGELING_TERMS_VERSION || "2026-07-30";
  const expectedPrivacyVersion = process.env.HEDGELING_PRIVACY_VERSION || "2026-07-30";
  if (
    req.body?.termsVersion !== expectedTermsVersion
    || req.body?.privacyVersion !== expectedPrivacyVersion
  ) {
    return res.status(400).json({ error: "The current legal terms must be accepted" });
  }
  try {
    const result = await client().send(new SignUpCommand({
      ClientId: appClientId(),
      Username: email,
      Password: password,
      UserAttributes: [
        { Name: "email", Value: email },
        { Name: "name", Value: displayName },
      ],
      ClientMetadata: {
        hedgeling_signup: "self_service",
        terms_version: expectedTermsVersion,
        privacy_version: expectedPrivacyVersion,
      },
    }));
    return res.status(result.UserConfirmed === true ? 201 : 202).json({
      ok: true,
      userConfirmed: result.UserConfirmed === true,
    });
  } catch (error) {
    if (error?.name === "UsernameExistsException") {
      return res.status(202).json({
        ok: true,
        userConfirmed: false,
      });
    }
    const mapped = signupError(error);
    return res.status(mapped.status).json({ error: mapped.message });
  }
}

export async function confirmSignUp(req, res) {
  requireSelfServiceSignup();
  const email = signupEmail(req);
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  if (!email || !code) {
    return res.status(400).json({ error: "Email and confirmation code are required" });
  }
  try {
    await client().send(new ConfirmSignUpCommand({
      ClientId: appClientId(),
      Username: email,
      ConfirmationCode: code,
    }));
    return res.json({ ok: true });
  } catch (error) {
    if (error?.name === "NotAuthorizedException") return res.json({ ok: true });
    const mapped = signupError(error);
    return res.status(mapped.status).json({ error: mapped.message });
  }
}

export async function resendSignupCode(req, res) {
  requireSelfServiceSignup();
  const email = signupEmail(req);
  if (!email) return res.status(400).json({ error: "Email is required" });
  try {
    await client().send(new ResendConfirmationCodeCommand({
      ClientId: appClientId(),
      Username: email,
    }));
  } catch (error) {
    if (!["UserNotFoundException", "InvalidParameterException"].includes(error?.name)) {
      const mapped = signupError(error);
      return res.status(mapped.status).json({ error: mapped.message });
    }
  }
  return res.json({ ok: true });
}

function requestCookie(req, name) {
  const item = String(req.get("cookie") || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : "";
}

function cookieOptions(maxAge, path = "/") {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function setAuthenticationCookies(res, result) {
  const authentication = result.AuthenticationResult;
  if (!authentication?.AccessToken) return false;
  const cookies = [
    `hedgeling_access_token=${encodeURIComponent(authentication.AccessToken)}; ${cookieOptions(authentication.ExpiresIn || 3600)}`,
  ];
  if (authentication.RefreshToken) {
    cookies.push(`hedgeling_refresh_token=${encodeURIComponent(authentication.RefreshToken)}; ${cookieOptions(60 * 60 * 24 * 30, "/api/auth/refresh")}`);
  }
  res.set("Set-Cookie", cookies);
  return true;
}

function clearIdentityConnectionCookie(res) {
  res.append("Set-Cookie", `hedgeling_identity_connection=; ${cookieOptions(0)}`);
}

function publicChallenge(result, username) {
  if (!result.ChallengeName) return null;
  if (![
    "NEW_PASSWORD_REQUIRED",
    "SMS_MFA",
    "SOFTWARE_TOKEN_MFA",
  ].includes(result.ChallengeName)) {
    throw Object.assign(new Error(`Unsupported Cognito challenge: ${result.ChallengeName}`), { status: 409 });
  }
  return {
    name: result.ChallengeName,
    session: result.Session,
    username,
    parameters: result.ChallengeParameters || {},
  };
}

export async function signIn(req, res) {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!username || !password) return res.status(400).json({ error: "Email and password are required" });
  try {
    const result = await client().send(new InitiateAuthCommand({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: appClientId(),
      AuthParameters: { USERNAME: username, PASSWORD: password },
    }));
    const challenge = publicChallenge(result, username);
    if (challenge) return res.json({ challenge });
    if (!setAuthenticationCookies(res, result)) throw new Error("Cognito did not return an access token");
    clearIdentityConnectionCookie(res);
    return res.json({ ok: true });
  } catch (error) {
    if (error?.status) throw error;
    const publicMessage = error?.name === "NotAuthorizedException"
      ? "Incorrect email or password"
      : error?.name === "UserNotConfirmedException"
        ? "Your account has not been confirmed"
        : "Sign-in failed";
    return res.status(401).json({ error: publicMessage });
  }
}

export async function respondToChallenge(req, res) {
  const { name, session, username, value } = req.body || {};
  if (!["NEW_PASSWORD_REQUIRED", "SMS_MFA", "SOFTWARE_TOKEN_MFA"].includes(name)) {
    return res.status(400).json({ error: "Unsupported sign-in challenge" });
  }
  if (![session, username, value].every((item) => typeof item === "string" && item)) {
    return res.status(400).json({ error: "Challenge response is incomplete" });
  }
  const responseKey = name === "NEW_PASSWORD_REQUIRED" ? "NEW_PASSWORD" : `${name}_CODE`;
  try {
    const result = await client().send(new RespondToAuthChallengeCommand({
      ClientId: appClientId(),
      ChallengeName: name,
      Session: session,
      ChallengeResponses: { USERNAME: username, [responseKey]: value },
    }));
    const challenge = publicChallenge(result, username);
    if (challenge) return res.json({ challenge });
    if (!setAuthenticationCookies(res, result)) throw new Error("Cognito did not return an access token");
    clearIdentityConnectionCookie(res);
    return res.json({ ok: true });
  } catch {
    return res.status(401).json({ error: "The challenge response was not accepted" });
  }
}

export async function refreshSession(req, res) {
  const refreshToken = requestCookie(req, "hedgeling_refresh_token");
  if (!refreshToken) return res.status(401).json({ error: "Your session has expired" });
  try {
    const result = await client().send(new InitiateAuthCommand({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: appClientId(),
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }));
    if (!setAuthenticationCookies(res, result)) throw new Error("Cognito did not return an access token");
    return res.json({ ok: true });
  } catch {
    await signOut(req, res, { respond: false });
    return res.status(401).json({ error: "Your session has expired" });
  }
}

export async function requestPasswordReset(req, res) {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  if (!username) return res.status(400).json({ error: "Email is required" });
  try {
    await client().send(new ForgotPasswordCommand({ ClientId: appClientId(), Username: username }));
  } catch (error) {
    if (!["UserNotFoundException", "InvalidParameterException"].includes(error?.name)) throw error;
  }
  return res.json({ ok: true });
}

export async function confirmPasswordReset(req, res) {
  const username = typeof req.body?.username === "string" ? req.body.username.trim() : "";
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!username || !code || !password) return res.status(400).json({ error: "Email, code, and new password are required" });
  try {
    await client().send(new ConfirmForgotPasswordCommand({
      ClientId: appClientId(),
      Username: username,
      ConfirmationCode: code,
      Password: password,
    }));
    return res.json({ ok: true });
  } catch {
    return res.status(400).json({ error: "The reset code or new password was not accepted" });
  }
}

export async function signOut(req, res, options = {}) {
  const refreshToken = process.env.HEDGELING_AUTH_MODE === "local" ? "" : requestCookie(req, "hedgeling_refresh_token");
  if (refreshToken) {
    try {
      await client().send(new RevokeTokenCommand({
        ClientId: appClientId(),
        Token: refreshToken,
      }));
    } catch {
      // Local sign-out must succeed even when Cognito is temporarily unavailable.
    }
  }
  res.set("Set-Cookie", [
    "hedgeling_local_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0",
    `hedgeling_access_token=; ${cookieOptions(0)}`,
    `hedgeling_identity_connection=; ${cookieOptions(0)}`,
    `hedgeling_refresh_token=; ${cookieOptions(0, "/api/auth/refresh")}`,
    `hedgeling_refresh_token=; ${cookieOptions(0)}`,
  ]);
  return options.respond === false ? undefined : res.json({ ok: true });
}
