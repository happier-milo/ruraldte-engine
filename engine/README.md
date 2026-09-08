# RCOF / Consumo de Folios + harness de certificación de boleta

El **RCOF** (Reporte de Consumo de Folios, `<ConsumoFolios>`) es uno de los
entregables obligatorios para certificar boleta electrónica ante el SII, y este
motor lo genera y lo firma por su cuenta — no depende de que ningún tercero lo
exponga por API.

## Por qué y cuándo

- **Certificación: obligatorio.** La guía del SII pide "Envío Reporte Consumo de
  Folios, vía upload, en ambiente de certificación": hay que generar, firmar y
  subir el XML.
- **Producción: NO se envía** (Res. Ex. SII 53/2022, desde el 1-ago-2022 — la
  boleta se reporta en tiempo real). Es trámite de certificación, **una vez por
  RUT**, no un cron.
- **Por RUT, no por software.** El SII certifica al contribuyente, así que este
  flujo se repite para cada emisor que quieras habilitar.

## Módulos

| Archivo | Qué hace |
|---|---|
| `consumo-folios.ts` | Arma el XML `<ConsumoFolios>` (sin firmar) y deriva los resúmenes desde las boletas emitidas. Función pura. |
| `xml-signature.ts` | Firma XMLDSig enveloped (C14N 1.0, RSA-SHA1, digest SHA1, KeyInfo con X509) — `signConsumoFolios(...)`. |
| `cert-harness.ts` | Orquestación: totales bruto→neto/IVA, builder de boleta multi-ítem con la referencia al SET, y `runCertHarness(...)` con dependencias inyectadas. |
| `cert-ruraldte.ts` | Emite el set completo en UN sobre `EnvioBOLETA` firmado, **directo al SII** (semilla → token → envío), y devuelve un solo trackId. |

## Flujo de certificación (una vez por RUT)

1. **(operador)** Postular el RUT en Maullín y declarar el software con el que
   vas a emitir.
2. **(operador)** Llenar `cert-set.example.json` → `set.json` con los casos del
   "Set de Pruebas Boleta Electrónica" que te asignó el SII.
3. **(operador)** Descargar el **CAF de certificación** (tipo 39).
   ⏰ El reloj de 24 h del SII arranca acá: ten el `set.json` listo **antes** de
   bajar el CAF.
4. **(motor)** Emitir el set con `emitCertSetViaRuralDte(...)` (`cert-ruraldte.ts`)
   y generar + firmar el RCOF con `consumo-folios.ts` + `signConsumoFolios(...)`.
5. **(operador)** Subir las boletas y el `ConsumoFolios` firmado en
   <https://www4.sii.cl/certBolElectDteInternet/> → declaración de cumplimiento.
6. El SII autoriza y el RUT queda habilitado para emitir boleta en producción.

## Lo que los tests cubren y lo que no

El roundtrip criptográfico —firmar y verificar con la misma canonicalización—
está cubierto por tests que corren offline. Lo que **no** se puede probar sin el
SII es la aceptación byte-exacta: eso se confirma recién emitiendo en Maullín.
Por eso el RCOF de certificación se sube a mano y no automatizamos ese submit.
Si el SII observa la firma o la canonicalización, el lugar a ajustar es
`xml-signature.ts`.

## Seguridad

El `.pfx` y su contraseña se leen de un path local y de variables de entorno.
Nunca van en el código, nunca se commitean, y `set.json` con datos reales
tampoco. El CAF trae la llave privada con la que se timbra cada folio: trátalo
como lo que es.
