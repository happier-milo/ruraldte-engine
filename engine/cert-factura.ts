// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Harness del SET de certificación de la familia factura ante el SII: mapea cada caso del
 * set a un DTE firmado, arma el sobre EnvioDTE, lo sube por el canal legacy y construye los
 * tres libros de la etapa 1 (ventas, compras y guías).
 *
 * El mapeo es lógica pura: `buildCertFacturaDtes` resuelve en memoria los folios (secuenciales
 * por tipo desde `firstFolioByType`, o por rango con `cafSegmentsByType` cuando el SII timbró en
 * tandas), las referencias (la primera al SET más la del documento corregido en NC/ND) y el
 * receptor de cada caso, sin tocar la red — sólo `emitCertSetFacturaViaRuralDte` y
 * `emitCertFacturaLibrosViaRuralDte` hablan con el SII. Las muestras impresas
 * (`buildCertFacturaMuestras`) tienen que construirse con exactamente los mismos argumentos: si
 * cambias el filtro de casos, los folios o la fecha, el TED del PDF deja de calzar con el
 * documento emitido y el SII repara "Firma TED no coincide". El `trackId` que devuelve el upload
 * no es aceptación; el veredicto del set llega en el SETMAIL del "Declarar Avance". Y los casos y
 * números de atención por defecto (`DEFAULT_FACTURA_CERT_CASES`, `SET_ATENCION`) corresponden a un
 * set concreto: el SII regenera el set con montos distintos en cada atención, así que revísalos
 * contra el texto que te entregaron antes de emitir, porque cada emisión real quema folios.
 *
 * @example
 * ```ts
 * import { buildCertFacturaDtes, DEFAULT_FACTURA_CERT_CASES } from "@ruraldte/engine/cert-factura";
 *
 * // pfxBytes/password = certificado digital del emisor; cafXml33 = el CAF que timbró el SII.
 * const dtes = buildCertFacturaDtes({
 *   cases: DEFAULT_FACTURA_CERT_CASES.filter((c) => c.tipoDocumento === 33),
 *   emisor: {
 *     rut: "76543210-K", legalName: "AGRICOLA DEMO SPA", giro: "Cultivo de cereales",
 *     acteco: 11101, dirOrigen: "Camino Real 100", cmnaOrigen: "Talca",
 *   },
 *   receptor: {
 *     rut: "77777777-7", razonSocial: "DISTRIBUIDORA DEL SUR SPA",
 *     giro: "Comercio", dirRecep: "Ruta 5 Sur 120", cmnaRecep: "Temuco",
 *   },
 *   firstFolioByType: { 33: 1 },
 *   cafByType: { 33: cafXml33 },
 *   fechaEmision: "2026-09-08", // el set se emite con FECHA = hoy
 *   tstedIso: "2026-09-08T10:00:00",
 * }, pfxBytes, password);
 *
 * for (const d of dtes) console.log(d.caso, d.tipoDocumento, d.folio, d.totals.total);
 * ```
 *
 * @module
 */
// ============================================================================
// cert-factura.ts — harness del SET de certificación de FACTURA (motor propio).
// ============================================================================
//
// Mapea los casos del set de pruebas SII (4897293/96/98/99) a DTEs de la familia
// factura, los firma (factura-dte.ts), los junta en un sobre EnvioDTE (envio-dte.ts)
// y lo sube por el canal legacy (sii-legacy-upload.ts). Lógica PURA con folios y
// referencias resueltas en memoria → testeable offline; el envío real lo dispara
// el edge fn dte-factura-cert-emit-set.
//
// Reglas del set (manual_certificacion.pdf + inst_set_pruebas.pdf):
//   - Cada caso lleva una 1ª referencia al SET: TpoDocRef="SET", FolioRef=<n° de
//     caso>, RazonRef="CASO <atención>-<n>" → el SII casa el caso con el set.
//   - NC/ND llevan ADEMÁS una 2ª referencia al documento corregido (su tipo +
//     folio + fecha) con CodRef 1=anula / 2=corrige texto / 3=corrige monto.
//   - Folios por tipo, desde el CAF de cada tipo (firstFolioByType).
//   - Factura usa precios NETOS; el IVA se calcula sobre el neto (post-descuentos).
//
// Montos: pesos CLP enteros. MontoItem = bruto de línea (Qty×Prc); el descuento
// se itemiza aparte (DescuentoMonto / DscRcgGlobal) — ver factura-dte.ts.
// ============================================================================

import {
  buildSignedFacturaDte,
  type FacturaDscRcgGlobal,
  type FacturaDteInput,
  type FacturaDteReferencia,
  type FacturaDteType,
  type FacturaOtraMoneda,
  type FacturaTransporte,
} from "./factura-dte.ts";
import { buildEnvioDte } from "./envio-dte.ts";
import {
  getLegacyToken,
  type LegacyEnv,
  LEGACY_USER_AGENT,
  legacyUpload,
  type LegacyUploadResult,
} from "./sii-legacy-upload.ts";
import { buildSignedLibroIecv, type LibroDetalle, type LibroIecvInput } from "./libro-iecv.ts";
import {
  buildSignedLibroGuia,
  type GuiaTpoOper,
  type LibroGuiaDetalle,
  type LibroGuiaInput,
} from "./libro-guia.ts";

const IVA_RATE = 0.19;
// FC 46 con RETENCIÓN TOTAL del IVA (cambio de sujeto genérico 19%). Estructura CANÓNICA que
// emite el motor (= ejemplo certificado del SII "Con Retención Total" + tabla SII
// docs/SII_IMPUESTOS_RETENCIONES_TABLA.md): línea con <Retenedor><IndAgente>R + CodImpAdic=15;
// header ImptoReten {TipoImp:15, TasaImp:19, MontoImp:=IVA}; MntTotal = Neto (= Neto+IVA−Reten).
// Por la regla SII campo 117 (a) MontoImp = Tasa × Σ(líneas con ese CodImpAdic) → 19%×Neto = IVA,
// así que el documento es INTERNAMENTE CORRECTO (verificado byte a byte + backtest offline 2026-06-18,
// scripts/_debug-fc46-backtest.ts).
//
// ⚠️ CATCH-22 DEL VALIDADOR DE CERT (NO es bug del motor — ver docs/mesa-ayuda-fc46/):
// El validador de ENVÍO del ambiente de cert NO aplica la regla (a) al código 15 (lo trata como
// AGREGADO → fuerza el esperado a [0]) y genera el reparo (HED-2-302) "[15] Monto [0] <> [IVA]".
// El SETMAIL del set rechaza (SRH) CUALQUIER documento con reparos; pero NO declarar la retención
// rechaza por "Datos de Impuesto Retenido No Corresponde". No existe estructura que pase ambos.
// AGOTADO EN VIVO (8 permutaciones, sin escape): códigos 15/41/361/481 (todos → mismo [0],
// independiente del código), con/sin <Retenedor>, con/sin CodImpAdic (quitarlo solo añade HED-2-300),
// con/sin CPCS (envío 251894210, código 481+CPCS=4803 → idéntico 302), MontoImp IVA vs 0.
// El [0] nace del <ImptoReten> del HEADER, no de la línea. Escalado a mesa de ayuda 2026-06-17.
// El 46 está DESACOPLADO del set de cert; el motor mantiene el soporte para PRODUCCIÓN (donde el SII
// acepta el documento como RPR, igual que proveedores comerciales). NO reintentar estructuras (no hay fix).
//
// 15 = IVA retenido total genérico (default, formato_dte v2.5 2026-02). Los OVERRIDE de env quedan
// solo como instrumentación del diagnóstico — todas las variantes ya dieron el MISMO HED-2-302:
//   FC46_RETEN_CODE (41/38/361/481…): REFUTADO — el reparo es independiente del código.
// Se lee por `globalThis` porque estas tres líneas corren AL IMPORTAR el módulo: con
// el identificador `Deno` pelado, importar este entrypoint desde Node o Bun reventaba
// con "Deno is not defined" antes de ejecutar nada. Son overrides de diagnóstico, así
// que fuera de Deno simplemente no existen y mandan los defaults.
const denoEnv = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env;
const CERT_RETEN_CODE = Number(denoEnv?.get("FC46_RETEN_CODE") ?? 15);
const CERT_RETEN_TASA = 19; // tasa del IVA (19%)
// CPCS (Código de Producto de Cambio de Sujeto): 2do <CdgItem> del ejemplo certificado. La hipótesis
// de que "ancla la línea como base de retención y levanta el [0]" fue REFUTADA en vivo (envío
// 251894210, CodImpAdic=481 + CPCS=4803 → mismo HED-2-302). Configurable solo para diagnóstico.
const CERT_RETEN_CPCS = denoEnv?.get("FC46_CPCS") || undefined;

/**
 * Línea de detalle de un caso del set. `precio` es unitario y NETO (sin IVA), en pesos enteros; sólo en
 * exportación (110/111/112) va en la moneda extranjera del documento, donde el XSD admite decimales.
 */
export type FacturaCertItem = {
  nombre: string;
  cantidad: number;
  /** Precio unitario NETO (sin IVA), pesos enteros. */
  precio: number;
  /** true = línea exenta. */
  exento?: boolean;
  /**
   * true = guía de traslado interno SIN valor comercial (no constituye venta): la línea
   * lleva QtyItem + UnmdItem + MontoItem=0, sin PrcItem ni IndExe, y los Totales van en 0
   * (MntTotal=0). Estructura de guía 52 IndTraslado=5 real/aceptada por el SII.
   */
  sinValor?: boolean;
  /** Unidad de medida (ej. "Hora"). */
  unidadMedida?: string;
  /** Descripción larga del ítem (DscItem). Ej: glosa de comisión exterior en export. */
  descripcion?: string;
  /** Descuento por línea en % (CASO básico-2). */
  descuentoPct?: number;
  /**
   * Recargo por línea en % (RecargoPct). Export 4903532-1: "%10 RECARGO EN LA LÍNEA DE ITEM".
   * En el subtipo Exportaciones el % se emite como <RecargoPct> y, si el monto es fraccionario
   * (10% de 1 = 0.1, no representable como RecargoMonto=positiveInteger), se omite RecargoMonto y
   * el MontoItem decimal absorbe el recargo (MontoItem = Prc×Qty×(1+pct/100)). Ver factura-dte.ts.
   */
  recargoPct?: number;
  /**
   * Liquidación-Factura (43): MontoItem TOTAL explícito de la línea agregada (el set da
   * "CANTIDAD n / TOTAL LINEA m", sin precio unitario). Admite NEGATIVO (NC/devoluciones
   * dentro de la liquidación). Si se da, manda sobre precio×cantidad y el builder emite
   * PrcItem=m/n decimal. `cantidad` = el conteo del caso (para QtyItem).
   */
  montoItem?: number;
  /** Liquidación-Factura (43): TpoDocLiq — tipo de doc que se liquida (30/33/39/61/43/99…). */
  tpoDocLiq?: number;
};

/** Receptor de un DTE de cert (genérico o por caso). */
export type CertReceptor = {
  rut: string;
  razonSocial: string;
  giro?: string;
  dirRecep?: string;
  cmnaRecep?: string;
  ciudadRecep?: string;
  /**
   * Exportación (110/111/112): receptor extranjero. RUTRecep = 55555555-5; el bloque
   * <Extranjero> lleva sólo <Nacionalidad> (código país tabla Aduana). NumId (id tributario
   * extranjero) es de la Factura de Turista (TipoFactEsp=1), NO de la exportación normal → opcional.
   */
  extranjero?: { numId?: string; nacionalidad?: number };
};

/** Un caso del set de pruebas de factura. */
export type FacturaCertCase = {
  /** Id completo del caso, ej. "4897293-1". */
  caso: string;
  /** Número de caso dentro del sub-set (FolioRef de la referencia SET). */
  nroCaso: number;
  tipoDocumento: FacturaDteType;
  items?: FacturaCertItem[];
  /** Descuento global sobre afectos en % (CASO básico-4). */
  descuentoGlobalPct?: number;
  /** NC/ND: referencia al documento corregido (otro caso del set). */
  ref?: { caso: string; codRef: 1 | 2 | 3; razon: string };
  /** Guía 52: despacho + transporte. */
  despacho?: { tipoDespacho?: 1 | 2 | 3; indTraslado: 1 | 2 | 3 | 4 | 5 | 6 | 7 };
  transporte?: FacturaTransporte;
  /** FC 46: tipo de transacción de compra. */
  tpoTranCompra?: number;
  /**
   * FC 46 (y su NC/ND): cambio de sujeto con RETENCIÓN TOTAL del IVA. El IVA se
   * declara completo pero se retiene → MntTotal = Neto (Neto+IVA−Retención) y se
   * emite ImptoReten TipoImp=15 (IVA Retenido Total). Ver SETMAIL 4897299.
   */
  retencionTotalIva?: boolean;
  /**
   * Receptor propio del caso. El inst_set_pruebas pide "RUT distintos para las
   * distintas facturas" → cada factura base usa uno del pool; las NC/ND HEREDAN
   * el receptor del documento que corrigen (consistencia de la cadena). Si se
   * omite, cae al receptor genérico del set (args.receptor).
   */
  receptor?: CertReceptor;
  /**
   * Liquidación-Factura (43): sección Comisiones y Otros Cargos (obligatoria). El IVA de
   * cada comisión afecta = round(neto × 0.19). Pueden ser negativas (ajustes de liquidación).
   */
  comisiones?: { tipoMovim: "C" | "O"; glosa: string; neto?: number; exento?: number }[];
  /**
   * Exportación (110/111/112): datos específicos. Los ítems son exentos; el receptor lleva
   * <Extranjero>; transporte.aduana lleva la sección Aduana; los recargos (flete/seguro/comisión)
   * van como <DscRcgGlobal> TpoMov=R IndExeDR=1. exento/total = MntExe/MntTotal en la moneda
   * extranjera = Σ(líneas post-descuento) + Σ(recargos), ≤4 decimales (XSD export: xs:decimal/4).
   */
  exportacion?: {
    /** String SII de la moneda (ej. "DOLAR USA", "FRANCO SZ"). Va en Totales/TpoMoneda. */
    tpoMoneda: string;
    /**
     * Exportación de SERVICIOS (110): IndServicio (formato_dte campo 9). 3 = Factura de Servicios
     * (asesorías/servicios calificados por Aduana), 4 = Servicios de Hotelería. Sólo en facturas de
     * servicio; export de bienes NO lo lleva. Se mapea al IdDoc (FacturaDteInput.indServicio).
     */
    indServicio?: number;
    /** Forma de pago exportación (FmaPagExp, tabla Aduana — ej. 32=ANTICIPO, 11=ACRED). */
    fmaPagExp?: number;
    /**
     * Fecha de cancelación (FchCancel, AAAA-MM-DD). Obligatoria en factura de exportación cuando
     * FmaPagExp indica ANTICIPO (32). Se mapea al IdDoc (tras FmaPagExp). Default = fecha de emisión.
     */
    fchCancel?: string;
    /**
     * Equivalente en otra moneda (CLP) — OBLIGATORIO en exportación (campo 129/132 formato_dte):
     * <OtraMoneda> con TpoMoneda="PESO CL" + TpoCambio + MntExeOtrMnda + MntTotOtrMnda.
     */
    otraMoneda?: FacturaOtraMoneda;
    /** Recargos globales (flete/seguro/comisión) — ValorDR ≤2 dec (Dec16_2). */
    recargos?: FacturaDscRcgGlobal[];
    /** MntExe = Σ(líneas post-descuento) + Σ(recargos exentos). */
    exento: number;
    /** MntTotal (= MntExe en exportación, todo exento). */
    total: number;
    /**
     * Referencias de aduana (además de la SET y la de NC/ND). TpoDocRef (formato_dte 2.5):
     * 807=DUS, 808=B/L, 809=AWB, 810=MIC/DTA, 811=Carta de Porte, 812=Resolución del SNA.
     * FolioRef alfanumérico (rango 800, no validado), FchRef = emisión, SIN CodRef.
     */
    referenciasAduana?: { tipoDocRef: string; folioRef: string; razonRef: string }[];
  };
};

/**
 * Totales resueltos de un caso, en pesos enteros (moneda extranjera en los casos de exportación).
 * Los campos opcionales son exclusivos de la Liquidación-Factura (43): en el resto de los tipos quedan sin definir.
 */
export type FacturaCertTotals = {
  neto: number;
  iva: number;
  exento: number;
  total: number;
  /** Liquidación-Factura (43): IVA propio (= IVA de comisiones) e IVA de terceros (IVA−IVAProp). */
  ivaProp?: number;
  ivaTerc?: number;
  /** Liquidación-Factura (43): totales de Comisiones y Otros Cargos (restados del MntTotal). */
  valComNeto?: number;
  valComExe?: number;
  valComIVA?: number;
};

/**
 * Totales de un caso de factura (precios NETOS): aplica descuento de línea y
 * descuento global a los afectos, calcula IVA sobre el neto resultante. El neto
 * resultante == sum(MontoItem−DescuentoMonto) − DscRcgGlobal (lo que valida el SII).
 */
export function computeFacturaCertTotals(
  items: FacturaCertItem[],
  descuentoGlobalPct?: number,
): FacturaCertTotals {
  let afectoNeto = 0;
  let exento = 0;
  for (const it of items) {
    if (it.sinValor) continue; // traslado interno sin valor → no aporta al total.
    const lineGross = Math.round(it.precio * it.cantidad);
    const lineDesc = it.descuentoPct ? Math.round(lineGross * it.descuentoPct / 100) : 0;
    if (it.exento) exento += lineGross - lineDesc;
    else afectoNeto += lineGross - lineDesc;
  }
  const globalDesc = descuentoGlobalPct ? Math.round(afectoNeto * descuentoGlobalPct / 100) : 0;
  const neto = afectoNeto - globalDesc;
  const iva = neto > 0 ? Math.round(neto * IVA_RATE) : 0;
  return { neto, iva, exento, total: neto + iva + exento };
}

/**
 * Totales de una Liquidación-Factura (43) — MODELO del ejemplo CERTIFICADO del SII
 * (publicado por el SII en su manual de integración), verificado byte-a-byte
 * contra sus cifras (MntNeto 234955 / IVA 44641 / IVAProp 918 / IVATerc 43723 / MntTotal 328912).
 *
 * Las líneas llevan `montoItem` EXPLÍCITO (agregados; admiten negativo: NC/ajustes dentro de la
 * liquidación). Sea netoDocs = Σ(montoItem afectos), MntExe = Σ(montoItem exentos), y las
 * Comisiones y Otros Cargos (ValComNeto/Exe/IVA, también ±). El modelo del SII es:
 *   - MntNeto = netoDocs + ValComNeto        (la comisión NETA se SUMA al neto del encabezado)
 *   - IVA     = round(MntNeto × IVA_RATE)     (IVA total del encabezado, sobre el neto agregado)
 *   - IVAProp = ValComIVA                      (IVA propio del mandatario = IVA de las comisiones)
 *   - IVATerc = IVA − IVAProp                  (IVA de los documentos de terceros liquidados)
 *   - MntTotal = MntNeto + MntExe + IVA − ValComNeto − ValComExe − ValComIVA  (formato DTE §124).
 *     La comisión se cancela ⟹ MntTotal = netoDocs + MntExe + IVA_de_los_docs.
 * IVAProp/IVATerc se emiten SIEMPRE que haya IVA (el ejemplo certificado los lleva siempre); sin
 * comisión → IVAProp=0, IVATerc=IVA.
 */
export function computeLiquidacionCertTotals(
  items: FacturaCertItem[],
  comisiones?: FacturaCertCase["comisiones"],
): FacturaCertTotals {
  let netoDocs = 0;
  let exento = 0;
  for (const it of items) {
    const monto = Math.round(it.montoItem ?? it.precio * it.cantidad);
    if (it.exento) exento += monto;
    else netoDocs += monto;
  }
  // Comisiones (pueden no existir): ValComNeto sumado al neto; ValComIVA = IVA propio.
  let valComNeto = 0, valComExe = 0, valComIVA = 0;
  for (const com of comisiones ?? []) {
    const cn = Math.round(com.neto ?? 0);
    valComNeto += cn;
    valComExe += Math.round(com.exento ?? 0);
    valComIVA += Math.round(cn * IVA_RATE);
  }
  // MntNeto = SOLO los docs afectos (NO incluye la comisión). Confirmado por el ejemplo
  // COMPLETO certificado del SII (MntNeto 234955 = solo líneas afectas, sin +ValComNeto).
  // La comisión solo aparece en <Comisiones> y se RESTA en MntTotal; su IVA es IVAProp.
  const neto = netoDocs;
  const iva = neto > 0 ? Math.round(neto * IVA_RATE) : 0;
  // IVAProp = ValComIVA; IVATerc = IVA − IVAProp (modelo del ejemplo certificado, identidad
  // IVA = IVAProp + IVATerc). Pero el formato (campos 113/114) exige IVAProp e IVATerc "< que IVA"
  // (el caso -1 pasa con IVATerc=IVA, así que el tope real es ≤). Con comisión NEGATIVA (valComIVA<0)
  // ⟹ IVATerc = IVA − valComIVA > IVA → viola el tope y repara "Encabezado No Cuadran" (set-review
  // 4903533 caso -4). IVAProp/IVATerc son OPCIONALES (oblig. 3) en el 43, así que en ese caso
  // degenerado se OMITEN (la comisión sigue informada en la sección <Comisiones>; el MntTotal no cambia).
  const splitOk = iva > 0 && valComIVA >= 0;
  const ivaProp = splitOk ? valComIVA : undefined;
  const ivaTerc = splitOk ? iva - valComIVA : undefined;
  const total = neto + exento + iva - valComNeto - valComExe - valComIVA;
  // Sin comisiones (liquidación pura): NO emitir ValCom* (la sección <Comisiones> y sus totales
  // §121-123 solo van "en caso que se apliquen", formato §F), pero SÍ emitir IVAProp/IVATerc.
  if (!comisiones || comisiones.length === 0) {
    return { neto, iva, exento, total, ivaProp, ivaTerc };
  }
  return { neto, iva, exento, total, ivaProp, ivaTerc, valComNeto, valComExe, valComIVA };
}

/**
 * Datos del emisor que se estampan en cada DTE del set. `acteco` es el código de actividad económica del SII
 * y `dirOrigen`/`cmnaOrigen` el domicilio del encabezado; en la guía de traslado interno (IndTraslado 5) estos
 * mismos datos se usan además como receptor.
 */
export type CertFacturaEmisor = {
  rut: string;
  legalName: string;
  giro: string;
  acteco: number;
  dirOrigen: string;
  cmnaOrigen: string;
  ciudadOrigen?: string;
};

/**
 * Un CAF con su rango de folios. Para resolver el CAF correcto por folio cuando un
 * tipo tiene los folios repartidos en VARIOS CAF (el SII timbra en tandas: un emisor
 * nuevo no consigue todos los folios del set en un solo CAF). Ej.: tipo 61 con CAF
 * 1-10 (3 sin usar: 8,9,10) + CAF 11-14 → un set de 7 NC abarca ambos.
 */
export type CertCafSegment = { cafXml: string; firstFolio: number; lastFolio: number };

/**
 * Entrada del mapeo del set: casos, emisor, receptor genérico, folios y CAF por tipo, fecha de emisión
 * y timestamp del TED. Los folios se asignan secuencialmente por tipo desde `firstFolioByType` siguiendo el
 * orden de `cases`, así que si cambias ese orden o filtras casos, cada caso recibe otro folio.
 */
export type BuildCertFacturaArgs = {
  cases: FacturaCertCase[];
  emisor: CertFacturaEmisor;
  /** Receptor genérico del set (fallback cuando un caso no define el suyo). */
  receptor: CertReceptor;
  /** Primer folio disponible por tipo (del CAF de cada tipo). */
  firstFolioByType: Record<number, number>;
  /** CAF XML por tipo (un solo CAF). Para varios CAF por tipo usar cafSegmentsByType. */
  cafByType: Record<number, string>;
  /**
   * CAF(s) con su rango por tipo. Si está presente para un tipo, GANA sobre
   * cafByType: cada folio se firma con el CAF cuyo rango lo contiene. Permite
   * abarcar folios repartidos en varios CAF del mismo tipo.
   */
  cafSegmentsByType?: Record<number, CertCafSegment[]>;
  fechaEmision: string;
  tstedIso: string;
  /**
   * Omite la 1ª referencia `TpoDocRef="SET"` (convención del SET DE PRUEBAS) en cada DTE.
   * - false / undefined (default): set de pruebas → cada DTE lleva la ref SET (el SII casa el caso).
   * - true: SIMULACIÓN / producción → los documentos NO pertenecen a un set, no llevan la ref SET.
   * Las referencias de NC/ND (doc corregido) y las de aduana (exportación) se mantienen igual.
   */
  omitSetReference?: boolean;
};

/**
 * Un caso ya resuelto en memoria: el XML del DTE firmado más el folio, los totales y el receptor con que quedó.
 * `signedDte` es lo que entra al sobre EnvioDTE.
 */
export type MappedCertDte = {
  caso: string;
  tipoDocumento: number;
  folio: number;
  totals: FacturaCertTotals;
  signedDte: string;
  /** Receptor resuelto del caso (propio, heredado de la ref, o el genérico). */
  receptor: CertReceptor;
};

/**
 * Mapea los casos → DTEs firmados, resolviendo folios por tipo (secuencial desde
 * firstFolioByType) y las referencias NC/ND a casos previos (por folio/tipo/fecha).
 * Devuelve los DTEs firmados + el registro folio/tipo/totales por caso.
 */
export function buildCertFacturaDtes(
  args: BuildCertFacturaArgs,
  pfxBytes: Uint8Array,
  password: string,
): MappedCertDte[] {
  const nextFolio = { ...args.firstFolioByType };
  // Registro por caso para resolver referencias NC/ND (folio/tipo + receptor, que
  // las NC/ND heredan del documento que corrigen).
  const byCaso = new Map<string, { folio: number; tipo: number; receptor: CertReceptor }>();
  const out: MappedCertDte[] = [];

  // Resuelve el CAF a usar para firmar el TED de un (tipo, folio). Si el tipo tiene
  // segmentos (varios CAF), elige el que contiene el folio; si no, usa el CAF único.
  const resolveCaf = (tipo: number, folio: number): string => {
    const segs = args.cafSegmentsByType?.[tipo];
    if (segs && segs.length > 0) {
      const seg = segs.find((s) => folio >= s.firstFolio && folio <= s.lastFolio);
      if (!seg) {
        throw new Error(
          `cert-factura: folio ${folio} (tipo ${tipo}) no cae en ningún CAF cargado ` +
            `(rangos: ${segs.map((s) => `${s.firstFolio}-${s.lastFolio}`).join(", ")})`,
        );
      }
      return seg.cafXml;
    }
    const single = args.cafByType[tipo];
    if (!single) throw new Error(`cert-factura: sin CAF para tipo ${tipo}`);
    return single;
  };

  for (const c of args.cases) {
    const tipo = c.tipoDocumento;
    const folio = nextFolio[tipo];
    if (folio === undefined) throw new Error(`cert-factura: sin folio para tipo ${tipo} (caso ${c.caso})`);
    nextFolio[tipo] = folio + 1;

    // Ítems: NC "corrige texto" (sin items) lleva una línea con monto 0.
    const items: FacturaCertItem[] = c.items && c.items.length > 0
      ? c.items
      : [{ nombre: c.ref?.razon ?? "Referencia", cantidad: 1, precio: 0 }];
    // Liquidación-Factura (43): totales con Comisiones (restadas del MntTotal). Exportación
    // (110/111/112): MntExe/MntTotal explícitos del caso (líneas + recargos, en moneda extranjera).
    const isExport = tipo === 110 || tipo === 111 || tipo === 112;
    const totals: FacturaCertTotals = tipo === 43
      ? computeLiquidacionCertTotals(items, c.comisiones)
      : isExport && c.exportacion
      ? { neto: 0, iva: 0, exento: c.exportacion.exento, total: c.exportacion.total }
      : computeFacturaCertTotals(items, c.descuentoGlobalPct);
    const isExenta = tipo === 34 || isExport || (items.every((it) => it.exento) && totals.neto === 0);

    // Referencias: (1) SET (set de pruebas) — se OMITE en simulación/producción (omitSetReference);
    // (2) doc corregido si es NC/ND; (3) refs de aduana en exportación.
    const referencias: FacturaDteReferencia[] = args.omitSetReference
      ? []
      : [
        { tipoDocRef: "SET", folioRef: c.nroCaso, fchRef: args.fechaEmision, razonRef: `CASO ${c.caso}` },
      ];
    if (c.ref) {
      const refDoc = byCaso.get(c.ref.caso);
      if (!refDoc) throw new Error(`cert-factura: caso ${c.caso} referencia ${c.ref.caso} no emitido aún`);
      referencias.push({
        tipoDocRef: String(refDoc.tipo),
        folioRef: refDoc.folio,
        fchRef: args.fechaEmision,
        codRef: c.ref.codRef,
        razonRef: c.ref.razon,
      });
    }
    // Exportación: referencias de aduana (DUS 807 / B-L 808 / AWB 809 / MIC-DTA 810 / Resolución SNA 812)
    // SIN CodRef. ⚠️ El cross-ref sugería CodRef=0 (el ejemplo certificado), pero el XSD REAL del SII
    // (DTE_v10.xsd: <CodRef> = xs:positiveInteger restringido a {1,2,3}) RECHAZA el 0 — verificado
    // con xmllint (HED). CodRef es minOccurs=0 → se OMITE en las refs de aduana (XSD-válido).
    for (const ra of c.exportacion?.referenciasAduana ?? []) {
      referencias.push({ tipoDocRef: ra.tipoDocRef, folioRef: ra.folioRef, fchRef: args.fechaEmision, razonRef: ra.razonRef });
    }

    // Receptor del caso:
    //  - Guía de traslado interno (IndTraslado=5): DEBE ser el emisor
    //    (inst_set_pruebas.pdf, set 4897296-1); el ejemplar cedible es inoficioso.
    //  - NC/ND: HEREDA el receptor del documento que corrige (cadena consistente).
    //  - Factura base: el receptor propio del caso, o el genérico del set.
    let receptor: CertReceptor;
    if (c.despacho?.indTraslado === 5) {
      receptor = {
        rut: args.emisor.rut,
        razonSocial: args.emisor.legalName,
        giro: args.emisor.giro,
        dirRecep: args.emisor.dirOrigen,
        cmnaRecep: args.emisor.cmnaOrigen,
      };
    } else if (c.receptor) {
      receptor = c.receptor;
    } else if (c.ref) {
      receptor = byCaso.get(c.ref.caso)?.receptor ?? args.receptor;
    } else {
      receptor = args.receptor;
    }

    const input: FacturaDteInput = {
      tipoDte: tipo,
      folio,
      fechaEmision: args.fechaEmision,
      // Liquidación-Factura (43): FmaPago es obligatorio (formato_dte L85; default 2 = crédito).
      formaPago: tipo === 43 ? 2 : undefined,
      despacho: c.despacho,
      transporte: c.transporte,
      // Exportación de servicios: IndServicio (3=servicios, 4=hotelería) en el IdDoc. Sólo en
      // facturas de servicio (4903532-1 asesorías, 4903532-3 alojamiento); export de bienes no lo lleva.
      indServicio: c.exportacion?.indServicio,
      fmaPagExp: c.exportacion?.fmaPagExp,
      // FchCancel: obligatorio en export con FmaPagExp=ANTICIPO (32) — campo 15. Explícito del caso, o
      // por defecto la fecha de emisión (≤ FchEmis). Sin anticipo NO se emite.
      fchCancel: c.exportacion?.fmaPagExp === 32
        ? (c.exportacion?.fchCancel ?? args.fechaEmision)
        : c.exportacion?.fchCancel,
      tpoTranCompra: c.tpoTranCompra,
      emisor: {
        rut: args.emisor.rut,
        razonSocial: args.emisor.legalName,
        giro: args.emisor.giro,
        acteco: args.emisor.acteco,
        dirOrigen: args.emisor.dirOrigen,
        cmnaOrigen: args.emisor.cmnaOrigen,
        ciudadOrigen: args.emisor.ciudadOrigen,
      },
      receptor,
      items: items.map((it) => {
        const fcReten = !!c.retencionTotalIva && !it.exento && !it.sinValor; // línea afecta del FC 46/NC/ND retención
        return {
          nombre: it.nombre,
          cantidad: it.cantidad,
          precio: it.precio,
          descripcion: it.descripcion,
          // Guía de traslado interno (IndTraslado=5): línea SIN valor → QtyItem + UnmdItem +
          // MontoItem=0, sin PrcItem ni IndExe (el traslado interno no constituye venta).
          sinValor: it.sinValor,
          exento: it.exento,
          // FC 46 retención total. Estructura del ejemplo oficial del SII (formato_retenedores.pdf +
          // 4 XML de ejemplo, docs/ejemplos-xml-sii/): línea con <Retenedor><IndAgente>R</IndAgente>
          // (marca al emisor como AGENTE RETENEDOR) + CodImpAdic=15; header ImptoReten {15,19,IVA} +
          // MntTotal=Neto. ⚠️ PROBADO VIVO 2026-06-16 (envío 251886524): ESA estructura exacta (= el
          // ejemplo oficial) AÚN da HED-2-302 "[15] Monto [0]<>[IVA]" en el cert → el validador del SII
          // computa el CodImpAdic=15 de la LÍNEA como [0] y choca con el IVA de ImptoReten.
          // VARIANTE (FC46_NO_CODIMPADIC=1) — ❌ PROBADA Y PEOR (envío 251886924, 2026-06-16): sacar el
          // CodImpAdic de la línea NO levanta el HED-2-302 (sigue) y AGREGA un HED-2-300 "Total
          // Impuesto/Retencion No Cuadra con Detalle". CONCLUSIÓN: el HED-2-302 viene del ImptoReten de
          // los TOTALES (el SII espera MontoImp=[0] para el código 15), NO de la línea. El CodImpAdic=15
          // en la línea es necesario para conciliar (evitar HED-2-300). Default (toggle OFF) = estructura
          // oficial del SII. El toggle se deja documentado; NO usar (es peor).
          // ⚠️ ACTUALIZACIÓN 2026-06-16 (búsqueda exhaustiva): el "catch-22" era PREMATURO. Las 7
          // pruebas NUNCA emitieron el <CdgItem>CPCS (ancla la línea para que el campo 117 la cuente),
          // y el código debe ser de PRODUCTO (ej. 481/CPCS=4803 del ejemplo NDF certificado, o 39/3900
          // PPA), NO el agregado 15 (que da Σ=[0]). Configurable: FC46_RETEN_CODE + FC46_CPCS.
          codImpAdic: (fcReten && denoEnv?.get("FC46_NO_CODIMPADIC") !== "1") ? CERT_RETEN_CODE : undefined,
          indAgente: fcReten || undefined, // agente retenedor (R): gatilla <Retenedor> en la línea
          cpcs: fcReten ? CERT_RETEN_CPCS : undefined, // CPCS: ancla la línea como base de retención (campo 117)
          // INT1 + UnmdItem: réplica fiel del ejemplo NDF certificado, SOLO con CPCS (= el test de
          // cambio de sujeto). Sin CPCS (default código 15) el FC 46 no los lleva (estructura mínima).
          codigo: (fcReten && CERT_RETEN_CPCS) ? { tipo: "INT1", valor: it.nombre.replace(/\s+/g, "").slice(0, 20) } : undefined,
          unidadMedida: (fcReten && CERT_RETEN_CPCS) ? (it.unidadMedida ?? "UN") : it.unidadMedida,
          descuentoPct: it.descuentoPct,
          recargoPct: it.recargoPct, // export 4903532-1: %10 recargo en la línea de item
          // Liquidación-Factura (43): MontoItem total explícito (agregado, puede ser negativo) + TpoDocLiq.
          montoItem: it.montoItem,
          tpoDocLiq: it.tpoDocLiq,
        };
      }),
      totals: {
        neto: totals.neto,
        iva: totals.iva,
        exento: totals.exento,
        // FC 46 retención total (estructura el oráculo de calibración): la retención es COMPLETA → ImptoReten
        // MontoImp=IVA, y el IVA retenido NO se cobra → MntTotal = Neto (+ Exe). HED-2-260:
        // MntTotal = MntNeto + MntExe + IVA − Retención(IVA) = Neto + Exe.
        total: c.retencionTotalIva ? totals.neto + totals.exento : totals.total,
        tasaIva: 19,
        ...(c.retencionTotalIva
          ? { impuestosReten: [{ tipo: CERT_RETEN_CODE, tasa: CERT_RETEN_TASA, monto: totals.iva }] } // {TipoImp:15, TasaImp:19, MontoImp:IVA}
          : {}),
        // Liquidación-Factura (43): IVA propio/terceros (tras IVA, antes de Comisiones).
        ...(totals.ivaProp !== undefined ? { ivaProp: totals.ivaProp } : {}),
        ...(totals.ivaTerc !== undefined ? { ivaTerc: totals.ivaTerc } : {}),
        // Liquidación-Factura (43): totales de Comisiones y Otros Cargos (restados del MntTotal).
        ...(totals.valComNeto !== undefined ? { valComNeto: totals.valComNeto } : {}),
        ...(totals.valComExe !== undefined ? { valComExe: totals.valComExe } : {}),
        ...(totals.valComIVA !== undefined ? { valComIVA: totals.valComIVA } : {}),
        // Exportación (110/111/112): TpoMoneda (moneda extranjera) en Totales + OtraMoneda (CLP) opcional.
        ...(c.exportacion ? { tpoMoneda: c.exportacion.tpoMoneda } : {}),
        ...(c.exportacion?.otraMoneda ? { otraMoneda: c.exportacion.otraMoneda } : {}),
      },
      // Liquidación-Factura (43): sección <Comisiones> (IVA de comisión afecta = round(neto×0.19)).
      comisiones: c.comisiones?.map((com) => ({
        tipoMovim: com.tipoMovim,
        glosa: com.glosa,
        ...(com.neto !== undefined ? { valComNeto: com.neto, valComIVA: Math.round(com.neto * IVA_RATE) } : {}),
        ...(com.exento !== undefined ? { valComExe: com.exento } : {}),
      })),
      // Exportación: recargos globales (flete/seguro/comisión). Estándar: descuento global %.
      descuentosGlobales: c.exportacion?.recargos ??
        (c.descuentoGlobalPct ? [{ tipo: "D", valorTipo: "%", valor: c.descuentoGlobalPct }] : undefined),
      referencias,
      cafXml: resolveCaf(tipo, folio),
      tstedIso: args.tstedIso,
      tmstFirma: args.tstedIso,
      documentId: `F${folio}T${tipo}`,
    };
    // Documento exento sin neto: vacía neto/iva (factura-dte ya omite por >0). Preserva
    // tpoMoneda/otraMoneda del input (exportación: el spread mantiene la moneda extranjera).
    if (isExenta) {
      input.totals = { ...input.totals, neto: 0, iva: 0, exento: totals.exento || totals.total, total: totals.total };
    }

    const signedDte = buildSignedFacturaDte(input, pfxBytes, password);
    byCaso.set(c.caso, { folio, tipo, receptor });
    out.push({ caso: c.caso, tipoDocumento: tipo, folio, totals, signedDte, receptor });
  }
  return out;
}

// ============================================================================
// MUESTRAS IMPRESAS (etapa 4 cert — WS-8). Mapea cada caso del set a un modelo
// imprimible (sin tocar emisor/receptor, que el edge fn pone desde la BD) + el
// TED extraído del DTE firmado, reusando la MISMA resolución de folios/refs que
// la emisión → la muestra calza con lo emitido. El render lo hace el worker
// (apps/hermes-pdf-worker, /pdf/factura) conforme al Manual de Muestras Impresas.
// ============================================================================

/** Traslados que constituyen venta → la guía lleva ejemplar cedible (manual §1.4). */
const GUIA_TRASLADO_VENTA = new Set([1, 9]);

/**
 * Línea del modelo imprimible de una muestra. En la Liquidación-Factura (43) la línea es un agregado sin precio
 * unitario: el total va en `valor` y admite monto negativo.
 */
export type MuestraItem = {
  codigo?: string;
  nombre: string;
  cantidad: number;
  unidad?: string;
  precio: number;
  exento?: boolean;
  descuentoPct?: number;
  /** Recargo por línea en % (export 4903532-1): se imprime en la muestra junto a la línea. */
  recargoPct?: number;
  /** Liquidación-Factura (43): total de la línea (MontoItem agregado, sin precio unitario; admite negativo). */
  valor?: number;
};

/**
 * Referencia tal como se imprime en la muestra. `tipoDocRef` es "SET" en la referencia al set de pruebas y el
 * código numérico del tipo en la del documento corregido; `codRef` (1 anula, 2 corrige texto, 3 corrige monto)
 * sólo aparece en esa segunda referencia.
 */
export type MuestraReferencia = {
  tipoDocRef: string;
  /** Folio referenciado. Las referencias de ADUANA lo traen alfanumérico (rango 800). */
  folioRef: number | string;
  fchRef: string;
  codRef?: number;
  razonRef?: string;
};

/** Lo que el worker /pdf/factura necesita por documento (emisor/receptor los agrega el edge fn). */
export type FacturaMuestraPrint = {
  tipoDte: number;
  folio: number;
  fechaEmision: string;
  items: MuestraItem[];
  totales: {
    neto: number; exento: number; iva: number; tasaIva: number; descuentoGlobal?: number; total: number;
    /** Exportación: moneda extranjera del documento (TpoMoneda, ej. "DOLAR USA") + equivalente CLP (MntTotOtrMnda). */
    tpoMoneda?: string;
    otraMoneda?: number;
    /** Liquidación-Factura (43): comisiones del mandatario (se RESTAN del total) + IVA propio/terceros. */
    valComNeto?: number; valComExe?: number; valComIVA?: number; ivaProp?: number; ivaTerc?: number;
  };
  referencias: MuestraReferencia[];
  /** Receptor resuelto del caso (propio / heredado de la ref / genérico; emisor si traslado interno). */
  receptor: CertReceptor;
  /** Guía de traslado interno (IndTraslado 5): el receptor debe ser el emisor. */
  receptorEsEmisor: boolean;
  /** Guía 52: tipo de traslado (IndTraslado, tabla 1–9). */
  despacho?: { tipoTraslado: number };
  tedXml: string;
};

/**
 * Una muestra impresa resuelta: el caso con su folio y el modelo que consume el render.
 * `cedible` dice si corresponde imprimir el ejemplar cedible: 33, 34, 43 y 46 siempre; la guía 52 sólo
 * cuando el traslado constituye venta; el resto de los tipos nunca.
 */
export type FacturaMuestra = {
  caso: string;
  tipoDocumento: number;
  folio: number;
  /** ¿Corresponde ejemplar cedible? 33/34/43/46 sí; 52 solo si el traslado es venta; el resto nunca. */
  cedible: boolean;
  print: FacturaMuestraPrint;
};

const TED_RE = /<TED[\s\S]*?<\/TED>/;

/**
 * Mapea los casos del set → muestras imprimibles. Firma los DTEs (deterministas:
 * mismos folios que la emisión con los mismos CAF/firstFolio), extrae el TED de
 * cada uno y arma el modelo de impresión + las referencias resueltas (SET + doc
 * corregido) idénticas a las del DTE emitido.
 *
 * ⚠️ EL MODELO NO LLEVA `plataforma`, Y ESO AHORA IMPORTA. Hasta el 08-sep-2026 el
 * render caía a `plataforma = "ComunidadRural"` y las muestras salían con el logo y
 * la línea legal de la plataforma — que es la representación que el SII AUTORIZÓ.
 * Ese default se quitó (el motor es open source y no puede imprimir marca ajena en
 * el documento de un tercero), así que hoy estas muestras saldrían SIN esa marca.
 *
 * Este builder no tiene llamador desde que se borró `dte-factura-cert-emit-set`
 * (2026-07-19). Cuando aparezca el próximo —al certificar un tipo nuevo o
 * re-certificar— tiene que pasar `plataforma` con el nombre de la plataforma del
 * emisor para replicar lo autorizado. Ver DTE_CERT_APRENDIZAJES.md §7.
 */
export function buildCertFacturaMuestras(
  args: BuildCertFacturaArgs,
  pfxBytes: Uint8Array,
  password: string,
): FacturaMuestra[] {
  const dtes = buildCertFacturaDtes(args, pfxBytes, password);
  const byCaso = new Map(dtes.map((d) => [d.caso, { folio: d.folio, tipo: d.tipoDocumento }]));
  const out: FacturaMuestra[] = [];

  for (const c of args.cases) {
    const d = dtes.find((x) => x.caso === c.caso);
    if (!d) throw new Error(`buildCertFacturaMuestras: caso ${c.caso} sin DTE`);
    const tedRaw = d.signedDte.match(TED_RE)?.[0];
    if (!tedRaw) throw new Error(`buildCertFacturaMuestras: TED no encontrado en ${c.caso}`);
    // El timbre PDF417 codifica el TED VERBATIM (latin1, byte a byte). El FRMA (CAF) y el FRMT
    // (timbre) se firmaron sobre el DA/DD COMPACTO (compactSiiDd); pero signDte pretty-printea el
    // DTE, así que el TED extraído del DTE firmado trae saltos de línea entre tags. Hay que
    // RE-COMPACTARLO (quitar whitespace ENTRE tags) para que el barcode lleve los bytes exactos que
    // se firmaron — si no, el SII re-hashea un DD/DA con whitespace y da "TED - Firma invalida" +
    // "alteracion en el CAF" en las Muestras Impresas (el envío XML pasa igual porque canonicaliza).
    // El contenido de los tags (RznSoc con espacios, base64) NO se toca: `>\s+<` solo matchea bordes.
    const ted = tedRaw.replace(/>\s+</g, "><").trim();

    const items: MuestraItem[] = (c.items && c.items.length > 0
      ? c.items
      : [{ nombre: c.ref?.razon ?? "Referencia", cantidad: 1, precio: 0 }]
    ).map((it) => ({
      nombre: it.nombre,
      cantidad: it.cantidad,
      precio: it.precio,
      exento: it.exento,
      unidad: it.unidadMedida,
      descuentoPct: it.descuentoPct,
      recargoPct: it.recargoPct,
      // Liquidación-Factura (43): la línea es un agregado con MontoItem explícito (sin precio
      // unitario) → mandamos el total de línea como `valor` para que la muestra lo imprima.
      ...(it.montoItem !== undefined ? { valor: it.montoItem } : {}),
    }));

    // Descuento global (monto) para mostrar en Totales: % sobre los afectos
    // (post descuento de línea) — debe casar con neto = afecto − globalDesc.
    let descuentoGlobal = 0;
    if (c.descuentoGlobalPct) {
      let afecto = 0;
      for (const it of c.items ?? []) {
        if (it.exento) continue;
        const gross = Math.round(it.precio * it.cantidad);
        const lineDsc = it.descuentoPct ? Math.round(gross * it.descuentoPct / 100) : 0;
        afecto += gross - lineDsc;
      }
      descuentoGlobal = Math.round(afecto * c.descuentoGlobalPct / 100);
    }

    // Ref SET: solo en el set de pruebas; en simulación/producción se omite (= buildCertFacturaDtes).
    const referencias: MuestraReferencia[] = args.omitSetReference
      ? []
      : [
        { tipoDocRef: "SET", folioRef: c.nroCaso, fchRef: args.fechaEmision, razonRef: `CASO ${c.caso}` },
      ];
    if (c.ref) {
      const r = byCaso.get(c.ref.caso);
      if (r) {
        referencias.push({
          tipoDocRef: String(r.tipo),
          folioRef: r.folio,
          fchRef: args.fechaEmision,
          codRef: c.ref.codRef,
          razonRef: c.ref.razon,
        });
      }
    }
    // Referencias de ADUANA (exportación 110/111/112), igual que en el DTE emitido.
    // Faltaban: la muestra impresa salía con MENOS referencias que el documento que
    // acompaña, y el SII compara justamente eso — es el reparo "El Documento Debe
    // Tener 2 Linea(s) de Referencia". Sin CodRef, como en buildCertFacturaDtes.
    for (const ra of c.exportacion?.referenciasAduana ?? []) {
      referencias.push({
        tipoDocRef: ra.tipoDocRef,
        folioRef: ra.folioRef,
        fchRef: args.fechaEmision,
        razonRef: ra.razonRef,
      });
    }

    const tipo = c.tipoDocumento;
    const cedible = tipo === 33 || tipo === 34 || tipo === 46 || tipo === 43 ||
      (tipo === 52 && GUIA_TRASLADO_VENTA.has(Number(c.despacho?.indTraslado)));

    out.push({
      caso: c.caso,
      tipoDocumento: tipo,
      folio: d.folio,
      cedible,
      print: {
        tipoDte: tipo,
        folio: d.folio,
        fechaEmision: args.fechaEmision,
        items,
        totales: {
          neto: d.totals.neto,
          exento: d.totals.exento,
          iva: d.totals.iva,
          tasaIva: 19,
          descuentoGlobal: descuentoGlobal || undefined,
          total: d.totals.total,
          // Exportación: moneda extranjera + equivalente CLP (para el render de la muestra).
          ...(c.exportacion ? { tpoMoneda: c.exportacion.tpoMoneda, otraMoneda: c.exportacion.otraMoneda?.mntTotOtrMnda } : {}),
          // Liquidación-Factura (43): comisiones (se restan del total) + IVA propio/terceros.
          ...(d.totals.valComNeto !== undefined ? { valComNeto: d.totals.valComNeto } : {}),
          ...(d.totals.valComExe !== undefined ? { valComExe: d.totals.valComExe } : {}),
          ...(d.totals.valComIVA !== undefined ? { valComIVA: d.totals.valComIVA } : {}),
          ...(d.totals.ivaProp !== undefined ? { ivaProp: d.totals.ivaProp } : {}),
          ...(d.totals.ivaTerc !== undefined ? { ivaTerc: d.totals.ivaTerc } : {}),
        },
        referencias,
        receptor: d.receptor,
        receptorEsEmisor: c.despacho?.indTraslado === 5,
        despacho: c.despacho ? { tipoTraslado: c.despacho.indTraslado } : undefined,
        tedXml: ted,
      },
    });
  }
  return out;
}

/**
 * Argumentos del envío del set: lo del mapeo más la carátula y el id del sobre EnvioDTE, y el canal legacy.
 * `rutReceptorSii` cae al RUT del SII (60803000-K) y `env` a "cert"; si no pasas `token` se pide uno nuevo por SOAP.
 */
export type EmitCertSetFacturaArgs = BuildCertFacturaArgs & {
  rutEnvia: string;
  rutReceptorSii?: string;
  fchResol: string;
  nroResol: number;
  tmstFirmaEnv: string;
  setId: string;
  env?: LegacyEnv;
  /** Token SOAP legacy ya obtenido (evita un round-trip extra; se comparte con los libros). */
  token?: string;
  fetchFn?: typeof fetch;
};

/**
 * Resultado del envío del sobre. `trackId` es el número de seguimiento del upload, NO aceptación: el veredicto
 * del set llega en el SETMAIL del "Declarar Avance". Si el SII rechaza, `trackId` viene en null y `status` trae
 * el código, pero el motivo en palabras no se propaga acá — hay que buscarlo dentro de `raw`; `dedup` marca que
 * el SII reconoció un archivo idéntico ya enviado y devolvió el track anterior.
 */
export type EmitCertSetFacturaResult = {
  trackId: string | null;
  status: number | null;
  dedup: boolean;
  sobreXml: string;
  dtes: MappedCertDte[];
  raw: string;
};

/**
 * Emite el set de factura: arma los DTEs, el sobre EnvioDTE y lo sube por el canal
 * legacy (token SOAP → DTEUpload). El SII registra los documentos; luego el caller
 * (o el founder en Maullín) hace "Declarar Avance" con los N° de atención.
 */
export async function emitCertSetFacturaViaRuralDte(
  args: EmitCertSetFacturaArgs,
  pfxBytes: Uint8Array,
  password: string,
): Promise<EmitCertSetFacturaResult> {
  if (args.cases.length === 0) throw new Error("emitCertSetFacturaViaRuralDte: cases vacío");
  const env: LegacyEnv = args.env ?? "cert";

  const dtes = buildCertFacturaDtes(args, pfxBytes, password);
  const sobre = buildEnvioDte({
    setId: args.setId,
    signedDtes: dtes.map((d) => d.signedDte),
    caratula: {
      rutEmisor: args.emisor.rut,
      rutEnvia: args.rutEnvia,
      rutReceptor: args.rutReceptorSii ?? "60803000-K",
      fchResol: args.fchResol,
      nroResol: args.nroResol,
      tmstFirmaEnv: args.tmstFirmaEnv,
    },
    pfxBytes,
    password,
  });

  const token = args.token ??
    await getLegacyToken(env, pfxBytes, password, {
      userAgent: LEGACY_USER_AGENT,
      fetchFn: args.fetchFn,
    });
  const result = await legacyUpload(env, {
    xmlBytes: sobre.bytes,
    token,
    rutSender: args.rutEnvia,
    rutCompany: args.emisor.rut,
    fileName: "set-factura.xml",
    userAgent: LEGACY_USER_AGENT,
    fetchFn: args.fetchFn,
  });

  return {
    trackId: result.trackId,
    status: result.status,
    dedup: result.dedup,
    sobreXml: sobre.xml,
    dtes,
    raw: result.raw,
  };
}

// ============================================================================
// DEFAULT del SET DE PRUEBAS factura (4897293/96/98/99) — editable en la consola.
// ============================================================================
//
// Montos del set SII (inst_set_pruebas.pdf / SIISetDePruebas784166260.txt). Algunos
// casos terse (NC/ND sin cantidad explícita, guía de traslado interno sin precio) se
// interpretan acá con el criterio más común y se AJUSTAN contra la revisión del set.
// Reglas aplicadas:
//   - NC "corrige texto/giro" (CodRef 2) → sin ítems (línea monto 0).
//   - NC/ND "modifica monto/devolución" (CodRef 3) → ítems con el monto indicado.
//   - NC/ND "anula" (CodRef 1) → replica los ítems del documento anulado (mismo total);
//     si el documento anulado era monto 0 (corrige-texto), la anulación queda en 0.
//   - Guía traslado interno (IndTraslado 5) → receptor=emisor (buildCertFacturaDtes).

/** Receptor genérico del set (editable). Para guía de traslado interno se ignora (usa el emisor). */
export const DEFAULT_FACTURA_CERT_RECEPTOR = {
  rut: "55555555-5",
  razonSocial: "CLIENTE DE PRUEBA SET SII",
  giro: "Comercio al por menor",
  dirRecep: "Av. Siempre Viva 742",
  cmnaRecep: "Santiago",
} as const;

/**
 * Pool de receptores DISTINTOS para las facturas base del set (inst_set_pruebas:
 * "Utilice RUT distintos para las distintas facturas"). RUTs con dígito verificador
 * válido. Las NC/ND heredan el receptor de la factura que corrigen (cadena), y la
 * guía de traslado interno usa el emisor → no consumen del pool.
 */
export const FACTURA_CERT_RECEPTORES: CertReceptor[] = [
  { rut: "66666666-6", razonSocial: "COMERCIAL LOS ANDES LIMITADA", giro: "Venta al por mayor de abarrotes", dirRecep: "Av. Libertador 1234", cmnaRecep: "Providencia" },
  { rut: "77777777-7", razonSocial: "DISTRIBUIDORA DEL SUR SPA", giro: "Distribución de mercaderías", dirRecep: "Camino Real 567", cmnaRecep: "Temuco" },
  { rut: "88888888-8", razonSocial: "SERVICIOS AGRICOLAS EL ROBLE EIRL", giro: "Servicios agrícolas y forestales", dirRecep: "Parcela 12 Los Maitenes", cmnaRecep: "Rancagua" },
  { ...DEFAULT_FACTURA_CERT_RECEPTOR },
];

/** Receptor para la Factura de Compra (46): el emisor es el COMPRADOR, el receptor es el proveedor/vendedor. */
const FACTURA_CERT_RECEPTOR_PROVEEDOR: CertReceptor = {
  rut: "99999999-9",
  razonSocial: "PROVEEDOR INSUMOS RURALES LIMITADA",
  giro: "Venta de insumos agrícolas",
  dirRecep: "Ruta 5 Sur Km 120",
  cmnaRecep: "Talca",
};

/**
 * Asigna receptores distintos a las facturas BASE (sin ref, no traslado interno),
 * ciclando el pool; FC 46 → proveedor. Las NC/ND no reciben (heredan en build).
 */
export function assignCertReceptores(cases: FacturaCertCase[]): FacturaCertCase[] {
  let i = 0;
  return cases.map((c) => {
    if (c.ref || c.despacho?.indTraslado === 5 || c.receptor) return c;
    const receptor = c.tipoDocumento === 46
      ? FACTURA_CERT_RECEPTOR_PROVEEDOR
      : FACTURA_CERT_RECEPTORES[i++ % FACTURA_CERT_RECEPTORES.length];
    return { ...c, receptor };
  });
}

/**
 * N° de atención de cada sub-set (RazonRef "CASO <atención>-<n>" + "Declarar Avance" en Maullín).
 *
 * SET NUEVO 2026-06-18 (SIISetDePruebas784166260.txt, tercer set): básico 4907369, libro ventas
 * 4907371, libro compras 4907372, guía 4907373, libro guías 4907374, exenta 4907375, EXPORTACIÓN
 * 4907376 (export1: 110/112/111) + 4907377 (export2: 110×3). Este set NO trae liquidación 43 ni
 * emisión de FC 46 (la 46 sólo aparece como folio 9 del libro de compras, no se emite) — queda
 * 100% dentro del alcance decidido (familia factura + libros + exportación).
 */
export const SET_ATENCION = {
  basico: "4907369",
  libroVentas: "4907371",
  libroCompras: "4907372",
  guia: "4907373",
  libroGuias: "4907374",
  exenta: "4907375",
  export1: "4907376", // Exportación (1): 110 factura export + 112 NC export + 111 ND export
  export2: "4907377", // Exportación (2): 110 × 3 (servicios YEN / mercaderías YEN / alojamiento USD)
  // FC 46 (factura compra SIMPLE, sin retención): set vigente 4917063 (2026-06-23). El caso es una
  // factura de compra normal — NO cambio de sujeto. Se emite como DTE (FC46_CERT_CASES) en sobre aparte.
  facturaCompra: "4917063",
} as const;

const RAW_FACTURA_CERT_CASES: FacturaCertCase[] = [
  // ── SET BÁSICO 4907369 — factura afecta 33 / NC 61 / ND 56 (set nuevo 2026-06-18) ──
  {
    caso: "4907369-1", nroCaso: 1, tipoDocumento: 33,
    items: [
      { nombre: "Cajón AFECTO", cantidad: 126, precio: 1078 },
      { nombre: "Relleno AFECTO", cantidad: 54, precio: 1736 },
    ],
  },
  {
    caso: "4907369-2", nroCaso: 2, tipoDocumento: 33,
    items: [
      { nombre: "Pañuelo AFECTO", cantidad: 267, precio: 2165, descuentoPct: 4 },
      { nombre: "ITEM 2 AFECTO", cantidad: 194, precio: 1228, descuentoPct: 6 },
    ],
  },
  {
    caso: "4907369-3", nroCaso: 3, tipoDocumento: 33,
    items: [
      { nombre: "Pintura B&W AFECTO", cantidad: 25, precio: 2268 },
      { nombre: "ITEM 2 AFECTO", cantidad: 154, precio: 3014 },
      { nombre: "ITEM 3 SERVICIO EXENTO", cantidad: 1, precio: 34740, exento: true },
    ],
  },
  {
    caso: "4907369-4", nroCaso: 4, tipoDocumento: 33,
    descuentoGlobalPct: 7,
    items: [
      { nombre: "ITEM 1 AFECTO", cantidad: 101, precio: 1929 },
      { nombre: "ITEM 2 AFECTO", cantidad: 43, precio: 1756 },
      { nombre: "ITEM 3 SERVICIO EXENTO", cantidad: 2, precio: 6771, exento: true },
    ],
  },
  {
    caso: "4907369-5", nroCaso: 5, tipoDocumento: 61,
    ref: { caso: "4907369-1", codRef: 2, razon: "CORRIGE GIRO DEL RECEPTOR" },
  },
  {
    // Devolución parcial de la factura caso 2 → REPLICA sus descuentos de línea (4% y 6%): el
    // precio unitario es el de la factura original y el valor devuelto es el neto post-descuento.
    caso: "4907369-6", nroCaso: 6, tipoDocumento: 61,
    ref: { caso: "4907369-2", codRef: 3, razon: "DEVOLUCION DE MERCADERIAS" },
    items: [
      { nombre: "Pañuelo AFECTO", cantidad: 98, precio: 2165, descuentoPct: 4 },
      { nombre: "ITEM 2 AFECTO", cantidad: 131, precio: 1228, descuentoPct: 6 },
    ],
  },
  {
    // Anula la factura del caso 3 → replica sus ítems (mismo total, incl. exento).
    caso: "4907369-7", nroCaso: 7, tipoDocumento: 61,
    ref: { caso: "4907369-3", codRef: 1, razon: "ANULA FACTURA" },
    items: [
      { nombre: "Pintura B&W AFECTO", cantidad: 25, precio: 2268 },
      { nombre: "ITEM 2 AFECTO", cantidad: 154, precio: 3014 },
      { nombre: "ITEM 3 SERVICIO EXENTO", cantidad: 1, precio: 34740, exento: true },
    ],
  },
  {
    // ND que anula la NC del caso 5 (corrige-giro, monto 0) → monto 0.
    caso: "4907369-8", nroCaso: 8, tipoDocumento: 56,
    ref: { caso: "4907369-5", codRef: 1, razon: "ANULA NOTA DE CREDITO ELECTRONICA" },
  },

  // ── SET FACTURA EXENTA 4907375 — factura exenta 34 / NC 61 / ND 56 (set nuevo 2026-06-18) ──
  {
    caso: "4907375-1", nroCaso: 1, tipoDocumento: 34,
    items: [{ nombre: "HORAS PROGRAMADOR", cantidad: 11, precio: 6348, exento: true, unidadMedida: "Hora" }],
  },
  {
    // Modifica monto de la exenta caso 1: revalora las 11 horas a 794 c/u (el set sólo da valor unitario).
    caso: "4907375-2", nroCaso: 2, tipoDocumento: 61,
    ref: { caso: "4907375-1", codRef: 3, razon: "MODIFICA MONTO" },
    items: [{ nombre: "HORAS PROGRAMADOR", cantidad: 11, precio: 794, exento: true, unidadMedida: "Hora" }],
  },
  {
    caso: "4907375-3", nroCaso: 3, tipoDocumento: 34,
    items: [
      { nombre: "SERV CONSULTORIA FACT ELECTRONICA", cantidad: 1, precio: 334182, exento: true },
      { nombre: "SERV CONSULTORIA GUIA DESPACHO ELECT", cantidad: 1, precio: 252450, exento: true },
    ],
  },
  {
    caso: "4907375-4", nroCaso: 4, tipoDocumento: 61,
    ref: { caso: "4907375-3", codRef: 2, razon: "CORRIGE GIRO" },
  },
  {
    caso: "4907375-5", nroCaso: 5, tipoDocumento: 56,
    ref: { caso: "4907375-4", codRef: 1, razon: "ANULA NOTA DE CREDITO ELECTRONICA" },
  },
  {
    caso: "4907375-6", nroCaso: 6, tipoDocumento: 34,
    items: [
      { nombre: "CAPACITACION USO CIGUEÑALES", cantidad: 1, precio: 339183, exento: true },
      { nombre: "CAPACITACION USO PLC's CNC", cantidad: 1, precio: 229730, exento: true },
    ],
  },
  {
    caso: "4907375-7", nroCaso: 7, tipoDocumento: 61,
    ref: { caso: "4907375-6", codRef: 3, razon: "MODIFICA MONTO" },
    items: [{ nombre: "CAPACITACION USO CIGUEÑALES", cantidad: 1, precio: 169591, exento: true }],
  },
  {
    // ND "modifica monto" que referencia DIRECTAMENTE la factura exenta caso 6 (no la NC caso 7).
    caso: "4907375-8", nroCaso: 8, tipoDocumento: 56,
    ref: { caso: "4907375-6", codRef: 3, razon: "MODIFICA MONTO" },
    items: [{ nombre: "CAPACITACION USO PLC's CNC", cantidad: 1, precio: 45946, exento: true }],
  },

  // ── SET GUÍA DE DESPACHO 4907373 — guía 52 (set nuevo 2026-06-18) ──
  {
    // Traslado interno entre bodegas (IndTraslado 5) → receptor=emisor. NO constituye venta →
    // SIN valor comercial: cada línea = QtyItem + UnmdItem + MontoItem=0 (sin PrcItem ni IndExe),
    // y Totales en 0 (MntTotal=0). El set sólo da cantidades (79/124/85). TipoDespacho OMITIDO
    // (el SETMAIL viejo reparó "Indicadores (Despacho/Traslado) No Corresponden" con TipoDespacho=3).
    caso: "4907373-1", nroCaso: 1, tipoDocumento: 52,
    despacho: { indTraslado: 5 },
    items: [
      { nombre: "ITEM 1", cantidad: 79, precio: 0, sinValor: true, unidadMedida: "UN" },
      { nombre: "ITEM 2", cantidad: 124, precio: 0, sinValor: true, unidadMedida: "UN" },
      { nombre: "ITEM 3", cantidad: 85, precio: 0, sinValor: true, unidadMedida: "UN" },
    ],
  },
  {
    // Venta, traslado por cuenta del emisor al local del cliente (TipoDespacho 2, IndTraslado 1).
    caso: "4907373-2", nroCaso: 2, tipoDocumento: 52,
    despacho: { tipoDespacho: 2, indTraslado: 1 },
    items: [
      { nombre: "ITEM 1", cantidad: 350, precio: 7169 },
      { nombre: "ITEM 2", cantidad: 678, precio: 1636 },
    ],
  },
  {
    // Venta, traslado por cuenta del cliente (TipoDespacho 1, IndTraslado 1).
    caso: "4907373-3", nroCaso: 3, tipoDocumento: 52,
    despacho: { tipoDespacho: 1, indTraslado: 1 },
    items: [
      { nombre: "ITEM 1", cantidad: 170, precio: 1967 },
      { nombre: "ITEM 2", cantidad: 419, precio: 5602 },
    ],
  },

  // ── SET FC 46 — definido como FACTURA DE COMPRA SIMPLE en FC46_CERT_CASES (más abajo).
  // HALLAZGO 2026-06-23: el "CASO GENERAL DE EMISOR DE FACTURA DE COMPRA" NO pide retención —
  // verificado contra el TEXTO LITERAL de DOS sets (4901278 y el vigente 4917063): sólo "Producto 1 /
  // Producto 2", sin mención de retención. La "RETENCION TOTAL DEL IVA" es del FOLIO 9 del LIBRO DE
  // COMPRAS (4897295), un registro contable, NO el documento a emitir. El bloqueo HED-2-302 lo causaba un
  // <ImptoReten>/15 agregado de más. El motor mantiene el soporte de retención (CERT_RETEN_CODE/CPCS +
  // retencionTotalIva) para PRODUCCIÓN (cambio de sujeto real). La 43 queda fuera (ver cert_liquidacion_43).
];

// Receptores extranjeros (exportación): RUTRecep = 55555555-5 + bloque <Extranjero> con SOLO
// <Nacionalidad> (código país tabla Aduana). NumId es de la Factura de Turista (TipoFactEsp=1),
// NO de la exportación normal → se omite.
const RECEPTOR_EXP_ITALIA: CertReceptor = {
  rut: "55555555-5", razonSocial: "IMPORTADORA ROMANA SRL", giro: "Importacion de metales",
  dirRecep: "Via Roma 1", cmnaRecep: "Napoli", ciudadRecep: "Napoli",
  extranjero: { nacionalidad: 504 }, // ITALIA
};
const RECEPTOR_EXP_VENEZUELA: CertReceptor = {
  rut: "55555555-5", razonSocial: "IMPORTADORA CARIBE CA", giro: "Importacion",
  dirRecep: "Av. Bolivar 100", cmnaRecep: "Maracaibo", ciudadRecep: "Maracaibo",
  extranjero: { nacionalidad: 201 }, // VENEZUELA
};

/* 
 * NOTA DEL SET DE EXPORTACIÓN — DTE 110 (factura export) / 112 (NC export) / 111 (ND export).
 * (Los números de atención vigentes están en `SET_ATENCION.export1/export2`; los de este texto
 *  eran los de una atención anterior. Este bloque documenta `EXPORT_CERT_CASES`, no la función
 *  que sigue: iba apilado sobre otro JSDoc, así que TypeScript sólo tomaba el segundo y esto
 *  no se leía en ninguna parte.)
 * Toda exportación es EXENTA (sin IVA): MntExe = MntTotal = Σ(líneas post-descuento) + Σ(recargos), en la
 * moneda extranjera. Flete y seguro van DOBLE: campos informativos del encabezado Aduana (MntFlete/MntSeguro)
 * Y como 2 recargos globales (DscRcgGlobal TpoMov=R, IndExeDR=1) — instrucción (**) del set. ValorDR ≤2 dec
 * (Dec16_2); MntExe/MntTotal ≤4 dec (xs:decimal). El equivalente CLP (<OtraMoneda> + <ValorDROtrMnda> por
 * recargo) es OBLIGATORIO en export (campos 129/132/DscRcgGlobal-6 formato_dte) → se emite con TC plausible
 * (FRANCO SZ 1075, DOLAR USA 950; el cert valida consistencia, no el valor exacto). FchCancel obligatorio en
 * el 110 con FmaPagExp=ANTICIPO (4903531-1). Los 2 sub-sets van en ENVÍOS SEPARADOS (instrucción 4 del set).
 */
/**
 * Redondeo FLOAT-SAFE del equivalente CLP de un monto en moneda extranjera (MntExeOtrMnda /
 * MntTotOtrMnda). El SII recalcula este CLP con redondeo PHP half-away-from-zero sobre
 * (montoExtranjera × TpoCambio) y rechaza si difiere por 1 peso. Hacerlo con
 * `Math.round(montoExtranjera * tpoCambio)` da el valor MAL cuando el producto cae justo en .5 y
 * la representación float64 lo deja por debajo: 106230.78 × 1075 = 114198088.49999999 en float →
 * Math.round = 114198088, pero el SII espera round(106230.785) = 114198089. Se evita escalando el
 * monto-moneda-extranjera (2 decimales) a entero ANTES de multiplicar:
 *   round(round(montoExtranjera × 100) × TpoCambio / 100)
 * Ej.: round(round(106230.78×100)=10623078 × 1075 / 100) = round(11419808850/100) = round(114198088.5)
 * = 114198089. (Math.round redondea .5 hacia +∞, que coincide con half-away-from-zero para positivos.)
 */
function clpRound(montoExtranjera: number, tpoCambio: number): number {
  return Math.round(Math.round(montoExtranjera * 100) * tpoCambio / 100);
}

/**
 * Los 6 casos de exportación del set: `SET_ATENCION.export1` (factura 110, nota de crédito 112 y nota de débito
 * 111) y `SET_ATENCION.export2` (110 × 3). Todo va exento y en la moneda extranjera de cada caso —con decimales,
 * no en pesos—; el array trae los dos sub-sets juntos pero el set exige un envío por número de atención, así que
 * fíltralos por el prefijo de `caso` antes de emitir. Ya vienen incluidos en `DEFAULT_FACTURA_CERT_CASES`.
 */
export const EXPORT_CERT_CASES: FacturaCertCase[] = [
  // ── EXPORTACIÓN (1) 4907376 — FRANCO SZ (CHF). 110 + 112 NC + 111 ND. ──
  {
    caso: "4907376-1", nroCaso: 1, tipoDocumento: 110,
    receptor: RECEPTOR_EXP_ITALIA,
    items: [{ nombre: "CHATARRA DE ALUMINIO", cantidad: 687, precio: 159, exento: true, unidadMedida: "PAR" }],
    transporte: {
      aduana: {
        codModVenta: 3, // EN CONSIGNACION LIBRE
        codClauVenta: 6, // S/CL
        totClauVenta: 3523.59,
        codViaTransp: 6, // FERROVIARIO
        codPtoEmbarque: 910, // PUERTO MONTT
        codPtoDesemb: 544, // NAPOLES
        // Tara/Peso (Aduana) — el SET pide UNIDAD TARA: KN (6), UNIDAD PESO BRUTO/NETO: PAR (17). El
        // set da las UNIDADES pero no los valores ("CALCULE LOS VALORES") → el emisor los calcula.
        // pesoNeto=687=cantidad de la línea; pesoBruto>pesoNeto; tara=20. Sin estos campos el
        // SET-REVIEW repara SRH "Datos del Documento de Exportación No Corresponde" (2026-06-17).
        tara: 20, codUnidMedTara: 6, // KN
        pesoBruto: 700, codUnidPesoBruto: 17, // PAR
        pesoNeto: 687, codUnidPesoNeto: 17, // PAR
        totItems: 1,
        totBultos: 69,
        tipoBultos: [{ codTpoBultos: 89, cantBultos: 69, marcas: "S/M" }], // PLANCHAS — Marcas obligatorio (HED-2-804)
        mntFlete: 2069.28,
        mntSeguro: 1215.22,
        codPaisRecep: 504, // ITALIA
        codPaisDestin: 504,
      },
    },
    exportacion: {
      tpoMoneda: "FRANCO SZ",
      fmaPagExp: 32, // ANTICIPO → FchCancel obligatorio (= fecha emisión, lo pone el builder)
      // OtraMoneda (CLP). TC FRANCO SZ = 1075. clpRound float-safe(112517.50 × 1075).
      otraMoneda: { tpoMoneda: "PESO CL", tpoCambio: 1075, mntExeOtrMnda: clpRound(112517.50, 1075), mntTotOtrMnda: clpRound(112517.50, 1075) },
      recargos: [
        // valorDROtrMnda = valor × TC. flete 2069.28×1075=2224476; seguro 1215.22×1075=1306361.5.
        { tipo: "R", valorTipo: "$", valor: 2069.28, valorDROtrMnda: 2224476, glosa: "FLETE", exento: 1 },
        { tipo: "R", valorTipo: "$", valor: 1215.22, valorDROtrMnda: 1306361.5, glosa: "SEGURO", exento: 1 },
      ],
      // 109233 (línea 687×159) + 2069.28 (flete) + 1215.22 (seguro) = 112517.50
      exento: 112517.50,
      total: 112517.50,
      referenciasAduana: [{ tipoDocRef: "810", folioRef: "1234", razonRef: "MIC/DTA" }], // MIC (Manifiesto Internacional)
    },
  },
  {
    // NC export: devolución de mercadería (mismo precio unitario). Sin Aduana/recargos (el set sólo
    // da ítem + cantidad). Hereda el receptor extranjero del 110 (caso 1).
    caso: "4907376-2", nroCaso: 2, tipoDocumento: 112,
    ref: { caso: "4907376-1", codRef: 3, razon: "DEVOLUCION DE MERCADERIA" },
    items: [{ nombre: "CHATARRA DE ALUMINIO", cantidad: 229, precio: 159, exento: true, unidadMedida: "PAR" }],
    // OtraMoneda (CLP). TC FRANCO SZ = 1075.
    exportacion: {
      tpoMoneda: "FRANCO SZ", exento: 36411, total: 36411, // 229 × 159
      otraMoneda: { tpoMoneda: "PESO CL", tpoCambio: 1075, mntExeOtrMnda: clpRound(36411, 1075), mntTotOtrMnda: clpRound(36411, 1075) },
    },
  },
  {
    // ND export: anula la NC del caso 2 → replica su monto.
    caso: "4907376-3", nroCaso: 3, tipoDocumento: 111,
    ref: { caso: "4907376-2", codRef: 1, razon: "ANULA NOTA DE CREDITO" },
    items: [{ nombre: "CHATARRA DE ALUMINIO", cantidad: 229, precio: 159, exento: true, unidadMedida: "PAR" }],
    // OtraMoneda (CLP). TC FRANCO SZ = 1075.
    exportacion: {
      tpoMoneda: "FRANCO SZ", exento: 36411, total: 36411,
      otraMoneda: { tpoMoneda: "PESO CL", tpoCambio: 1075, mntExeOtrMnda: clpRound(36411, 1075), mntTotOtrMnda: clpRound(36411, 1075) },
    },
  },

  // ── EXPORTACIÓN (2) 4907377 — YEN (servicios + mercaderías) + DOLAR USA (alojamiento). 110 × 3. ──
  {
    // Servicio (asesorías). VALOR LINEA = 94 YEN + "%10 RECARGO EN LA LINEA DE ITEM POR COMISIONES EN EL
    // EXTERIOR". El recargo va A NIVEL DE LÍNEA como <RecargoPct>10</RecargoPct> con PrcItem=94 → el SII
    // computa MontoItem = 94 × (1 + 10/100) = 103.4 (subtipo Exportaciones: MontoItem decimal/4). NO se
    // emite <RecargoMonto> (9.4 fraccionario = MntImpType positiveInteger inválido → se omite, minOccurs=0).
    // El set lo pide EN LA LÍNEA, no como DscRcgGlobal (eso reparaba "Debe Tener 0 Línea(s) de Recargo Global").
    caso: "4907377-1", nroCaso: 1, tipoDocumento: 110,
    receptor: RECEPTOR_EXP_VENEZUELA,
    items: [{ nombre: "ASESORIAS Y PROYECTOS PROFESIONALES", cantidad: 1, precio: 94, recargoPct: 10, exento: true, descripcion: "COMISIONES EN EL EXTERIOR" }],
    transporte: {
      aduana: {
        codClauVenta: 2, // CFR
        codViaTransp: 8, // OLEODUCTOS, GASODUCTOS
        codPtoEmbarque: 907, // TALCAHUANO
        codPtoDesemb: 285, // MARACAIBO
        totItems: 1,
        codPaisRecep: 201, // VENEZUELA
        codPaisDestin: 201,
      },
    },
    exportacion: {
      tpoMoneda: "YEN",
      indServicio: 3, // Factura de Servicios (asesorías, servicios calificados por Aduana) — formato_dte campo 9.
      fmaPagExp: 1, // COB1 (cobranza hasta 1 año; no anticipo → sin FchCancel)
      // OtraMoneda (CLP). TC YEN = 7 (plausible; el cert valida consistencia, no el valor de mercado).
      otraMoneda: { tpoMoneda: "PESO CL", tpoCambio: 7, mntExeOtrMnda: clpRound(103.4, 7), mntTotOtrMnda: clpRound(103.4, 7) },
      exento: 103.4, // 94 + 10% de 94 = 103.4 (recargo en la línea)
      total: 103.4,
      referenciasAduana: [{ tipoDocRef: "812", folioRef: "12345", razonRef: "RESOLUCION SNA" }],
    },
  },
  {
    // Mercaderías por volumen (MCUB). Descuento 5% en la línea 1. Comisiones 11% del total cláusula +
    // flete + seguro como 3 recargos globales. Bulto TRONCOS (cod 18, NO contenedor → sin Id/Sello).
    caso: "4907377-2", nroCaso: 2, tipoDocumento: 110,
    receptor: RECEPTOR_EXP_VENEZUELA,
    items: [
      { nombre: "CAJAS CIRUELAS TIERNIZADAS SIN CAROZO CALIBRE 60/70", cantidad: 1036, precio: 194, exento: true, unidadMedida: "KN", descuentoPct: 5 },
      { nombre: "CAJAS DE PASAS DE UVA FLAME MORENA SIN SEMILLA MEDIANAS", cantidad: 243, precio: 132, exento: true, unidadMedida: "KN" },
    ],
    transporte: {
      aduana: {
        codModVenta: 9, // SIN PAGO
        codClauVenta: 2, // CFR
        totClauVenta: 5613.15,
        codViaTransp: 8, // OLEODUCTOS, GASODUCTOS
        codPtoEmbarque: 907, // TALCAHUANO
        codPtoDesemb: 285, // MARACAIBO
        // Tara/Peso (Aduana) — el SET pide UNIDAD TARA/PESO BRUTO/PESO NETO: MCUB (16). El set da las
        // UNIDADES, no los valores ("CALCULE LOS VALORES"). pesoNeto=1279=1036+243 (suma de cantidades);
        // pesoBruto>pesoNeto; tara=21. Sin estos campos → SRH (mismo reparo que export 1).
        tara: 21, codUnidMedTara: 16, // MCUB
        pesoBruto: 1300, codUnidPesoBruto: 16, // MCUB
        pesoNeto: 1279, codUnidPesoNeto: 16, // MCUB
        totItems: 2,
        totBultos: 104,
        tipoBultos: [{ codTpoBultos: 18, cantBultos: 104, marcas: "S/M" }], // TRONCOS (cod 18; bulto común, sin contenedor)
        mntFlete: 5251.25,
        mntSeguro: 4912.68,
        codPaisRecep: 201, // VENEZUELA
        codPaisDestin: 201,
      },
    },
    exportacion: {
      tpoMoneda: "YEN",
      fmaPagExp: 1, // COB1 (cobranza hasta 1 año; no anticipo → sin FchCancel)
      // OtraMoneda (CLP). TC YEN = 7. clpRound(233792.38 × 7).
      otraMoneda: { tpoMoneda: "PESO CL", tpoCambio: 7, mntExeOtrMnda: clpRound(233792.38, 7), mntTotOtrMnda: clpRound(233792.38, 7) },
      recargos: [
        // valorDROtrMnda = valor × TC (7). comisión 11% de 5613.15 = 617.4465 → 617.45; ×7=4322.15.
        { tipo: "R", valorTipo: "$", valor: 617.45, valorDROtrMnda: 4322.15, glosa: "COMISIONES EN EL EXTRANJERO", exento: 1 },
        { tipo: "R", valorTipo: "$", valor: 5251.25, valorDROtrMnda: 36758.75, glosa: "FLETE", exento: 1 },
        { tipo: "R", valorTipo: "$", valor: 4912.68, valorDROtrMnda: 34388.76, glosa: "SEGURO", exento: 1 },
      ],
      // líneas: ciruelas 1036×194=200984 −5% (10049) = 190935 ; pasas 243×132 = 32076 → 223011
      // + recargos 617.45 + 5251.25 + 4912.68 = 10781.38 → 233792.38
      exento: 233792.38,
      total: 233792.38,
      referenciasAduana: [
        { tipoDocRef: "807", folioRef: "4290123456", razonRef: "DUS" }, // Documento Único de Salida
        { tipoDocRef: "809", folioRef: "12512345678", razonRef: "AWB" }, // Air Waybill (guía aérea)
      ],
    },
  },
  {
    // Servicio de alojamiento. VALOR LINEA = 281 USD. Sólo moneda + nacionalidad (sin Aduana/recargos).
    caso: "4907377-3", nroCaso: 3, tipoDocumento: 110,
    receptor: RECEPTOR_EXP_VENEZUELA,
    items: [{ nombre: "ALOJAMIENTO HABITACIONES", cantidad: 1, precio: 281, exento: true }],
    // OtraMoneda (CLP). TC DOLAR USA = 950. clpRound(281 × 950) = 266950.
    exportacion: {
      tpoMoneda: "DOLAR USA", exento: 281, total: 281,
      indServicio: 4, // Servicios de Hotelería (alojamiento) — formato_dte campo 9; sin CodViaTransp/CodPtoDesemb obligatorios.
      otraMoneda: { tpoMoneda: "PESO CL", tpoCambio: 950, mntExeOtrMnda: clpRound(281, 950), mntTotOtrMnda: clpRound(281, 950) },
      // 2ª referencia (la 1ª es la SET, auto-agregada): el SII reparó "El Documento Debe Tener 2
      // Linea(s) de Referencia". Alojamiento es EXPORTACIÓN DE SERVICIOS (IndServicio=4) → el documento
      // que califica la operación como export es la RESOLUCIÓN DEL SNA: TpoDocRef 812. FolioRef
      // alfanumérico libre NO validado por el SII.
      referenciasAduana: [{ tipoDocRef: "812", folioRef: "12345", razonRef: "RESOLUCION SNA" }],
    },
  },
];

/**
 * SET FC 46 (4917063, vigente 2026-06-23) — "CASO GENERAL DE EMISOR DE FACTURA DE COMPRA". El caso es
 * una FACTURA DE COMPRA SIMPLE, SIN retención: MntTotal = MntNeto + IVA. NO lleva <ImptoReten> ni
 * <Retenedor> ni CodImpAdic → NO dispara el reparo HED-2-302 (que el set anterior provocó al agregar
 * retención que el caso no pedía). Verificado contra el texto literal del set + el XSD oficial. Va en
 * sobre SEPARADO (atención 4917063) → NO se incluye en DEFAULT_FACTURA_CERT_CASES (no contamina el set
 * 4907369 ya certificado). Montos:
 *   -1 FC 46: Producto 1 500×4152 + Producto 2 26×2192 → neto 2.132.992, IVA 405.268, total 2.538.260
 *   -2 NC 61 devolución parcial: Producto 1 ×167 + Producto 2 ×9 (mismos precios; ref -1, CodRef 3)
 *   -3 ND 56 anula la NC: replica los ítems de -2 (ref -2, CodRef 1)
 */
export const FC46_CERT_CASES: FacturaCertCase[] = assignCertReceptores([
  {
    caso: "4917063-1", nroCaso: 1, tipoDocumento: 46, retencionTotalIva: true,
    items: [
      { nombre: "Producto 1", cantidad: 500, precio: 4152 },
      { nombre: "Producto 2", cantidad: 26, precio: 2192 },
    ],
  },
  {
    caso: "4917063-2", nroCaso: 2, tipoDocumento: 61, retencionTotalIva: true,
    ref: { caso: "4917063-1", codRef: 3, razon: "DEVOLUCION DE MERCADERIA ITEMS 1 Y 2" },
    items: [
      { nombre: "Producto 1", cantidad: 167, precio: 4152 },
      { nombre: "Producto 2", cantidad: 9, precio: 2192 },
    ],
  },
  {
    caso: "4917063-3", nroCaso: 3, tipoDocumento: 56, retencionTotalIva: true,
    ref: { caso: "4917063-2", codRef: 1, razon: "ANULA NOTA DE CREDITO ELECTRONICA" },
    items: [
      { nombre: "Producto 1", cantidad: 167, precio: 4152 },
      { nombre: "Producto 2", cantidad: 9, precio: 2192 },
    ],
  },
]);

/**
 * SET BÁSICO LIQUIDACIONES (4919094, vigente 2026-06-24) — 4 casos de Liquidación-Factura
 * Electrónica (43). El consignatario (mandatario) liquida al mandante; cada línea es un AGREGADO
 * ("CANTIDAD n / TOTAL LINEA m" del set) del documento liquidado, con MontoItem explícito (admite
 * negativo: NC/devolución/liquidación previa) y TpoDocLiq por línea. Va en sobre SEPARADO (atención
 * 4919094) → NO entra en DEFAULT_FACTURA_CERT_CASES. Receptor = mandante (genérico, vía args.receptor).
 *
 * TpoDocLiq (formato_dte §Detalle campo 4 — "código del docto que se liquida, electrónico o manual,
 * o 99 en Anticipo"): regla del set → "ELECTRÓNICA" explícito = electrónico; sin la palabra = manual.
 *   FACTURAS→30 · FACTURAS ELECTRONICAS / FACTURA ELECTRONICA NNNN→33 · NOTA DE CREDITO→60 ·
 *   BOLETAS→35 · ANTICIPO→99 · LIQUIDACION FACTURA ELECTRONICA→43.
 * ⚠️ Calibración a vigilar en el SETMAIL (manual vs electrónico): BOLETAS 35/39 y NOTA DE CREDITO 60/61.
 * Exento → IndExe=1 (las líneas "EXENTO …"); afecto → sin IndExe. Comisiones del mandatario: afectas,
 * IVA=round(neto×0.19); IVAProp=ΣValComIVA, IVATerc=IVA−IVAProp; el MntTotal RESTA las comisiones.
 */
export const LIQ43_CERT_CASES: FacturaCertCase[] = [
  {
    caso: "4919094-1", nroCaso: 1, tipoDocumento: 43,
    items: [
      { nombre: "NETO FACTURAS", cantidad: 11, precio: 0, montoItem: 695654, tpoDocLiq: 30 },
      { nombre: "EXENTO FACTURAS", cantidad: 8, precio: 0, montoItem: 174557, exento: true, tpoDocLiq: 30 },
      { nombre: "NETO FACTURAS ELECTRONICAS", cantidad: 52, precio: 0, montoItem: 112848, tpoDocLiq: 33 },
      { nombre: "EXENTO FACTURAS ELECTRONICAS", cantidad: 39, precio: 0, montoItem: 105992, exento: true, tpoDocLiq: 33 },
    ],
  },
  {
    caso: "4919094-2", nroCaso: 2, tipoDocumento: 43,
    items: [
      { nombre: "NETO FACTURA ELECTRONICA 4254", cantidad: 1, precio: 0, montoItem: 50157, tpoDocLiq: 33 },
      { nombre: "EXENTO FACTURA ELECTRONICA 4254", cantidad: 1, precio: 0, montoItem: 24364, exento: true, tpoDocLiq: 33 },
      { nombre: "NETO FACTURA ELECTRONICA 4768", cantidad: 1, precio: 0, montoItem: 647515, tpoDocLiq: 33 },
      { nombre: "EXENTO FACTURA ELECTRONICA 4768", cantidad: 1, precio: 0, montoItem: 378800, exento: true, tpoDocLiq: 33 },
      { nombre: "NETO NOTA DE CREDITO 328", cantidad: 1, precio: 0, montoItem: -52428, tpoDocLiq: 60 },
      { nombre: "EXENTO NOTA DE CREDITO 328", cantidad: 1, precio: 0, montoItem: -18307, exento: true, tpoDocLiq: 60 },
      { nombre: "BOLETAS", cantidad: 8572, precio: 0, montoItem: 6462364, tpoDocLiq: 35 },
    ],
  },
  {
    caso: "4919094-3", nroCaso: 3, tipoDocumento: 43,
    items: [
      { nombre: "NETO FACTURA ELECTRONICA 1515", cantidad: 1, precio: 0, montoItem: 387110, tpoDocLiq: 33 },
      { nombre: "NETO FACTURAS ELECTRONICAS", cantidad: 310, precio: 0, montoItem: 153267, tpoDocLiq: 33 },
      { nombre: "EXENTO FACTURAS ELECTRONICAS", cantidad: 52, precio: 0, montoItem: 119103, exento: true, tpoDocLiq: 33 },
    ],
    comisiones: [
      { tipoMovim: "C", glosa: "NETO COMISION FIJA", neto: 3185 },
      { tipoMovim: "C", glosa: "NETO COMISION VARIABLE", neto: 7663 },
    ],
  },
  {
    caso: "4919094-4", nroCaso: 4, tipoDocumento: 43,
    items: [
      { nombre: "NETO ANTICIPO FACTURACION", cantidad: 310, precio: 0, montoItem: 550000, tpoDocLiq: 99 },
      { nombre: "NETO FACTURAS", cantidad: 52, precio: 0, montoItem: 366884, tpoDocLiq: 30 },
      { nombre: "EXENTO FACTURAS", cantidad: 59, precio: 0, montoItem: 208950, exento: true, tpoDocLiq: 30 },
      { nombre: "NETO FACTURAS ELECTRONICAS", cantidad: 46, precio: 0, montoItem: 109978, tpoDocLiq: 33 },
      { nombre: "EXENTO FACTURAS ELECTRONICAS", cantidad: 9, precio: 0, montoItem: 1588653, exento: true, tpoDocLiq: 33 },
      { nombre: "NETO NOTA DE CREDITO 1981", cantidad: 1, precio: 0, montoItem: -95716, tpoDocLiq: 60 },
      { nombre: "NETO LIQUIDACION FACTURA ELECTRONICA 4554", cantidad: 1, precio: 0, montoItem: -146652, tpoDocLiq: 43 },
      { nombre: "EXENTO LIQUIDACION FACTURA ELECTRONICA 4554", cantidad: 1, precio: 0, montoItem: -147823, exento: true, tpoDocLiq: 43 },
    ],
    comisiones: [
      { tipoMovim: "C", glosa: "NETO COMISION CONSIGNACION", neto: 2233 },
      { tipoMovim: "C", glosa: "NETO COMISIONES LIQUIDACION FACTURA ELECTRONICA 4554", neto: -7333 },
    ],
  },
];

/** Los 25 casos del set (19 estándar: 8 básico + 8 exenta + 3 guía; 6 exportación) con receptores asignados a las facturas base. */
export const DEFAULT_FACTURA_CERT_CASES: FacturaCertCase[] = assignCertReceptores([
  ...RAW_FACTURA_CERT_CASES,
  ...EXPORT_CERT_CASES,
]);

// ============================================================================
// LIBROS de la etapa 1 del set: IEV (4907371) + IEC (4907372) + Libro Guías (4907374).
// ============================================================================

/** RUT proveedor genérico para el Libro de Compras (el set no lo da; editable). */
const LIBRO_COMPRAS_PROVEEDOR_RUT = "11111111-1";

/**
 * Libro de Compras (IEC) del set 4907372 — lista FIJA dada por el SII (no deriva
 * de los DTEs emitidos). "FACTURA"=30 (manual) · "FACTURA ELECTRONICA"=33 ·
 * "NOTA DE CREDITO"=60 (manual) · "FACTURA DE COMPRA ELECTRONICA"=46. IVA uso
 * común: factor 0.60 (FctProp) → el resumen emite TotCredIVAUsoComun = IVAUsoComun×0.60.
 * Entrega gratuita (f67): IVA NO RECUPERABLE (IVANoRec CodIVANoRec=4), fuera de MntIVA.
 * Retención total (f9): el contribuyente es el COMPRADOR/agente retenedor → en COMPRAS la registra
 * con IVA RECUPERABLE total y MntTotal = Neto+IVA (BRUTO, sin restar retención; SIN IVARetTotal, que
 * es del libro de VENTAS — casos_especiales II.1). (SETMAIL 4903527: uso común, IVA no recup., MntTotal bruto FC.)
 */
export function buildCertLibroComprasDetalles(fecha: string): LibroDetalle[] {
  const rut = LIBRO_COMPRAS_PROVEEDOR_RUT;
  const afecta = (tipoDoc: number, folio: number, neto: number): LibroDetalle => {
    const iva = Math.round(neto * IVA_RATE);
    return { tipoDoc, folio, fecha, rut, tasaIva: 19, montoNeto: neto, montoIva: iva, montoTotal: neto + iva };
  };
  const iva32 = Math.round(10846 * IVA_RATE);
  const iva781 = Math.round(30122 * IVA_RATE);
  const iva67 = Math.round(11868 * IVA_RATE); // IVA no recuperable (entrega gratuita)
  const iva9 = Math.round(10498 * IVA_RATE);
  return [
    afecta(30, 234, 49203), // FACTURA — del giro con derecho a crédito.
    {
      // FACTURA ELECTRONICA 32 — del giro, con parte exenta.
      tipoDoc: 33, folio: 32, fecha, rut, tasaIva: 19,
      montoExento: 10406, montoNeto: 10846, montoIva: iva32, montoTotal: 10406 + 10846 + iva32,
    },
    {
      // FACTURA 781 — IVA uso común (FctProp 0.60).
      tipoDoc: 30, folio: 781, fecha, rut, tasaIva: 19,
      montoNeto: 30122, ivaUsoComun: iva781, montoTotal: 30122 + iva781,
    },
    afecta(60, 451, 2902), // NOTA DE CREDITO — por descuento a factura 234.
    {
      // FACTURA ELECTRONICA 67 — ENTREGA GRATUITA del proveedor → IVA NO RECUPERABLE
      // (CodIVANoRec=4), fuera de MntIVA. MntTotal = Neto + IVANoRec.
      tipoDoc: 33, folio: 67, fecha, rut, tasaIva: 19,
      montoNeto: 11868, ivaNoRec: [{ cod: 4, monto: iva67 }], montoTotal: 11868 + iva67,
    },
    {
      // FACTURA DE COMPRA ELECTRONICA 9 — compra con retención total del IVA (cambio de sujeto). En el
      // LIBRO DE COMPRAS la retención total del IVA se informa con **OtrosImp CodImp=15** (IVA Retenido
      // Total), NO con IVARetTotal (ese campo es del libro de VENTAS). MntIVA = IVA recuperable (1995);
      // OtrosImp/15 = IVA retenido (1995); **MntTotal del detalle = Neto + IVA − retención = Neto (10498)**;
      // el resumen TotMntTotal = Σ(MntTotal) (no resta otra vez). Fuentes SII: ejemplos_libro_compras.pdf
      // §2.1, formato_iecv (IEC field 21/25), cod_otros_imp_retenc.pdf (15 = IVA Retenido Total genérico).
      // ⚠️ Derivado de TRES SETMAIL reales del set 4907372 (SRH, 2026-06-18): (1) bruto sin retención →
      // "No Informa IVA Retenido Total" + "Monto Total No Cuadra"; (2) IVARetTotal (campo de VENTAS) →
      // "No Informa Adecuadamente IVA Retenido Total" + LBR-2; (3) restar la retención en el resumen → LRH
      // "Descuadrado". OtrosImp/15 en COMPRAS + MntTotal neto + resumen=Σ = el único modelo que cuadra.
      tipoDoc: 46, folio: 9, fecha, rut, tasaIva: 19, facturaCompra: true,
      montoNeto: 10498, montoIva: iva9, otrosImp: [{ codImp: 15, tasaImp: 19, mntImp: iva9 }], montoTotal: 10498,
    },
    afecta(60, 211, 8471), // NOTA DE CREDITO — por descuento a factura electrónica 32.
  ];
}

/**
 * Datos comunes de los tres libros del set. `receptor` se informa en cada detalle del libro de ventas y en la guía
 * que constituye venta —la guía de traslado interno se informa con el emisor, la anulada no lleva receptor y el
 * libro de compras usa una nómina fija con su propio RUT de proveedor—, y `fechaEmision` fecha todos los detalles
 * y fija el período tributario con sus primeros 7 caracteres (AAAA-MM).
 */
export type CertLibroOpts = {
  emisor: CertFacturaEmisor;
  receptor: { rut: string; razonSocial: string };
  rutEnvia: string;
  fchResol: string;
  nroResol: number;
  /** AAAA-MM-DD (fecha de los documentos del set). */
  fechaEmision: string;
  /**
   * Folio de notificación base de los libros ESPECIALES (default 1). El SII identifica un libro
   * ESPECIAL por (RUT + TipoLibro + Período + FolioNotificacion); reusar el folio de un set anterior
   * que ya cerró el período da LNC "Libro Cerrado". IEV/Guías = base; IEC = base+1. Para re-certificar
   * un set nuevo sobre un período ya cerrado, pasar un base FRESCO (ej. 3 → IEV/Guías 3, IEC 4).
   */
  folioNotificacionBase?: number;
};

/**
 * Arma los 3 libros del set a partir de los DTEs emitidos (PURO, testeable):
 *   - IEV (ventas): los 8 documentos del SET BÁSICO (SET_ATENCION.basico; el set indica usar
 *     el básico cuando se obtuvo básico + exenta).
 *   - IEC (compras): la lista fija del set de compras (SET_ATENCION.libroCompras).
 *   - Libro de Guías: las 3 guías (SET_ATENCION.guia; caso 2 venta facturada, caso 3 anulada).
 */
export function buildCertLibros(
  mapped: MappedCertDte[],
  opts: CertLibroOpts,
): { ventas: LibroIecvInput; compras: LibroIecvInput; guias: LibroGuiaInput } {
  const periodo = opts.fechaEmision.slice(0, 7);
  const periodoId = periodo.replace("-", "");
  // FolioNotificacion: IEV/Guías = base, IEC = base+1. Base fresco (≠ set anterior) abre libro ESPECIAL
  // nuevo sin chocar con el período ya cerrado (LNC). El envioId incluye el folio (id único + evita dedup).
  const folNotif = opts.folioNotificacionBase ?? 1;

  const ventasDet: LibroDetalle[] = mapped
    .filter((d) => d.caso.startsWith(`${SET_ATENCION.basico}-`))
    .map((d) => ({
      tipoDoc: d.tipoDocumento,
      folio: d.folio,
      fecha: opts.fechaEmision,
      rut: opts.receptor.rut,
      razonSocial: opts.receptor.razonSocial,
      tasaIva: d.totals.neto > 0 ? 19 : undefined,
      montoExento: d.totals.exento || undefined,
      montoNeto: d.totals.neto || undefined,
      montoIva: d.totals.iva || undefined,
      montoTotal: d.totals.total,
    }));

  const guiasDet: LibroGuiaDetalle[] = mapped
    .filter((d) => d.caso.startsWith(`${SET_ATENCION.guia}-`))
    .map((d) => {
      const n = d.caso.split("-")[1];
      if (n === "3") {
        // Guía anulada → cuenta solo en TotGuiaAnulada (post-envío SII).
        return { folio: d.folio, anulado: 2, fecha: opts.fechaEmision } as LibroGuiaDetalle;
      }
      const esInterno = n === "1";
      const tpoOper: GuiaTpoOper = esInterno ? 5 : 1; // 5 traslado interno · 1 venta (caso 2 facturada).
      return {
        folio: d.folio,
        tpoOper,
        fecha: opts.fechaEmision,
        rut: esInterno ? opts.emisor.rut : opts.receptor.rut,
        razonSocial: esInterno ? opts.emisor.legalName : opts.receptor.razonSocial,
        montoNeto: d.totals.neto || undefined,
        tasaIva: d.totals.neto > 0 ? 19 : undefined,
        iva: d.totals.iva || undefined,
        montoTotal: d.totals.total,
      } as LibroGuiaDetalle;
    });

  const base = {
    rutEmisorLibro: opts.emisor.rut,
    rutEnvia: opts.rutEnvia,
    periodoTributario: periodo,
    fchResol: opts.fchResol,
    nroResol: opts.nroResol,
    tmstFirma: `${opts.fechaEmision}T12:00:00`,
  };
  return {
    ventas: {
      ...base,
      tipoOperacion: "VENTA",
      folioNotificacion: folNotif,
      envioId: `LV${periodoId}-${folNotif}`,
      detalles: ventasDet,
    },
    compras: {
      ...base,
      tipoOperacion: "COMPRA",
      folioNotificacion: folNotif + 1,
      envioId: `LC${periodoId}-${folNotif + 1}`,
      detalles: buildCertLibroComprasDetalles(opts.fechaEmision),
      factorProporcionalidad: 0.6,
    },
    guias: {
      ...base,
      folioNotificacion: folNotif,
      envioId: `LG${periodoId}-${folNotif}`,
      detalles: guiasDet,
    },
  };
}

/**
 * Los tres libros ya armados (`buildCertLibros`) más el RUT dueño de los libros (`emisorRut`), el de quien hace
 * el envío (`rutEnvia`) y el canal por donde se suben. `env` cae a "cert" y, si no pasas `token`, se pide uno
 * nuevo por SOAP antes del primer upload.
 */
export type EmitCertLibrosArgs = {
  ventas: LibroIecvInput;
  compras: LibroIecvInput;
  guias: LibroGuiaInput;
  emisorRut: string;
  rutEnvia: string;
  env?: LegacyEnv;
  /** Token SOAP legacy ya obtenido (se comparte con el sobre). */
  token?: string;
  fetchFn?: typeof fetch;
};

/** Resultado de subir un libro: la respuesta del canal legacy y el XML firmado que se envió, para auditoría o storage. */
export type LibroEmitOne = { result: LegacyUploadResult; xml: string };
/**
 * Los tres libros ya subidos. `emitCertFacturaLibrosViaRuralDte` los envía secuencialmente en ese orden
 * —ventas (IEV), compras (IEC) y guías— con un mismo token.
 */
export type EmitCertLibrosResult = { ventas: LibroEmitOne; compras: LibroEmitOne; guias: LibroEmitOne };

/**
 * Firma los 3 libros (IEV/IEC/Guías) y los sube por el canal legacy con el mismo
 * token. El SII los valida como parte de la etapa 1 del set; el "Declarar Avance"
 * (N° atención 4897294/95/97) lo hace el founder en Maullín. Devuelve el resultado
 * del upload + el XML firmado de cada libro (para auditoría/storage).
 */
export async function emitCertFacturaLibrosViaRuralDte(
  args: EmitCertLibrosArgs,
  pfxBytes: Uint8Array,
  password: string,
): Promise<EmitCertLibrosResult> {
  const env: LegacyEnv = args.env ?? "cert";
  const token = args.token ??
    await getLegacyToken(env, pfxBytes, password, { userAgent: LEGACY_USER_AGENT, fetchFn: args.fetchFn });

  const emitOne = async (
    built: { xml: string; bytes: Uint8Array },
    fileName: string,
  ): Promise<LibroEmitOne> => {
    const result = await legacyUpload(env, {
      xmlBytes: built.bytes,
      token,
      rutSender: args.rutEnvia,
      rutCompany: args.emisorRut,
      fileName,
      userAgent: LEGACY_USER_AGENT,
      fetchFn: args.fetchFn,
    });
    return { result, xml: built.xml };
  };

  // Secuencial (un solo token, evita golpear el gateway en paralelo).
  const ventas = await emitOne(buildSignedLibroIecv(args.ventas, pfxBytes, password), "libro-ventas.xml");
  const compras = await emitOne(buildSignedLibroIecv(args.compras, pfxBytes, password), "libro-compras.xml");
  const guias = await emitOne(buildSignedLibroGuia(args.guias, pfxBytes, password), "libro-guias.xml");

  return { ventas, compras, guias };
}
