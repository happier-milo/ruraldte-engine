# `pdf-service/` — representación gráfica + timbre PDF417

Servicio HTTP **sin estado** que dibuja el PDF de un DTE. Node 24, dos
dependencias (`pdf-lib`, `zxing-wasm`), fuentes estándar del PDF: no descarga
nada, no guarda nada, no necesita base de datos.

```bash
npm install
npm test        # 80 tests
npm start       # escucha en :8787
```

```
POST /pdf/boleta        boleta 39/41
POST /pdf/factura       33/34/43/46/52/56/61 y exportación 110/111/112
POST /pdf/factura-set   varios documentos en un solo PDF (muestras del SII)
```

## El timbre es lo difícil

El `<TED>` va en un PDF417 **en byte mode**, codificado ISO-8859-1. Si el
codificador mete un *byte shift* donde no corresponde, los acentos aislados se
corrompen y el timbre deja de decodificar al TED que le dio origen — un
documento observable. Por eso acá está `zxing-wasm` y no `bwip-js`, y por eso
hay un test que lee el PDF417 de vuelta desde el PDF generado y lo compara con
el TED de entrada.

## El emisor declara lo suyo

Dos campos opcionales llevan tu nombre al documento, y **ninguno tiene default de
marca**:

| Campo | Si no lo pasas |
|---|---|
| `plataforma` | La línea legal queda *"Documento tributario electrónico emitido por {emisor}."* — sin cláusula de plataforma, y sin logo |
| `verifyUrl` | Se imprime `www.sii.cl` |

Hasta el 08-sep-2026 el default de `plataforma` era `"ComunidadRural"` —el nombre
del primer cliente de este motor— y terminaba impreso en el documento de
cualquiera que no pasara el campo. Se quitó cuando los llamadores que dependían de
él pasaron a declararlo explícito. Queda anclado con
`test/defaults-neutros.test.mjs`, que aserta sobre el texto realmente dibujado.

## El logo

El render dibuja un logotipo arriba a la izquierda si existe
`src/assets/logo-wordmark.png` **y** el documento es de la plataforma. Este
repositorio **no trae ese archivo**: es una marca, y la licencia Apache 2.0 no
licencia marcas (§6). Sin el PNG, el bloque del emisor sube y la razón social
encabeza el membrete — que es exactamente lo que el SII pide como mínimo.
Pon el tuyo ahí si quieres uno (≤ 1/5 del ancho, manual de muestras §1.1.3).

## Despliegue

`systemd/ruraldte-pdf-service.service` es la unidad que usamos: proceso Node
detrás de un reverse proxy, sin estado, replicable. Escala horizontal sin
coordinación — no hay nada que compartir entre instancias.
