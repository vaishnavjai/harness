import { createAuditLogger } from "@harness/audit";

/**
 * Desktop-side audit trail: desktop commands that change state (file writes,
 * workspace and skill changes, config, memory), interactive terminal sessions
 * and the command lines typed into them. Records go to the shared
 * hash-chained log (~/.config/harness/audit.log); see @harness/audit.
 *
 * Arguments are summarised to paths and identifiers. File contents, skill
 * bodies and secrets are never copied into the log.
 */

/** Desktop bridge commands that change files, configuration or state. */
export const AUDITED_DESKTOP_COMMANDS = new Set([
  "workspaceCreate",
  "workspaceCreateRemote",
  "workspaceUpdateRemote",
  "workspaceUpdateDisplayName",
  "workspaceForget",
  "workspaceAddAuthorizedRoot",
  "workspaceHarnessWrite",
  "workspaceImportConfig",
  "workspaceExportConfig",
  "opencodeCommandWrite",
  "opencodeCommandDelete",
  "writeOpencodeConfig",
  "importSkill",
  "installSkillTemplate",
  "writeLocalSkill",
  "uninstallSkill",
  "saveFile",
  "engineInstall",
  "engineRestart",
  "engineStop",
  "harnessServerRestart",
  "resetHarnessState",
  "resetOpencodeCache",
  "nukeHarnessAndOpencodeConfigAndExit",
  "setDesktopBootstrapConfig",
  "clearDesktopBootstrapConfig",
  "connectLinkAccept",
  "desktopIntegrationInstall",
  "desktopIntegrationRemove",
  "memoryUpdateSettings",
  "memorySetApiKey",
  "memoryStart",
  "memoryStop",
  "memoryRetain",
]);

const IDENTIFYING_KEYS = [
  "path",
  "folderPath",
  "filePath",
  "targetPath",
  "directory",
  "root",
  "workspaceId",
  "id",
  "name",
  "scope",
  "kind",
  "templateId",
  "baseUrl",
  "defaultPath",
];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep the arguments that identify what changed. Long strings are treated as
 * content and reduced to their length.
 *
 * @param {unknown[]} args
 * @returns {Record<string, string | number | boolean | null>}
 */
export function summarizeCommandArgs(args) {
  /** @type {Record<string, string | number | boolean | null>} */
  const detail = {};
  args.slice(0, 4).forEach((arg, index) => {
    if (typeof arg === "string") {
      detail[`arg${index}`] = arg.length <= 512 ? arg : `[${arg.length} chars]`;
    } else if (typeof arg === "number" || typeof arg === "boolean") {
      detail[`arg${index}`] = arg;
    } else if (isRecord(arg)) {
      for (const key of IDENTIFYING_KEYS) {
        const value = arg[key];
        if (typeof value === "string" && value.length <= 512) detail[key] = value;
        else if (typeof value === "number" || typeof value === "boolean") detail[key] = value;
      }
      if (typeof arg.content === "string") detail.contentChars = arg.content.length;
    }
  });
  return detail;
}

/**
 * Turns raw terminal input into submitted command lines. Input that follows
 * a password prompt is dropped, never recorded.
 */
export function createTerminalCommandRecorder({ onCommand, maxLength = 1_000 }) {
  let line = "";
  let recentOutput = "";
  let secretLine = false;

  return {
    /** @param {string} data */
    output(data) {
      recentOutput = `${recentOutput}${data}`.slice(-200);
    },
    /** @param {string} data */
    input(data) {
      // Drop escape sequences: arrows, function keys, bracketed-paste markers.
      const text = data.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[O][A-Za-z]|\x1b./g, "");
      for (const char of text) {
        if (char === "\r" || char === "\n") {
          const submitted = line.trim();
          if (submitted && !secretLine) onCommand(submitted);
          line = "";
          secretLine = false;
          recentOutput = "";
        } else if (char === "\x7f" || char === "\b") {
          line = line.slice(0, -1);
        } else if (char === "\x03" || char === "\x15") {
          // Ctrl-C / Ctrl-U abandon the line.
          line = "";
          secretLine = false;
        } else if (char >= " ") {
          if (!line) {
            const lastOutputLine = recentOutput.split(/\r?\n/).pop() ?? "";
            secretLine = /(pass(word|phrase)?|passcode|pin|secret|token)[^:\n]{0,40}:\s*$/i.test(lastOutputLine);
          }
          if (line.length < maxLength) line += char;
        }
      }
    },
  };
}

/**
 * @param {{ filePath: string, onError?: (error: unknown) => void }} options
 */
export function createDesktopAudit({ filePath, onError }) {
  const logger = createAuditLogger({
    filePath,
    source: "desktop",
    onError: onError ?? ((error) => console.warn("[audit] could not write the audit log:", error)),
  });

  return {
    logger,
    /**
     * @param {string} command
     * @param {unknown[]} args
     * @param {{ ok: boolean, error?: string }} outcome
     */
    command(command, args, outcome) {
      if (!AUDITED_DESKTOP_COMMANDS.has(command)) return;
      logger.record({
        kind: `desktop.${command}`,
        actor: "user",
        subject: command,
        detail: { ...summarizeCommandArgs(args), ok: outcome.ok, error: outcome.error ?? null },
      });
    },
    /** @param {{ terminalId: string, shell: string, cwd: string }} session */
    terminalStarted({ terminalId, shell, cwd }) {
      logger.record({ kind: "terminal.session.start", actor: "user", subject: shell, detail: { terminal: terminalId, cwd } });
    },
    /** @param {{ terminalId: string, exitCode: number | null, signal: number | null | undefined }} session */
    terminalExited({ terminalId, exitCode, signal }) {
      logger.record({
        kind: "terminal.session.exit",
        actor: "user",
        detail: { terminal: terminalId, exitCode: exitCode ?? null, signal: signal ?? null },
      });
    },
    /** @param {string} terminalId */
    terminalRecorder(terminalId) {
      return createTerminalCommandRecorder({
        onCommand: (command) =>
          logger.record({ kind: "terminal.command", actor: "user", subject: command, detail: { terminal: terminalId } }),
      });
    },
    /** @param {string} kind @param {Record<string, string | number | boolean | null>} detail */
    event(kind, detail = {}) {
      logger.record({ kind, actor: "harness", detail });
    },
    flush: () => logger.flush(),
  };
}
