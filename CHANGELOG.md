# Changelog

Formato [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) ·
Versionado [SemVer](https://semver.org/lang/es/).

## [0.6.0] — 2026-10-09

### Añadido
- **`rsa-firma`** — la firma RSA-SHA1 de cada DTE y de cada sobre sale por la
  implementación nativa del runtime (`node:crypto`) en vez de la de node-forge, que es
  JavaScript puro. La firma
  es la misma, byte a byte (PKCS#1 v1.5 es determinista); lo que cambia es el costo.
  Medido con una clave de 2048 bits: 19,6 ms de CPU por firma en forge contra 1,7 ms en
  la nativa. Firmar una boleta baja de unos 23 ms de CPU a unos 5, y un sobre de 50
  boletas, de 1,1 segundos a menos de 0,3.

  No se confía en que sean iguales: la primera firma con cada clave se calcula de las
  dos maneras y se comparan. Si no coinciden, o el runtime no trae RSA-SHA1, firma
  forge de ahí en adelante y `estadoFirmaNativa()` dice por qué. `buildSignedBoletaDte`,
  `buildSignedFacturaDte`, `buildEnvioBoleta` y `buildEnvioDte` no cambian de firma ni
  de salida. Emitir una factura (el DTE y su sobre) baja de 53 a 18 ms de CPU.

  Importa si firmas por lotes: el SII admite hasta 500 boletas por envío y recomienda
  50, y con la firma en JavaScript un sobre de ese tamaño no cabía en el tope de CPU de
  una función serverless.
- **`texto-sii`** — lo que viene del SII se decodifica por bytes (UTF-8 estricto y, si
  no lo es, ISO-8859-1), no con `Response.text()`. El portal de folios contesta en
  ISO-8859-1 y con `text()` las tildes y la Ñ llegaban como U+FFFD.

- **Descuentos y recargos globales en boletas** (`descuentosGlobales` en
  `buildBoletaDocumento` y `buildSignedBoletaDte`): hasta 20 líneas `<DscRcgGlobal>`,
  en porcentaje o en pesos, con su indicador de exención. Es opcional; sin el campo el
  documento sale igual que antes. Los totales los sigue pasando quien llama, ya
  ajustados. Aporte de [@vbastianpc](https://github.com/vbastianpc).
- **`parseBoletaStatus` y `parseEnvioBoletaStatus`** (`sii-status`, también desde
  `sii-client`): leen las respuestas de estado de una boleta y de un envío sin lanzar
  por cambios en el cuerpo del SII. Recuperan lo que reconocen sin convertir tipos,
  conservan el cuerpo original y dicen qué faltó o vino distinto. No infieren
  aceptación. `getEnvioStatus` y `getBoletaStatus` pueden devolver además el
  `Content-Type`. Aporte de [@vbastianpc](https://github.com/vbastianpc).
- **`engine/sii-openapi/openapi.yaml`** — la definición OpenAPI del canal de boletas
  del SII (versión 1.0.5), como referencia, y `scripts/fetch-sii-openapi.sh` para
  bajarla de nuevo. Es del SII y no está cubierta por la licencia de este repositorio:
  ver `NOTICE`. Aporte de [@vbastianpc](https://github.com/vbastianpc).

### Corregido
- **`getBoletaStatus`** — el comentario decía que la fecha de emisión va como
  AAAA-MM-DD. El openapi del SII pide DD-MM-YYYY.
- **`sii-folios`** — la sesión con el portal de folios decodifica con `texto-sii`: el
  CAF y las páginas conservan la Ñ y las tildes. Cuando el SII niega el timbraje ("NO
  SE AUTORIZA TIMBRAJE…"), el motivo se cita desde esa frase (`motivoSiiNoAutoriza`):
  antes se cortaba en el encabezado genérico, justo antes de la razón. Y la solicitud
  de folios se lee del formulario que trae el campo buscado, no del primero de la página.

## [0.5.0] — 2026-09-20

### Quitado
- **`provider/`** — la fachada `DteProvider` (emit/poll/getXml/getPdf/healthcheck) deja
  de publicarse. No era una biblioteca genérica: es la capa que usa el emisor que
  mantiene este motor, con un contrato moldeado por sus necesidades —identificador de
  emisor propio, contenido extra de la muestra impresa, un canal aparte para la factura
  de compra— y un ruteo que lee su base de datos. Publicada al lado del motor se leía
  como "la forma oficial de usar esto", y no lo era. El motor, que es lo que el SII hace
  igual para todos, no cambió ni una línea.

  **Migración**: el README muestra el camino directo, que es el que la fachada hacía por
  dentro — `buildSignedFacturaDte` → `buildEnvioDte` → `getLegacyToken` + `legacyUpload`,
  y `getLegacyEnvioStatus` para el estado. Para boleta (39/41), `buildSignedBoletaDte` →
  `buildEnvioBoleta` → `authenticate` + `sendEnvio`. Si tenías tu propia fachada sobre
  `provider/`, apúntala a esas funciones: no hay lógica que reponer, solo el orden.

## [0.4.2] — 2026-09-09

### Añadido
- **`docs/COMO_CONTROLA_EL_SII.md`** — la respuesta a la primera pregunta sensata que
  aparece cuando alguien ve un motor DTE abierto: si cualquiera puede usar cualquier
  software, dónde quedan los controles. Las cuatro puertas del protocolo (certificado,
  titular habilitado, RUT autorizado y cuota de folios), cada una con la referencia al
  código donde se puede verificar. La escribió un lector preguntándola en público.

## [0.4.1] — 2026-09-08

### Corregido
- **Una afirmación falsa en el README.** Decía que el motor está "certificado y
  autorizado por el SII". No es así, y contradecía la propia documentación del
  repo: el SII autoriza al **contribuyente**, no al software, y dejó de certificar
  programas hace años. Reescrito con lo que sí es verificable —que con este motor un
  contribuyente real recorrió el proceso completo para los 12 tipos— y de paso
  explicando el régimen, que es lo que necesita saber quien quiera emitir con él.

## [0.4.0] — 2026-09-08

Primera publicación como código abierto. El motor existía desde junio de 2026 y
lleva meses emitiendo en producción; lo nuevo es la licencia, no el código.

### Qué trae
- **Los 12 tipos del catálogo SII**: boleta 39/41, factura 33/34, factura de compra
  46, notas 56/61, guía 52, exportación 110/111/112 y liquidación-factura 43. Con
  este motor un contribuyente real recorrió el proceso de certificación del SII
  para todos ellos — el SII autoriza al contribuyente, no al software.
- Los **tres libros** (ventas, compras, guías), **cesión electrónica** (AEC/RPETC
  para factoring), **intercambio** con los acuses de la Ley 19.983, consulta del
  padrón de contribuyentes y solicitud de folios.
- **Representación gráfica** en PDF con timbre PDF417 en byte mode.
- Licencia **Apache 2.0** con concesión expresa de patentes, `NOTICE` con la
  procedencia de los esquemas XSD del SII —que no están cubiertos por esta
  licencia— y `TRADEMARKS.md`: la licencia cubre el código, no la marca.
- **Todos los símbolos exportados documentados** (297 de 297), así que la
  referencia que genera JSR explica cada uno en vez de mostrar firmas peladas.
- CI pública: type-check y los **290 tests** (162 motor · 43 provider · 85 PDF),
  todos offline.

### Lo que este motor no hace, a propósito
No persiste nada, no asigna folios de forma atómica, no custodia certificados y
no es multi-tenant. Las credenciales viajan por request. Eso lo hace auditable y
testeable sin infraestructura, y deja esas decisiones donde corresponde: en quien
lo opera.
