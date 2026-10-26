const signupForm = document.querySelector("#signupForm");
const confirmForm = document.querySelector("#confirmForm");
const message = document.querySelector("#message");
let configuration = null;
let pendingPassword = "";

function showMessage(text, tone = "error") {
  message.textContent = text;
  message.dataset.tone = tone;
  message.hidden = !text;
}

async function post(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "The request could not be completed");
  return data;
}

async function signInAndContinue() {
  const data = await post("/api/auth/login", {
    username: document.querySelector("#email").value,
    password: pendingPassword,
  });
  if (data.challenge) {
    location.assign("/login?next=/onboarding");
    return;
  }
  location.assign("/onboarding");
}

function showConfirmation() {
  signupForm.hidden = true;
  confirmForm.hidden = false;
  document.querySelector("#stepLabel").textContent = "Verify email";
  document.querySelector("#formTitle").textContent = "Check your inbox";
  document.querySelector("#formIntro").textContent = "Confirm your email to protect the workspace you are about to create.";
  document.querySelector("#confirmationEmail").textContent = document.querySelector("#email").value;
  document.querySelector("#confirmationCode").focus();
  showMessage("");
}

fetch("/api/auth/config")
  .then((response) => response.json())
  .then((config) => {
    configuration = config;
    if (!config.selfServiceSignupEnabled) {
      throw new Error("Self-service signup is not available yet.");
    }
    document.querySelector("#trialEyebrow").textContent =
      `${config.trialDays}-day free trial`;
    for (const [selector, url] of [
      ["#termsLink", config.termsUrl],
      ["#privacyLink", config.privacyUrl],
    ]) {
      const link = document.querySelector(selector);
      if (url) link.href = url;
      else {
        link.removeAttribute("href");
        link.title = "Legal document URL is not configured in this environment";
      }
    }
  })
  .catch((error) => {
    showMessage(error.message);
    signupForm.querySelector("button").disabled = true;
  });

signupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = signupForm.querySelector("button");
  button.disabled = true;
  showMessage("");
  pendingPassword = document.querySelector("#password").value;
  try {
    const result = await post("/api/auth/signup", {
      displayName: document.querySelector("#displayName").value,
      email: document.querySelector("#email").value,
      password: pendingPassword,
      acceptedTerms: document.querySelector("#legalAcceptance").checked,
      acceptedPrivacy: document.querySelector("#legalAcceptance").checked,
      termsVersion: configuration.termsVersion,
      privacyVersion: configuration.privacyVersion,
    });
    if (result.userConfirmed) await signInAndContinue();
    else showConfirmation();
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

confirmForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = confirmForm.querySelector("button");
  button.disabled = true;
  showMessage("");
  try {
    await post("/api/auth/signup/confirm", {
      email: document.querySelector("#email").value,
      code: document.querySelector("#confirmationCode").value,
    });
    if (pendingPassword) await signInAndContinue();
    else location.assign("/login?next=/onboarding");
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});

document.querySelector("#resendCode").addEventListener("click", async () => {
  const button = document.querySelector("#resendCode");
  button.disabled = true;
  try {
    await post("/api/auth/signup/resend", {
      email: document.querySelector("#email").value,
    });
    showMessage("A new confirmation code has been requested.", "success");
  } catch (error) {
    showMessage(error.message);
  } finally {
    button.disabled = false;
  }
});
