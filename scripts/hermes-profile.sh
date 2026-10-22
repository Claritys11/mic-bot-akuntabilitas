#!/usr/bin/env bash
# Buat profil Hermes Agent terpisah untuk bot kelas: memori FRESH, tidak menyentuh profil utama
# (yang terhubung ke Discord utamamu). Pemakaian: bash scripts/hermes-profile.sh [nama] [port]
set -euo pipefail
NAME="${1:-mic}"
PORT="${2:-8643}"
PROFILE_DIR="$HOME/.hermes/profiles/$NAME"

if [ -e "$PROFILE_DIR" ]; then
  echo "Profil $NAME sudah ada di $PROFILE_DIR — batal." >&2
  exit 1
fi

# --clone: salin config.yaml/.env (provider & API key), TANPA token bot Discord/channel.
hermes profile create "$NAME" --clone --no-alias --description "Bot akuntabilitas kelas (MIC)"

# --clone ikut menyalin MEMORY.md & USER.md → hapus supaya benar-benar fresh.
rm -f "$PROFILE_DIR/memories/MEMORY.md" "$PROFILE_DIR/memories/USER.md"

# Matikan memori persisten: obrolan kelas tidak boleh menumpuk di memori agent (prinsip privasi).
hermes -p "$NAME" config set memory.memory_enabled false
hermes -p "$NAME" config set memory.user_profile_enabled false

KEY="$(openssl rand -hex 24)"
{
  echo ""
  echo "# --- API server untuk bot MIC ---"
  echo "API_SERVER_ENABLED=true"
  echo "API_SERVER_KEY=$KEY"
  echo "API_SERVER_PORT=$PORT"
} >> "$PROFILE_DIR/.env"

cat <<MSG

Profil "$NAME" siap (memori kosong & nonaktif).
1) Jalankan gateway profil ini:   hermes -p $NAME gateway
2) Isi .env bot MIC:
   LLM_BASE_URL=http://localhost:$PORT/v1
   LLM_API_KEY=$KEY
   LLM_TEXT_MODEL=hermes-agent
   LLM_JSON_MODE=false
   (Kalau gateway utama berjalan sebagai multiplexer, endpoint-nya bisa jadi
    http://localhost:8642/p/$NAME/v1 — lihat docs multi-profile-gateways.)
3) Disarankan matikan tools untuk platform api_server:  hermes -p $NAME tools
MSG
