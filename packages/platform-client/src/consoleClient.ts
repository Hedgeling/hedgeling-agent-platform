// v1.3.0 specs 09/10: the ONE console HTTP transport the CLI sync commands
// share (spec 09's `glossary push|pull`, spec 10's `sync push|pull`). Origin,
// auth, and typed errors live here so every command speaks to the console the
// same way; secrets travel exclusively in env vars and never in output.
//
// Console automation uses scoped bearer credentials exclusively.
export class ConsoleHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "ConsoleHttpError";
  }
}

export type ConsoleClient = {
  origin: string;
  projectSlug: string | undefined;
  request: <T>(method: "GET" | "POST" | "PUT" | "DELETE", apiPath: string, body?: unknown, options?: { projectQuery?: boolean }) => Promise<T>;
};

export type ConsoleClientOptions = {
  origin: string;
  token?: string;
  projectSlug?: string;
};

export function createConsoleClient(options: ConsoleClientOptions): ConsoleClient {
  const origin = options.origin.replace(/\/+$/, "");
  const parsedOrigin = new URL(origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsedOrigin.hostname);
  if (parsedOrigin.origin !== origin || parsedOrigin.username || parsedOrigin.password
    || (parsedOrigin.protocol !== "https:" && !(local && parsedOrigin.protocol === "http:"))) {
    throw new Error("Console URL must be an HTTPS origin (HTTP is allowed only for loopback troubleshooting).");
  }
  const token = options.token?.trim();
  if (!token) throw new Error("Set HEDGELING_CONSOLE_TOKEN to a scoped bearer credential; Basic Auth is no longer supported.");
  const authorization = `Bearer ${token}`;

  const request = async <T>(method: "GET" | "POST" | "PUT" | "DELETE", apiPath: string, body?: unknown, requestOptions: { projectQuery?: boolean } = {}): Promise<T> => {
    if (!apiPath.startsWith("/") || apiPath.startsWith("//")) throw new Error("Console request path must be relative to the configured origin");
    const url = new URL(`${origin}${apiPath}`);
    if (url.origin !== origin) throw new Error("Console request must use the configured origin");
    if (requestOptions.projectQuery !== false && options.projectSlug && !url.searchParams.has("project")) {
      url.searchParams.set("project", options.projectSlug);
    }
    const res = await fetch(url.toString(), {
      method,
      redirect: "error",
      headers: {
        authorization,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // A hung console must never hang CI — transport failures are exit 2.
      signal: AbortSignal.timeout(30_000),
    });
    let parsed: unknown = undefined;
    const text = await res.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (!res.ok) {
      const detail =
        parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : res.statusText;
      throw new ConsoleHttpError(`${method} ${apiPath}: HTTP ${res.status}${detail ? ` (${detail})` : ""}`, res.status, parsed);
    }
    return parsed as T;
  };

  return { origin, projectSlug: options.projectSlug, request };
}

/**
 * Resolve the console client from the environment (the CI convention). Returns
 * an error string instead of throwing so commands can print one actionable
 * line and exit 2 (configuration error, distinct from check failures).
 */
export function consoleClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  // Spec 10: `sync` resolves the origin from --origin or the committed cursor
  // artifact (.hedgeling/sync.json) before falling back to the env var.
  overrides: { origin?: string } = {},
): ConsoleClient | { error: string } {
  const origin = (overrides.origin || env.HEDGELING_CONSOLE_URL || env.HEDGELING_ADMIN_URL || "").trim();
  if (!origin) {
    return { error: "HEDGELING_CONSOLE_URL is not set — point it at the Hedgeling console origin (or pass --origin)." };
  }
  const token = (env.HEDGELING_CONSOLE_TOKEN || env.HEDGELING_API_TOKEN || "").trim();
  if (!token) return { error: "Set HEDGELING_CONSOLE_TOKEN to a scoped bearer credential; Basic Auth is no longer supported." };
  const projectSlug = (env.HEDGELING_PROJECT_SLUG || env.HEDGELING_CONSOLE_PROJECT || "").trim() || undefined;
  try { return createConsoleClient({ origin, token, projectSlug }); }
  catch (error) { return { error: error instanceof Error ? error.message : "Invalid console configuration" }; }
}
