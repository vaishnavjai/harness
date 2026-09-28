import { contextBridge, ipcRenderer } from "electron";

let latestRequest = null;
let showCallback = null;

ipcRenderer.on("harness:menu-overlay:show", (_event, request) => {
  latestRequest = request;
  showCallback?.(request);
});

ipcRenderer.on("harness:menu-overlay:hide", () => {
  latestRequest = null;
  showCallback?.(null);
});

contextBridge.exposeInMainWorld("__HARNESS_MENU_OVERLAY__", {
  ready() {
    ipcRenderer.send("harness:menu-overlay:ready");
  },
  onShow(callback) {
    showCallback = callback;
    if (latestRequest) {
      callback(latestRequest);
    }
    return () => {
      if (showCallback === callback) {
        showCallback = null;
      }
    };
  },
  choose(requestId, itemId) {
    ipcRenderer.send("harness:menu-overlay:choose", { requestId, itemId });
  },
  close(requestId) {
    ipcRenderer.send("harness:menu-overlay:close", { requestId });
  },
});
