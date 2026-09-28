#!/usr/bin/env python3
"""Update only the renderer of a live, owned desktop preview; preserve its profile."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("world", choices=["preview-desktop"])
parser.add_argument("--stage", required=True)
parser.add_argument("--ref", required=True, help="Reviewed, pushed full 40-character commit SHA")
args = parser.parse_args()
if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]*", args.stage):
    parser.error("Use the normalized stage name from world outputs.")
if not re.fullmatch(r"[0-9a-f]{40}", args.ref):
    parser.error("Use a reviewed, pushed full 40-character commit SHA; branch names are mutable.")
root = Path(__file__).resolve().parents[4]
receipt_dir = Path(os.environ.get("HARNESS_WORLD_SNAPSHOT_DIR", root / "evals/results/.worlds/scripts"))
receipt = receipt_dir / f"{args.world}--{args.stage}.json"
state = json.loads(receipt.read_text())
if state.get("kind") != "script" or state.get("place") != "daytona" or Path(state["sourcePath"]).resolve() != root / "worlds" / f"{args.world}.ts":
    parser.error("Receipt is not an owned Daytona preview in this worktree.")
os.kill(state["pid"], 0)
outputs = state["outputs"]
if outputs.get("releaseVersion"):
    parser.error("Published release previews are immutable and cannot use the source frontend updater; stop this stage and launch a new one.")
# One shell-quoted Python program runs remotely. The desktop renderer picks up the
# checkout through the running Vite server's hot reload.
remote = r'''
import os, subprocess
ref = REF
root = "/workspace"
subprocess.run(["git", "diff", "--quiet"], cwd=root, check=True)
subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=root, check=True)
subprocess.run(["git", "fetch", "origin", ref], cwd=root, check=True)
fetched = subprocess.check_output(["git", "rev-parse", "FETCH_HEAD"], cwd=root, text=True).strip()
if fetched != ref: raise RuntimeError("Fetched commit does not match the requested SHA")
subprocess.run(["git", "checkout", "--detach", ref], cwd=root, check=True)
install_env = {key: value for key, value in os.environ.items() if key in {"PATH", "HOME", "PNPM_HOME"}}
with open("/tmp/preview-update.log", "w") as log:
    subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=root, env=install_env, stdout=log, stderr=subprocess.STDOUT, check=True)
print("Updated renderer source; existing profile preserved.")
'''
sandbox = outputs["desktopSandbox"]
if not re.fullmatch(r"[a-zA-Z0-9_-]+", sandbox):
    parser.error("Invalid sandbox ID in receipt")
program = remote.replace("REF", repr(args.ref))
subprocess.run(["daytona", "exec", sandbox, "--", "python3", "-c", shlex.quote(program)], check=True)
# Never resurrect a receipt whose lifetime ended while the update was running.
current = json.loads(receipt.read_text())
if current["pid"] != state["pid"]:
    raise RuntimeError("Preview ownership changed during update")
os.kill(current["pid"], 0)
# Keep boot ref distinct: Electron main and preload still run that version.
current["outputs"]["frontendRef"] = args.ref
with receipt.open("r+") as handle:
    handle.write(json.dumps(current, indent=2) + "\n")
    handle.truncate()
print("Frontend update complete. Reopen the existing preview and verify the changed screen.")
