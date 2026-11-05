#!/bin/sh
set -eu
umask 077
mkdir -p /tmp/caudelyx-mongo
cp /run/secrets/replica_key /tmp/caudelyx-mongo/keyfile
cp /run/tls/server.pem /tmp/caudelyx-mongo/server.pem
cp /run/tls/ca.pem /tmp/caudelyx-mongo/ca.pem
chown -R mongodb:mongodb /tmp/caudelyx-mongo
chmod 400 /tmp/caudelyx-mongo/keyfile /tmp/caudelyx-mongo/server.pem
exec /usr/local/bin/docker-entrypoint.sh mongod --config /opt/caudelyx/mongo-config.yml
