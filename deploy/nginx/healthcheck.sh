#!/bin/sh
set -eu
# Preserve the real URL hostname for SNI/certificate/Host; change only socket.
curl --silent --fail --max-time 3 --cacert /run/tls/ca.pem --connect-to "$TENANT_HOST:$TENANT_PORT:127.0.0.1:3001" "https://$TENANT_AUTHORITY/" >/dev/null
curl --silent --fail --max-time 3 --cacert /run/tls/ca.pem --connect-to "$PLATFORM_HOST:$PLATFORM_PORT:127.0.0.1:3443" "https://$PLATFORM_AUTHORITY/" >/dev/null
