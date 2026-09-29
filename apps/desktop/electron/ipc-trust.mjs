// Privileged IPC channels answer only the Harness window's own main frame.
//
// Any web contents in the app can send an IPC message; the channels here start
// terminals, relaunch the app, open programs and run the desktop bridge. The
// message names its sender, so the main process checks it instead of assuming
// only the trusted page could have sent it.

/**
 * @typedef {{ sender: unknown; senderFrame: unknown; returnValue?: unknown }} IpcEventLike
 * @typedef {{
 *   handle(channel: string, listener: (event: any, ...args: any[]) => unknown): void;
 *   on(channel: string, untrustedReply: unknown, listener: (event: any, ...args: any[]) => unknown): void;
 * }} IpcMainLike
 */

/**
 * @param {{ handle: Function; on: Function }} ipcMain
 * @param {() => { webContents: { mainFrame: unknown } } | null | undefined} getMainWindow
 */
export function createTrustedIpc(ipcMain, getMainWindow) {
  /** @param {IpcEventLike} event */
  const isTrusted = (event) => {
    const window = getMainWindow();
    return Boolean(window) && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  };
  return {
    isTrusted,
    /** Invoke channel: an untrusted sender gets a rejection. */
    handle(channel, listener) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!isTrusted(event)) throw new Error(`Blocked ${channel}: it can only be called from the Harness window.`);
        return listener(event, ...args);
      });
    },
    /** Synchronous channel: an untrusted sender gets `untrustedReply` and nothing else happens. */
    on(channel, untrustedReply, listener) {
      ipcMain.on(channel, (event, ...args) => {
        if (!isTrusted(event)) {
          event.returnValue = untrustedReply;
          return;
        }
        return listener(event, ...args);
      });
    },
  };
}
