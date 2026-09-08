# `cert-tools/` — pre-vuelo de la certificación

Certificar ante el SII **gasta folios**: cada intento consume uno del CAF de
certificación, y el SII los entrega de a pocos. Estas dos herramientas existen
para que el intento que gastas ya esté bien.

| Herramienta | Qué hace | ¿Toca el SII? |
|---|---|---|
| `precheck-cert-factura.ts` | Oráculo offline: arma los DTE del set con el motor real y compara totales y estructura contra una tabla dorada (factura de compra con retención total, NC de devolución, guía de traslado interno, liquidación 43…). | No |
| `validate-cert-factura-xsd.ts` | Pre-vuelo XSD: valida el sobre y los tres libros contra los esquemas oficiales del SII con `xmllint`. | No |

```bash
deno task cert:precheck                 # offline, sin dependencias externas
bash scripts/fetch-xsd.sh               # baja el kit del SII a .sii-xsd/
deno task cert:xsd .sii-xsd             # necesita xmllint (libxml2)
```

## Los esquemas

`validate-cert-factura-xsd.ts` necesita el kit XSD **completo** del SII
(`EnvioBOLETA_v11`, `LibroCV`, `LibroGuia`, `ConsumoFolios`…), del cual este
repositorio solo versiona la parte que usan los tests. Bájalo de la fuente:

```bash
bash scripts/fetch-xsd.sh
```

El primer argumento es el directorio del kit. Sin argumento busca en
`$HOME/Documents/SII Dev`, que es donde lo tiene quien mantiene esto — pásale
`.sii-xsd` y listo.
