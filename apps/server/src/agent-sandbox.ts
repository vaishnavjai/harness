import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { win32 } from "node:path";

/**
 * Runs the agent's shell commands inside an OS sandbox (checklist item 3).
 *
 * The engine runs every shell command as `$SHELL -c <command>`. When the sandbox is on, `SHELL` is the
 * `harness-sandbox` helper, which reads a policy file and starts the real shell inside a Windows AppContainer.
 * This module decides what the policy says and keeps the file current; the helper enforces it.
 *
 * Off by default. Turning it on with no working helper is an error, never a silent fall back to no sandbox.
 */

export const AGENT_SANDBOX_ENV = "HARNESS_AGENT_SANDBOX";
export const AGENT_SANDBOX_NETWORK_ENV = "HARNESS_AGENT_SANDBOX_NETWORK";
export const AGENT_SANDBOX_HELPER_ENV = "HARNESS_AGENT_SANDBOX_HELPER";
export const AGENT_SANDBOX_SHELL_ENV = "HARNESS_AGENT_SANDBOX_SHELL";
/** Extra folders no grant may reach, separated by `;` (the desktop sets this to its data folder). */
export const AGENT_SANDBOX_PROTECT_ENV = "HARNESS_AGENT_SANDBOX_PROTECT";
/** Names the policy file for the helper. Removed from the environment of every command the helper starts. */
export const SANDBOX_POLICY_ENV = "HARNESS_SANDBOX_POLICY";

export type SandboxNetwork = "none" | "internet" | "internet-server";

/** The file the helper reads. Its shape is the helper's contract (`native/harness-sandbox/src/policy.rs`). */
export type AgentSandboxPolicy = {
  version: 1;
  shell: string;
  readWrite: string[];
  readOnly: string[];
  protect: string[];
  tempDir: string;
  network: SandboxNetwork;
};

export class AgentSandboxUnavailableError extends Error {
  constructor(message: string) {
    super(`The agent sandbox is turned on (${AGENT_SANDBOX_ENV}) but cannot be used: ${message}`);
    this.name = "AgentSandboxUnavailableError";
  }
}

const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const FALSE_VALUES = new Set(["", "0", "false", "off", "no"]);

export function agentSandboxRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env[AGENT_SANDBOX_ENV] ?? "").trim().toLowerCase();
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  // A value nobody meant ("ture") must not quietly leave the sandbox off.
  throw new AgentSandboxUnavailableError(`${AGENT_SANDBOX_ENV}=${JSON.stringify(env[AGENT_SANDBOX_ENV])} is not one of 1, true, on, 0, false, off`);
}

/** No network unless asked: an agent that has been talked into leaking something cannot send it anywhere. */
export function agentSandboxNetwork(env: NodeJS.ProcessEnv = process.env): SandboxNetwork {
  const value = (env[AGENT_SANDBOX_NETWORK_ENV] ?? "none").trim().toLowerCase();
  if (value === "none" || value === "internet" || value === "internet-server") return value;
  throw new AgentSandboxUnavailableError(`${AGENT_SANDBOX_NETWORK_ENV}=${JSON.stringify(env[AGENT_SANDBOX_NETWORK_ENV])} is not one of none, internet, internet-server`);
}

const key = (path: string) => path.toLowerCase();

function within(parent: string, path: string): boolean {
  const [base, candidate] = [key(parent), key(path)];
  return candidate === base || candidate.startsWith(`${base}\\`);
}

/** A drive-absolute Windows path in canonical form (single backslashes, no trailing one), or null. */
export function windowsPath(raw: string | undefined): string | null {
  if (!raw || !/^[A-Za-z]:[\\/]/.test(raw)) return null;
  const normal = win32.normalize(raw).replace(/[\\/]+$/, "");
  return /^[A-Za-z]:$/.test(normal) ? `${normal}\\` : normal;
}

function unique(paths: string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => (seen.has(key(path)) ? false : (seen.add(key(path)), true)));
}

type WindowsEnv = { systemDrive: string; systemRoot: string; programFiles: string[]; programData: string; profile: string | null; sensitive: string[] };

function windowsEnv(env: NodeJS.ProcessEnv): WindowsEnv {
  const systemDrive = (env.SystemDrive ?? "C:").replace(/[\\/]+$/, "");
  const systemRoot = windowsPath(env.SystemRoot) ?? `${systemDrive}\\Windows`;
  const profile = windowsPath(env.USERPROFILE);
  return {
    systemDrive,
    systemRoot,
    programFiles: [env.ProgramFiles, env["ProgramFiles(x86)"], `${systemDrive}\\Program Files`, `${systemDrive}\\Program Files (x86)`].map(windowsPath).filter((p): p is string => p !== null),
    programData: windowsPath(env.ProgramData) ?? `${systemDrive}\\ProgramData`,
    profile,
    sensitive: [profile, windowsPath(env.APPDATA), windowsPath(env.LOCALAPPDATA), `${systemDrive}\\Users`].filter((p): p is string => p !== null),
  };
}

function inSystemFolder(path: string, w: WindowsEnv): boolean {
  return [w.systemRoot, w.programData, ...w.programFiles].some((dir) => within(dir, path));
}

/** Why a folder cannot be granted, or null when it can. The helper makes the same call and has the last word. */
export function whyNotGrantable(path: string, env: NodeJS.ProcessEnv): string | null {
  const w = windowsEnv(env);
  if (/^[A-Za-z]:\\?$/.test(path)) return "it is a whole drive";
  if (inSystemFolder(path, w)) return "it is inside a system folder";
  if (w.sensitive.some((dir) => within(path, dir))) return "it is, or contains, the user profile";
  return null;
}

export type BuiltPolicy = { policy: AgentSandboxPolicy; skipped: Array<{ path: string; reason: string }> };

/**
 * The shell the engine would pick on Windows: Git's bash when it is installed, then PowerShell, then cmd.
 * Kept identical to the engine's choice so turning the sandbox on does not change which shell the agent gets.
 */
export function windowsShell(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): string | null {
  const w = windowsEnv(env);
  const candidates = [
    env[AGENT_SANDBOX_SHELL_ENV],
    env.OPENCODE_GIT_BASH_PATH,
    ...w.programFiles.map((dir) => `${dir}\\Git\\bin\\bash.exe`),
    env.LOCALAPPDATA ? `${env.LOCALAPPDATA}\\Programs\\Git\\bin\\bash.exe` : undefined,
    `${w.systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    `${w.systemRoot}\\System32\\cmd.exe`,
  ];
  for (const candidate of candidates) {
    const path = windowsPath(candidate);
    if (path && exists(path)) return path;
  }
  return null;
}

/**
 * Folders on PATH the agent's tools live in that the container could not otherwise read. Program Files and
 * Windows are already readable to an AppContainer, and the helper refuses them as grants, so they are left out.
 */
export function toolFolders(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): string[] {
  const w = windowsEnv(env);
  const entries = (env.Path ?? env.PATH ?? "").split(";").map(windowsPath).filter((p): p is string => p !== null);
  return unique(entries.filter((dir) => exists(dir) && !inSystemFolder(dir, w) && whyNotGrantable(dir, env) === null));
}

export function buildAgentSandboxPolicy(input: {
  /** Workspace folders and any other folder the person has authorized, as configured. */
  roots: string[];
  /** Harness's own data: config, runtime database, vault, audit log, memory. Never reachable from the sandbox. */
  protect: string[];
  tempDir: string;
  shell: string;
  network: SandboxNetwork;
  env: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}): BuiltPolicy {
  const exists = input.exists ?? existsSync;
  const skipped: BuiltPolicy["skipped"] = [];
  const readWrite: string[] = [];
  for (const raw of input.roots) {
    const path = windowsPath(raw);
    const reason = path === null ? "it is not a local drive folder" : whyNotGrantable(path, input.env) ?? (exists(path) ? null : "it does not exist");
    if (path !== null && reason === null) readWrite.push(path);
    else skipped.push({ path: raw, reason: reason ?? "unusable" });
  }
  const protect = unique(input.protect.map(windowsPath).filter((p): p is string => p !== null));
  // A folder that reaches Harness's own data would let the agent rewrite the audit log and read the vault.
  const safe = readWrite.filter((path) => {
    const clash = protect.find((dir) => within(dir, path) || within(path, dir));
    if (clash) skipped.push({ path, reason: `it overlaps Harness's own data at ${clash}` });
    return !clash;
  });
  return {
    policy: {
      version: 1,
      shell: input.shell,
      readWrite: unique(safe),
      readOnly: toolFolders(input.env, exists),
      protect,
      tempDir: windowsPath(input.tempDir) ?? input.tempDir,
      network: input.network,
    },
    skipped,
  };
}

/** Writes the policy so a command that starts mid-write reads either the old file or the new one, never half. */
export async function writeAgentSandboxPolicy(path: string, policy: AgentSandboxPolicy): Promise<void> {
  await mkdir(win32.dirname(path), { recursive: true });
  const staged = `${path}.${process.pid}.tmp`;
  await writeFile(staged, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  await rename(staged, path);
}

export type AgentSandbox = {
  /** Merge into the engine's environment. */
  env: Record<string, string>;
  policyPath: string;
  /** Rewrite the policy from the current workspaces. Call after any workspace or authorized folder changes. */
  refresh: () => Promise<BuiltPolicy>;
};

export type AgentSandboxInput = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Folder for the policy file and scratch space, under Harness's own data. */
  storageDir: string;
  /** Current workspace folders and authorized roots. Read again on every refresh. */
  roots: () => string[];
  /** Harness's own data folders. */
  protect: () => string[];
  exists?: (path: string) => boolean;
};

/** Prepares the sandbox, or returns null when it is not requested. Throws when it is requested but cannot work. */
export async function prepareAgentSandbox(input: AgentSandboxInput): Promise<AgentSandbox | null> {
  const env = input.env ?? process.env;
  if (!agentSandboxRequested(env)) return null;
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    throw new AgentSandboxUnavailableError(`there is no sandbox for ${platform} yet (Windows only for now)`);
  }
  const exists = input.exists ?? existsSync;
  const helper = windowsPath(env[AGENT_SANDBOX_HELPER_ENV]);
  if (!helper) throw new AgentSandboxUnavailableError(`${AGENT_SANDBOX_HELPER_ENV} must name harness-sandbox.exe (an absolute path)`);
  if (!exists(helper)) throw new AgentSandboxUnavailableError(`the helper is missing at ${helper}`);
  const shell = windowsShell(env, exists);
  if (!shell) throw new AgentSandboxUnavailableError("no shell was found to run commands in");
  const network = agentSandboxNetwork(env);

  const policyPath = win32.join(input.storageDir, "sandbox", "policy.json");
  // Scratch space lives in the user's temp folder, not under Harness's data: the data is protected, and a grant may not overlap it.
  const tempDir = win32.join(windowsPath(env.TEMP ?? env.TMP) ?? tmpdir(), "harness-agent-sandbox");
  const extraProtect = (env[AGENT_SANDBOX_PROTECT_ENV] ?? "").split(";").filter(Boolean);
  const refresh = async (): Promise<BuiltPolicy> => {
    const built = buildAgentSandboxPolicy({
      roots: input.roots(),
      protect: [...input.protect(), ...extraProtect, input.storageDir],
      tempDir,
      shell,
      network,
      env,
      exists,
    });
    await writeAgentSandboxPolicy(policyPath, built.policy);
    return built;
  };
  await refresh();
  return { env: { SHELL: helper, [SANDBOX_POLICY_ENV]: policyPath }, policyPath, refresh };
}
