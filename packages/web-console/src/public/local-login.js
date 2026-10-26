document.querySelector("#localLogin").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.querySelector("#token");
  try {
    const response = await fetch("/api/auth/local", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: input.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Sign-in failed");
    input.value = "";
    location.assign("/");
  } catch (error) {
    document.querySelector("#message").textContent = error.message;
  }
});
