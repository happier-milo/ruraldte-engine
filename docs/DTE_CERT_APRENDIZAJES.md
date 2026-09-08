# Aprendizajes de Certificación de Boleta Electrónica (corrida real)

**Fuente:** certificación real del propio RUT (Comunidad Rural SpA, 78.416.626-0), jun-2026.
**Para qué:** alimentar (a) nuestro **proceso**, (b) el **agente DTE** (guiar APRs), (c) la **documentación/guía de onboarding**. Corrige supuestos previos.

---

## 1. El flujo REAL de certificación de boleta (end-to-end)

1. **Postulación** — sii.cl → Factura electrónica → **Sistema de Facturación de Mercado** → Postulación. Marcar **Boleta Electrónica + Boleta Exenta Electrónica** (NO factura). Software = el que vas a usar de verdad (el propio, si emites con este motor). Admin = RUT del rep legal. **Operar como la EMPRESA, no el RUT personal** (gotcha real: el header del SII mostró el RUT personal y la postulación se confundió).
2. **Verificación de Actividad (RIAC)** — **gate frecuente.** Puede salir **"VIA negativa → pendiente de acreditación"**. Se pide online: sii.cl → Factura electrónica → "Verificación de actividad para emitir facturas" (aunque diga *facturas*, destraba boleta). Acreditación: subir por el ícono rojo en "Consulta estado verificación y acreditación" la **Descripción de Actividad** + **comprobante de domicilio** + **contratos/facturas de proveedores**; puede requerir **visita en terreno** del fiscalizador. **Cada APR pasa por esto** (el SII certifica por contribuyente, no por software).
3. **CAF de certificación** — `maullin.sii.cl/cvc_cgi/dte/of_solicita_folios`, tipo **39**, 5 folios. **NUNCA** el portal gratuito MIPYME (no entrega el XML). Atajo prod: `palena.sii.cl/...`.
4. **Emitir el set en UN SOLO SOBRE** EnvioBoleta — ⚠️ **las 5 boletas dentro de un envío** (un track ID), NO 5 envíos separados. (Rechazo `SRH` "El Documento no esta en el envio" = mandamos sobres separados.)
5. **Entregables por email a `SII_BE_Certificacion@sii.cl`** (asunto `SET DE PRUEBA DE BOLETA ELECTRÓNICA NOMBRE EMPRESA Rut XXXXXXXX-X`):
   1. **RCOF / Consumo de Folios** (vía UPLOAD en ambiente certificación).
   2. **Número de envío** (track ID).
   3. **Representaciones gráficas PDF** de los documentos del set.
   4. **Libro de Boletas Electrónicas (XML)**.
   5. **10 muestras** de boletas PDF (operaciones reales del giro).
6. El **sitio de consulta** (`comunidadrural.cl/boleta`) debe ir **impreso en las boletas** (bajo el timbre) y **disponible en la web** — se verifica al autorizar.
7. **V°B°** del SII → **Declaración de Cumplimiento** (rep legal) → **autorizado desde el 1° del mes en curso**.

## 2. Requisitos que se olvidan

- **Set de prueba: nombres "tal cual".** El SII entrega un `Set de Prueba BE.txt` con ítems exactos (ej. "Sandwic" sin h, "Alineacion y balanceo", "item afecto 1"). Emitir con nombres distintos = rechazo. → Construimos el parser `parse-sii-boleta-set.ts` + botón "Subir Set de Prueba (.txt)".
- **El CAF NO es el certificado digital.** CAF = folios (numeración). Certificado `.pfx` = firma. Dos cosas distintas.
- **El cert es por RUT.** Cada APR cliente repite postulación + verificación + set. Lo que automatizamos es el set + los entregables.

## 3. Gotchas técnicos (nuestros, ya corregidos)

- `gen_random_bytes` no resolvía en las funciones de credenciales (search_path sin `extensions`) → 400 al cargar credenciales. Fix mig `20260608170000`.
- **el oráculo de calibración: cada boleta = 3 llamadas** (`dte/generar` → `envio/generar` → `envio/enviar`) y límite **3/seg** → techo real ~1 boleta/seg. Cualquier rate-limiter cuenta **CALLS, no docs**. Throttle 400ms + retry-429.
- **Carátula del RCOF:** el panel mandaba campos incompletos → RCOF con `FchResol/NroResol/FchFinal/TmstFirmaEnv = "undefined"` (el SII lo rechaza). Fix: defaults en el edge fn.
- **Track IDs no se persistían** (solo en la tabla de resultado). Pendiente: persistirlos.

## 4. Qué debe reflejar el agente DTE / la guía de onboarding

- Guiar el flujo real (§1), advirtiendo del **gate de Verificación de Actividad** (es lo que más demora).
- Explicar la consulta `/boleta` (impresa + web).
- Distinguir CAF vs certificado.
- El set en **un sobre** y los **5 entregables por email**.

## 5. Pendientes de producto derivados

- **Libro de Boletas Electrónicas (XML)** — falta generarlo (entregable #4 del cert + operación diaria). Componente de Plan B.
- **PDF de boleta** con PDF417 + Link de Consulta (entregables #3/#5).
- **Persistir track IDs** de emisión.
- **Plan B** (motor propio) — ver `docs/PLAN_B_DTE_PROPIO.md`.

---

## 6. Certificación FAMILIA FACTURA + libros + exportación (set 4907369-77, jun-2026) — CERTIFICADO OK

**Fuente:** corrida real del propio RUT 78.416.626-0, set SII `784166260`, 2026-06-18. Los 8 sub-sets quedaron **REVISADO CONFORME** (paso Set de Pruebas aprobado). Alcance certificado: **33 (afecta), 34 (exenta), 52 (guía), 56 (ND), 61 (NC), 110/111/112 (exportación) + Libros de Ventas/Compras/Guías.** El 43 (liquidación) y la EMISIÓN del 46 (factura de compra) quedan fuera (el 46 sólo se REGISTRA en el libro de compras).

### 6.1 Flujo de emisión del set de factura (end-to-end)
1. **CAF de cert** por tipo en `maullin.sii.cl/cvc_cgi/dte/of_solicita_folios` (el TLS de maullin es flaky → reintentos internos lo absorben). Pedir lo justo + margen para re-emisiones.
2. **Sobre estándar = básico + exenta + guía en UN solo EnvioDTE** (los 19 DTEs estándar juntos; el SII separa los sub-sets por la referencia interna `TpoDocRef=SET / FolioRef=nroCaso / RazonRef="CASO <atención>-<n>"`). Un mismo N° de envío sirve para declarar varios sub-sets.
3. **3 libros** (IEV/IEC/Guías) por separado.
4. **Exportación en DOS sobres SEPARADOS** (instrucción del set): export(1) y export(2) cada uno su EnvioDTE.
5. **EPR/LOK ≠ certificado.** EPR (sobre) / LOK (libro) = aceptado a nivel estructura/firma/cuadratura. El veredicto real es el **SETMAIL** que se dispara al hacer **"Declarar Avance"** (Maullín, por N° de envío + fecha). SETMAIL **SOK** = correcto; **SRH** = rechazado por valores → afinar y re-emitir.

### 6.2 Gotchas técnicos CLAVE (corregidos, con evidencia del SII real)
- **Bulto TRONCOS = `CodTpoBultos` 18, NO 8.** El 8 no existe en la tabla de tipos de bulto de Aduana (cazado por verificación independiente ANTES de emitir; sin el fix, el export reparaba). Verificar SIEMPRE los códigos de Aduana contra la tabla, no asumir.
- **FC de compra (45/46) con RETENCIÓN TOTAL del IVA en el LIBRO DE COMPRAS → `OtrosImp CodImp=15`, NO `IVARetTotal`.** `IVARetTotal`/`IVARetParcial`/`TotIVARetTotal`/`TotOpIVARetTotal` son campos del libro de **VENTAS (LV)** (así los etiqueta el `LibroCV_v10.xsd`). En **COMPRAS** la retención total va con `OtrosImp{CodImp:15, TasaImp:19, MntImp:IVA}` (código 15 = "IVA Retenido Total" genérico; ver `cod_otros_imp_retenc.pdf` + `ejemplos_libro_compras.pdf §2.1`). Detalle correcto: `MntNeto`, `MntIVA` (IVA recuperable), `OtrosImp/15`, **`MntTotal = Neto`** (= Neto+IVA−retención). Resumen: `TotOtrosImp/15` + **`TotMntTotal = Σ MntTotal`** (NO restar la retención otra vez en el resumen → da LRH "Descuadrado"). Costó 3 SETMAIL hasta dar con esto; el reparo era "No Informa Adecuadamente IVA Retenido Total" (el cert busca OtrosImp/15 en compras y no lo encontraba).
- **Libro especial: `FolioNotificacion` FRESCO cada vez.** El SII identifica un libro especial por `(RUT + TipoLibro + Período + FolioNotificacion)`. Reusar un folio de un set anterior del mismo período da **"ENVIO NO REGISTRADO PARA LA EMPRESA"** en Declarar Avance (aunque el upload diga LOK) o LNC "Libro Cerrado". Para re-emitir un libro, usar un FolioNotificacion nuevo.
- **Exportación:** flete y seguro van **DOBLE** (campos informativos del encabezado Aduana `MntFlete`/`MntSeguro` **Y** como 2 recargos globales `DscRcgGlobal TpoMov=R IndExeDR=1`). Recargo de comisión en la línea = `RecargoPct` (nivel de línea), NO `DscRcgGlobal`. El equivalente CLP (`OtraMoneda`) usa **redondeo float-safe** `round(round(monto×100)×TC/100)` — el SII recalcula con redondeo PHP half-away-from-zero y rechaza por 1 peso. `TpoCambio` no se valida contra mercado (basta consistencia interna). El TED de export lleva `<MNT>` **decimal** (no redondear → TED-3-640).
- **Tara/Peso de Aduana obligatorios** en export de bienes (sin ellos: SRH "Datos del Documento de Exportación No Corresponde"); `Marcas` obligatorio en TipoBultos (HED-2-804); contenedor (cod 75) exige `IdContainer/Sello/EmisorSello`, bulto común (TRONCOS 18, PLANCHAS 89) no.

### 6.3 Tooling de cert (offline-first, repetible)
- `scripts/precheck-cert-factura.ts` — oráculo de valores (tabla dorada vs motor real), 25 casos, offline.
- `scripts/validate-cert-factura-xsd.ts` — valida el sobre + 3 libros contra los **XSD oficiales del SII** (xmllint) + cuadratura de libros + aritmética re-derivada del XML emitido. **Correr ambos en verde antes de cualquier emisión** (la emisión real consume folios).

### 6.4 (SUPERADO) 46 + 43 — ambos certificados; ver §7
El 46 (factura de compra) y el 43 (liquidación-factura) **se certificaron** (jun-2026). El detalle completo y generalizado está en **§7**.

---

## 7. Agregar TIPOS ADICIONALES a un emisor ya autorizado (46 Factura de Compra + 43 Liquidación-Factura) — jun-2026 ✅

**Contexto:** una vez que el RUT es emisor autorizado, agregar un tipo nuevo es un **add-on**: se declara el tipo, el SII emite un set, y se recorre set→simulación→impresos→declaración→autorización. Probado EN VIVO para el **46** (retención total) y el **43** (liquidación). **Este §7 es el playbook para certificar CUALQUIER tipo, de CR o de cualquier cliente.**

### 7.1 Flujo "agregar un tipo" (end-to-end, repetible)
1. **Declarar el tipo** en la postulación (SII → Factura electrónica → … → marcar SOLO el tipo nuevo, ej. "SET LIQUIDACION FACTURA" / "SET CASO GENERAL FACTURA COMPRA"). **NO re-marcar lo ya certificado** (otro ciclo perdido).
2. El SII emite un **SET DE PRUEBAS** con una atención nueva (46→`4917063`, 43→`4919094`). ⚠️ **El set se regenera por atención: misma plantilla, MONTOS DISTINTOS.** Construir los casos contra el TEXTO LITERAL del set, NO reusar montos viejos (el `4901277` del 43 quedó obsoleto).
3. **Construir los casos** (`<TIPO>_CERT_CASES` en `cert-factura.ts`, 3 copias) + pre-flight XSD.
4. **Pedir CAF** del tipo (cert, `requestAndRegisterCafViaProviders`, ambiente=0).
5. **Emitir el set** por EnvioDTE (canal legacy cert) con **FECHA=hoy** → trackId → pollear **EPR 0 reparos**.
6. **Declarar Avance** (Maullín, N° de envío) → **SETMAIL SOK** (veredicto real).
7. **Simulación** (20-100 docs de operación real, sin ref SET, 0 reparos) → Declarar Avance → SOK.
8. **Muestras impresas** (PDF por doc, tributaria + cedible) → subir → verde en Timbre/CAF/TED/Validación.
   > ⚠️ **Pasar `plataforma` en el body del render.** Hasta el 08-sep-2026 el `pdf-service` caía a
   > `plataforma = "ComunidadRural"` y las muestras salían con el logo y la línea legal de la
   > plataforma — que es la representación que el SII **autorizó**. Ese default se quitó (el motor es
   > open source y no puede imprimir marca ajena en el documento de un tercero), así que sin el campo
   > las muestras salen **sin** esa marca. `buildCertFacturaMuestras` no lo arma: lo pone el llamador.
9. **Declaración de Cumplimiento** (rep. legal) → **Autorización**.

### 7.2 Lecciones transversales (valen para TODO tipo y TODO cliente) ⭐
- **EPR ≠ veredicto.** El EPR (0 reparos) es necesario pero NO suficiente; el veredicto real es el **SETMAIL** al Declarar Avance (SOK/SRH). Nunca cantar victoria con el EPR (lección que mordió en el 46).
- **Pre-flight XSD ANTES de Maullín.** `validate-cert-factura-xsd.ts` (sobre vs `EnvioDTE_v10.xsd` oficial + aritmética re-derivada) caza reparos estructurales que el EPR no ve. La emisión real gasta folios; el pre-flight no. (Cazó el `TpoDocLiq` faltante del 43.)
- **FECHA = hoy.** Fecha stale → reparos LEVES `DTE-1-650` (excede plazo 3 días) + `TED-1-646` (timbre < fecha CAF). La fechaEmisión debe ser ≥ FA del CAF y dentro de 3 días de la recepción.
- **La MUESTRA debe replicar los inputs EXACTOS de la emisión** (mismo pipeline de casos + folios + receptor + fecha + tsted). El TED/FRMT es la firma del DD; si UN campo difiere → SII rechaza "Firma TED del timbre no coincide". **MORDIÓ DOS VECES:** (a) 46 — folios asumidos ≠ reales; (b) 43 — la emisión corre `assignCertReceptores` (pool 66/77/88/55) y la muestra usó el fallback `55555555-5` → 3 de 4 mismatch. **REGLA: la muestra debe usar el MISMO `assignCertReceptores([...combinado]).filter(tipo)` que la emisión.**
- **El SII AGREGA, no reemplaza** uploads → borrar las viejas/mal clasificadas, no solo re-subir.
- **DTEMAIL** (detalle de reparos) NO llega al Gmail del founder; se ve en Maullín o el correo DTE registrado. El poll (`QueryEstUp`) solo da el CONTEO; el detalle (códigos `DTE-X`/`TED-X`/`HED-X`) viene del DTEMAIL/Maullín.
- **Verificar empíricamente** (emitir+pollear) antes de declarar un "catch-22" imposible. El validador del SII puede tener bugs (`HED-2-302`) → escalar a mesa de ayuda, no desistir.

### 7.3 DTE 46 (Factura de Compra) — retención total del IVA
- El set EXIGE **retención total** (cambio de sujeto): `ImptoReten{TipoImp:15,TasaImp:19,MontoImp:IVA}` + `CodImpAdic=15` + `<Retenedor><IndAgente>R` + **MntTotal = Neto**. El 46 *simple* (sin retención) → SETMAIL SRH.
- `HED-2-302` resuelto (el SII corrigió el validador, jun-2026). Canal: **EnvioDTE** (el `LSX-00290 "46"` fue ruteo erróneo a EnvioBOLETA).
- En el **Libro de Compras**: retención total → `OtrosImp CodImp=15` (NO `IVARetTotal`, que es de Ventas); `MntTotal=Neto`; resumen `TotMntTotal=ΣMntTotal` (no restar la retención dos veces → LRH).

### 7.4 DTE 43 (Liquidación-Factura) — el más complejo del catálogo
- **`TpoDocLiq` OBLIGATORIO por línea** del Detalle (XSD: tras CdgItem, antes de NmbItem). El motor tira error en build si falta (guard en `buildFacturaDocumento`). Mapeo (regla del set: "ELECTRÓNICA" explícito→electrónico, si no→manual): FACTURAS→30, F.ELECTRÓNICA→33, BOLETAS→35, NOTA DE CRÉDITO→60, ANTICIPO→99, LIQUIDACIÓN→43.
- **IVA propio:** `IVAProp`=ΣValComIVA (IVA de las comisiones del mandatario), `IVATerc`=IVA−IVAProp (campos 113/114, se OMITEN si comisión-IVA<0); `<Comisiones>` (ValCom Neto/Exe/IVA, admiten negativo) se RESTAN del MntTotal. **MntNeto = SOLO netoDocs (NO la comisión).** Verificado byte-a-byte vs el ejemplo certificado del SII (`computeLiquidacionCertTotals`).
- **Líneas agregadas:** QtyItem=CANTIDAD del set + MontoItem=TOTAL LINEA, **sin PrcItem** (el validador toma el monto directo; QtyItem=1 fijo → reparo "Valores de la Línea No Cuadran"). Admiten negativo (NC/liquidación dentro).
- **PDF:** el worker no renderizaba el 43 (`tipoDte no soportado: 43`) → se le agregó (título "LIQUIDACIÓN FACTURA ELECTRÓNICA", fila "Comisiones y Otros Cargos", valor de línea desde `montoItem`, cedible). El motor manda `valor` + comisiones en el `print` de `buildCertFacturaMuestras`. **⚠️ Este render vive en el worker PDF — ver §8 (ownership): debe ser de RuralDTE, no de CR.**

### 7.5 Tooling del flujo (offline-first, repetible)
- `precheck-cert-factura.ts` (oráculo de montos, tabla dorada) + `validate-cert-factura-xsd.ts` (XSD oficial + aritmética re-derivada) — **ambos en verde antes de emitir**.
- Emisión: `_debug-emit-set-factura.ts` (`SET_TIPOS` + `SET_EMIT=<atención>` + `FECHA=hoy` + `CAF_REQUEST=<tipo>` + `FIRST_FOLIOS`).
- Simulación: `_sim-<tipo>.ts` (datos reales, `omitSetReference`). Muestras: `_muestras-<tipo>.ts` (replicar el pipeline de emisión + Hermes `/pdf/factura`). Verificar FRMT de la muestra vs el sobre emitido ANTES de subir.
