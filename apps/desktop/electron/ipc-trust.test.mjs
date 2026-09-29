import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { createTrustedIpc } from "./ipc-trust.mjs";

function fakeIpcMain() {
  const handlers = new Map();
  const listeners = new Map();
  return {
    handlers,
    listeners,
    handle: (channel, fn) => handlers.set(channel, fn),
    on: (channel, fn) => listeners.set(channel, fn),
  };
}

const mainFrame = { id: "main" };
const window = { webContents: { mainFrame } };

describe("createTrustedIpc", () => {
  it("runs a handler for the main window's main frame", async () => {
    const ipc = fakeIpcMain();
    createTrustedIpc(ipc, () => window).handle("harness:test", (_event, value) => `ok:${value}`);
    assert.equal(await ipc.handlers.get("harness:test")({ sender: window.webContents, senderFrame: mainFrame }, 7), "ok:7");
  });

  it("rejects other frames, other web contents and a missing window without running the handler", () => {
    const ipc = fakeIpcMain();
    let ran = 0;
    const trusted = createTrustedIpc(ipc, () => window);
    trusted.handle("harness:test", () => { ran += 1; });
    const call = ipc.handlers.get("harness:test");
    assert.throws(() => call({ sender: window.webContents, senderFrame: { id: "iframe" } }), /Blocked harness:test/);
    assert.throws(() => call({ sender: { other: true }, senderFrame: mainFrame }), /Blocked harness:test/);
    assert.throws(() => call({ sender: window.webContents, senderFrame: null }), /Blocked harness:test/);
    const noWindow = fakeIpcMain();
    createTrustedIpc(noWindow, () => null).handle("harness:test", () => { ran += 1; });
    assert.throws(() => noWindow.handlers.get("harness:test")({ sender: window.webContents, senderFrame: mainFrame }), /Blocked/);
    assert.equal(ran, 0);
  });

  it("answers an untrusted synchronous call with the fallback and does nothing else", () => {
    const ipc = fakeIpcMain();
    let ran = 0;
    createTrustedIpc(ipc, () => window).on("harness:sync", "fallback", (event) => { ran += 1; event.returnValue = "real"; });
    const untrusted = { sender: {}, senderFrame: {} };
    ipc.listeners.get("harness:sync")(untrusted);
    assert.equal(untrusted.returnValue, "fallback");
    const trusted = { sender: window.webContents, senderFrame: mainFrame };
    ipc.listeners.get("harness:sync")(trusted);
    assert.equal(trusted.returnValue, "real");
    assert.equal(ran, 1);
  });
});

describe("the desktop's IPC registrations", () => {
  const source = readFileSync(fileURLToPath(new URL("./main.mjs", import.meta.url)), "utf8");

  it("register every privileged channel through the trusted wrapper", () => {
    const direct = [...source.matchAll(/ipcMain\.(?:handle|on)\("(harness:[^"]+)"/g)].map((match) => match[1]);
    // The context-menu channels check the sender themselves and are development-only.
    assert.deepEqual(direct.filter((channel) => !channel.startsWith("harness:context-menu:")), []);
    for (const channel of ["harness:desktop", "harness:shell:openExternal", "harness:shell:relaunch", "harness:terminal:create", "harness:desktop-bootstrap-sync"]) {
      assert.match(source, new RegExp(`trustedIpc\\.(?:handle|on)\\("${channel}"`), channel);
    }
  });
});
