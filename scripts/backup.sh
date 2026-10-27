#!/usr/bin/env bash
# Backup MongoDB harian (data pilot tidak boleh hilang). Berisi data siswa → simpan lokal, izin 600.
# Pakai: bash scripts/backup.sh            (jalankan dari folder repo; mongo lewat docker compose)
# Cron harian 02:00:  0 2 * * * cd /path/ke/repo && bash scripts/backup.sh >> backups/backup.log 2>&1
# Pulihkan:           docker compose exec -T mongo mongorestore --archive --gzip --drop < backups/mic-YYYYMMDD-HHMM.gz
set -euo pipefail
cd "$(dirname "$0")/.."
DB="${MONGO_DB:-mic}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p backups
chmod 700 backups
OUT="backups/${DB}-$(date +%Y%m%d-%H%M).gz"
umask 077
docker compose exec -T mongo mongodump --quiet --archive --gzip --db "$DB" > "$OUT"
# Arsip kosong/rusak = gagal (jangan sampai backup lama terhapus padahal yang baru gagal).
if [ ! -s "$OUT" ]; then
  echo "backup GAGAL: $OUT kosong" >&2
  rm -f "$OUT"
  exit 1
fi
find backups -name "${DB}-*.gz" -mtime "+${KEEP_DAYS}" -delete
echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
