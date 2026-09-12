// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Implementación de `DteProvider` con el motor propio: firma el DTE localmente (XMLDSig + C14N),
 * arma el sobre y lo envía directo al SII, sin API de terceros de por medio.
 *
 * Rutea por tipo a DOS canales distintos del SII, y ahí está la trampa: la boleta 39/41 viaja en un
 * sobre EnvioBOLETA por la API REST `boleta.electronica.*`, y todo el resto (33/34/43/46/52/56/61/
 * 110/111/112) en un EnvioDTE por el upload legacy `cgi_dte/UPL/DTEUpload`. `poll()` consulta el
 * mismo canal por el que se envió — pollear un trackId de upload contra el endpoint de boleta nunca
 * resuelve y el documento queda colgado. Ojo también con la base del precio: en factura y notas el
 * `precio` de cada ítem va NETO (el IVA se declara en Totales) y en boleta va BRUTO. El provider
 * falla temprano con `ProviderConfigError` en lo que quemaría el folio (giro o domicilio vacíos,
 * falta de `acteco`, NC/ND sin referencia, 43 sin `liquidacion.items`), pero no cuadra los montos ni
 * calcula la fiscalidad de 43/46: es un conducto fiel, esa validación es del llamador. No genera la
 * representación impresa (el PDF es otro componente) y el `trackId` no es aceptación — hay que
 * pollear hasta el estado terminal, que `mapEnvioStatus` / `mapLegacyOutcome` normalizan a
 * DOK / DNK / RCH / EPR.
 *
 * @example
 * ```ts
 * import { RuralDteProvider } from "@ruraldte/engine/provider";
 *
 * const emisor = { rut: "76543210-K", legalName: "SERVICIOS EJEMPLO SPA", giro: "Servicios informáticos",
 *                  address: "Camino Rural 100", city: "Melipilla", acteco: 620200 };
 * const credentials = { pfxBase64, pfxPassword, cafXmlBase64, certRut: "22222222-2" }; // del vault, en memoria
 * const provider = new RuralDteProvider();
 *
 * const { trackId } = await provider.emit({
 *   emisor, credentials, documentType: 33, folio: 1, certification: true,
 *   receiver: { rut: "77777777-7", name: "COMERCIAL EJEMPLO LTDA", giro: "Comercio",
 *               address: "San Diego 2222", city: "Santiago" },
 *   amounts: { neto: 25042, iva: 4758, total: 29800 }, // factura: el precio de la línea es NETO
 *   glosa: "Servicio de mantención", paymentForm: 1,
 *   emittedAtIso: "2026-06-08T18:24:11", // sella la firma: el reintento sale byte-idéntico y el SII deduplica
 * });
 *
 * // trackId ≠ aceptación: hay que pollear, y con el mismo documentType (elige el canal).
 * const { revisionEstado } = await provider.poll({
 *   emisor, credentials, trackId, documentType: 33, folio: 1, certification: true,
 * });
 * ```
 *
 * @module
 */
// ============================================================================
// RuralDteProvider — motor propio (Plan B): firma local + envío directo al SII.
// ============================================================================
//
// Implementa `DteProvider` delegando en el motor de `../engine/`:
//   emit  → buildSignedBoletaDte (DTE+TED firmado) → buildEnvioBoleta (sobre
//           firmado, C14N real) → sii-client authenticate (semilla→token) →
//           sendEnvio (multipart directo al SII) → TrackID.
//   poll  → sii-client getEnvioStatus (estado del envío por TrackID).
//   getXml→ el sobre EnvioBOLETA (el caller lo persiste en emit()).
//
// ALCANCE: TODOS los tipos del set certificado:
//   · boleta 39/41                              → sobre EnvioBOLETA (canal REST)
//   · factura/nota 33/34/56/61, guía 52,
//     exportación 110/111/112                   → sobre EnvioDTE (canal legacy)
//   · liquidación-factura 43 (req.liquidacion)  → sobre EnvioDTE (canal legacy)
//   · factura de compra 46 (req.compra)         → sobre EnvioDTE (canal legacy)
//
// ⚠️ ROLLOUT: la CAPACIDAD de emitir está acá; RUTEAR cada tipo al motor en
// PRODUCCIÓN lo decide el orquestador (el worker de la cola en apps/api). En
// ambiente de certificación (Maullín) este emit arma y envía el sobre directo.
// 43/46: el orquestador todavía NO rellena req.liquidacion/req.compra desde el
// payload de la cola (deuda: gateway → EmitPayload → build.ts); el provider ya los
// emite cuando se proveen — hoy lo usa el pipeline de certificación (cert-factura).
//
// Sin apikey de terceros: firma con el `.pfx` de la comunidad (cargado por
// request, igual que un proveedor comercial) y habla directo con `apicert.sii.cl`/`api.sii.cl`.
// El PDF (representación impresa) NO lo genera este motor — es Componente E.
// ============================================================================

import {
  type DteProvider,
  type DteProviderName,
  type ProviderAssetRequest,
  ProviderConfigError,
  type ProviderEmitRequest,
  type ProviderEmitResponse,
  type ProviderHealthcheckResult,
  type ProviderPdfResponse,
  type ProviderPollRequest,
  type ProviderPollResponse,
  ProviderResponseError,
  ProviderUnreachableError,
  ProviderUnsupportedDocumentError,
  type ProviderXmlResponse,
} from "./types.ts";
import { type BoletaDteInput, buildSignedBoletaDte } from "../engine/boleta-dte.ts";
import {
  buildSignedFacturaDte,
  type FacturaDteInput,
  type FacturaDteItem,
  type FacturaDteReferencia,
  type FacturaDteTotals,
  type FacturaDteType,
} from "../engine/factura-dte.ts";
import { buildEnvioBoleta } from "../engine/envio-boleta.ts";
import { buildEnvioDte } from "../engine/envio-dte.ts";
import {
  authenticate,
  getEnvioStatus,
  getSemilla,
  sendEnvio,
  SII_USER_AGENT,
  type SiiEnv,
} from "../engine/sii-client.ts";
import {
  getLegacyEnvioStatus,
  getLegacyToken,
  type LegacyEnv,
  type LegacyEnvioStatus,
  LEGACY_USER_AGENT,
  legacyUpload,
} from "../engine/sii-legacy-upload.ts";

const PROVIDER_NAME: DteProviderName = "ruraldte";
// Formato Mozilla OBLIGATORIO: el gateway de envío del SII devuelve 401
// "NO ESTA AUTENTICADO" con cualquier otro UA (verificado vivo 2026-06-10).
const USER_AGENT = SII_USER_AGENT;
/** RUT del SII como receptor del envío (constante en boletas). */
const RUT_RECEPTOR_SII = "60803000-K";

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64ToUtf8(b64: string): string {
  return new TextDecoder().decode(b64ToBytes(b64));
}
// Formatter de hora chilena, HOISTEADO a const de módulo (P6): construir un
// Intl.DateTimeFormat es caro (~decenas de µs) y la config es fija → se reúsa en
// cada firma (chileParts está en el hot path de FchEmis/TmstFirma/TSTED). El objeto
// es stateless entre llamadas (formatToParts(d) no muta), así que es seguro compartir.
const CHILE_DTF = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Santiago",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

// Hora LOCAL de Chile (America/Santiago). El SII espera FchEmis/TmstFirma/TSTED en
// hora local chilena, NO UTC — `new Date().toISOString()` es UTC y cerca de medianoche
// cae en el día siguiente (FchEmis incorrecta, rechazo/observación del SII). Intl
// resuelve el DST (UTC-3 verano / UTC-4 invierno) vía la tz database del runtime.
// Exportada para testear la conversión con una fecha fija.
/**
 * Convierte un instante a hora local de Chile (America/Santiago) para los campos de fecha del DTE.
 * El SII espera FchEmis/TmstFirma/TSTED en hora chilena, no UTC: cerca de medianoche
 * `toISOString()` cae en el día siguiente y la FchEmis sale mal. El cambio de horario
 * (UTC-3 verano / UTC-4 invierno) lo resuelve `Intl` con la base de zonas horarias del runtime.
 *
 * @returns `fecha` en `YYYY-MM-DD` e `iso` en `YYYY-MM-DDTHH:mm:ss`, sin sufijo de zona.
 */
export function chileParts(d: Date): { fecha: string; iso: string } {
  const parts = CHILE_DTF.formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const fecha = `${g("year")}-${g("month")}-${g("day")}`;
  return { fecha, iso: `${fecha}T${g("hour")}:${g("minute")}:${g("second")}` };
}
function nowParts(): { fecha: string; iso: string } {
  return chileParts(new Date()); // edge runtime: Date + Intl disponibles
}
// Instante de firma: DETERMINISTA si el orquestador selló `emittedAtIso` (re-firma
// byte-idéntica → el SII deduplica en reintento, no duplica el folio); si no, el reloj (Chile).
function emitParts(req: ProviderEmitRequest): { fecha: string; iso: string } {
  if (req.emittedAtIso) return { fecha: req.emittedAtIso.slice(0, 10), iso: req.emittedAtIso };
  return nowParts();
}
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `DteProvider` que firma el DTE con el `.pfx` del emisor y lo envía directo al SII: la boleta
 * 39/41 en un sobre EnvioBOLETA por la API REST, y 33/34/43/46/52/56/61/110/111/112 en un
 * EnvioDTE por el upload legacy; cualquier otro tipo rechaza `emit()` con
 * `ProviderUnsupportedDocumentError`.
 *
 * `poll()` elige el canal con el `documentType` que le pases: si no es el mismo del `emit()`,
 * consulta el canal equivocado y ese trackId no resuelve nunca. El token del SII queda cacheado
 * por canal, RUT y ambiente en la instancia, y sin expiración: crea un provider por tick y
 * suéltalo — una instancia de larga vida termina reusando un token vencido.
 *
 * `getPdf()` siempre rechaza con `ProviderConfigError`, y `getXml()` sólo te devuelve el sobre que
 * le pases en `envioDteXml`: la representación impresa y la persistencia del XML son del llamador.
 */
export class RuralDteProvider implements DteProvider {
  readonly name: DteProviderName = PROVIDER_NAME;

  // Caché de token SII por TICK (auditoría A1). El provider se instancia por tick
  // (worker-drain / dte-poll → makeProvider). Antes cada emit/poll re-autenticaba
  // (GET semilla → firmar semilla RSA → POST token) → en un lote del mismo emisor
  // eran N×2 round-trips al SII + N firmas de semilla, cuando UN token basta. El
  // token del SII vive minutos/horas y un tick es de segundos → no expira mid-tick.
  // Cache de INSTANCIA: se libera con el provider al terminar el tick (sin retención
  // cross-tick). Clave = `${kind}:${rut}:${env}`; un miss = re-autentica (no rompe).
  private _tokenCache = new Map<string, string>();

  private async cachedToken(key: string, fetchToken: () => Promise<string>): Promise<string> {
    const hit = this._tokenCache.get(key);
    if (hit) return hit;
    const token = await fetchToken();
    this._tokenCache.set(key, token);
    return token;
  }

  emit(req: ProviderEmitRequest): Promise<ProviderEmitResponse> {
    const t = req.documentType;
    if (t === 39 || t === 41) return this.emitBoleta(req);
    // Factura/nota 33/34/56/61 + guía 52 + exportación 110/111/112 +
    // liquidación-factura 43 + factura de compra 46 → EnvioDTE.
    if (
      t === 33 || t === 34 || t === 43 || t === 46 || t === 56 || t === 61 ||
      t === 52 || t === 110 || t === 111 || t === 112
    ) {
      return this.emitFactura(req);
    }
    return Promise.reject(new ProviderUnsupportedDocumentError(t, PROVIDER_NAME));
  }

  private async emitBoleta(req: ProviderEmitRequest): Promise<ProviderEmitResponse> {
    const { pfxBase64, pfxPassword, cafXmlBase64, certRut } = req.credentials;
    if (!pfxBase64 || !pfxPassword) {
      throw new ProviderConfigError(
        "RuralDteProvider requiere credentials.pfxBase64 + pfxPassword (.pfx)",
      );
    }
    if (!cafXmlBase64) {
      throw new ProviderConfigError(
        `RuralDteProvider requiere credentials.cafXmlBase64 para el tipo ${req.documentType}`,
      );
    }

    // DirOrigen/CmnaOrigen van incondicionales en el <Emisor> del DTE (boleta-dte.ts):
    // sin domicilio NO se emite (error de config, sin retry) — jamás un <CmnaOrigen/> vacío.
    const dirOrigen = req.emisor.address?.trim() ?? "";
    const cmnaOrigen = req.emisor.city?.trim() ?? "";
    if (!dirOrigen || !cmnaOrigen) {
      throw new ProviderConfigError(
        "RuralDteProvider requiere emisor.address + emisor.city (DirOrigen/CmnaOrigen del DTE)",
      );
    }
    // GiroEmis(or) tiene minLength=1 en el XSD: un giro vacío = STATUS 7 con el
    // folio ya quemado → error de config acá, jamás un <GiroEmisor/> vacío.
    if (!req.emisor.giro?.trim()) {
      throw new ProviderConfigError(
        "RuralDteProvider requiere emisor.giro (GiroEmisor del DTE, no puede ir vacío)",
      );
    }

    const tipoDte = req.documentType as 39 | 41;
    const isExenta = tipoDte === 41 || (req.exemptIndicator ?? 0) === 1;
    const { fecha, iso } = emitParts(req);
    const pfxBytes = b64ToBytes(pfxBase64);
    const cafXml = b64ToUtf8(cafXmlBase64);
    const rutEnvia = certRut ?? req.emisor.rut;

    const input: BoletaDteInput = {
      tipoDte,
      folio: req.folio,
      fechaEmision: fecha,
      indServicio: (req.serviceIndicator as 1 | 2 | 3 | 4) ?? 3,
      emisor: {
        rut: req.emisor.rut,
        razonSocial: req.emisor.legalName,
        giro: req.emisor.giro ?? "",
        dirOrigen,
        cmnaOrigen,
      },
      receptor: {
        rut: req.receiver.rut,
        razonSocial: req.receiver.name,
        dirRecep: req.receiver.address,
      },
      // Detalle explícito del caller (1..60 líneas) o síntesis desde glosa+amounts.
      // En boleta el precio es BRUTO (IVA incluido): el borde valida la cuadratura
      // Σlíneas ↔ amounts sobre esa base, así que acá se pasan tal cual.
      //
      // Boleta mixta (afecta + exenta) sintetizada: dos líneas — la exenta con su monto
      // y flag. Sin esto MntExe se perdería y la cuadratura MntNeto+IVA ≠ MntTotal sería
      // rechazo del SII.
      items: req.items && req.items.length > 0
        ? req.items
        : isExenta
        ? [{ nombre: req.glosa.slice(0, 80), cantidad: 1, precio: req.amounts.total, exento: true }]
        : (req.amounts.exento ?? 0) > 0
        ? [
          { nombre: req.glosa.slice(0, 80), cantidad: 1, precio: req.amounts.total - (req.amounts.exento ?? 0), exento: false },
          { nombre: `${req.glosa.slice(0, 71)} (exento)`, cantidad: 1, precio: req.amounts.exento ?? 0, exento: true },
        ]
        : [{ nombre: req.glosa.slice(0, 80), cantidad: 1, precio: req.amounts.total, exento: false }],
      totals: isExenta
        ? { neto: 0, iva: 0, exento: req.amounts.total, total: req.amounts.total }
        : { neto: req.amounts.neto, iva: req.amounts.iva, exento: req.amounts.exento ?? 0, total: req.amounts.total },
      referencia: req.references && req.references.length > 0
        ? {
          tipoDocRef: String(req.references[0].referencedDocumentType),
          folioRef: req.references[0].referencedFolio,
          razonRef: req.references[0].reason,
        }
        : undefined,
      cafXml,
      tstedIso: iso,
      tmstFirma: iso,
      documentId: `F${req.folio}T${tipoDte}`,
    };

    // 1) DTE firmado + 2) sobre EnvioBOLETA firmado (C14N real).
    let envelopeXml: string;
    let envelopeBytes: Uint8Array;
    try {
      const signedDte = buildSignedBoletaDte(input, pfxBytes, pfxPassword);
      const env = buildEnvioBoleta({
        setId: `BOLETA_${tipoDte}_${req.folio}`,
        signedDtes: [signedDte],
        caratula: {
          rutEmisor: req.emisor.rut,
          rutEnvia,
          rutReceptor: RUT_RECEPTOR_SII,
          fchResol: "2014-08-22", // boleta cert/prod: ResEx estándar Ley 20.998
          nroResol: 0,
          tmstFirmaEnv: iso,
        },
        pfxBytes,
        password: pfxPassword,
      });
      envelopeXml = env.xml;
      envelopeBytes = env.bytes;
    } catch (err) {
      // Error de firma/armado = configuración/datos, no transitorio.
      throw new ProviderConfigError(
        `RuralDteProvider build/sign falló: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 3) Autenticar (semilla→token) + 4) enviar el sobre al SII (transporte compartido).
    return this.sendEnvelopeToSii(req, pfxBytes, rutEnvia, {
      xml: envelopeXml,
      bytes: envelopeBytes,
    });
  }

  /**
   * Emite FACTURA / NC / ND (33/34/56/61) por el sobre EnvioDTE. Misma firma per-DTE
   * (signDte) y transporte (sendEnvelopeToSii) que boleta; cambia el <Documento>
   * (factura-dte.ts: RznSoc/Acteco/GiroRecep/TasaIVA/FchRef) y el sobre (EnvioDTE).
   */
  private async emitFactura(req: ProviderEmitRequest): Promise<ProviderEmitResponse> {
    const { pfxBase64, pfxPassword, cafXmlBase64, certRut } = req.credentials;
    if (!pfxBase64 || !pfxPassword) {
      throw new ProviderConfigError(
        "RuralDteProvider requiere credentials.pfxBase64 + pfxPassword (.pfx)",
      );
    }
    if (!cafXmlBase64) {
      throw new ProviderConfigError(
        `RuralDteProvider requiere credentials.cafXmlBase64 para el tipo ${req.documentType}`,
      );
    }
    if (req.emisor.acteco == null) {
      throw new ProviderConfigError(
        "RuralDteProvider factura requiere emisor.acteco (código de actividad económica)",
      );
    }
    // DirOrigen/CmnaOrigen van incondicionales en el <Emisor> del DTE (factura-dte.ts,
    // toda la familia 33/34/43/46/52/56/61/110-112): sin domicilio NO se emite (error
    // de config, sin retry) — jamás un <CmnaOrigen/> vacío.
    const dirOrigen = req.emisor.address?.trim() ?? "";
    const cmnaOrigen = req.emisor.city?.trim() ?? "";
    if (!dirOrigen || !cmnaOrigen) {
      throw new ProviderConfigError(
        "RuralDteProvider requiere emisor.address + emisor.city (DirOrigen/CmnaOrigen del DTE)",
      );
    }
    // GiroEmis con minLength=1 en el XSD: giro vacío = STATUS 7 con folio quemado.
    if (!req.emisor.giro?.trim()) {
      throw new ProviderConfigError(
        "RuralDteProvider requiere emisor.giro (GiroEmis del DTE, no puede ir vacío)",
      );
    }
    const tipoDte = req.documentType as FacturaDteType;
    const isGuia = tipoDte === 52;
    const isExport = tipoDte === 110 || tipoDte === 111 || tipoDte === 112;
    const isLiquidacion = tipoDte === 43;
    const isCompra = tipoDte === 46;

    // NC/ND (56/61) y NC/ND de exportación (111/112) requieren ≥1 referencia.
    if (
      (tipoDte === 56 || tipoDte === 61 || tipoDte === 111 || tipoDte === 112) &&
      !(req.references && req.references.length > 0)
    ) {
      throw new ProviderConfigError(
        `RuralDteProvider: el tipo ${tipoDte} (NC/ND) requiere al menos una referencia al documento corregido`,
      );
    }
    if (isGuia && !req.despacho) {
      throw new ProviderConfigError(
        "RuralDteProvider: la guía 52 requiere `despacho` (indTraslado del traslado)",
      );
    }
    if (isExport && !req.exportacion?.tpoMoneda) {
      throw new ProviderConfigError(
        "RuralDteProvider: la exportación (110/111/112) requiere `exportacion.tpoMoneda`",
      );
    }
    // Liquidación-factura (43): el Detalle es multi-línea con TpoDocLiq por línea — no se
    // sintetiza desde glosa+amounts. Sin `liquidacion.items` el motor rechaza por schema;
    // fallar acá, claro, antes de gastar folio/auth (lección del cert 43: el reparo
    // estructural no lo ve el EPR, sólo el SETMAIL al Declarar Avance).
    if (isLiquidacion && !(req.liquidacion?.items && req.liquidacion.items.length > 0)) {
      throw new ProviderConfigError(
        "RuralDteProvider: la liquidación-factura (43) requiere `liquidacion.items` (cada línea con su tpoDocLiq)",
      );
    }

    // Exenta: 34 y exportación siempre exentas; 56/61/guía según exemptIndicator o sin neto.
    // La carátula del EnvioDTE la valida el canal legacy y una resolución equivocada es
    // un rechazo garantizado (CRT-3-19 "Fecha/Numero Resolucion Invalido"). Acá había un
    // default `?? "2014-08-22"` —la Res. Ex. de BOLETA de producción— que convertía un
    // emisor sin `fch_resol` en un DTE rechazado con el folio ya gastado. En
    // certificación la fecha es PARTICULAR DE CADA EMPRESA (se saca de Maullín →
    // "Consultar emisores autorizados"), así que no hay ningún valor que se pueda
    // adivinar; y el default ni siquiera era coherente, porque pegaba `NroResol 0` (el de
    // cert) con una fecha de producción.
    //
    // No es hipotético: el 2026-09-11, de los emisores de certificación de la plataforma
    // solo UNO tenía `fch_resol` cargada. Todos los demás mandaban esa carátula
    // imposible, y uno de ellos era el cliente que estaba certificando.
    //
    // Falla acá, antes de tocar el folio, diciendo qué le falta al emisor.
    const resolutionDate = req.resolutionDate?.trim();
    if (!resolutionDate) {
      throw new ProviderConfigError(
        "RuralDteProvider: la carátula del EnvioDTE requiere resolutionDate (la FchResol " +
          "del emisor para el ambiente que emite; en certificación es la de la empresa en " +
          "Maullín, NO la de producción)",
      );
    }

    const isExenta = tipoDte === 34 || isExport ||
      (req.exemptIndicator ?? 0) === 1 || req.amounts.neto === 0;
    const { fecha, iso } = emitParts(req);
    const pfxBytes = b64ToBytes(pfxBase64);
    const cafXml = b64ToUtf8(cafXmlBase64);
    const rutEnvia = certRut ?? req.emisor.rut;
    const total = req.amounts.total;

    const referencias: FacturaDteReferencia[] | undefined = req.references?.map((r) => ({
      tipoDocRef: String(r.referencedDocumentType),
      folioRef: r.referencedFolio,
      fchRef: r.referencedDate,
      codRef: r.reasonCode === 1 || r.reasonCode === 2 || r.reasonCode === 3
        ? r.reasonCode
        : undefined,
      razonRef: r.reason,
    }));

    // Detalle: 43/46 (cambio de sujeto / mandato) traen líneas explícitas (TpoDocLiq,
    // IndAgente, CPCS, CodImpAdic…) por su propio canal; `req.items` es el detalle
    // multi-línea general (33/34/52/56/61); si no hay ninguno, se sintetiza UNA línea
    // desde glosa+amounts. En esta familia el precio es NETO (el IVA va en Totales).
    const items: FacturaDteItem[] = isLiquidacion
      ? req.liquidacion!.items
      : isCompra && req.compra?.items && req.compra.items.length > 0
      ? req.compra.items
      : req.items && req.items.length > 0
      ? req.items
      // Mixta (afecta + exenta): línea neta + línea exenta con flag — sin la
      // segunda, MntExe se perdería y la cuadratura sería rechazo del SII.
      : !isExenta && !isExport && (req.amounts.exento ?? 0) > 0
      ? [
        { nombre: req.glosa.slice(0, 80), cantidad: 1, precio: req.amounts.neto, exento: false },
        { nombre: `${req.glosa.slice(0, 71)} (exento)`, cantidad: 1, precio: req.amounts.exento ?? 0, exento: true },
      ]
      : [{
        nombre: req.glosa.slice(0, 80),
        cantidad: 1,
        // Factura: PrcItem es NETO en afecta (IVA va en Totales); total en exenta.
        precio: isExenta ? total : req.amounts.neto,
        exento: isExenta,
      }];

    // Totales: exportación (TpoMoneda) · liquidación 43 (IVAProp/IVATerc + ValCom*) ·
    // exenta · afecta. El caller computa la fiscalidad de 43/46 (el provider es conducto).
    let totals: FacturaDteTotals;
    if (isExport) {
      // Exportación: Totales en la moneda extranjera (TpoMoneda + MntExe + MntTotal),
      // + sección OtraMoneda (equivalente en CLP) si se provee.
      totals = {
        neto: 0,
        iva: 0,
        exento: total,
        total,
        tpoMoneda: req.exportacion?.tpoMoneda,
        otraMoneda: req.exportacion?.otraMoneda,
      };
    } else if (isLiquidacion) {
      const liq = req.liquidacion!;
      totals = {
        neto: req.amounts.neto,
        iva: req.amounts.iva,
        exento: liq.exento ?? 0,
        total,
        ...(liq.ivaProp !== undefined ? { ivaProp: liq.ivaProp } : {}),
        ...(liq.ivaTerc !== undefined ? { ivaTerc: liq.ivaTerc } : {}),
        ...(liq.valComNeto !== undefined ? { valComNeto: liq.valComNeto } : {}),
        ...(liq.valComExe !== undefined ? { valComExe: liq.valComExe } : {}),
        ...(liq.valComIVA !== undefined ? { valComIVA: liq.valComIVA } : {}),
      };
    } else if (isExenta) {
      totals = { neto: 0, iva: 0, exento: total, total };
    } else {
      // MntExe del doc mixto viaja en amounts.exento (validado neto+iva+exento=total).
      totals = { neto: req.amounts.neto, iva: req.amounts.iva, exento: req.amounts.exento ?? 0, total };
    }
    // FC 46 (cambio de sujeto): retención (ImptoReten) + IVA no retenido sobre los Totales base.
    if (isCompra && req.compra) {
      if (req.compra.impuestosReten) totals.impuestosReten = req.compra.impuestosReten;
      if (req.compra.ivaNoRet !== undefined) totals.ivaNoRet = req.compra.ivaNoRet;
    }

    const input: FacturaDteInput = {
      tipoDte,
      folio: req.folio,
      fechaEmision: fecha,
      // v2.5 (Res. Ex. 154/2025, oblig. 2026-05-01): FmaPago es obligatorio en
      // 33/34/43 — si no viene un valor válido, default 2 (crédito), como el SII.
      formaPago: req.paymentForm === 1 || req.paymentForm === 2 || req.paymentForm === 3
        ? req.paymentForm
        : tipoDte === 33 || tipoDte === 34 || tipoDte === 43
        ? 2
        : undefined,
      // Guía 52 / exportación: el builder sólo emite estas secciones si están seteadas.
      despacho: req.despacho,
      transporte: req.transporte,
      fmaPagExp: req.exportacion?.fmaPagExp,
      fchCancel: req.exportacion?.fchCancel,
      indServicio: req.exportacion?.indServicio,
      emisor: {
        rut: req.emisor.rut,
        razonSocial: req.emisor.legalName,
        giro: req.emisor.giro ?? "",
        acteco: req.emisor.acteco,
        dirOrigen,
        cmnaOrigen,
        ciudadOrigen: cmnaOrigen,
      },
      receptor: {
        rut: req.receiver.rut,
        razonSocial: req.receiver.name,
        giro: req.receiver.giro,
        dirRecep: req.receiver.address,
        cmnaRecep: req.receiver.city,
        ciudadRecep: req.receiver.city,
        correo: req.receiver.email,
        extranjero: req.receiver.extranjero, // exportación: receptor extranjero
      },
      items,
      totals,
      // Liquidación-factura (43): sección <Comisiones> (lo que se queda el mandatario).
      comisiones: req.liquidacion?.comisiones,
      // Factura de compra (46): tipo de transacción de compra (TpoTranCompra).
      tpoTranCompra: req.compra?.tpoTranCompra,
      referencias,
      cafXml,
      tstedIso: iso,
      tmstFirma: iso,
      documentId: `F${req.folio}T${tipoDte}`,
    };

    let envelope: { xml: string; bytes: Uint8Array };
    try {
      const signedDte = buildSignedFacturaDte(input, pfxBytes, pfxPassword);
      const env = buildEnvioDte({
        setId: `DTE_${tipoDte}_${req.folio}`,
        signedDtes: [signedDte],
        caratula: {
          rutEmisor: req.emisor.rut,
          rutEnvia,
          rutReceptor: RUT_RECEPTOR_SII,
          // La resolución la pone el EMISOR (emisores.fch_resol/nro_resol), nunca este
          // archivo. Ver la validación de arriba: había un default `?? "2014-08-22"` y
          // convertía un dato faltante en un documento rechazado.
          fchResol: resolutionDate,
          nroResol: req.resolutionNumber ?? 0,
          tmstFirmaEnv: iso,
        },
        pfxBytes,
        password: pfxPassword,
      });
      envelope = { xml: env.xml, bytes: env.bytes };
    } catch (err) {
      // Error de firma/armado = configuración/datos, no transitorio.
      throw new ProviderConfigError(`RuralDteProvider build/sign factura falló: ${errMsg(err)}`);
    }

    // FACTURA va por el canal UPLOAD legacy (cgi_dte/UPL/DTEUpload), NO por la
    // API REST boleta.electronica.* — la recepción general de DTE del SII es
    // palena/maullin (sii-legacy-upload.ts ya acepta EnvioDTE).
    return this.sendEnvelopeLegacy(req, pfxBytes, rutEnvia, envelope);
  }

  /**
   * Autentica (semilla→token) y envía el sobre al SII; mapea fallos de red a
   * Unreachable y HTTP≥400 a ResponseError. Compartido por emitBoleta (EnvioBOLETA)
   * y emitFactura (EnvioDTE).
   */
  private async sendEnvelopeToSii(
    req: ProviderEmitRequest,
    pfxBytes: Uint8Array,
    rutEnvia: string,
    envelope: { xml: string; bytes: Uint8Array },
  ): Promise<ProviderEmitResponse> {
    const siiEnv: SiiEnv = req.certification ? "cert" : "prod";
    let token: string;
    try {
      token = await this.cachedToken(`modern:${rutEnvia}:${siiEnv}`, () =>
        authenticate(siiEnv, pfxBytes, req.credentials.pfxPassword!, {
          userAgent: USER_AGENT,
        }));
    } catch (err) {
      // semilla/token caídos → tratar como inalcanzable (failover/retry).
      throw new ProviderUnreachableError(
        `RuralDteProvider auth SII falló: ${errMsg(err)}`,
        PROVIDER_NAME,
      );
    }

    let sent;
    try {
      sent = await sendEnvio(siiEnv, {
        xmlBytes: envelope.bytes,
        token,
        rutSender: rutEnvia,
        rutCompany: req.emisor.rut,
        userAgent: USER_AGENT,
      });
    } catch (err) {
      throw new ProviderUnreachableError(
        `RuralDteProvider envío SII falló: ${errMsg(err)}`,
        PROVIDER_NAME,
      );
    }

    if (sent.status >= 400 || !sent.trackId) {
      throw new ProviderResponseError(
        `RuralDteProvider envío rechazado (HTTP ${sent.status}): ${sent.raw.slice(0, 200)}`,
        sent.status >= 400 ? sent.status : 502,
        sent.raw,
        PROVIDER_NAME,
      );
    }

    return {
      trackId: sent.trackId,
      certificacion: req.certification ? 1 : 0,
      xml: envelope.xml, // el orquestador lo persiste a Storage
    };
  }

  /**
   * Transporte FACTURA/DTE: token SOAP legacy + upload a cgi_dte/UPL/DTEUpload
   * (sii-legacy-upload.ts). STATUS 0 = recibido; dedup ("ya fue enviado") se trata
   * como éxito idempotente reusando el track. STATUS 1/5/6/7 (permiso/auth/schema)
   * = permanente (reject); el resto = transitorio (failover/retry).
   */
  private async sendEnvelopeLegacy(
    req: ProviderEmitRequest,
    pfxBytes: Uint8Array,
    rutEnvia: string,
    envelope: { xml: string; bytes: Uint8Array },
  ): Promise<ProviderEmitResponse> {
    const env: LegacyEnv = req.certification ? "cert" : "prod";
    let token: string;
    try {
      token = await this.cachedToken(`legacy:${rutEnvia}:${env}`, () =>
        getLegacyToken(env, pfxBytes, req.credentials.pfxPassword!, {
          userAgent: LEGACY_USER_AGENT,
        }));
    } catch (err) {
      throw new ProviderUnreachableError(
        `RuralDteProvider auth legacy SII falló: ${errMsg(err)}`,
        PROVIDER_NAME,
      );
    }

    let result;
    try {
      result = await legacyUpload(env, {
        xmlBytes: envelope.bytes,
        token,
        rutSender: rutEnvia,
        rutCompany: req.emisor.rut,
        fileName: "envio.xml",
        userAgent: LEGACY_USER_AGENT,
      });
    } catch (err) {
      throw new ProviderUnreachableError(
        `RuralDteProvider upload legacy SII falló: ${errMsg(err)}`,
        PROVIDER_NAME,
      );
    }

    // STATUS 0 = OK; dedup (mismo archivo) = idempotente → ambos con track = éxito.
    if (result.trackId && (result.status === 0 || result.dedup)) {
      return {
        trackId: result.trackId,
        certificacion: req.certification ? 1 : 0,
        xml: envelope.xml,
      };
    }
    // 1=sin permiso · 5=no autenticado · 6=empresa no autorizada · 7=esquema inválido
    // → permanente; el resto (interno/sin track) → transitorio.
    const permanent = result.status === 1 || result.status === 5 ||
      result.status === 6 || result.status === 7;
    // El motivo va PRIMERO, no el crudo: la cabecera del RECEPCIONDTE (RUTSENDER,
    // RUTCOMPANY, FILE, TIMESTAMP) gasta los 200 chars que caben y deja al lector
    // con "STATUS 7" pelado — un rechazo de esquema sin el elemento culpable no se
    // puede arreglar. `glosa` es lo que el SII escribe DESPUÉS del <STATUS>.
    const motivo = result.glosa ?? result.raw.slice(0, 200);
    throw new ProviderResponseError(
      `RuralDteProvider upload legacy rechazado (STATUS ${result.status}): ${motivo}`,
      permanent ? 400 : 502,
      result.raw,
      PROVIDER_NAME,
    );
  }

  async poll(req: ProviderPollRequest): Promise<ProviderPollResponse> {
    const { pfxBase64, pfxPassword } = req.credentials;
    if (!pfxBase64 || !pfxPassword) {
      throw new ProviderConfigError(
        "RuralDteProvider poll requiere credentials.pfxBase64 + pfxPassword",
      );
    }
    const pfxBytes = b64ToBytes(pfxBase64);
    // El estado se consulta en el MISMO canal por el que se envió (igual que emit()):
    //  · boleta 39/41 → EnvioBOLETA (REST) → getEnvioStatus (boleta.electronica.envio).
    //  · TODO lo demás (factura/nota/guía/export/43/46) → EnvioDTE por el UPLOAD legacy
    //    (cgi_dte/DTEUpload) → su estado vive en QueryEstUp (getLegacyEnvioStatus). Pollear
    //    el endpoint boleta con un trackId de UPLOAD nunca resuelve → el doc queda en 'sent'
    //    para siempre (nunca ve el EPR). Bug real: la factura emitía pero jamás se aceptaba.
    const t = req.documentType;
    if (t !== 39 && t !== 41) return this.pollLegacy(req, pfxBytes);

    const siiEnv: SiiEnv = req.certification ? "cert" : "prod";
    let token: string;
    try {
      // Mismo token moderno que emit para este RUT+ambiente → en un tick de poll de
      // un mismo emisor (dte-poll) se autentica una sola vez.
      token = await this.cachedToken(`modern:${req.emisor.rut}:${siiEnv}`, () =>
        authenticate(siiEnv, pfxBytes, pfxPassword, { userAgent: USER_AGENT }));
    } catch (err) {
      throw new ProviderUnreachableError(
        `RuralDteProvider poll auth falló: ${err instanceof Error ? err.message : String(err)}`,
        PROVIDER_NAME,
      );
    }

    const res = await getEnvioStatus(siiEnv, {
      rutCompany: req.emisor.rut,
      trackId: req.trackId,
      token,
      userAgent: USER_AGENT,
    });

    return {
      trackId: req.trackId,
      certificacion: req.certification ? 1 : 0,
      ...mapEnvioStatus(res.status, res.raw),
    };
  }

  /**
   * Estado de un envío FACTURA/DTE (EnvioDTE por el canal UPLOAD legacy): se consulta en
   * QueryEstUp (getLegacyEnvioStatus), con el MISMO token SOAP legacy que usó el upload
   * (sendEnvelopeLegacy). Mapea el outcome legacy (accepted/rejected/processing/unknown)
   * al revisionEstado canónico. Una consulta caída = transitorio (sigue pending, no finaliza mal).
   */
  private async pollLegacy(
    req: ProviderPollRequest,
    pfxBytes: Uint8Array,
  ): Promise<ProviderPollResponse> {
    const env: LegacyEnv = req.certification ? "cert" : "prod";
    const rutEnvia = req.credentials.certRut ?? req.emisor.rut;
    const base = {
      trackId: req.trackId,
      certificacion: (req.certification ? 1 : 0) as 0 | 1,
    };

    let token: string;
    try {
      token = await this.cachedToken(`legacy:${rutEnvia}:${env}`, () =>
        getLegacyToken(env, pfxBytes, req.credentials.pfxPassword!, {
          userAgent: LEGACY_USER_AGENT,
        }));
    } catch (err) {
      throw new ProviderUnreachableError(
        `RuralDteProvider poll auth legacy falló: ${errMsg(err)}`,
        PROVIDER_NAME,
      );
    }

    let st: LegacyEnvioStatus;
    try {
      st = await getLegacyEnvioStatus(env, {
        trackId: req.trackId,
        rutSender: rutEnvia,
        rutCompany: req.emisor.rut,
        token,
        userAgent: LEGACY_USER_AGENT,
      });
    } catch (err) {
      // Consulta de estado caída (red/SOAP) → transitorio: seguir poleando.
      return { ...base, revisionEstado: "EPR", revisionDetalle: `Consulta estado legacy falló: ${errMsg(err)}` };
    }
    return { ...base, ...mapLegacyOutcome(st) };
  }

  getXml(req: ProviderAssetRequest): Promise<ProviderXmlResponse> {
    // El sobre EnvioBOLETA se retorna en emit() y se persiste a Storage; este
    // método es idempotente si el caller ya lo tiene en mano.
    if (req.envioDteXml) return Promise.resolve({ xmlContent: req.envioDteXml });
    return Promise.reject(
      new ProviderConfigError(
        "RuralDteProvider getXml: el sobre debe haberse persistido en emit() — pasar envioDteXml o leer dte_documents.xml_storage_path",
      ),
    );
  }

  getPdf(_req: ProviderAssetRequest): Promise<ProviderPdfResponse> {
    // El motor propio NO genera la representación impresa (Componente E / worker box).
    return Promise.reject(
      new ProviderConfigError(
        "RuralDteProvider no genera PDF (representación impresa = Componente E)",
      ),
    );
  }

  async healthcheck(opts?: { certification?: boolean }): Promise<ProviderHealthcheckResult> {
    // La semilla es PÚBLICA (no requiere cert). `certification` elige el ambiente del
    // SII a sondear: true = Maullín (cert/test), false = Palena (prod). Default cert
    // (preserva el comportamiento previo); el gate de go-live sondea prod.
    const env = (opts?.certification ?? true) ? "cert" : "prod";
    const start = Date.now();
    try {
      await getSemilla(env, { userAgent: USER_AGENT });
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// Estados del ENVÍO de boleta. Set AUTORITATIVO del openapi del SII
// (components.schemas.ResultadoEnvioDataRespuesta.estado, verificado vivo 06-09):
//   CRT EPR FOK PRD RCH RCO VOF REC RFR RPR RPT RSC SOK RCT.
//   Progreso (intermedio):  REC SOK FOK PRD CRT      → seguir poleando (pending)
//   Error interno SII:       VOF                     → transitorio (pending/retry)
//   Final OK:                EPR (procesado)         → aceptado (DOK) *
//   Final con reparos:       RPR (aceptado c/reparos)→ con reparos (DNK)
//   Rechazos:                RPT RFR RCT RCH RCO RSC → rechazado (RCH)
//
// NOTA: las tablas /globales/boleta.electronica.* del openapi están MUERTAS
// (SOAP "no existe servicio" en cert Y prod, probado 06-09); la fuente de verdad
// es ESTE enum del schema del openapi (que el watcher #7 hashea para drift).
//
// (*) EPR=terminal-aceptado a CONFIRMAR en el cert run: algunos flujos requieren
//     además consultar el estado POR-BOLETA (EstadoBoletaRespuesta.codigo =
//     DOK DNK FAU FNA FAN EMP TMD TMC MMD MMC AND ANC; AND/ANC = anulada).
//
// Salida en `revisionEstado` canónico (DOK/DNK/RCH/EPR) que entiende
// normalizeDteStatus en dte-emit-core: DOK→accepted, DNK→warnings, RCH→rejected,
// EPR (u otro no-terminal)→pending. NO emitimos 'RPR' como salida porque
// normalizeDteStatus lo trata como rechazo (semántica factura ≠ boleta).
const ENVIO_PENDING = new Set(["REC", "SOK", "FOK", "PRD", "CRT", "VOF"]);
const ENVIO_REJECTED = new Set(["RPT", "RFR", "RCT", "RCH", "RCO", "RSC"]);

/** Clasifica un código de estado de envío de boleta → revisionEstado canónico. */
export function classifyEnvioEstado(
  code: string,
  raw: string,
): { revisionEstado: string; revisionDetalle: string | null } {
  const c = code.trim().toUpperCase();
  if (c === "EPR") return { revisionEstado: "DOK", revisionDetalle: "Envío procesado (aceptado)" };
  if (c === "RPR") return { revisionEstado: "DNK", revisionDetalle: "Aceptado con reparos" };
  if (ENVIO_REJECTED.has(c) || /RECHAZAD/.test(c)) {
    return { revisionEstado: "RCH", revisionDetalle: raw.slice(0, 200) };
  }
  if (ENVIO_PENDING.has(c)) {
    return { revisionEstado: "EPR", revisionDetalle: `En proceso (${c})` };
  }
  // Aliases / códigos sueltos por si el SII devuelve texto en vez del código.
  if (/(^|[^A-Z])DOK([^A-Z]|$)|ACEPTAD/.test(c)) {
    return { revisionEstado: "DOK", revisionDetalle: "Envío aceptado" };
  }
  if (/REPARO|OBSERVAC|(^|[^A-Z])DNK([^A-Z]|$)/.test(c)) {
    return { revisionEstado: "DNK", revisionDetalle: raw.slice(0, 200) };
  }
  // Desconocido → pending (no finalizar mal; el daily sweep reintenta).
  return {
    revisionEstado: "EPR",
    revisionDetalle: c ? `Estado SII no reconocido: ${c}` : "Procesando en SII",
  };
}

/**
 * Extrae el detalle legible de un rechazo desde `detalle_rep_rech` (forma REAL
 * de la respuesta del SII, observada vivo 2026-06-10):
 *   { estado:"RSC", detalle_rep_rech:[{ estado:"RCH", descripcion:"DTE Rechazado",
 *     error:[{ seccion:"ENV", descripcion:"Error en Schema",
 *              detalle:"CHR-00002: Line too long (4090)" }] }] }
 */
function extractRepRechDetail(j: Record<string, unknown>): string | null {
  const det = j.detalle_rep_rech;
  if (!Array.isArray(det) || det.length === 0) return null;
  const parts: string[] = [];
  for (const d of det as Record<string, unknown>[]) {
    const head = [d.descripcion, d.tipo && d.folio ? `${d.tipo}-${d.folio}` : null]
      .filter(Boolean).join(" ");
    if (head) parts.push(String(head));
    const errs = d.error;
    if (Array.isArray(errs)) {
      for (const e of errs as Record<string, unknown>[]) {
        const line = [e.seccion, e.descripcion, e.detalle].filter(Boolean).join(": ");
        if (line) parts.push(line);
      }
    }
  }
  return parts.length > 0 ? parts.join(" · ").slice(0, 300) : null;
}

/**
 * Mapea el estado de un envío FACTURA/DTE (QueryEstUp / getLegacyEnvioStatus) al
 * revisionEstado canónico (DOK/RCH/EPR) que entiende normalizeDteStatus:
 *   · accepted (EPR/LSO)                   → DOK (aceptado)
 *   · rejected (RFR/RPR/RCH/RSC/RCT/…)     → RCH (rechazado; en la familia DTE legacy el
 *                                            reparo RPR se trata como rechazo — el motor lo
 *                                            agrupa en LEGACY_REJECTED y normalizeDteStatus
 *                                            no distingue DNK acá)
 *   · processing (REC/SOK/PRD/…) / unknown → EPR (seguir poleando; NO finalizar mal)
 */
export function mapLegacyOutcome(
  s: LegacyEnvioStatus,
): { revisionEstado: string; revisionDetalle: string | null } {
  if (s.outcome === "accepted") {
    return { revisionEstado: "DOK", revisionDetalle: s.glosa ?? "Envío procesado (aceptado)" };
  }
  if (s.outcome === "rejected") {
    return { revisionEstado: "RCH", revisionDetalle: s.glosa ?? s.raw.slice(0, 200) };
  }
  // No-terminal. Dos casos que NO son lo mismo y hasta acá se escribían igual:
  //   · processing → el SII lo está procesando de verdad (REC/SOK/PRD/PEN/-11).
  //   · unknown    → el SII contestó algo que NO sabemos leer. Decirle "En proceso"
  //     es una mentira que se pollea sola para siempre: el 33#12 de un cliente en
  //     cert acumuló 77 intentos mostrando "En proceso (106)" — y 106 no es un
  //     estado de envío, es el código de la CONSULTA. Ahora se nombra como lo que
  //     es, y se arrastra la GLOSA del SII, que venía en la respuesta y se botaba.
  const glosa = s.glosa ? `: ${s.glosa}` : "";
  if (s.outcome === "processing") {
    return {
      revisionEstado: "EPR",
      revisionDetalle: s.estado ? `En proceso (${s.estado})${glosa}` : `Procesando en SII${glosa}`,
    };
  }
  return {
    revisionEstado: "EPR",
    revisionDetalle: s.estado
      ? `Estado SII no reconocido (${s.estado})${glosa}`
      : `Sin estado en la respuesta del SII${glosa}`,
  };
}

/**
 * Mapea la respuesta HTTP del estado del envío (getEnvioStatus) → revisionEstado
 * canónico. 5xx/4xx = transitorio (sigue pending). Extrae el código del JSON
 * (REST) o del XML/texto (`<ESTADO>XXX</ESTADO>`) y delega en classifyEnvioEstado.
 * Si el SII adjunta `detalle_rep_rech` (rechazos/reparos), ese detalle legible
 * reemplaza al raw en `revisionDetalle`.
 */
export function mapEnvioStatus(
  httpStatus: number,
  raw: string,
): { revisionEstado: string; revisionDetalle: string | null } {
  if (httpStatus >= 400) {
    // Error de consulta (server/cliente) → transitorio, seguir poleando.
    return {
      revisionEstado: "EPR",
      revisionDetalle: `Consulta HTTP ${httpStatus}: ${raw.slice(0, 160)}`,
    };
  }
  let code = "";
  let repRechDetail: string | null = null;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    code = String(j.estado ?? j.statusCode ?? j.codigo ?? j.estadoEnvio ?? "");
    repRechDetail = extractRepRechDetail(j);
  } catch {
    // XML/texto: buscar <ESTADO>XXX</ESTADO>; si no, usar el crudo.
    code = raw.match(/<ESTADO>\s*([A-Za-z]{2,4})\s*<\/ESTADO>/)?.[1] ?? raw;
  }
  const mapped = classifyEnvioEstado(code, raw);
  if (repRechDetail && (mapped.revisionEstado === "RCH" || mapped.revisionEstado === "DNK")) {
    return { ...mapped, revisionDetalle: repRechDetail };
  }
  return mapped;
}
