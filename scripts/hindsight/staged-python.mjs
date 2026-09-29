// Picks the Python that `uv python install --install-dir <dir>` just placed in
// <dir>. Newer uv also drops a link named after the minor version
// (`cpython-3.11-...`) beside the real `cpython-3.11.x-...` folder. On Windows
// the link sorts first; moving it and then deleting <dir> destroys the real
// install it points to, so only real folders are eligible.
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function pickInstalledPython(dir) {
  const real = readdirSync(dir)
    .filter((name) => name.startsWith("cpython-") && lstatSync(join(dir, name)).isDirectory())
    .sort();
  return real.at(-1) ?? null;
}
