import { waitFor } from "@harness/behaviors";
import { org } from "../seed.ts";
import { webTab } from "../surfaces.ts";
import { shot } from "./shot.ts";

const browser = webTab({ org });

async function waitForHarnessWeb(surface: Awaited<ReturnType<typeof browser.load>>): Promise<void> {
  await waitFor(surface, () => (Boolean(window.__harnessControl)), {
    timeoutMs: 120_000,
    label: "Harness Web booted",
  });
  await waitFor(surface, () => (document.body.innerText.includes("acme-robotics")
    && document.body.innerText.includes("Describe your task")
    && !document.body.innerText.includes("Pulling in the latest messages")), {
    timeoutMs: 120_000,
    label: "Harness Web settled on the demo workspace",
  });
}

export const harnessWebTab = shot("harness-web-tab", {
  use: browser,
  at: "/",
  steps: [waitForHarnessWeb],
  expect: ["acme-robotics", "What do you need done?"],
  never: ["Something went wrong", "Unable to connect", "docs-3959-screenshots"],
  out: "packages/docs/images/harness-web-browser-tab.png",
});
