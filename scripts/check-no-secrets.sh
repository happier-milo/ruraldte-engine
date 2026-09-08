#!/usr/bin/env bash
# ============================================================================
# check-no-secrets.sh — acá se firman documentos tributarios de terceros: este
# repositorio NO contiene material de firma. El guardián corre en CI para que
# tampoco lo contenga mañana.
#
# Recorre el árbol con `find`, NO con `git ls-files`: la primera versión usaba
# git y pasaba en verde fuera de un repo git —es decir, justo donde más falta
# hace, en el árbol recién exportado antes de tener historia—. Un guardián que
# no encuentra archivos no está limpio: está ciego.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

archivos=$(find . -type f \
  -not -path "./.git/*" -not -path "*/node_modules/*" -not -path "./.sii-xsd/*" \
  | sort)
[ -n "$archivos" ] || { echo "✗ no se encontró ningún archivo: el guardián está ciego"; exit 1; }

fallos=0
señal() { echo "✗ $1"; fallos=$((fallos + 1)); }

# 1. Archivos de clave o certificado, por extensión.
while read -r f; do
  case "$f" in
    *.pfx|*.p12|*.key|*.pem|*.crt|*.cer|*.jks|*.keystore) señal "archivo prohibido: $f" ;;
  esac
done <<< "$archivos"

# 2. Llave privada incrustada en cualquier archivo (incluye un CAF real pegado
#    dentro de un <RSASK>, que es como se filtraría un folio timbrable).
while read -r f; do
  [ "$f" = "./scripts/check-no-secrets.sh" ] && continue   # este archivo NOMBRA lo que busca
  if LC_ALL=C grep -qE -- '-{3,}BEGIN [A-Z ]*PRIVATE KEY-{3,}' "$f" 2>/dev/null; then
    señal "llave privada dentro de: $f"
  fi
done <<< "$archivos"

if [ "$fallos" -gt 0 ]; then
  echo
  echo "$fallos hallazgo(s). Nada de esto se publica — y si ya salió, revócalo."
  exit 1
fi
echo "✓ sin material de firma en el árbol ($(wc -l <<< "$archivos" | tr -d ' ') archivos revisados)"
