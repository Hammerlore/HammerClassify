#!/usr/bin/env bash
#
# Spielt den Code von HammerClassify nach /mnt/nvme/hammerclassify und (neu)startet den
# pm2-Prozess. Daten (data/), .env und keys liegen dort und gehören ncadmin:
# dieses Skript fasst sie nicht an und kann sie nicht lesen.
#
#   ./tools/aufspielen.sh
#
# Prod spielst du selbst auf, von einem Commit, den du kennst. Eine SSH-Verbindung für alles:
# einmal Touch ID oder Passphrase.
#
# Erstes Einrichten auf einem frischen Rechner: das Skript legt die .env an
# (npm run setup, Einrichtungscode genau einmal) — danach einmalig mit sudo:
#   sudo bash /mnt/nvme/hammerclassify/tools/lan-einrichten.sh

set -euo pipefail
cd "$(dirname "$0")/.."

ZIEL="${HAMMERCLASSIFY_ZIEL:-hammerpi:/mnt/nvme/hammerclassify}"
HOST="${ZIEL%%:*}"
DIR="${ZIEL#*:}"
CP="$HOME/.ssh/cm-hammerclassify-%C"

npm run --silent check
if [ -n "$(git status --porcelain | grep -v '^??')" ]; then
  echo "Es gibt ungespeicherte Änderungen. Aufgespielt wird nur ein Stand, der committet ist." >&2
  exit 1
fi
echo "Spiele $(git log -1 --format='%h %s') auf $ZIEL"

ssh -fNM -o ControlPath="$CP" -o ControlPersist=no "$HOST"
trap 'ssh -o ControlPath="$CP" -O exit "$HOST" 2>/dev/null || true' EXIT
pi() { ssh -o ControlPath="$CP" "$HOST" "$@"; }

pi "mkdir -p '$DIR'"
rsync -az --delete -e "ssh -o ControlPath=$CP" \
  --exclude /.git/ --exclude /node_modules/ --exclude /data/ --exclude /keys/ --exclude /logs/ \
  --exclude /.env --exclude '/.env.bak*' \
  --exclude /.claude/ --exclude .DS_Store \
  ./ "$ZIEL/"
pi "cd '$DIR' && npm ci --omit=dev --no-audit --no-fund --loglevel=error"

if ! pi "test -f '$DIR/.env'"; then
  echo "Auf $HOST fehlt $DIR/.env — lege sie an (Einrichtungscode wird genau EINMAL angezeigt):"
  pi "cd '$DIR' && npm run setup"
  INIT=1
fi

pi "cd '$DIR' && pm2 startOrReload ecosystem.config.cjs --update-env && pm2 save"
sleep 2
pi "curl -s -o /dev/null -w 'Antwort auf dem Pi: %{http_code}\n' http://127.0.0.1:3018/"
if [ -n "${INIT:-}" ]; then
  echo "Code liegt bereit, Prozess läuft. Jetzt auf dem Pi: sudo bash $DIR/tools/lan-einrichten.sh"
fi
