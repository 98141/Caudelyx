#!/bin/sh
set -eu
for value in "$TENANT_HOST" "$PLATFORM_HOST"; do
 case "$value" in ''|*[!A-Za-z0-9.-]*) echo DEMO_WEB_HOST_INVALID >&2;exit 1;; esac
done
for value in "$TENANT_AUTHORITY" "$PLATFORM_AUTHORITY"; do
 case "$value" in ''|*[!A-Za-z0-9.:-]*) echo DEMO_WEB_AUTHORITY_INVALID >&2;exit 1;; esac
done
envsubst '$TENANT_HOST $PLATFORM_HOST $TENANT_AUTHORITY $PLATFORM_AUTHORITY' < /etc/nginx/caudelyx.template > /tmp/nginx.conf
exec nginx -c /tmp/nginx.conf -g 'daemon off;'
