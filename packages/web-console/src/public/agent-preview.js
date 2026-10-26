import { proposalCard, answerCard, typewriterComposer } from "./agent-components.js";
import { AgentAttention } from "./agent-attention.js";

// This playground deliberately has no action API or run client. All submissions
// are in-memory examples, including the shared approval component.
const card = document.getElementById("previewCard");
const reply = document.getElementById("previewReply");
const attention = new AgentAttention();
document.getElementById("previewComposer").innerHTML = typewriterComposer;
const render = (kind) => {
  reply.textContent = "";
  for (const button of document.querySelectorAll("[data-example]")) button.setAttribute("aria-pressed", String(button.dataset.example === kind));
  if (kind === "approval") card.replaceChildren(proposalCard({
    id: "design-example", preview: {
      action: "localization_job.create",
      fields: { name: "Autumn launch", sourceLocale: "en", targetLocales: ["fr", "de", "ja"], steps: ["machine_translation", "review"] },
      resources: { project: { name: "Website · Marketing" }, sourceCount: 24 },
      cost: "Draft only · No translation run or provider spending.",
      sideEffects: ["Saves a draft job with the selected content and languages.", "Translation starts only after a separate confirmation."],
    },
  }, async () => {}, async () => {}, { example: true }));
  else if (kind === "options") card.replaceChildren(answerCard({
    example: true, title: "How should these words travel?", description: "Choose the translation workflow for this example job.",
    fields: [{ name: "workflow", label: "Translation workflow", value: "ai_review", options: [
      { value: "ai_review", label: "AI translation + human review", description: "Prepare a first draft, then give a linguist the final word." },
      { value: "human_review", label: "Human translation + review", description: "Have a translator write it and a reviewer refine it." },
      { value: "decide_later", label: "Help me decide", description: "Talk through the content, quality needs, and timing first." },
    ] }],
  }, async () => {}));
  else card.replaceChildren(answerCard({
    example: true, title: "Let’s name the next chapter.", description: "A few details to prepare the example preview.", submitLabel: "Use these details",
    fields: [
      { name: "name", label: "Project name", placeholder: "e.g. Autumn launch" },
      { name: "locales", label: "Target languages", placeholder: "e.g. French, German, Japanese" },
      { name: "notes", label: "Anything else? (optional)", multiline: true, required: false, placeholder: "Tone, audience, or something we should ask about…" },
    ],
  }, async () => {}));
};
for (const button of document.querySelectorAll("[data-example]")) button.addEventListener("click", () => render(button.dataset.example));
document.getElementById("agentComposer").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = document.getElementById("agentInput");
  if (!input.value.trim()) return;
  reply.textContent = `Your sample note: ${input.value.trim()}\n\nExample only · Nothing was sent to the agent.`;
  input.value = "";
});
document.getElementById("agentInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); document.getElementById("agentComposer").requestSubmit(); }
});
document.getElementById("previewHighlight").addEventListener("click", () => { attention.clear(); attention.mark(document.getElementById("previewHighlightTarget"), "Example · looking at this section"); });
render("approval");
