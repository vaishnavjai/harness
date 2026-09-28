#!/usr/bin/env bash
set -euo pipefail

chart_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

assert_contains() {
  local file="$1"
  local needle="$2"
  if ! grep -F -q -- "$needle" "$file"; then
    printf 'Expected rendered chart to contain %s\n' "$needle" >&2
    return 1
  fi
}

default_rendered="$tmp_dir/default.yaml"
helm template harness-ee "$chart_dir" > "$default_rendered"
assert_contains "$default_rendered" 'DEN_HARNESS_WEB_ENABLED: "false"'

enabled_values="$tmp_dir/enabled-values.yaml"
enabled_rendered="$tmp_dir/enabled.yaml"
printf '%s\n' 'config:' '  public:' '    harnessWebEnabled: "true"' > "$enabled_values"
helm template harness-ee "$chart_dir" -f "$enabled_values" > "$enabled_rendered"
assert_contains "$enabled_rendered" 'DEN_HARNESS_WEB_ENABLED: "true"'

printf 'harness-web-enabled chart checks passed\n'
