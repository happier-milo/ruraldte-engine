#!/usr/bin/env bash
# ============================================================================
# check-license-headers.sh — todo archivo de código lleva su cabecera SPDX.
# Las inyecta el exportador; este guardián existe para que un cambio en el
# exportador no las pierda en silencio.
#
# Cuenta los archivos revisados y FALLA si no encontró ninguno: la primera
# versión reportaba "✓ cabeceras completas" sobre un árbol vacío —`find` sin
# resultados y `2>/dev/null` tragándose el "No such file"—. Un guardián que no
# encuentra nada no está conforme: está ciego, que es el mismo bug que tenía
# check-no-secrets.sh.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

archivos=$(find engine provider cert-tools pdf-service/src pdf-service/test \
  -type f \( -name '*.ts' -o -name '*.mjs' \) | sort)
n=$(printf '%s' "$archivos" | grep -c . || true)
[ "$n" -ge 50 ] || { echo "✗ solo $n archivo(s) de código encontrados: el guardián está ciego"; exit 1; }

sin=0
while read -r f; do
  [ -z "$f" ] && continue
  head -3 "$f" | grep -q 'SPDX-License-Identifier: Apache-2.0' || { echo "✗ sin cabecera SPDX: $f"; sin=$((sin+1)); }
done <<< "$archivos"

[ "$sin" -eq 0 ] || { echo; echo "$sin archivo(s) sin cabecera de licencia."; exit 1; }
echo "✓ cabeceras SPDX completas ($n archivos)"
