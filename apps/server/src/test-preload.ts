import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every server test that records an audit entry writes here instead of the
// real ~/.config/harness/audit.log.
process.env.HARNESS_AUDIT_LOG ??= join(mkdtempSync(join(tmpdir(), "harness-server-test-audit-")), "audit.log");
