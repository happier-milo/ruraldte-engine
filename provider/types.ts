// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Contrato `DteProvider`: la interfaz uniforme que implementa cualquier adaptador que
 * emite DTE al SII, más los tipos de request/response y los errores tipados con que el
 * orquestador decide reintento, failover o `manual_pending`.
 *
 * Es solo tipos y clases de error: no abre sockets, no firma nada, no valida montos.
 * Quien lo implementa (`emit`/`poll`/`getPdf`/`getXml`/`healthcheck`) es un conducto
 * fiel — la fiscalidad (retenciones del 46, split IVAProp/IVATerc del 43, la cuadratura
 * de las líneas contra `amounts`) la calcula quien arma el request. Las credenciales
 * viajan por request: el `.pfx` en base64 con su password y el CAF del tipo que estás
 * emitiendo, que el caller elige. Y `emit()` te devuelve un `trackId`, no una aceptación:
 * el veredicto del SII llega recién en `poll()` (`revisionEstado`: DOK / DNK / RCH / EPR).
 * Para decidir reintento hay una sola señal, `ProviderResponseError.isTransient` — 5xx,
 * 429, 408 y 425 sí; el resto de los 4xx es tu payload y reintentar no ayuda.
 *
 * @example
 * ```ts
 * import {
 *   type DteProvider,
 *   type ProviderEmitRequest,
 *   ProviderResponseError,
 * } from "@ruraldte/engine/provider-types";
 *
 * declare const provider: DteProvider;
 * declare const pfxBase64: string, pfxPassword: string, cafXmlBase64: string;
 *
 * const req: ProviderEmitRequest = {
 *   emisor: { rut: "76543210-K", legalName: "Agrícola Ejemplo SpA", acteco: 620200 },
 *   credentials: { pfxBase64, pfxPassword, cafXmlBase64 }, // el CAF debe ser el del tipo 33
 *   documentType: 33, folio: 128, paymentForm: 1, certification: true,
 *   receiver: { rut: "77777777-7", name: "Cliente Ejemplo Ltda", giro: "Comercio", address: "Los Robles 742", city: "Osorno" },
 *   amounts: { neto: 100000, iva: 19000, total: 119000 },
 *   glosa: "Asesoría técnica",
 * };
 *
 * try {
 *   const { trackId } = await provider.emit(req); // guárdalo: el estado se consulta con poll()
 * } catch (e) {
 *   // transitorio (5xx, 429, 408, 425) → reintentar con backoff; el resto es tu payload
 *   if (e instanceof ProviderResponseError && e.isTransient) await encolarReintento(req);
 *   else throw e;
 * }
 * ```
 *
 * @module
 */
// ============================================================================
// DTE Provider — interfaz uniforme para emisión de documentos tributarios.
// ============================================================================
//
// Abstracción que permite cambiar entre proveedores (API Gateway, un proveedor comercial)
// sin tocar el código de orquestación (dte-emit-core.ts, dte-poll-now, etc.).
//
// Cada provider implementa `DteProvider` y normaliza:
//   - Auth (apikey vs connection token)
//   - Body shape (estructurado vs XML pre-armado)
//   - Endpoints (HTTP paths, base URLs)
//   - Manejo de cert PEM / pkey PEM por request
//
// Routing decidido por `platform_dte_settings.dte_provider_primary` —
// service_role lee con `loadProviderRouting(admin)`.
//
// Failover MANUAL only en V1: superadmin flippea via UI con
// set_dte_provider_routing RPC. Sin auto-switch silencioso.
// ============================================================================

import type {
  FacturaComision,
  FacturaDteItem,
  FacturaImptoReten,
  FacturaOtraMoneda,
  FacturaTransporte,
} from "../engine/factura-dte.ts";

// Hay UN proveedor: el motor propio. El union tenía un segundo miembro para un
// proveedor comercial de respaldo que la directiva del 2026-06-29 descartó
// (RuralDTE emite DIRECTO al SII; un fallback que cobra por documento no tiene
// sentido). Ese valor no lo usaba ya nadie — `PROVIDER_NAME` es siempre "ruraldte".
/**
 * Identifica al adaptador que emitió: es el `name` de todo `DteProvider` y viaja en el
 * campo `provider` de `ProviderUnreachableError` y `ProviderResponseError` para saber
 * quién falló. Hoy el union tiene un solo miembro.
 */
export type DteProviderName = "ruraldte";

// ---------- Document types soportados ----------------------------------------

/**
 * Tipos DTE que maneja el provider. El motor propio (RuralDTE) emite TODOS los
 * tipos del set certificado: boleta 39/41, factura/nota 33/34/56/61, guía 52,
 * exportación 110/111/112 y los de cambio-de-sujeto/mandato — liquidación-factura
 * 43 (vía `liquidacion`) y factura de compra 46 (vía `compra`). Si un provider
 * concreto no soporta algún tipo, throwea `ProviderUnsupportedDocumentError` en emit().
 */
export type ProviderDteType =
  | 33
  | 34
  | 39
  | 41
  | 43
  | 46
  | 52
  | 56
  | 61
  | 110
  | 111
  | 112;

// ---------- Inputs comunes ---------------------------------------------------

/**
 * Identificación del emisor que va en el `<Emisor>` del DTE.
 * `giro`, `address` y `city` son opcionales en el tipo, pero el motor propio los exige en
 * toda emisión y lanza `ProviderConfigError` si falta alguno: `GiroEmis` tiene minLength=1
 * en el XSD y `DirOrigen`/`CmnaOrigen` se emiten incondicionales, así que dejarlos en
 * blanco manda un documento inválido con el folio ya gastado.
 */
export type ProviderEmisor = {
  /** RUT con guion: "78416626-0" */
  rut: string;
  legalName: string;
  giro?: string;
  address?: string;
  city?: string;
  /**
   * Código de actividad económica (Acteco). OBLIGATORIO para FACTURA/NC/ND por el
   * motor propio (RuralDTE) — el XSD DTE_v10 lo exige en el Emisor. Boleta no lo
   * usa; un proveedor comercial lo resuelve internamente.
   */
  acteco?: number;
};

/**
 * Datos del receptor para el `<Receptor>` del DTE.
 * La boleta (39/41) solo ocupa `rut`, `name` y `address`; el resto de la familia
 * (factura, nota, guía, exportación) además lleva `giro`, `email` y `city`, que alimenta
 * tanto CmnaRecep como CiudadRecep.
 */
export type ProviderReceiver = {
  rut: string;
  name: string;
  email?: string;
  address?: string;
  city?: string;
  /** Giro del receptor (GiroRecep). Usado en factura afecta por el motor propio. */
  giro?: string;
  /**
   * Exportación (110/111/112): receptor extranjero. `nacionalidad` = código país
   * (tabla Aduana del SII). El RUT del receptor extranjero suele ser 55555555-5.
   * `numId` (id tributario extranjero) es de la Factura de Turista — opcional.
   */
  extranjero?: { numId?: string; nacionalidad?: number };
};

/**
 * Totales del documento, en pesos enteros: acá no hay centavos.
 * El provider no cuadra los montos —que neto+iva (+exento) dé `total` y que el detalle
 * sume lo mismo es responsabilidad de quien arma el request— y en un documento exento
 * (34, 41, exportación, `exemptIndicator` = 1 o `neto` = 0) ignora `neto`/`iva` y lleva
 * el `total` completo a MntExe.
 */
export type ProviderAmounts = {
  neto: number;
  iva: number;
  total: number;
  /** MntExe del documento MIXTO (afecta + exenta): neto+iva+exento === total.
   * Sin él, la porción exenta se perdería y la cuadratura sería rechazo del SII. */
  exento?: number;
};

/**
 * Una entrada del bloque `<Referencia>`: qué documento se referencia y por qué.
 * `referencedDate` va en formato AAAA-MM-DD, y `reasonCode` solo se emite como CodRef
 * cuando es 1 (anula), 2 (corrige texto) o 3 (corrige montos) —el XSD lo restringe a esa
 * enumeración, así que cualquier otro valor se descarta y del motivo queda únicamente
 * `reason`. La boleta usa solo la primera referencia del arreglo, y de ella solo el tipo,
 * el folio y `reason`.
 */
export type ProviderReference = {
  referencedDocumentType: number;
  referencedFolio: number;
  referencedDate: string;
  reasonCode: number;
  reason: string;
};

// ---------- Auth shapes ------------------------------------------------------

/**
 * Credenciales por-emisor que cualquier provider necesita para firmar al SII.
 *
 * Ambos providers vigentes firman con el `.pfx` binario + password originales:
 * - un proveedor comercial: lo manda multipart a su API; auth = `Authorization: <apikey>`
 *   platform-wide (del constructor del adapter).
 * - RuralDTE ("ruraldte", motor propio): firma localmente (XMLDSig + C14N) y
 *   envía directo al SII (semilla→token→envío); no necesita apikey de terceros.
 */
export type ProviderEmisorCredentials = {
  /**
   * .pfx binario base64-encoded — REQUERIDO por un proveedor comercial y el motor propio.
   * Si está vacío, el adapter throwea ProviderConfigError.
   */
  pfxBase64?: string;
  /** Password del .pfx — REQUERIDO. */
  pfxPassword?: string;
  /**
   * CAF XML correspondiente al tipo de DTE a emitir, base64-encoded.
   * REQUERIDO por un proveedor comercial en `emit()` (NO en poll ni getPdf).
   * El caller debe seleccionar el CAF correcto según `documentType`.
   */
  cafXmlBase64?: string;
  /**
   * RUT del CERTIFICADO firmante (persona, rep legal) con guión: "22222222-2".
   * El proveedor comercial usa este RUT en `Certificado.Rut` para casar el .pfx — DEBE ser el
   * del cert (persona), NO el del emisor/empresa. Si se omite, el adapter cae al
   * RUT del emisor (comportamiento legacy, que un proveedor comercial probablemente rechaza
   * cuando el cert pertenece a una persona distinta de la empresa emisora).
   */
  certRut?: string;
};

// ---------- Emit -------------------------------------------------------------

/**
 * Exportación (110/111/112): moneda y pago de exportación. El builder emite los
 * Totales de exportación (TpoMoneda + MntExe + MntTotal en la moneda extranjera)
 * y, si se provee, la sección OtraMoneda (equivalente en CLP).
 */
export type ProviderExportacion = {
  /** Tipo de moneda del documento (TpoMoneda, ej. "DOLAR USA"). Obligatorio. */
  tpoMoneda: string;
  /** Sección OtraMoneda (equivalente en otra moneda, típicamente "PESO CL"). */
  otraMoneda?: FacturaOtraMoneda;
  /** Forma de pago exportación (FmaPagExp, tabla Aduana — ej. 11=ACRED, 32=ANTICIPO). */
  fmaPagExp?: number;
  /** AAAA-MM-DD. Fecha de cancelación (obligatoria si FmaPagExp = ANTICIPO). */
  fchCancel?: string;
  /** Exportación de servicios (110): IndServicio (3=servicios, 4=hotelería, …). */
  indServicio?: number;
};

/**
 * Liquidación-Factura (43): el Detalle es multi-línea con `tpoDocLiq` por línea
 * (cada línea liquida un documento) — no se puede expresar con `glosa`+`amounts`,
 * así que el caller pasa las líneas (FacturaDteItem) y los totales de la liquidación.
 * `comisiones` = lo que se queda el mandatario (gatilla la sección <Comisiones> y se
 * RESTA del MntTotal). El split IVAProp (IVA de comisiones) / IVATerc (IVA−IVAProp) y
 * los ValCom* son SLOTS que el caller computa (igual que la matriz de retención de
 * boleta): el provider es un conducto fiel, no calcula la fiscalidad.
 */
export type ProviderLiquidacion = {
  /** Líneas del Detalle (cada una con `tpoDocLiq` del documento que liquida + `montoItem`). */
  items: FacturaDteItem[];
  /** Sección <Comisiones> (Comisiones y Otros Cargos), 0..20. */
  comisiones?: FacturaComision[];
  /** Monto exento de la liquidación (MntExe); 0 si no hay líneas exentas. */
  exento?: number;
  /** IVA propio del mandatario (= IVA de las comisiones). */
  ivaProp?: number;
  /** IVA de terceros (= IVA − IVAProp). */
  ivaTerc?: number;
  /** Totales de comisiones (van en el encabezado <Totales> y se restan del MntTotal). */
  valComNeto?: number;
  valComExe?: number;
  valComIVA?: number;
};

/**
 * Factura de Compra (46): la emite el COMPRADOR. Caso simple = factura de compra
 * normal (se sintetiza desde `glosa`+`amounts`, sin `compra.items`). Caso cambio de
 * sujeto / retención = el caller pasa `items` con IndAgente=R + CPCS + CodImpAdic en
 * las líneas afectas, y `impuestosReten`/`ivaNoRet` para los Totales (ImptoReten/IVANoRet).
 */
export type ProviderCompra = {
  /** Líneas del Detalle (retención de cambio de sujeto). Si se omite, se sintetiza 1 ítem. */
  items?: FacturaDteItem[];
  /** Tipo de transacción de compra (TpoTranCompra, IdDoc). */
  tpoTranCompra?: number;
  /** Impuestos/retenciones adicionales (ImptoReten), 0..20. */
  impuestosReten?: FacturaImptoReten[];
  /** IVA No Retenido (IVANoRet) — parte del IVA que el comprador NO retuvo. */
  ivaNoRet?: number;
};

/**
 * Todo lo que `emit()` necesita para armar, firmar y enviar un DTE: emisor, credenciales
 * por-emisor, tipo, folio, receptor, totales y las secciones propias de cada familia
 * (`despacho`, `transporte`, `exportacion`, `liquidacion`, `compra`).
 * El folio lo asigna el caller —el provider no reserva ninguno— y las precondiciones por
 * familia se revisan antes de tocar el SII: sin referencia en 56/61/111/112, sin
 * `despacho` en la guía 52, sin `exportacion.tpoMoneda` en 110/111/112 o sin
 * `liquidacion.items` en el 43, `emit()` rechaza con `ProviderConfigError` y el folio no
 * se gasta.
 */
export type ProviderEmitRequest = {
  emisor: ProviderEmisor;
  credentials: ProviderEmisorCredentials;
  documentType: ProviderDteType;
  folio: number;
  receiver: ProviderReceiver;
  amounts: ProviderAmounts;
  glosa: string;
  /**
   * Detalle multi-línea (1..60 <Detalle>, tope del XSD DTE_v10). Cuando viene, REEMPLAZA
   * la línea única que se sintetiza desde `glosa`+`amounts`. La cuadratura Σlíneas↔amounts
   * la garantiza el borde (validate.ts): acá es conducto, igual que `liquidacion`/`compra`.
   *
   * ⚠️ El PRECIO cambia de base según la familia: en factura/nota/guía `precio` es NETO
   * (el IVA va en Totales) y en boleta (39/41) es BRUTO (IVA incluido) — es la misma
   * asimetría que ya tenía la síntesis de línea única, no una regla nueva.
   *
   * No aplica a 43 (usa `liquidacion.items`, con TpoDocLiq por línea) ni a 46 con cambio
   * de sujeto (usa `compra.items`, con IndAgente/CPCS/CodImpAdic).
   */
  items?: FacturaDteItem[];
  paymentForm: number;
  serviceIndicator?: number;
  exemptIndicator?: number;
  internalReference?: string;
  references?: ProviderReference[];
  /**
   * Guía de despacho (52): tipo de despacho + indicador de traslado (IdDoc).
   * indTraslado 1=constituye venta · 2=venta por efectuar · 3=consignación ·
   * 4=promoción/donación · 5=traslado interno · 6=otros no-venta · 7=devolución ·
   * 8=traslado para exportación (no venta) · 9=venta para exportación.
   */
  despacho?: { tipoDespacho?: 1 | 2 | 3; indTraslado: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 };
  /**
   * Transporte (guía 52 y exportación): vehículo, carro, transportista, destino, Aduana +
   * los campos de traslado de la Res.154 (fchSalida/horaSalida/fchLlegada). Pasa tal cual al motor.
   */
  transporte?: FacturaTransporte;
  /** Exportación (110/111/112): moneda + forma de pago de exportación. */
  exportacion?: ProviderExportacion;
  /**
   * Liquidación-Factura (43): detalle multi-línea (TpoDocLiq/línea) + comisiones +
   * split IVAProp/IVATerc. OBLIGATORIO para el tipo 43 (sin esto, emit() rechaza con
   * ProviderConfigError; el motor además exige TpoDocLiq por línea).
   */
  liquidacion?: ProviderLiquidacion;
  /**
   * Factura de Compra (46): cambio de sujeto / retención (IndAgente, ImptoReten,
   * IVANoRet, TpoTranCompra). Opcional — un 46 simple se sintetiza desde glosa+amounts.
   */
  compra?: ProviderCompra;
  /** true = ambiente certificación SII (Maullin), false = producción (Palena) */
  certification: boolean;
  /**
   * Fecha de la Res. Ex. SII del emisor (AAAA-MM-DD) para la carátula EnvioDTE de
   * FACTURA/NC/ND (motor propio). En cert = la del emisor en Maullín (CRT-3-19);
   * en prod, si se omite, el motor usa la genérica Res. Ex. 80/2014 (2014-08-22).
   * Boleta y un proveedor comercial lo ignoran.
   */
  resolutionDate?: string;
  /** Número de Res. Ex. SII del emisor para la carátula EnvioDTE. Default 0. */
  resolutionNumber?: number;
  /**
   * Instante de firma DETERMINISTA — los 19 chars ISO "AAAA-MM-DDThh:mm:ss" que el
   * orquestador SELLA en la 1ª firma y reusa en cada reintento (RuralDTE: vía
   * freeze_emit_instant). Si está presente, el motor lo usa para FchEmis (slice 0,10),
   * TmstFirma, TSTED y TmstFirmaEnv en lugar del reloj → un re-emit produce bytes
   * idénticos y el SII deduplica (no duplica el folio si el primer envío llegó pero el
   * ack se perdió). Si se omite, el motor cae a new Date() (comportamiento legacy).
   */
  emittedAtIso?: string;
  signal?: AbortSignal;
};

/**
 * Acuse del envío: el `trackId` con que después consultas el estado en `poll()`.
 * Un `trackId` NO es aceptación — el veredicto del SII llega recién en `poll()`. El `xml`
 * es el sobre firmado: un string Unicode que solo DECLARA `iso-8859-1` (al SII se sube en
 * bytes Latin-1, nunca recodificado a UTF-8), y conviene persistirlo al emitir porque el
 * motor propio no lo guarda y `getXml()` te lo va a pedir de vuelta. `xmlPath` es un slot
 * para la ruta donde lo dejaste; el motor propio no lo rellena.
 */
export type ProviderEmitResponse = {
  /** Track ID que devuelve el SII para polling posterior */
  trackId: string;
  certificacion: 0 | 1;
  /**
   * XML del DTE firmado (string UTF-8). API Gateway puede omitirlo (se obtiene
   * después con getXml). un proveedor comercial SÍ lo retorna como output de /dte/generar +
   * /envio/generar — el orquestador debe persistirlo a Storage al emit time
   * para evitar tener que regenerarlo después (no es posible) y para que
   * getPdf() lo reutilice como input.
   */
  xml?: string;
  xmlPath?: string;
};

// ---------- Poll status ------------------------------------------------------

/**
 * Lo que `poll()` necesita para consultar un envío: el `trackId` que devolvió `emit()`,
 * más el emisor, sus credenciales y el ambiente.
 * `documentType` elige el canal de consulta (39/41 por el de boletas, el resto por el
 * legacy) y tiene que ser el mismo tipo con que se emitió: con el canal cruzado la
 * consulta no resuelve nunca y el documento queda pegado sin estado. De las credenciales
 * acá se usan el `.pfx`, su password y —en el canal legacy— `certRut`; el CAF no.
 */
export type ProviderPollRequest = {
  emisor: ProviderEmisor;
  credentials: ProviderEmisorCredentials;
  trackId: string;
  documentType: number;
  folio: number;
  certification: boolean;
  signal?: AbortSignal;
};

/**
 * Estado del envío según el SII. El motor propio lo normaliza a cuatro valores: `DOK`
 * aceptado, `DNK` aceptado con reparos, `RCH` rechazado y `EPR` no terminal (hay que
 * seguir poleando).
 * `revisionEstado` no es el código crudo del SII: viene traducido, y el `EPR` del canal de
 * boletas —que allá significa "procesado"— llega acá como `DOK`. `DNK` solo lo produce ese
 * canal: en el legacy (factura, nota, guía, exportación) el reparo va agrupado con los
 * rechazos y sale como `RCH`. Un código que el motor no reconoce, o una consulta de estado
 * que responde con error, salen como `EPR` con el motivo en `revisionDetalle` — nunca como
 * un rechazo inventado.
 */
export type ProviderPollResponse = {
  trackId: string;
  certificacion: 0 | 1;
  /** "DOK" (aceptado), "DNK" (con observ), "RCH/RCT/RCF" (rechazado), "EPR" (procesando) */
  revisionEstado: string;
  revisionDetalle: string | null;
};

// ---------- Assets (PDF + XML) ----------------------------------------------

/**
 * Lo mismo que `poll()` más el material para recuperar los archivos del documento.
 * El motor propio no regenera el sobre: `getXml()` devuelve `envioDteXml` si se lo pasas y
 * rechaza con `ProviderConfigError` si no. `pdfMetadata` solo lo consume un adaptador que
 * imprima; el motor propio no genera representación impresa.
 */
export type ProviderAssetRequest = ProviderPollRequest & {
  /**
   * EnvioDTE XML content (UTF-8 string). Requerido por un proveedor comercial para generar
   * PDF (necesita el XML como input al endpoint /impresion). API Gateway
   * lo ignora — descarga el PDF directo via trackId/folio.
   */
  envioDteXml?: string;
  /**
   * Metadata para impresión PDF — solo usado por un proveedor comercial:
   *   - numeroResolucion + fechaResolucion: ResEx SII del emisor (req. para timbre)
   *   - unidadSII: ej. "ALTO HOSPICIO"
   *   - vendedor, formaPago, condicionVenta: glosa contractual del PDF
   */
  pdfMetadata?: {
    numeroResolucion?: number;
    fechaResolucion?: string;
    unidadSII?: string;
    vendedor?: string;
    formaPago?: string;
    condicionVenta?: string;
  };
};

/**
 * Representación impresa del documento, en base64.
 * El motor propio no la produce: su `getPdf()` rechaza con `ProviderConfigError` porque la
 * impresión vive en otro componente.
 */
export type ProviderPdfResponse = {
  /** PDF content as base64 string */
  pdfBase64: string;
};

/**
 * Sobre EnvioDTE/EnvioBOLETA del documento.
 * Es un string Unicode que solo declara `iso-8859-1`: los bytes que se transmiten al SII
 * van en Latin-1, así que guárdalo y súbelo en esa codificación, no recodificado a UTF-8.
 */
export type ProviderXmlResponse = {
  /** XML content as raw UTF-8 string */
  xmlContent: string;
};

// ---------- Healthcheck ------------------------------------------------------

/**
 * Resultado del sondeo: `ok`, la latencia en milisegundos —que se mide igual cuando falla—
 * y, si falló, el mensaje en `error`.
 * El motor propio lo resuelve pidiendo la semilla pública del ambiente que elige
 * `certification`: es un smoke test del SII, no una verificación de credenciales, CAF ni
 * folios.
 */
export type ProviderHealthcheckResult = {
  ok: boolean;
  latencyMs: number;
  error?: string;
};

// ---------- Provider interface ----------------------------------------------

/**
 * Interfaz uniforme de emisión —`emit`, `poll`, `getPdf`, `getXml`, `healthcheck`, con
 * credenciales por request— para que el orquestador no dependa del adaptador que tiene
 * debajo.
 * Quien la implementa es un conducto fiel: no calcula fiscalidad ni cuadra montos.
 * `emit()` devuelve un `trackId` y el veredicto del SII llega en `poll()`; un método puede
 * no estar disponible en un adaptador dado (el motor propio rechaza `getPdf()` con
 * `ProviderConfigError`), y sobre un `ProviderResponseError` la señal para decidir
 * reintento es `isTransient`.
 */
export interface DteProvider {
  readonly name: DteProviderName;
  emit(req: ProviderEmitRequest): Promise<ProviderEmitResponse>;
  poll(req: ProviderPollRequest): Promise<ProviderPollResponse>;
  getPdf(req: ProviderAssetRequest): Promise<ProviderPdfResponse>;
  getXml(req: ProviderAssetRequest): Promise<ProviderXmlResponse>;
  /** Smoke test rápido. `certification` elige el ambiente del SII a sondear:
   *  true/undefined = cert (Maullín), false = prod (Palena). */
  healthcheck(
    opts?: { emisor?: ProviderEmisor; credentials?: ProviderEmisorCredentials; certification?: boolean },
  ): Promise<ProviderHealthcheckResult>;
}

// ---------- Errores comunes --------------------------------------------------

/**
 * Provider config error: faltan credenciales o setup incorrecto. NO se debe
 * hacer failover en este caso — es un problema de configuración persistente.
 */
export class ProviderConfigError extends Error {
  readonly kind = "config" as const;
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/**
 * Provider unreachable: fetch falló (red, DNS, timeout). Failover candidato.
 */
export class ProviderUnreachableError extends Error {
  readonly kind = "unreachable" as const;
  constructor(message: string, public readonly provider: DteProviderName) {
    super(message);
    this.name = "ProviderUnreachableError";
  }
}

/**
 * Provider response error: HTTP non-2xx con body. Failover candidato para 5xx,
 * NO para 4xx (que indica error de payload — re-intentar con otro provider no ayuda).
 */
export class ProviderResponseError extends Error {
  readonly kind = "response" as const;
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly provider: DteProviderName,
  ) {
    super(message);
    this.name = "ProviderResponseError";
  }

  /**
   * Reintentable (failover / retry con backoff) vs permanente (reject).
   *   - 5xx → server transitorio.
   *   - 429 (Too Many Requests) → rate limit. La apikey un proveedor comercial es COMPARTIDA
   *     platform-wide (3 req/s, 40 req/min), así que bajo carga multitenant un
   *     429 es esperable y JAMÁS debe rechazar la boleta — hay que esperar y
   *     reintentar, no descartar.
   *   - 408 (Request Timeout) / 425 (Too Early) → timeouts del lado server.
   * El resto de 4xx = error de payload/credenciales: reintentar no ayuda.
   */
  get isTransient(): boolean {
    if (this.status === 429 || this.status === 408 || this.status === 425) {
      return true;
    }
    return this.status >= 500 && this.status < 600;
  }
}

/**
 * Provider no soporta este tipo de documento. NO failover — el otro provider
 * podría sí soportarlo, pero requiere lógica explícita del orquestador.
 */
export class ProviderUnsupportedDocumentError extends Error {
  readonly kind = "unsupported_document" as const;
  constructor(documentType: number, provider: DteProviderName) {
    super(`Provider ${provider} does not support document type ${documentType}`);
    this.name = "ProviderUnsupportedDocumentError";
  }
}

/**
 * Provider está en modo "disabled" — no se debe emitir nada vía API.
 * El orquestador debe rutear esto a `status='manual_pending'`.
 */
export class ProviderDisabledError extends Error {
  readonly kind = "disabled" as const;
  constructor(message = "DTE provider routing is disabled") {
    super(message);
    this.name = "ProviderDisabledError";
  }
}
