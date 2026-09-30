import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  AGENT_SANDBOX_ENV,
  AGENT_SANDBOX_HELPER_ENV,
  AGENT_SANDBOX_NETWORK_ENV,
  AGENT_SANDBOX_PROTECT_ENV,
  AGENT_SANDBOX_SHELL_ENV,
  AgentSandboxUnavailableError,
  SANDBOX_POLICY_ENV,
  agentSandboxNetwork,
  agentSandboxRequested,
  buildAgentSandboxPolicy,
  prepareAgentSandbox,
  toolFolders,
  whyNotGrantable,
  windowsPath,
  windowsShell,
  type AgentSandboxPolicy,
} from "./agent-sandbox.js";

// A Windows machine, described. Nothing here touches the real disk: every path check goes through `exists`.
const ENV: NodeJS.ProcessEnv = {
  SystemDrive: "C:",
  SystemRoot: "C:\\Windows",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  ProgramData: "C:\\ProgramData",
  USERPROFILE: "C:\\Users\\me",
  APPDATA: "C:\\Users\\me\\AppData\\Roaming",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  Path: ["C:\\Windows\\System32", "C:\\Program Files\\Git\\cmd", "C:\\Users\\me\\.bun\\bin", "C:\\Users\\me\\AppData\\Roaming\\npm", "C:\\Users\\me\\.bun\\bin\\", "C:\\missing\\bin"].join(";"),
};

const PRESENT = new Set(
  [
    "C:\\Windows\\System32",
    "C:\\Windows\\System32\\cmd.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Program Files\\Git\\cmd",
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Users\\me\\.bun\\bin",
    "C:\\Users\\me\\AppData\\Roaming\\npm",
    "C:\\Users\\me\\proj",
    "C:\\Users\\me\\AppData\\Roaming\\harness\\data",
    "C:\\Users\\me",
    "D:\\work",
    "C:\\tools\\harness-sandbox.exe",
  ].map((path) => path.toLowerCase()),
);
const exists = (path: string) => PRESENT.has(path.toLowerCase());
const identity = (path: string) => path;

describe("switches", () => {
  test("the sandbox is off unless asked for, and a typo does not leave it quietly off", () => {
    expect(agentSandboxRequested({})).toBe(false);
    expect(agentSandboxRequested({ [AGENT_SANDBOX_ENV]: "0" })).toBe(false);
    expect(agentSandboxRequested({ [AGENT_SANDBOX_ENV]: "off" })).toBe(false);
    for (const on of ["1", "true", "ON", "yes"]) expect(agentSandboxRequested({ [AGENT_SANDBOX_ENV]: on })).toBe(true);
    expect(() => agentSandboxRequested({ [AGENT_SANDBOX_ENV]: "ture" })).toThrow(AgentSandboxUnavailableError);
  });

  test("the network is off unless asked for, and only known modes are accepted", () => {
    expect(agentSandboxNetwork({})).toBe("none");
    expect(agentSandboxNetwork({ [AGENT_SANDBOX_NETWORK_ENV]: "Internet" })).toBe("internet");
    expect(agentSandboxNetwork({ [AGENT_SANDBOX_NETWORK_ENV]: "internet-server" })).toBe("internet-server");
    expect(() => agentSandboxNetwork({ [AGENT_SANDBOX_NETWORK_ENV]: "all" })).toThrow(AgentSandboxUnavailableError);
  });
});

describe("paths", () => {
  test("windowsPath accepts drive paths only, in one canonical form", () => {
    expect(windowsPath("c:/Users//me/proj/")).toBe("c:\\Users\\me\\proj");
    expect(windowsPath("\\\\?\\C:\\Users\\me")).toBe("C:\\Users\\me");
    expect(windowsPath("C:\\")).toBe("C:\\");
    for (const bad of [undefined, "", "relative\\dir", "\\\\server\\share", "/usr/bin", "C:relative"]) expect(windowsPath(bad)).toBeNull();
  });

  test("whyNotGrantable refuses drives, system folders and the profile, and allows a workspace inside it", () => {
    for (const bad of ["C:\\", "C:\\Windows", "C:\\Windows\\System32", "C:\\Program Files\\Git", "C:\\ProgramData", "C:\\Users", "C:\\Users\\me", "C:\\Users\\me\\AppData", "C:\\Users\\me\\AppData\\Local"]) {
      expect(whyNotGrantable(bad, ENV), bad).not.toBeNull();
    }
    for (const good of ["C:\\Users\\me\\proj", "D:\\work", "C:\\Users\\me\\AppData\\Roaming\\npm"]) expect(whyNotGrantable(good, ENV), good).toBeNull();
  });
});

describe("shell", () => {
  test("PowerShell is used, never Git bash, even when Git is installed and the engine would pick it", () => {
    const withBash = { ...ENV, OPENCODE_GIT_BASH_PATH: "C:\\Program Files\\Git\\bin\\bash.exe" };
    expect(windowsShell(withBash, exists)).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  test("PowerShell 7 wins when present, and cmd is the last resort", () => {
    const seven = (path: string) => exists(path) || path === "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    expect(windowsShell(ENV, seven)).toBe("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    const onlyCmd = (path: string) => path === "C:\\Windows\\System32\\cmd.exe";
    expect(windowsShell(ENV, onlyCmd)).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(windowsShell(ENV, () => false)).toBeNull();
  });

  test("an override must be a shell that can run in the container", () => {
    expect(() => windowsShell({ ...ENV, [AGENT_SANDBOX_SHELL_ENV]: "C:\\Program Files\\Git\\bin\\bash.exe" }, exists)).toThrow(/Git bash cannot run/);
    expect(() => windowsShell({ ...ENV, [AGENT_SANDBOX_SHELL_ENV]: "powershell" }, exists)).toThrow(AgentSandboxUnavailableError);
    expect(windowsShell({ ...ENV, [AGENT_SANDBOX_SHELL_ENV]: "C:\\Windows\\System32\\cmd.exe" }, exists)).toBe("C:\\Windows\\System32\\cmd.exe");
  });
});

describe("tool folders", () => {
  test("only folders the container could not already read, each once, and only if they exist", () => {
    expect(toolFolders(ENV, exists, identity)).toEqual(["C:\\Users\\me\\.bun\\bin", "C:\\Users\\me\\AppData\\Roaming\\npm"]);
  });

  test("a folder is judged and granted as the place it really is", () => {
    // `C:\Program Files\nodejs` is a link into a folder the container cannot read: that folder needs the grant.
    const env = { ...ENV, Path: "C:\\Program Files\\nodejs;C:\\Program Files\\Git\\cmd" };
    const present = (path: string) => exists(path) || path === "C:\\Program Files\\nodejs";
    const resolve = (path: string) => (path === "C:\\Program Files\\nodejs" ? "C:\\hostedtoolcache\\windows\\node\\24\\x64" : path);
    expect(toolFolders(env, present, resolve)).toEqual(["C:\\hostedtoolcache\\windows\\node\\24\\x64"]);
    // The reverse: a link that leads into the profile is refused rather than granted.
    const intoProfile = (path: string) => (path === "C:\\Program Files\\nodejs" ? "C:\\Users\\me" : path);
    expect(toolFolders(env, present, intoProfile)).toEqual([]);
  });
});

describe("policy", () => {
  const roots = ["C:\\Users\\me\\proj", "C:\\Users\\me\\proj\\", "c:/users/me/proj", "C:\\Users\\me", "C:\\", "\\\\server\\share\\x", "C:\\Users\\me\\AppData\\Roaming\\harness\\data", "D:\\work", "C:\\gone"];
  const protect = ["C:\\Users\\me\\AppData\\Roaming\\harness", "c:\\users\\me\\appdata\\roaming\\harness\\"];

  const build = () =>
    buildAgentSandboxPolicy({ roots, protect, shell: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", network: "none", env: ENV, exists, resolve: identity });

  test("keeps the workspaces, and says why it dropped each of the rest", () => {
    const { policy, skipped } = build();
    expect(policy.readWrite).toEqual(["C:\\Users\\me\\proj", "D:\\work"]);
    expect(policy.protect).toEqual(["C:\\Users\\me\\AppData\\Roaming\\harness"]);
    expect(policy.readOnly).toEqual(["C:\\Users\\me\\.bun\\bin", "C:\\Users\\me\\AppData\\Roaming\\npm"]);
    const reasons = Object.fromEntries(skipped.map((entry) => [entry.path, entry.reason]));
    expect(reasons["C:\\Users\\me"]).toMatch(/profile/);
    expect(reasons["C:\\"]).toMatch(/drive/);
    expect(reasons["\\\\server\\share\\x"]).toMatch(/not a local drive folder/);
    expect(reasons["C:\\Users\\me\\AppData\\Roaming\\harness\\data"]).toMatch(/Harness's own data/);
    expect(reasons["C:\\gone"]).toMatch(/does not exist/);
  });

  test("a workspace that is a junction to the profile is dropped, judged as what it really is", () => {
    const { policy, skipped } = buildAgentSandboxPolicy({
      roots: ["C:\\Users\\me\\proj"],
      protect,
      shell: "C:\\Windows\\System32\\cmd.exe",
      network: "none",
      env: ENV,
      exists,
      resolve: (path) => (path === "C:\\Users\\me\\proj" ? "C:\\Users\\me" : path),
    });
    expect(policy.readWrite).toEqual([]);
    expect(skipped[0]?.reason).toMatch(/profile/);
  });

  test("the file matches what the helper parses (shared fixture)", () => {
    const fixture = join(import.meta.dir, "..", "..", "..", "native", "harness-sandbox", "tests", "fixtures", "server-policy.json");
    const { policy } = build();
    if (process.env.UPDATE_SANDBOX_FIXTURE === "1") writeFileSync(fixture, `${JSON.stringify(policy, null, 2)}\n`);
    expect(JSON.parse(readFileSync(fixture, "utf8"))).toEqual(policy);
  });
});

describe("prepareAgentSandbox", () => {
  const base = {
    storageDir: "C:\\Users\\me\\AppData\\Roaming\\harness\\runtime",
    roots: () => ["C:\\Users\\me\\proj"],
    protect: () => ["C:\\Users\\me\\AppData\\Roaming\\harness"],
    exists,
    resolve: identity,
  };
  const on = { ...ENV, [AGENT_SANDBOX_ENV]: "1", [AGENT_SANDBOX_HELPER_ENV]: "C:\\tools\\harness-sandbox.exe" };

  test("does nothing when the sandbox is not requested", async () => {
    expect(await prepareAgentSandbox({ ...base, env: ENV, platform: "win32" })).toBeNull();
  });

  test("refuses to start rather than run unsandboxed when it cannot work", async () => {
    await expect(prepareAgentSandbox({ ...base, env: on, platform: "linux" })).rejects.toThrow(/no sandbox for linux/);
    await expect(prepareAgentSandbox({ ...base, env: { ...on, [AGENT_SANDBOX_HELPER_ENV]: undefined }, platform: "win32" })).rejects.toThrow(/must name harness-sandbox.exe/);
    await expect(prepareAgentSandbox({ ...base, env: { ...on, [AGENT_SANDBOX_HELPER_ENV]: "C:\\tools\\missing.exe" }, platform: "win32" })).rejects.toThrow(/helper is missing/);
    await expect(prepareAgentSandbox({ ...base, env: on, platform: "win32", exists: (path) => path === "C:\\tools\\harness-sandbox.exe" })).rejects.toThrow(/no PowerShell or cmd/);
  });

  test("points the engine's shell at the helper, writes the policy, and rewrites it when workspaces change", async () => {
    const writes: Array<{ path: string; policy: AgentSandboxPolicy }> = [];
    let folders = ["C:\\Users\\me\\proj"];
    const sandbox = await prepareAgentSandbox({
      ...base,
      env: { ...on, [AGENT_SANDBOX_PROTECT_ENV]: "C:\\Users\\me\\AppData\\Roaming\\Extra;" },
      platform: "win32",
      roots: () => folders,
      writePolicy: async (path, policy) => void writes.push({ path, policy }),
    });
    expect(sandbox).not.toBeNull();
    expect(sandbox?.env).toEqual({ SHELL: "C:\\tools\\harness-sandbox.exe", [SANDBOX_POLICY_ENV]: "C:\\Users\\me\\AppData\\Roaming\\harness\\runtime\\sandbox\\policy.json" });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.policy.readWrite).toEqual(["C:\\Users\\me\\proj"]);
    expect(writes[0]?.policy.network).toBe("none");
    // Harness's own data, the desktop's extra folder and the runtime folder are all protected.
    expect(writes[0]?.policy.protect).toEqual(["C:\\Users\\me\\AppData\\Roaming\\harness", "C:\\Users\\me\\AppData\\Roaming\\Extra", "C:\\Users\\me\\AppData\\Roaming\\harness\\runtime"]);

    folders = ["C:\\Users\\me\\proj", "D:\\work"];
    const built = await sandbox?.refresh();
    expect(built?.policy.readWrite).toEqual(["C:\\Users\\me\\proj", "D:\\work"]);
    expect(writes).toHaveLength(2);
  });
});
