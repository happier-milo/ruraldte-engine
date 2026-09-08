#!/usr/bin/env bash
# ============================================================================
# fetch-xsd.sh — baja los esquemas XSD desde el SII, que es de donde son.
# ----------------------------------------------------------------------------
# Deja DOS cosas:
#
#   .sii-xsd/            el kit COMPLETO con la estructura que publica el SII
#                        (schema_dte/, schema_iecv/, …). Es lo que necesita
#                        `deno task cert:xsd .sii-xsd`. Está en .gitignore.
#
#   engine/xsd/*.xsd     los pocos esquemas que cargan los tests, en plano.
#                        Ya vienen versionados; esto los REFRESCA desde la
#                        fuente si quieres verificar que son los mismos.
#
# Los .xsd son del Servicio de Impuestos Internos, no nuestros: los incluimos
# por comodidad y NO están cubiertos por la licencia de este repo (ver NOTICE).
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."

BASE="https://www.sii.cl/factura_electronica/factura_mercado"
KIT=".sii-xsd"
# schema_lgd = Libro de Guías de Despacho. Faltaba, y sin él
# `deno task cert:xsd .sii-xsd` terminaba en ❌ por LibroGuia_v10.xsd — el flujo
# que documenta el README no llegaba a puerto.
ZIPS=(schema_dte schema_iecv schema_envio_bol schema_libro_bol schema_lgd)

mkdir -p "$KIT"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

for z in "${ZIPS[@]}"; do
  echo "→ $z.zip"
  curl -fsSL "$BASE/$z.zip" -o "$TMP/$z.zip"
  rm -rf "${KIT:?}/$z"
  unzip -oq "$TMP/$z.zip" -d "$KIT/$z"
done

echo
echo "Kit completo en $KIT/ — úsalo así:"
echo "    deno task cert:xsd $KIT"
echo

# Refresco de los esquemas versionados (solo los que ya existen: no agregamos
# archivos nuevos al repo sin que alguien lo decida).
cambios=0
for f in engine/xsd/*.xsd; do
  nuevo="$(find "$KIT" -name "$(basename "$f")" -print -quit)"
  if [ -n "$nuevo" ] && ! cmp -s "$nuevo" "$f"; then
    cp "$nuevo" "$f"; echo "  actualizado: $f"; cambios=$((cambios+1))
  fi
done
[ "$cambios" -eq 0 ] && echo "engine/xsd/: idénticos a la fuente del SII ✓"
