#!/usr/bin/env bash
#
# install-runner.sh — set up a second Caterpillar runner on a machine that has
# something the cluster does not: a GPU, a USB device, game files, a human.
#
# See DESIGN.md §8. Runners are not addressed, they are MATCHED: a task declares
# `requires: [usb]` and only a runner advertising `usb` can claim it. Both halves are
# already built — what is missing on a fresh machine is a runner that advertises
# anything but `linux, net`, which is why a task requiring `human-present` today sits
# `ready` forever, claimable by nobody and looking like a stuck scheduler.
#
# Usage:
#   scripts/install-runner.sh --capabilities linux,usb,human-present --from-cluster
#   scripts/install-runner.sh --capabilities linux,gpu --config ./config.json
#
#   --capabilities  comma-separated, from: linux k8s net gpu usb human-present nix
#                     `nix` means this machine can BUILD a task's dev environment
#                     (DESIGN.md §8.1). Language toolchains are not capabilities —
#                     a runner with `nix` installs lua, go or python for itself.
#   --from-cluster  read the deployed config with kubectl and adapt it (recommended)
#   --config FILE   adapt this config instead
#   --root DIR      where state, mirrors, worktrees and credentials live
#                     (default: ~/.local/share/caterpillar)
#   --runner-id ID  advertised in logs and lease records (default: caterpillar-$(hostname -s))
#   --user-unit     install a systemd --user unit instead of a system one
#   --dry-run       print what would be written, write nothing
#
# THE CONFIG IS DERIVED, NEVER WRITTEN FROM SCRATCH. Both runners share one state repo,
# so they must agree about workspaces, limits and the model — a hand-written second
# config is a silent divergence waiting to happen. Only the machine-specific fields are
# overridden: capabilities, the paths, and where secrets are read from.
set -euo pipefail

CAPABILITIES=""
FROM_CLUSTER=0
CONFIG_IN=""
ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/caterpillar"
RUNNER_ID="caterpillar-$(hostname -s 2>/dev/null || hostname)"
USER_UNIT=0
DRY_RUN=0

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KNOWN_CAPABILITIES="linux k8s net gpu usb human-present nix"

die() { echo "install-runner: $*" >&2; exit 1; }
note() { echo "install-runner: $*"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --capabilities) CAPABILITIES="${2:-}"; shift 2 ;;
    --from-cluster) FROM_CLUSTER=1; shift ;;
    --config) CONFIG_IN="${2:-}"; shift 2 ;;
    --root) ROOT="${2:-}"; shift 2 ;;
    --runner-id) RUNNER_ID="${2:-}"; shift 2 ;;
    --user-unit) USER_UNIT=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -n "$CAPABILITIES" ]] || die "--capabilities is required (e.g. linux,usb,human-present)"

# A capability no runner advertises is satisfied by nobody; a capability MISSPELLED here
# is worse, because the runner starts happily and simply never claims the task that
# needed it. Checked against the same list src/domain/task.ts defines.
IFS=',' read -ra CAPS <<< "$CAPABILITIES"
for cap in "${CAPS[@]}"; do
  [[ " $KNOWN_CAPABILITIES " == *" $cap "* ]] \
    || die "'$cap' is not a capability (known: $KNOWN_CAPABILITIES)"
done

command -v git >/dev/null || die "git is not on PATH"
command -v node >/dev/null || die "node is not on PATH — 22.18 or newer is required"

# `nix` does not need declaring — the supervisor probes for it at boot and advertises it
# if it is there (DESIGN.md §8.1). Declaring it anyway is honoured, so this only warns
# about the one combination that misleads: advertised here, absent from the machine, which
# makes the runner claim tasks it can then only park.
if [[ " $CAPABILITIES " == *"nix"* ]] && ! command -v nix >/dev/null; then
  note "WARNING: 'nix' is advertised but nix is not on PATH. This runner will claim tasks"
  note "         that declare a toolchain and then park every one of them. You do not need"
  note "         to list 'nix' at all — install it and the runner works it out at boot."
fi

node_ok=$(node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.stdout.write(a>22||(a===22&&b>=18)?"yes":"no")')
[[ "$node_ok" == "yes" ]] \
  || die "node $(node --version) is too old — 22.18 is the floor (it strips types without a flag)"

case "$(uname -s)" in
  Linux) ;;
  *) note "WARNING: only Linux is tested. The credential helper needs a unix socket." ;;
esac

# ---------------------------------------------------------------------------- config

if [[ "$FROM_CLUSTER" == "1" ]]; then
  command -v kubectl >/dev/null || die "--from-cluster needs kubectl"
  note "reading the deployed config (context: $(kubectl config current-context))"
  SOURCE_JSON="$(kubectl -n caterpillar get configmap caterpillar-config \
    -o jsonpath='{.data.config\.json}')" || die "could not read the caterpillar-config ConfigMap"
  [[ -n "$SOURCE_JSON" ]] || die "the ConfigMap has no config.json"
elif [[ -n "$CONFIG_IN" ]]; then
  [[ -f "$CONFIG_IN" ]] || die "no such file: $CONFIG_IN"
  SOURCE_JSON="$(cat "$CONFIG_IN")"
else
  die "pass --from-cluster or --config FILE — the config is derived, not invented"
fi

SECRETS_DIR="$ROOT/secrets"

# Rewritten with node rather than sed: the structure is nested, and a regex that
# half-matched a path would produce a config that loads cleanly and then writes to the
# wrong disk.
#
# shellcheck disable=SC2016  # the `$` below are JS template literals, read by node, and
# must NOT be expanded by the shell. Values reach the script through the environment.
CONFIG_JSON="$(SOURCE="$SOURCE_JSON" ROOT="$ROOT" CAPS="$CAPABILITIES" SECRETS="$SECRETS_DIR" node -e '
const config = JSON.parse(process.env.SOURCE);
const root = process.env.ROOT;

config.capabilities = process.env.CAPS.split(",");
config.stateRepo = { ...config.stateRepo, path: `${root}/state` };
config.paths = { mirrors: `${root}/mirrors`, tasks: `${root}/tasks` };
config.secretsDir = process.env.SECRETS;
if (config.llm?.credentialsPath !== undefined) {
  // Must be WRITABLE and durable: refreshing rotates the refresh token, and pi writes
  // the new one back. A read-only path locks this runner out about an hour after boot.
  config.llm = { ...config.llm, credentialsPath: `${root}/credentials/anthropic.json` };
}
process.stdout.write(JSON.stringify(config, null, 2));
')" || die "could not adapt the config"

# ------------------------------------------------------------------------- unit + dirs

# The supervisor opens one credential socket PER TASK (DESIGN.md §9.2) and takes the
# DIRECTORY of this path, not the path itself — so an existing installation keeps the
# same `$ROOT/run` and simply gains `<task>.sock` files inside it.
CRED_SOCKET="$ROOT/run/cred.sock"
CRED_HELPER="$ROOT/bin/caterpillar-cred"

if [[ "$USER_UNIT" == "1" ]]; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  UNIT_SCOPE="--user"
else
  UNIT_DIR="/etc/systemd/system"
  UNIT_SCOPE="--system"
fi
UNIT_PATH="$UNIT_DIR/caterpillar-runner.service"

UNIT="$(cat <<UNIT_EOF
[Unit]
Description=Caterpillar runner ($CAPABILITIES)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO_ROOT
Environment=RUNNER_ID=$RUNNER_ID
Environment=CONFIG_PATH=$ROOT/config.json
Environment=CRED_SOCKET=$CRED_SOCKET
Environment=CRED_HELPER=$CRED_HELPER
Environment=METRICS_PORT=9090
ExecStart=$(command -v node) $REPO_ROOT/src/index.ts
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT_EOF
)"

if [[ "$DRY_RUN" == "1" ]]; then
  echo "--- $ROOT/config.json"; echo "$CONFIG_JSON"
  echo "--- $UNIT_PATH"; echo "$UNIT"
  exit 0
fi

mkdir -p "$ROOT"/{state,mirrors,tasks,credentials,run,bin} "$SECRETS_DIR"
chmod 700 "$SECRETS_DIR"
printf '%s\n' "$CONFIG_JSON" > "$ROOT/config.json"

# git invokes this by name, so it has to be an executable on disk rather than an npm
# script. It exits 0 printing nothing on any failure — git reads that as "no credential"
# and reports a normal auth error instead of a confusing helper crash.
cat > "$CRED_HELPER" <<HELPER_EOF
#!/bin/sh
exec $(command -v node) $REPO_ROOT/src/cli/credential-helper.ts "\$@"
HELPER_EOF
chmod 0755 "$CRED_HELPER"

note "wrote $ROOT/config.json"
note "wrote $CRED_HELPER"

if command -v systemctl >/dev/null; then
  mkdir -p "$UNIT_DIR" 2>/dev/null || true
  if printf '%s\n' "$UNIT" > "$UNIT_PATH" 2>/dev/null; then
    note "wrote $UNIT_PATH"
    note "enable with: systemctl $UNIT_SCOPE daemon-reload && systemctl $UNIT_SCOPE enable --now caterpillar-runner"
  else
    note "could not write $UNIT_PATH (try sudo, or --user-unit). The unit was:"
    printf '%s\n' "$UNIT"
  fi
else
  note "no systemd here. Run it directly:"
  note "  RUNNER_ID=$RUNNER_ID CONFIG_PATH=$ROOT/config.json CRED_SOCKET=$CRED_SOCKET \\"
  note "    CRED_HELPER=$CRED_HELPER node $REPO_ROOT/src/index.ts"
fi

cat <<NEXT

Before it can claim anything, two things this script deliberately does not do:

1. SECRETS. One directory per secretRef, one file per key, mode 0600 — the same layout
   Kubernetes produces and src/secrets/load.ts reads:

     $SECRETS_DIR/caterpillar-github-app/{app-id,installation-id,private-key.pem}

   Copy them from wherever you seal them. Nothing here fetches a credential, and
   nothing here should: a script that can pull private keys onto a workstation is a
   worse problem than a manual copy.

2. THE MODEL CREDENTIAL. On a subscription this runner needs its own:

     npm run llm:login -- --out $ROOT/credentials/anthropic.json

   The \`--\` is required, or npm eats \`--out\` as one of its own flags; the flag
   itself is required too, and the CLI exits 1 without it.

   It must be writable and durable — refreshing rotates the refresh token and pi
   writes the new one back.

Then hand it work. A task only reaches this machine if it asks for something only this
machine has (DESIGN.md §8):

    requires:
      - $(printf '%s' "${CAPS[0]}")

An agent already running elsewhere moves work here with
\`handoff(requires: ["${CAPS[0]}"])\`; the task returns to \`ready\`, this runner claims
it on its next poll, and appends to the SAME journal. One narrative, two machines.

Watch for \`supervisor.start\` with capabilities "$CAPABILITIES" to know it is live.
NEXT
