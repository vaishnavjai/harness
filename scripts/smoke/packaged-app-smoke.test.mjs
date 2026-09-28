import assert from "node:assert/strict";
import test from "node:test";

import { hexToAddress, isLoopbackAddress, parseProcNetTcp } from "./packaged-app-smoke.mjs";

test("decodes /proc/net/tcp addresses", () => {
  assert.equal(hexToAddress("0100007F", 4), "127.0.0.1");
  assert.equal(hexToAddress("00000000", 4), "0.0.0.0");
  assert.equal(hexToAddress("00000000000000000000000001000000", 6), "::1");
  assert.equal(hexToAddress("0000000000000000FFFF00000100007F", 6), "127.0.0.1");
});

test("parses listening and connected sockets", () => {
  const text = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:22B8 00000000:0000 0A 00000000:00000000 00:00000000 00000000 65534        0 4242 1 0000000000000000 100 0 0 10 0",
    "   1: 0100007F:B1C2 08080808:01BB 01 00000000:00000000 00:00000000 00000000 65534        0 4343 1 0000000000000000 20 4 30 10 -1",
  ].join("\n");
  const sockets = parseProcNetTcp(text, 4);
  assert.deepEqual(sockets[0], { local: { address: "127.0.0.1", port: 8888 }, remote: { address: "0.0.0.0", port: 0 }, state: "0A", inode: "4242" });
  assert.equal(sockets[1].remote.address, "8.8.8.8");
  assert.equal(sockets[1].remote.port, 443);
  assert.equal(isLoopbackAddress(sockets[0].local.address), true);
  assert.equal(isLoopbackAddress(sockets[1].remote.address), false);
});
