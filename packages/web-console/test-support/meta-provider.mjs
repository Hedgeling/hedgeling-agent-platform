import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Generate ephemeral test certificates outside a production container when its
// slim runtime has no openssl executable. Never bake these into the image.
export function createTestTls() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "meta-byok-tls-"));
  const cert = path.join(directory, "cert.pem"), key = path.join(directory, "key.pem");
  const config = path.join(directory, "openssl.cnf");
  fs.writeFileSync(config, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-config", config], { stdio: "ignore" });
  return directory;
}

// Synthetic provider: exercise the real HTTPS adapter without model credentials.
export async function metaProvider() {
  const supplied = process.env.HEDGELING_TEST_TLS_DIRECTORY;
  const directory = supplied || createTestTls();
  const cert = path.join(directory, "cert.pem"), key = path.join(directory, "key.pem");
  const calls = [], control = { fail: false, text: "Bonjour {name}", beforeResponse: null };
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : null;
    calls.push({ method: req.method, path: req.url, authorization: req.headers.authorization, body });
    if (control.beforeResponse) await control.beforeResponse({ req, body });
    res.writeHead(control.fail ? 403 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(control.fail ? { error: "private upstream detail" } : req.method === "GET" ? { id: "test-meta-model" } : {
      id: "synthetic-meta-response", status: "completed",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: control.text }] }],
      usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130, output_tokens_details: { reasoning_tokens: 12 } },
    }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { calls, control, env: { HEDGELING_META_RESPONSES_URL: `https://127.0.0.1:${server.address().port}/v1/responses`,
    HEDGELING_META_TRANSLATION_MODEL: "test-meta-model", NODE_EXTRA_CA_CERTS: cert },
  close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); if (!supplied) fs.rmSync(directory, { recursive: true, force: true }); } };
}
