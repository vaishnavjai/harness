#!/usr/bin/env sh
set -eu

HARNESS_WORKSPACE="${HARNESS_WORKSPACE:-/workspace}"
HARNESS_DATA_DIR="${HARNESS_DATA_DIR:-/data/harness-server}"
HARNESS_SIDECAR_DIR="${HARNESS_SIDECAR_DIR:-/data/sidecars}"
HARNESS_PORT="${HARNESS_PORT:-8787}"
HARNESS_TOKEN="${HARNESS_TOKEN:-microsandbox-token}"
HARNESS_HOST_TOKEN="${HARNESS_HOST_TOKEN:-microsandbox-host-token}"
HARNESS_APPROVAL_MODE="${HARNESS_APPROVAL_MODE:-auto}"
HARNESS_CORS_ORIGINS="${HARNESS_CORS_ORIGINS:-*}"
HARNESS_CONNECT_HOST="${HARNESS_CONNECT_HOST:-127.0.0.1}"
HARNESS_EXTENSIONS_PLUGIN_DIR="${HARNESS_EXTENSIONS_PLUGIN_DIR:-/opt/harness/opencode-plugins}"
HOME="${HOME:-/root}"
USER="${USER:-root}"
SHELL="${SHELL:-/bin/sh}"
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"

if [ "$HOME" = "/" ]; then
  HOME=/root
  XDG_CONFIG_HOME="$HOME/.config"
  XDG_CACHE_HOME="$HOME/.cache"
  XDG_DATA_HOME="$HOME/.local/share"
  XDG_STATE_HOME="$HOME/.local/state"
fi

export HOME USER SHELL XDG_CONFIG_HOME XDG_CACHE_HOME XDG_DATA_HOME XDG_STATE_HOME
export HARNESS_DATA_DIR HARNESS_TOKEN HARNESS_HOST_TOKEN HARNESS_EXTENSIONS_PLUGIN_DIR
export HARNESS_MANAGE_OPENCODE=1
export HARNESS_OPENCODE_BIN=/usr/local/bin/opencode

mkdir -p "$HARNESS_WORKSPACE" "$HARNESS_DATA_DIR" "$HARNESS_SIDECAR_DIR"
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME"

printf '%s\n' "Starting Harness micro-sandbox"
printf '%s\n' "- workspace: $HARNESS_WORKSPACE"
printf '%s\n' "- home: $HOME"
printf '%s\n' "- harness url: http://$HARNESS_CONNECT_HOST:$HARNESS_PORT"
printf '%s\n' "- client token: $HARNESS_TOKEN"
printf '%s\n' "- host token: $HARNESS_HOST_TOKEN"
printf '%s\n' "- health: curl http://$HARNESS_CONNECT_HOST:$HARNESS_PORT/health"
printf '%s\n' "- auth test: curl -H \"Authorization: Bearer $HARNESS_TOKEN\" http://$HARNESS_CONNECT_HOST:$HARNESS_PORT/workspaces"

exec harness-server \
  --workspace "$HARNESS_WORKSPACE" \
  --host 0.0.0.0 \
  --port "$HARNESS_PORT" \
  --token "$HARNESS_TOKEN" \
  --host-token "$HARNESS_HOST_TOKEN" \
  --approval "$HARNESS_APPROVAL_MODE" \
  --cors "$HARNESS_CORS_ORIGINS" \
  --verbose
