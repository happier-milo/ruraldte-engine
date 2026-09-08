// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Orquesta el set de pruebas de certificación de boleta electrónica ante el SII: emite caso por
 * caso, junta folios y montos, y arma el RCOF (`<ConsumoFolios>`) que firma tu `signRcof`.
 *
 * El I/O es tuyo: `emitBoleta` y `signRcof` se inyectan, y el RCOF que devuelve hay que subirlo a
 * mano en el portal de certificación. Los precios del set vienen BRUTOS (con IVA):
 * `computeBoletaTotals` deriva `neto = round(bruto/1.19)` e `iva = bruto − neto` en pesos enteros y
 * se guía SOLO por el flag `exento` de cada línea, nunca por el tipo — en una boleta 41 marca
 * `exento: true` línea por línea o los totales salen con neto e IVA. La emisión va secuencial (el
 * orden de los folios importa) e `interEmitDelayMs` (default 0) es la pausa contra el rate limit de
 * 3/seg del oráculo de calibración, por donde va el `emitBoleta` real. Si armas el JSON con `buildCertBoletaJson`,
 * pásale `indicadorServicio`: es opcional en la firma, pero el SII rechaza por schema la boleta que
 * no lo lleva.
 *
 * @example
 * ```ts
 * import { type CertSetCase, runCertHarness } from "@ruraldte/engine/cert-harness";
 *
 * const cases: CertSetCase[] = [
 *   { caso: "CASO-1", tipoDocumento: 39, items: [{ nombre: "Cuota", cantidad: 1, precio: 11900 }] },
 *   { caso: "CASO-2", tipoDocumento: 41, items: [{ nombre: "Agua", cantidad: 3, precio: 1000, exento: true }] },
 * ];
 *
 * const { boletas, rcofXml } = await runCertHarness({
 *   cases,
 *   caratula: {
 *     rutEmisor: "76543210-K", rutEnvia: "22222222-2", nroResol: 0, fchResol: "2026-06-07",
 *     fchInicio: "2026-06-07", fchFinal: "2026-06-07", secEnvio: 1, tmstFirmaEnv: "2026-06-07T12:00:00",
 *   },
 *   interEmitDelayMs: 400,
 *   deps: { emitBoleta, signRcof }, // tuyos: emisión real + firma con el .pfx
 * });
 * // boletas[i].folio / .trackId; rcofXml se sube a mano al portal de certificación.
 * ```
 *
 * @module
 */
// ============================================================================
// Harness de certificación de boleta (set de pruebas SII) — orquestación.
// ============================================================================
//
// Flujo de certificación de boleta en Maullin:
//   1. (founder) postular el RUT + descargar CAF de certificación.
//   2. emitir los N casos del "set de pruebas" (multi-ítem, con referencia SET).
//   3. generar + firmar el RCOF (<ConsumoFolios>) con los folios emitidos.
//   4. subir las boletas + el RCOF en el portal de certificación (upload manual).
//   5. (founder) declaración de cumplimiento → SII autoriza.
//
// Este módulo cubre los pasos 2–3 como LÓGICA PURA con dependencias inyectadas
// (`emitBoleta`, `signRcof`) → testeable con mocks y AISLADA de la ruta de
// emisión de producción (no toca el provider comercial). Reusable por-RUT: nuestra
// SpA primero, luego cada APR cliente.
//
// Montos: el set de boleta da precios CON IVA (bruto). Para boleta afecta (39)
// el SII deriva MntNeto = round(bruto/1.19) e IVA = bruto − neto.
// Pesos CLP enteros (sin centavos).
// ============================================================================

import {
  buildConsumoFoliosXml,
  buildResumenes,
  type ConsumoFoliosCaratula,
  type EmittedBoletaRecord,
} from "./consumo-folios.ts";

/** Línea de una boleta del set. `precio` es bruto (con IVA) para afecta. */
export type CertLineItem = {
  nombre: string;
  cantidad: number;
  /** Precio unitario bruto (con IVA si la línea es afecta), pesos enteros. */
  precio: number;
  unidadMedida?: string;
  /** true = línea exenta de IVA. */
  exento?: boolean;
};

/** Un caso del set de pruebas. */
export type CertSetCase = {
  /** Identificador del caso, ej. "CASO-1". */
  caso: string;
  /** 39 = boleta afecta, 41 = boleta exenta. */
  tipoDocumento: 39 | 41;
  items: CertLineItem[];
  /** RazonReferencia (default = `caso`). */
  razonReferencia?: string;
};

/**
 * Totales de una boleta del set ya desglosados, en pesos enteros: `total` = `neto` + `iva` + `exento`.
 * Una boleta sin líneas afectas trae `neto` e `iva` en 0, y en el resumen del RCOF los montos en 0 no se escriben (`MntNeto`, `MntIva` y `MntExento` se omiten; `MntTotal` va siempre).
 */
export type BoletaTotals = {
  /** Neto afecto, pesos. */
  neto: number;
  /** IVA, pesos. */
  iva: number;
  /** Exento, pesos. */
  exento: number;
  /** Total = neto + iva + exento, pesos. */
  total: number;
};

const IVA_RATE = 0.19;

/**
 * Deriva los totales de una boleta desde sus líneas (precios brutos).
 *   - líneas afectas: se suma el bruto, luego neto = round(bruto/1.19), iva = bruto − neto.
 *   - líneas exentas: se suma directo a exento.
 */
export function computeBoletaTotals(items: CertLineItem[]): BoletaTotals {
  let grossAfecto = 0;
  let exento = 0;
  for (const it of items) {
    const lineGross = Math.round(it.precio * it.cantidad);
    if (it.exento) exento += lineGross;
    else grossAfecto += lineGross;
  }
  const neto = grossAfecto > 0 ? Math.round(grossAfecto / (1 + IVA_RATE)) : 0;
  const iva = grossAfecto - neto;
  return { neto, iva, exento, total: grossAfecto + exento };
}

/**
 * Arma el `Documento` JSON multi-ítem para el oráculo de calibración `/api/v1/dte/generar`,
 * con la referencia al SET que exige la certificación
 * (TpoDocRef="SET", RazonRef="CASO-N").
 *
 * Se mantiene local al harness (no reusa el provider comercial.buildDteDocumentoJson,
 * que es single-ítem y no expresa la referencia SET) para no tocar la ruta de prod.
 */
export function buildCertBoletaJson(args: {
  setCase: CertSetCase;
  folio: number;
  fechaEmision: string;
  totals: BoletaTotals;
  emisor: { rut: string; legalName: string; giro?: string; address?: string; city?: string };
  certRutCanonical: string;
  pfxPassword: string;
  setFolioReferencia: number;
  /**
   * IndServicio del XSD boleta (OBLIGATORIO: 1/2/3/4; set de cert = 3 "venta y
   * servicios"). El SII rechaza por schema el DTE sin él — verificado VIVO
   * 2026-06-10: el dte/generar del oráculo de calibración lo OMITE si no se pasa
   * (LSX-00213 'only 0 occurrences of particle "IndServicio"').
   */
  indicadorServicio?: 1 | 2 | 3 | 4;
}): Record<string, unknown> {
  const { setCase, folio, fechaEmision, totals, emisor } = args;
  const isExenta = setCase.tipoDocumento === 41;

  const detalles = setCase.items.map((it) => ({
    IndicadorExento: it.exento || isExenta ? 1 : 0,
    Nombre: it.nombre.slice(0, 80),
    Cantidad: it.cantidad,
    UnidadMedida: it.unidadMedida ?? "un",
    Precio: it.precio,
    MontoItem: Math.round(it.precio * it.cantidad),
  }));

  const totalesJson: Record<string, unknown> = { MontoTotal: totals.total };
  if (totals.neto > 0) {
    totalesJson.MontoNeto = totals.neto;
    totalesJson.IVA = totals.iva;
  }
  if (totals.exento > 0) totalesJson.MontoExento = totals.exento;

  const identificacion: Record<string, unknown> = {
    TipoDTE: setCase.tipoDocumento,
    Folio: folio,
    FechaEmision: fechaEmision,
  };
  if (args.indicadorServicio !== undefined) {
    identificacion.IndicadorServicio = args.indicadorServicio;
  }

  return {
    Documento: {
      Encabezado: {
        IdentificacionDTE: identificacion,
        Emisor: {
          Rut: emisor.rut,
          RazonSocialBoleta: emisor.legalName.slice(0, 100),
          GiroBoleta: (emisor.giro ?? "").slice(0, 80), // GiroEmisor boleta: máx 80
          DireccionOrigen: emisor.address ?? "",
          ComunaOrigen: emisor.city ?? "",
        },
        Receptor: { Rut: "66666666-6", RazonSocial: "Set de pruebas SII" },
        Totales: totalesJson,
      },
      Detalles: detalles,
      Referencias: [{
        NroLinea: 1,
        TipoDocumentoReferencia: "SET",
        FolioReferencia: args.setFolioReferencia,
        RazonReferencia: setCase.razonReferencia ?? setCase.caso,
      }],
    },
    Certificado: { Rut: args.certRutCanonical, Password: args.pfxPassword },
  };
}

// ---------- Orquestación (dependencias inyectadas) --------------------------

/**
 * Lo que devuelve tu `emitBoleta` por cada caso del set: el folio con que quedó la boleta y el trackId de su envío al SII.
 * El harness no asigna folios ni consulta el estado del envío: el folio que devuelves es el que entra al `RangoUtilizados` del RCOF —tiene que ser el mismo que va en el XML emitido—, y el trackId solo viaja hasta `CertHarnessResult`.
 */
export type EmitBoletaResult = { folio: number; trackId: string };

/**
 * El I/O que le inyectas al harness: la emisión real de cada boleta del set y la firma del RCOF.
 * `signRcof` recibe el XML sin firma y el `documentId` que va en la `Reference URI="#…"`, y tiene que firmar esa forma exacta: si la re-indentas o la vuelves a serializar, la firma deja de calzar.
 */
export type RunCertHarnessDeps = {
  /** Emite una boleta del set → folio + trackId. Real = flujo el oráculo de calibración; test = mock. */
  emitBoleta: (
    args: { setCase: CertSetCase; totals: BoletaTotals; index: number },
  ) => Promise<EmitBoletaResult>;
  /** Firma el <ConsumoFolios> sin firma → XML firmado. Real = signConsumoFolios(.pfx); test = mock. */
  signRcof: (unsignedXml: string, documentId: string) => string;
};

/**
 * Salida del harness: una fila por boleta emitida (caso, tipo, folio, trackId y totales), el XML del RCOF ya firmado y el `documentId` con que se firmó.
 * El RCOF no sale desde acá: en certificación se sube a mano en el portal del SII.
 */
export type CertHarnessResult = {
  boletas: Array<
    { caso: string; tipoDocumento: 39 | 41; folio: number; trackId: string; totals: BoletaTotals }
  >;
  /** XML del RCOF firmado, listo para upload manual en el portal de certificación. */
  rcofXml: string;
  rcofDocumentId: string;
};

/**
 * Corre el harness: emite cada caso del set, junta los folios/montos y genera +
 * firma el RCOF. NO sube nada al SII (el envío del RCOF en certificación es
 * upload manual). Devuelve los trackId de las boletas + el RCOF firmado.
 */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Emite los casos del set de certificación uno tras otro y devuelve el RCOF firmado con los folios que salieron.
 * La emisión es secuencial, en el orden de `cases` y con una pausa opcional entre boletas para respetar el rate limit de lo que haya detrás de tu `emitBoleta`. El harness no habla con el SII por su cuenta: el envío de cada boleta lo hace tu `emitBoleta`, y el RCOF firmado queda para subirlo a mano al portal de certificación.
 *
 * @param input.cases Casos del set, en el orden en que se emiten.
 * @param input.caratula Carátula del `<ConsumoFolios>`; su `rutEnvia` debe ser el RUT del certificado que firma.
 * @param input.deps Emisión real de cada boleta y firma del RCOF.
 * @param input.tasaIva Valor que se escribe como `TasaIVA` en el resumen que lleva IVA. Default 19.
 * @param input.interEmitDelayMs Pausa entre boletas, en milisegundos; no se aplica antes de la primera. Default 0.
 * @returns Las boletas emitidas (caso, tipo, folio, trackId y totales), el XML del RCOF firmado y su `documentId`.
 * @throws Error si `cases` viene vacío. También propaga lo que lancen tus `deps` y el Error del builder del RCOF cuando los folios no cuadran: si tu `emitBoleta` repite un folio, la suma de `RangoUtilizados` deja de calzar con `FoliosEmitidos`.
 */
export async function runCertHarness(input: {
  cases: CertSetCase[];
  caratula: ConsumoFoliosCaratula;
  deps: RunCertHarnessDeps;
  tasaIva?: number;
  /**
   * Pausa entre emisiones (ms) para respetar el rate limit del oráculo de calibración (3/seg).
   * Default 0 (tests con mocks no esperan); el edge fn de prod pasa ~400ms.
   */
  interEmitDelayMs?: number;
}): Promise<CertHarnessResult> {
  if (input.cases.length === 0) {
    throw new Error("runCertHarness: el set de pruebas no tiene casos");
  }

  const boletas: CertHarnessResult["boletas"] = [];
  const records: EmittedBoletaRecord[] = [];
  const delayMs = input.interEmitDelayMs ?? 0;

  // Emisión secuencial con pausa: el oráculo de calibración rate-limitea a 3/seg (429) y el orden
  // de folios importa. La pausa entre boletas mantiene la tasa bajo el límite.
  for (let i = 0; i < input.cases.length; i++) {
    if (i > 0 && delayMs > 0) await sleep(delayMs);
    const setCase = input.cases[i];
    const totals = computeBoletaTotals(setCase.items);
    const { folio, trackId } = await input.deps.emitBoleta({ setCase, totals, index: i });
    boletas.push({
      caso: setCase.caso,
      tipoDocumento: setCase.tipoDocumento,
      folio,
      trackId,
      totals,
    });
    records.push({
      tipoDocumento: setCase.tipoDocumento,
      folio,
      mntNeto: totals.neto || undefined,
      mntIva: totals.iva || undefined,
      mntExento: totals.exento || undefined,
      mntTotal: totals.total,
    });
  }

  const resumenes = buildResumenes(records, { tasaIva: input.tasaIva });
  const { xml, documentId } = buildConsumoFoliosXml({ caratula: input.caratula, resumenes });
  const rcofXml = input.deps.signRcof(xml, documentId);

  return { boletas, rcofXml, rcofDocumentId: documentId };
}
