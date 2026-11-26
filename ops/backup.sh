#!/bin/sh
set -eu
umask 077

: "${DATABASE_URL:?Set DATABASE_URL}"
: "${BACKUP_DIR:?Set BACKUP_DIR}"

mkdir -p "$BACKUP_DIR"
temporary="$(mktemp "$BACKUP_DIR/.ruang.XXXXXX")"
trap 'rm -f -- "$temporary"' EXIT HUP INT TERM

pg_dump --dbname="$DATABASE_URL" --format=custom --file="$temporary"
pg_restore --list "$temporary" > /dev/null
mv -- "$temporary" "$BACKUP_DIR/ruang-$(date -u +%Y-%m-%d).dump"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'ruang-????-??-??.dump' -mtime +13 -delete
