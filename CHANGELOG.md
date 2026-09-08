# Changelog

Formato [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) ·
Versionado [SemVer](https://semver.org/lang/es/).

## [0.4.0] — 2026-09-08

Primera publicación como código abierto. El motor existía desde junio de 2026 y
lleva meses emitiendo en producción; lo nuevo es la licencia, no el código.

### Qué trae
- **Los 12 tipos del catálogo SII**, certificados y autorizados (Res. Ex. 80/2014):
  boleta 39/41, factura 33/34, factura de compra 46, notas 56/61, guía 52,
  exportación 110/111/112 y liquidación-factura 43.
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
