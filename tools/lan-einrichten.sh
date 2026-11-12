#!/usr/bin/env bash
#
# Einmalig auf dem hammerpi, mit sudo: Name in Pi-hole, Zertifikat und Apache-Eintrag für
# classify.lan.hammerlore.de. Nutzt dasselbe Cloudflare-Token wie moneyme.lan und cloud.lan.
#
#   sudo bash /mnt/nvme/hammerclassify/tools/lan-einrichten.sh
#
# Läuft mehrfach ohne Schaden: ein vorhandenes Zertifikat bleibt, der Apache-Eintrag wird ersetzt.

set -euo pipefail
NAME=classify.lan.hammerlore.de
IP=192.168.180.84
DIR="$(cd "$(dirname "$0")/.." && pwd)"
[ "$(id -u)" = 0 ] || { echo "Bitte mit sudo starten." >&2; exit 1; }

# 1. Name im Heimnetz: lokaler DNS-Eintrag in Pi-hole, die übrigen Einträge bleiben
HOSTS="$(docker exec pihole pihole-FTL --config dns.hosts)"
if ! grep -q " $NAME" <<<"$HOSTS"; then
  NEU="$(python3 -c 'import sys,json; s=sys.argv[1].strip().strip("[]"); l=[x.strip() for x in s.split(",") if x.strip()]; l.append(sys.argv[2]); print(json.dumps(l))' "$HOSTS" "$IP $NAME")"
  docker exec pihole pihole-FTL --config dns.hosts "$NEU" >/dev/null
  echo "Pi-hole: $NAME -> $IP eingetragen"
fi

# 2. Zertifikat über die DNS-Challenge bei Cloudflare
if [ ! -d "/etc/letsencrypt/live/$NAME" ]; then
  certbot certonly --non-interactive --dns-cloudflare \
    --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
    --key-type ecdsa -d "$NAME" --deploy-hook "systemctl reload apache2"
fi

# 3. Apache leitet https://$NAME an die App auf 127.0.0.1:3018 weiter
install -m 644 "$DIR/server/apache-classify.conf" /etc/apache2/sites-available/hammerclassify.conf
a2ensite -q hammerclassify
apache2ctl configtest
systemctl reload apache2
echo "Fertig: https://$NAME"
