#!/usr/bin/env bash
# ============================================================================
# fetch-sii-openapi.sh — baja la definición OpenAPI desde el SII.
# ----------------------------------------------------------------------------
# Deja engine/sii-openapi/openapi.yaml, relativo a la raíz del repo.
# El archivo es del Servicio de Impuestos Internos, no nuestro: lo incluimos
# como referencia para integrar la API de boletas electrónicas y sus consultas.
# NO está cubierto por la licencia de este repo (ver NOTICE).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

URL="https://www4c.sii.cl/bolcoreinternetui/api/openapi.yaml"
DEST="engine/sii-openapi/openapi.yaml"

mkdir -p "$(dirname "$DEST")"
# Reemplaza la copia anterior solo cuando la descarga termina correctamente.
TMP="$(mktemp "${DEST}.XXXXXX")"; trap 'rm -f "$TMP"' EXIT
curl -fsSL "$URL" -o "$TMP"
test -s "$TMP"
mv "$TMP" "$DEST"

echo "Actualizado: $DEST"
