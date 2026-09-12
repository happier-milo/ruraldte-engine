# RuralDTE Engine

**Motor de documentos tributarios electrónicos (DTE) chilenos.** Construye, firma
y envía DTE **directo al SII** — sin intermediarios, sin costo por documento.

[![JSR](https://jsr.io/badges/@ruraldte/engine)](https://jsr.io/@ruraldte/engine)
[![Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-green.svg)](LICENSE)
[![Tests](https://github.com/happier-milo/ruraldte-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/happier-milo/ruraldte-engine/actions/workflows/ci.yml)

Es el mismo motor que corre en producción emitiendo ante el SII de Chile, no una
versión recortada. Lo mantiene y lo usa **Comunidad Rural**
([comunidadrural.cl](https://www.comunidadrural.cl)), que emite con él directamente.

> **El SII autoriza al contribuyente, no al software.** Dejó de certificar
> programas hace años: hoy declaras con qué software vas a emitir y el proceso de
> certificación lo recorre tu RUT. Así que nadie puede venderte un motor
> "certificado por el SII" — lo que sí se puede decir de este es que **con él un
> contribuyente real recorrió el proceso completo** (sets de prueba, muestras
> impresas y declaración de cumplimiento) para los 12 tipos del catálogo, y emite
> en producción desde junio de 2026.

Los 12 tipos:

| | Tipos |
|---|---|
| Boleta | **39** afecta · **41** exenta |
| Factura | **33** afecta · **34** exenta · **46** de compra |
| Notas | **56** débito · **61** crédito |
| Traslado | **52** guía de despacho |
| Exportación | **110** factura · **111** nota débito · **112** nota crédito |
| Liquidación | **43** liquidación-factura |

Además: los 3 libros (ventas, compras, guías), cesión electrónica (AEC/RPETC para
factoring), intercambio con acuses de la Ley 19.983, consulta del padrón de
contribuyentes, solicitud de folios (CAF) y representación gráfica en PDF con
timbre PDF417.

## Por qué existe

Emitir un DTE en Chile normalmente significa pagar por documento a un
intermediario. Pero el SII no cobra por recibir: cobra por nada. Lo único que se
necesita es hablar su protocolo bien — y eso es un problema de una vez, no un
costo por transacción.

Este motor es ese problema resuelto: **firma local, envío directo, costo marginal
cero**. Lo abrimos porque el protocolo del SII no debería ser el peaje de nadie.

## Instalación

```ts
// Deno / JSR
import { buildSignedFacturaDte } from "jsr:@ruraldte/engine";
```

O clona el repo: no hay build, no hay bundler, no hay `postinstall`. Dos
dependencias en total (`node-forge` y `@xmldom/xmldom`).

## Emitir una factura

```ts
import { RuralDteProvider } from "./provider/ruraldte.ts";

const provider = new RuralDteProvider();

const res = await provider.emit({
  emisor: {
    rut: "78416626-0",
    legalName: "MI EMPRESA SpA",
    giro: "Servicios de tecnología",
    address: "Av. Siempre Viva 742",
    city: "Santiago",
    acteco: 620200,
  },
  credentials: {
    pfxBase64,             // tu certificado digital (.pfx), en base64
    pfxPassword,
    cafXmlBase64,          // el CAF del tipo que vas a emitir
    certRut: "22222222-2", // RUT de la persona titular del certificado
  },
  documentType: 33,
  folio: 1,
  receiver: { rut: "76543210-K", name: "CLIENTE SpA", giro: "Comercio",
              address: "Los Olmos 123", city: "Temuco" },
  amounts: { neto: 100000, iva: 19000, total: 119000 },
  glosa: "Servicio de mantención",
  paymentForm: 1,
  certification: true,     // Maullín. false = Palena (producción)
});

console.log(res.trackId);  // el SII acusó recibo del sobre
```

**`trackId` no es aceptación.** El SII responde el envío de inmediato y valida
después. Hay que pollear:

```ts
const estado = await provider.poll({ trackId: res.trackId, /* … */ });
// estado.status: "accepted" | "accepted_with_reparos" | "rejected" | "processing"
```

Las credenciales viajan **por request**. El motor no tiene estado, no guarda
nada y no conoce ninguna base de datos: cómo custodias el `.pfx` es tu
problema — y debería serlo.

## Lo que hay adentro

```
engine/        el motor: TED, XMLDSig, C14N inclusiva, sobres, libros, AEC,
               intercambio, clientes SII (REST y legacy), PKCS#12, códigos
provider/      el contrato `DteProvider` (emit/poll/getPdf/getXml/healthcheck)
               con errores tipados que distinguen "reintenta" de "no insistas"
cert-tools/    pre-vuelo XSD antes de gastar folios en la certificación
pdf-service/   representación gráfica + timbre PDF417, HTTP stateless
```

### Decisiones que vale la pena conocer

- **C14N propia, basada en el parser.** La canonicalización inclusiva de la firma
  se hace sobre el árbol, no con expresiones regulares sobre el texto. Es la
  diferencia entre firmar lo que crees y firmar lo que serializas.
- **El timbre PDF417 va en byte mode.** El `<TED>` se codifica como bytes
  ISO-8859-1. El *byte shift* de bwip-js rompe los acentos aislados y el timbre
  deja de decodificar al TED exacto — por eso acá se usa `zxing-wasm`, con un
  test de round-trip que lo decodifica de vuelta.
- **Latin-1 en serio.** Una raya `—` en la glosa reventaba la firma del TED. Hay
  un `sanitizeSiiText()` y un test de regresión con nombre y apellido.
- **Sin proveedor de respaldo.** Emitimos directo al SII. Un fallback a un
  intermediario comercial sería volver a pagar por documento.

## Lo que este motor NO hace

A propósito. Es una librería, no una plataforma:

- No persiste nada — ni documentos, ni folios, ni estados.
- No asigna folios de forma atómica (eso necesita una transacción; si dos
  procesos toman el mismo folio, el SII rechaza el segundo).
- No custodia certificados, no maneja multi-tenant, no encola ni reintenta.
- No hace el trámite de certificación por ti. El SII autoriza **por RUT**, así que
  tienes que postular, correr tu set de pruebas y declarar cumplimiento con tu
  propio contribuyente. `docs/DTE_CERT_APRENDIZAJES.md` es el mapa de ese camino.

> **¿Si cualquiera puede usar cualquier software, dónde están los controles?** Es la
> pregunta correcta, y tiene respuesta concreta: el SII no valida tu programa, valida
> cuatro cosas en cada request —tu certificado, que el titular pueda actuar por esa
> empresa, que el RUT esté autorizado, y una cuota de folios que él reparte—.
> Explicado con las referencias al código en
> [**Cómo controla el SII**](https://github.com/happier-milo/ruraldte-engine/blob/main/docs/COMO_CONTROLA_EL_SII.md).

Nada de eso viene incluido: son las piezas que cada quien resuelve alrededor del
motor (el servicio alojado que las traía se dio de baja en septiembre de 2026). El
motor sí está completo: si prefieres operarlo tú, tienes todo lo que se necesita
para emitir.

## Certificación ante el SII

`docs/DTE_CERT_APRENDIZAJES.md` es el cuaderno de bitácora real de certificar 12
tipos: el orden del trámite, los rechazos que nos comimos y por qué. Dos cosas
que ahorran semanas:

- **El EPR con 0 reparos NO es el veredicto.** El veredicto es el SETMAIL que
  llega al *Declarar Avance* (SOK/SRH).
- **Valida contra el XSD antes de emitir en Maullín.** Cada intento gasta un
  folio de certificación, y el SII los entrega de a pocos.

## Tests

```bash
deno task check && deno task test          # 205: 162 motor + 43 provider
cd pdf-service && npm install && npm test  #  85: PDF + timbre
```

290 tests (205 + 85), todos offline. No son de humo: verifican firmas RSA de verdad,
comparan el `<DD>` byte a byte contra el de un proveedor certificado, validan
contra los XSD v2.5 oficiales del SII y decodifican el PDF417 del PDF de vuelta
al TED que le dio origen.

## Licencia

[Apache 2.0](LICENSE) — © 2026 Comunidad Rural SpA. Incluye concesión expresa de
patentes. Lee también [NOTICE](NOTICE) (los XSD son del SII, no nuestros) y
[TRADEMARKS.md](TRADEMARKS.md) (el nombre y el logo no vienen en el paquete).

Esto no es un producto del SII ni asesoría tributaria. La responsabilidad de lo
que emitas es tuya.

## Contribuir

[CONTRIBUTING.md](CONTRIBUTING.md) — usamos DCO (`git commit -s`), no CLA.
Vulnerabilidades: [SECURITY.md](SECURITY.md), nunca en un issue público.

---

## English

**RuralDTE Engine** builds, signs and submits Chilean electronic tax documents
(DTE) straight to the SII — no per-document intermediary, no marginal cost.

It is the same engine running in production against Chile's SII — maintained and used
by **Comunidad Rural** ([comunidadrural.cl](https://www.comunidadrural.cl)),
The SII authorizes the **taxpayer**, not the software — it stopped certifying
programs years ago. What can be said about this engine: a real taxpayer used it to
pass the SII's full certification process for all 12 document types (invoices,
credit/debit notes, receipts, dispatch guides, export invoices, settlement
invoices) and has been issuing in production since June 2026. It also covers the
three statutory books, invoice assignment for factoring (AEC), Law 19.983
acknowledgements, and PDF rendering with the PDF417 stamp.

Two dependencies, no build step, 290 offline tests (205 + 85). Credentials travel per
request: the engine is stateless and knows nothing about databases. Everything a
Chilean taxpayer needs to issue on their own is here; persistence, multi-tenancy,
atomic folio assignment and certificate custody live in the hosted service and
are not open source.

Docs are in Spanish — the domain is a Chilean tax protocol and translating the
SII's vocabulary would make it harder, not easier. Issues and PRs in English are
welcome.
