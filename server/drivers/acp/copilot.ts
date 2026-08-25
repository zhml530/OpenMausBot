// GitHub Copilot CLI over its public-preview ACP stdio server.
// `copilot --acp` works on old releases (including 0.0.420) and current ones;
// older releases reject the newer, optional `--stdio` disambiguation flag.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelCatalog, ProviderErrorCode } from "../../contracts.ts";
import { execCli } from "../../procs.ts";
import { createAcpDriver, type AcpSupport } from "./core.ts";

export const STATIC_COPILOT_MODELS: ModelCatalog = {
  default: "claude-sonnet-4.6",
  options: [
    { id: "claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
    { id: "claude-haiku-4.5", label: "Claude Haiku 4.5" },
    { id: "claude-opus-4.6", label: "Claude Opus 4.6" },
    { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
    { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
    { id: "gpt-5.2", label: "GPT-5.2" },
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
    { id: "gpt-4.1", label: "GPT-4.1" },
  ],
};

const MODEL_ID = /^[a-z0-9][a-z0-9._:+/-]*$/i;
const EXEC_TIMEOUT_MS = 8_000;

type StoredCopilotUser = Record<string, string>;

interface StoredCopilotConfig {
  lastLoggedInUser?: StoredCopilotUser;
  lastloggedinuser?: StoredCopilotUser;
  loggedInUsers?: StoredCopilotUser[];
  loggedinusers?: StoredCopilotUser[];
}

export type CopilotFailure = (Error & { code?: string | number }) | string | null | undefined;

function modelLabel(id: string): string {
  return id.split(/[-_/]+/g).filter(Boolean)
    .map((part) => (/^gpt$/i.test(part) ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ");
}

/** Parse the wrapped quoted choices printed beside `copilot --help --model`. */
export function decodeCopilotModelHelp(text: string): ModelCatalog | null {
  const marker = text.search(/--model\s+<model>/i);
  if (marker < 0) return null;
  const tail = text.slice(marker);
  const nextOption = tail.slice(1).search(/\r?\n\s{2,}--[a-z]/i);
  const block = nextOption < 0 ? tail : tail.slice(0, nextOption + 1);
  const options: ModelCatalog["options"] = [];
  const seen = new Set<string>();
  for (const match of block.matchAll(/["']([^"']+)["']/g)) {
    const id = match[1]?.trim() ?? "";
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const fallback = STATIC_COPILOT_MODELS.options.find((option) => option.id === id);
    options.push(fallback ? { ...fallback } : { id, label: modelLabel(id) });
  }
  if (!options.length) return null;
  return { default: options[0]!.id, options };
}

function execText(run: typeof execCli, cli: string, args: string[], env: Record<string, string | undefined>) {
  return new Promise<string | null>((resolve) => {
    // SAFETY: childEnv starts as process.env plus string-valued instance env;
    // ACP transforms only add or delete string-valued environment keys.
    run(cli, args, { timeout: EXEC_TIMEOUT_MS, env: env as NodeJS.ProcessEnv }, (err, stdout) =>
      resolve(err ? null : String(stdout ?? "")));
  });
}

export async function fetchCopilotModels(
  cli: string,
  env: Record<string, string | undefined>,
  run: typeof execCli = execCli,
): Promise<ModelCatalog> {
  const help = await execText(run, cli, ["--help"], env);
  const live = help ? decodeCopilotModelHelp(help) : null;
  if (!live) return STATIC_COPILOT_MODELS;
  const configured = env.COPILOT_MODEL?.trim();
  if (configured && MODEL_ID.test(configured) && !live.options.some((option) => option.id === configured)) {
    live.options.push({ id: configured, label: modelLabel(configured), custom: true });
  }
  if (configured && live.options.some((option) => option.id === configured)) live.default = configured;
  return live;
}

const nonBlank = (value: string | undefined): boolean => Boolean(value?.trim());

function hasStoredLogin(env: Record<string, string | undefined>): boolean {
  const root = env.COPILOT_HOME || join(env.HOME || env.USERPROFILE || homedir(), ".copilot");
  const path = join(root, "config.json");
  if (!existsSync(path)) return false;
  try {
    const parsed: StoredCopilotConfig = JSON.parse(readFileSync(path, "utf8"));
    const last = parsed.lastLoggedInUser ?? parsed.lastloggedinuser;
    if (last && Object.keys(last).length > 0) return true;
    const users = parsed.loggedInUsers ?? parsed.loggedinusers;
    if (users && (Array.isArray(users) ? users.length > 0 : Object.keys(users).length > 0)) return true;
  } catch {
    // A malformed config is not proof of a usable keychain login.
  }
  return false;
}

/** The actual OAuth secret stays in the OS keychain; the ACP turn remains the
 * authority on token expiry. This snapshot only detects stored user metadata. */
export function copilotIsAuthenticated(env: Record<string, string | undefined>): boolean {
  return nonBlank(env.COPILOT_GITHUB_TOKEN) || nonBlank(env.GH_TOKEN) ||
    nonBlank(env.GITHUB_TOKEN) || nonBlank(env.COPILOT_PROVIDER_BASE_URL) || hasStoredLogin(env);
}

export function classifyCopilotError(error: CopilotFailure): ProviderErrorCode | undefined {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const code = error instanceof Error ? error.code : undefined;
  const blob = `${code ?? ""} ${message}`.toLowerCase();
  if (/unauthoriz|unauthenticated|not signed in|not logged in|authentication required|invalid.*token/.test(blob))
    return "invalid_credentials";
  if (/copilot.*(subscription|plan).*(inactive|expired|required)|no active copilot subscription/.test(blob))
    return "inactive_subscription";
  if (/rate limit|quota|premium requests? limit|region.*not supported/.test(blob))
    return "quota_or_region_restriction";
  return undefined;
}

const support = (run: typeof execCli): AcpSupport => ({
  driverKind: "copilotAgent",
  displayName: "GitHub Copilot",
  models: STATIC_COPILOT_MODELS,
  defaultCli: "copilot",
  nativeSource: "copilot.acp",
  loginNote: "GitHub Copilot CLI is not signed in — run `copilot login` in a terminal",
  install: {
    command: {
      darwin: "brew install --cask copilot-cli",
      linux: "curl -fsSL https://gh.io/copilot-install | bash",
      win32: "winget install GitHub.Copilot",
    },
    docsUrl: "https://docs.github.com/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli",
    signInCommand: "copilot login",
  },
  resolveModels: (environment, config) => fetchCopilotModels(config.cli || "copilot", environment, run),
  spawnArgs: (config, turn) => [
    ...(config.fullAuto ? ["--allow-all"] : []),
    ...(turn.model ? ["--model", turn.model] : []),
    "--acp",
  ],
  credentialEnv: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_PROVIDER_API_KEY"],
  pickAuthMethod: () => null,
  authFailure: "continue",
  isAuthenticated: copilotIsAuthenticated,
  classifyError: (error) => {
    // SAFETY: classification only stringifies the value and reads Error fields;
    // arbitrary thrown values fit this deliberately closed adapter.
    return classifyCopilotError(error as CopilotFailure);
  },
  async configureSession({ request, sessionId, turn }) {
    if (!turn.model) return;
    try {
      await request("session/set_model", { sessionId, modelId: turn.model });
    } catch (error) {
      // SAFETY: core.ts rejects ACP requests with Error objects; JSON-RPC
      // errors attach an optional numeric code to that Error.
      const err = error as Error & { code?: unknown };
      // argv already pins the model on CLIs without this optional ACP method.
      if (err.code === -32601 || err.code === -32602) return;
      throw error;
    }
  },
  buildPromptText: (turn) => (turn.system ? `${turn.system}\n\n${turn.text}` : turn.text),
});

export function createCopilotAgentDriver(run: typeof execCli = execCli) {
  return createAcpDriver(support(run));
}

export const CopilotAgentDriver = createCopilotAgentDriver();
