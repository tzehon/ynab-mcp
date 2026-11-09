#!/bin/sh
set -eu
umask 077
refuse() { echo 'CONTAINER_SETUP_REJECTED' >&2; exit 1; }
[ ! -L /data ] && [ -d /data ] || refuse
for path in /data/authorization /run/ynab-mcp; do
  [ ! -L "$path" ] || refuse
  if [ "$(id -u)" = 0 ]; then
    if [ ! -e "$path" ]; then mkdir -m 0700 "$path"; fi
    [ -d "$path" ] || refuse
    chown 1000:1000 "$path"
    chmod 0700 "$path"
  else
    [ -d "$path" ] && [ "$(stat -c %u "$path")" = "$(id -u)" ] && [ "$(stat -c %a "$path")" = 700 ] || refuse
  fi
done
if [ "$(id -u)" = 0 ]; then
  exec setpriv --reuid=1000 --regid=1000 --clear-groups -- "$@"
fi
exec "$@"
