import { execSync } from "node:child_process";

execSync("pnpm --filter @harness/desktop build", { stdio: "inherit" });
