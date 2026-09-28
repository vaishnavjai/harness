import { expect, test } from "bun:test";

import { buildHarnessV2Instructions } from "./opencode-v2-instructions.js";

test("v2 discovers remote skills on demand and keeps local skills native", () => {
  const connected = buildHarnessV2Instructions(true);
  expect(connected.operatingInstructions).toContain("remote skills");
  expect(connected.skillInstructions).toContain("Harness Connect");
  expect(connected.skillInstructions).toContain("on demand");
  expect(JSON.stringify(connected)).not.toContain("<available_remote_skills>");
});
