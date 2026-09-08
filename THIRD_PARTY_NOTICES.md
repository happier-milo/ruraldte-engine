# Dependencias de terceros

RuralDTE Engine se distribuye bajo Apache-2.0. Estas son **todas** sus
dependencias externas, con su licencia. Ninguna es copyleft de contagio.

## Motor y provider (Deno)

| Dependencia | Versión | Licencia | Para qué |
|---|---|---|---|
| [node-forge](https://github.com/digitalbazaar/forge) | 1.3.1 | BSD-3-Clause **OR** GPL-2.0 (usada bajo **BSD-3-Clause**) | RSA/SHA-1 del XMLDSig, lectura de PKCS#12 (.pfx) |
| [@xmldom/xmldom](https://github.com/xmldom/xmldom) | 0.9.10 | MIT | Parser DOM para la C14N inclusiva |
| [@std/assert](https://jsr.io/@std/assert) | 1.x | MIT | Solo en tests |

## Servicio de PDF (Node)

| Dependencia | Versión | Licencia | Para qué |
|---|---|---|---|
| [pdf-lib](https://github.com/Hopding/pdf-lib) | ^1.17.1 | MIT | Construcción del PDF (fuentes estándar, sin assets) |
| [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) | ^2.2.4 | MIT | Timbre PDF417 en **byte mode** (envuelve zxing-cpp, Apache-2.0) |

> **Por qué zxing y no bwip-js:** el `<TED>` va en el PDF417 codificado como
> bytes ISO-8859-1. El *byte shift* de bwip-js rompe los acentos aislados, y un
> timbre que no decodifica al TED exacto es un documento observable por el SII.

## Esquemas del SII

`engine/xsd/*.xsd` son del Servicio de Impuestos Internos, redistribuidos sin
modificación y **fuera** del alcance de la licencia Apache 2.0 de este
repositorio. Ver `NOTICE` y `scripts/fetch-xsd.sh`.

## Cómo verificar esta tabla

```bash
deno info engine/factura-dte.ts | grep -E 'npm:|jsr:'
cd pdf-service && npm ls --omit=dev
```
