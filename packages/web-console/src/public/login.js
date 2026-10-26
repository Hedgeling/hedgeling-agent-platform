const loginForm = document.querySelector("#loginForm");
const challengeForm = document.querySelector("#challengeForm");
const resetRequestForm = document.querySelector("#resetRequestForm");
const resetConfirmForm = document.querySelector("#resetConfirmForm");
const message = document.querySelector("#message");
const passwordField = document.querySelector("#passwordField");
const passwordInput = document.querySelector("#password");
const usernameInput = document.querySelector("#username");
const loginSubmit = document.querySelector("#loginSubmit");
const forgotPassword = document.querySelector("#forgotPassword");
const changeAccount = document.querySelector("#changeAccount");
let passwordStep = false;
const recoveryMode = new URLSearchParams(location.search).get("recovery") === "1";

function showMessage(text) {
  message.textContent = text;
  message.hidden = !text;
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Sign-in failed");
  return data;
}

function showChallenge(challenge) {
  loginForm.hidden = true;
  challengeForm.hidden = false;
  document.querySelector("#challengeName").value = challenge.name;
  document.querySelector("#challengeSession").value = challenge.session;
  document.querySelector("#challengeUsername").value = challenge.username;
  const value = document.querySelector("#challengeValue");
  const newPassword = challenge.name === "NEW_PASSWORD_REQUIRED";
  document.querySelector("#challengeLabel").textContent = newPassword ? "Create a new password" : "Verification code";
  value.type = newPassword ? "password" : "text";
  value.autocomplete = newPassword ? "new-password" : "one-time-code";
  value.value = "";
  value.focus();
}

function showOnly(form) {
  [loginForm, challengeForm, resetRequestForm, resetConfirmForm].forEach((item) => { item.hidden = item !== form; });
  showMessage("");
}

function showEmailStep() {
  passwordStep = false;
  passwordField.hidden = true;
  passwordInput.required = false;
  passwordInput.value = "";
  usernameInput.readOnly = false;
  loginSubmit.innerHTML = 'Continue <span aria-hidden="true">→</span>';
  forgotPassword.hidden = true;
  changeAccount.hidden = true;
  showMessage("");
  usernameInput.focus();
}

function showPasswordStep() {
  passwordStep = true;
  passwordField.hidden = false;
  passwordInput.required = true;
  usernameInput.readOnly = true;
  loginSubmit.innerHTML = 'Sign in <span aria-hidden="true">→</span>';
  forgotPassword.hidden = false;
  changeAccount.hidden = false;
  passwordInput.focus();
}

function finishSignIn() {
  const next = new URLSearchParams(location.search).get("next");
  location.assign(next?.startsWith("/") && !next.startsWith("//") ? next : "/");
}

fetch("/api/me").then((response) => {
  if (response.ok) finishSignIn();
}).catch(() => {});

fetch("/api/auth/config")
  .then((response) => response.ok ? response.json() : null)
  .then((config) => {
    if (config?.mode === "basic") {
      loginForm.hidden = true;
      document.querySelector("#invitationHelp").hidden = true;
      document.querySelector(".intro").textContent = "This deployment uses browser authentication. Open any console page and sign in via the prompt.";
      return;
    }
    if (config?.selfServiceSignupEnabled) {
      document.querySelector("#signupHelp").hidden = false;
      document.querySelector("#invitationHelp").hidden = true;
    }
  })
  .catch(() => {});

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage("");
  const button = loginForm.querySelector("button");
  button.disabled = true;
  try {
    if (!passwordStep) {
      const next = new URLSearchParams(location.search).get("next");
      const discovery = await post("/api/auth/discover", {
        email: usernameInput.value,
        next,
        recovery: recoveryMode,
      });
      if (discovery.method === "sso") {
        location.assign(discovery.url);
        return;
      }
      if (discovery.passwordLoginEnabled === false) {
        throw new Error("Your organization requires single sign-on. Contact your administrator.");
      }
      showPasswordStep();
      return;
    }
    const data = await post("/api/auth/login", {
      username: usernameInput.value,
      password: passwordInput.value,
    });
    if (data.challenge) showChallenge(data.challenge);
    else finishSignIn();
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

challengeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showMessage("");
  const button = challengeForm.querySelector("button");
  button.disabled = true;
  try {
    const data = await post("/api/auth/challenge", {
      name: document.querySelector("#challengeName").value,
      session: document.querySelector("#challengeSession").value,
      username: document.querySelector("#challengeUsername").value,
      value: document.querySelector("#challengeValue").value,
    });
    if (data.challenge) showChallenge(data.challenge);
    else finishSignIn();
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#backToLogin").addEventListener("click", () => {
  showOnly(loginForm);
  showPasswordStep();
});

forgotPassword.addEventListener("click", () => {
  document.querySelector("#resetUsername").value = usernameInput.value;
  showOnly(resetRequestForm);
  document.querySelector("#resetUsername").focus();
});

changeAccount.addEventListener("click", showEmailStep);

document.querySelectorAll(".backToLogin").forEach((button) => button.addEventListener("click", () => {
  showOnly(loginForm);
  showEmailStep();
}));

resetRequestForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = resetRequestForm.querySelector("button");
  button.disabled = true;
  try {
    await post("/api/auth/password-reset/request", { username: document.querySelector("#resetUsername").value });
    showOnly(resetConfirmForm);
    document.querySelector("#resetCode").focus();
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

resetConfirmForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = resetConfirmForm.querySelector("button");
  button.disabled = true;
  try {
    await post("/api/auth/password-reset/confirm", {
      username: document.querySelector("#resetUsername").value,
      code: document.querySelector("#resetCode").value,
      password: document.querySelector("#resetPassword").value,
    });
    showOnly(loginForm);
    usernameInput.value = document.querySelector("#resetUsername").value;
    showPasswordStep();
    showMessage("Password updated. Sign in with your new password.");
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});
