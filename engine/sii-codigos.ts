// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Tablas de códigos generales del SII para DTE: tipo de documento, forma de pago,
 * indicador de traslado y de servicio, código de traslado excepcional, IVA no
 * recuperable, impuestos/retenciones (tabla 4 del formato) y tipos de documento de
 * referencia.
 *
 * Es un catálogo de consulta, no un validador: el motor arma los XML con literales, así
 * que importar estas tablas no valida ni corrige nada — sirven para poblar selectores en
 * la UI, traducir código a glosa y detectar drift. Los códigos de Aduana (países,
 * puertos, monedas, bultos) viven aparte, en `@ruraldte/engine/aduana-codes`. Dos
 * trampas: `tasa` no siempre es un número (`"agregado"`, `"variable"`, `"UTM/m³"` y
 * `"UTM/volumen"` son glosas, no factores que puedas multiplicar), y `formaPagoCodigo`
 * devuelve la clave tal como la entrega `Object.entries` — el string `"1"` aunque el tipo
 * diga `number`.
 *
 * @example
 * ```ts
 * import {
 *   formaPagoCodigo,
 *   IMPUESTOS_RETENCIONES,
 *   nombreTipoDte,
 *   TIPOS_DOC_REFERENCIA,
 * } from "@ruraldte/engine/sii-codigos";
 *
 * nombreTipoDte(33); // "Factura Electrónica"
 * nombreTipoDte(99); // undefined — ese código no está en el catálogo
 *
 * const ganado = IMPUESTOS_RETENCIONES[32];
 * ganado.tipo;              // "R" → retención, se RESTA del total
 * ganado.tasa;              // 8 → <ImptoReten><TipoImp>32</TipoImp><TasaImp>8</TasaImp>
 * ganado.cambioSujetoTotal; // 321 → código alterno del rubro; la tasa la defines tú
 *
 * TIPOS_DOC_REFERENCIA["801"];        // "Orden de Compra" → TpoDocRef de la referencia
 * Number(formaPagoCodigo("Contado")); // 1 — sin Number() te llega el string "1"
 * ```
 *
 * @module
 */
// ============================================================================
// sii-codigos.ts — Tablas de códigos GENERALES del SII para DTE (no Aduana).
// ============================================================================
// FUENTE OFICIAL: SII, "Formato Documentos Tributarios Electrónicos" v2.5 (2026-02,
// formato_dte_202602) + XSDs oficiales (SiiTypes_v10 / DTE_v10). Las tablas Aduana
// (países, puertos, monedas, bultos, etc.) viven en `aduana-codes.ts`.
//
// Estos códigos hoy se usan como literales en el motor; este módulo los centraliza
// como catálogo oficial para validación y para que la UI ofrezca selección amigable.
// La tabla de impuestos/retenciones replica `docs/SII_IMPUESTOS_RETENCIONES_TABLA.md`.

/** Tipos de Documento Tributario (campo TipoDTE / IdDoc). Catálogo SII. */
export const TIPOS_DTE: Record<number, string> = {
  30: "Factura",
  32: "Factura de ventas y servicios no afectos o exentos de IVA",
  33: "Factura Electrónica",
  34: "Factura No Afecta o Exenta Electrónica",
  35: "Boleta",
  38: "Boleta Exenta",
  39: "Boleta Electrónica",
  40: "Liquidación Factura",
  41: "Boleta No Afecta o Exenta Electrónica",
  43: "Liquidación-Factura Electrónica",
  45: "Factura de Compra",
  46: "Factura de Compra Electrónica",
  48: "Comprobante de Pago Electrónico",
  50: "Guía de Despacho",
  52: "Guía de Despacho Electrónica",
  55: "Nota de Débito",
  56: "Nota de Débito Electrónica",
  60: "Nota de Crédito",
  61: "Nota de Crédito Electrónica",
  110: "Factura de Exportación Electrónica",
  111: "Nota de Débito de Exportación Electrónica",
  112: "Nota de Crédito de Exportación Electrónica",
};

/** Forma de Pago (FmaPago). Default 2 (crédito) si se omite. */
export const FORMA_PAGO: Record<number, string> = {
  1: "Contado",
  2: "Crédito",
  3: "Sin costo (entrega gratuita)",
};

/** Indicador de Traslado de bienes (IndTraslado) — guías de despacho. */
export const IND_TRASLADO: Record<number, string> = {
  1: "Operación constituye venta",
  2: "Ventas por efectuar",
  3: "Consignaciones",
  4: "Entrega gratuita",
  5: "Traslados internos",
  6: "Otros traslados no venta",
  7: "Devolución de mercaderías",
  8: "Traslado para exportación (no venta)",
  9: "Venta para exportación",
};

/** Indicador de Servicio (IndServicio). 4/5/6 solo para Factura de Exportación. */
export const IND_SERVICIO: Record<number, string> = {
  1: "Factura de servicios periódicos domiciliarios",
  2: "Factura de otros servicios periódicos",
  3: "Factura de servicios (export: servicios calificados por Aduana)",
  4: "Servicios de hotelería",
  5: "Servicio de transporte terrestre internacional",
  6: "Servicios prestados y utilizados totalmente en el extranjero",
};

/** Código Emisor de Traslado Excepcional (CdgTraslado) — solo Guía de Despacho. */
export const CDG_TRASLADO: Record<number, string> = {
  1: "Exportador",
  2: "Agente de Aduana",
  3: "Vendedor (entrega en Zona Primaria)",
  4: "Contribuyente autorizado expresamente por el SII",
};

/** IVA No Recuperable (CodIVANoRec) — Libro de Compras. Fuente: formato_iecv / SII. */
export const IVA_NO_RECUPERABLE: Record<number, string> = {
  1: "Compras destinadas a generar operaciones no gravadas o exentas",
  2: "Facturas registradas fuera de plazo",
  3: "Gastos rechazados",
  4: "Entregas gratuitas (promociones, donaciones) recibidas",
  9: "Otros",
};

/** Tipo de impuesto/retención de una línea de la tabla 4 del formato DTE. */
export interface ImpuestoSii {
  /** Nombre del impuesto o retención. */
  nombre: string;
  /** "R" = retención (se RESTA al total) · "A" = adicional (se SUMA al total). */
  tipo: "R" | "A";
  /** Tasa: porcentaje (número), "agregado" (suma de retenciones, el SII no recomputa),
   *  o glosa para tasas en UTM por volumen (diésel/gasolina/gas). */
  tasa: number | string;
  /** Código alterno para cambio de sujeto TOTAL del rubro (ej. ganado 32 → 321). */
  cambioSujetoTotal?: number;
}

/**
 * Codificación Tipos de Impuestos y Recargos (formato_dte §4, tabla 4), enumeración
 * validada contra `ImpAdicDTEType` (SiiTypes_v10.xsd). Se usa en `<CodImpAdic>` (línea)
 * y `<ImptoReten>{TipoImp,TasaImp,MontoImp}` (Totales). Ver `docs/SII_IMPUESTOS_RETENCIONES_TABLA.md`.
 * Códigos 54/55 existen en el XSD sin descripción en §4 → no usar sin confirmar con el SII.
 */
export const IMPUESTOS_RETENCIONES: Record<number, ImpuestoSii> = {
  // ── Retenciones (tipo R) — cambio de sujeto / FC 46 ──
  15: { nombre: "IVA retenido total (genérico, suma de retenciones)", tipo: "R", tasa: "agregado" },
  16: { nombre: "IVA retenido parcial", tipo: "R", tasa: "agregado" },
  30: { nombre: "IVA retenido legumbres", tipo: "R", tasa: 10, cambioSujetoTotal: 301 },
  31: { nombre: "IVA retenido silvestres", tipo: "R", tasa: "agregado" },
  32: { nombre: "IVA retenido ganado", tipo: "R", tasa: 8, cambioSujetoTotal: 321 },
  33: { nombre: "IVA retenido madera", tipo: "R", tasa: 8, cambioSujetoTotal: 331 },
  34: { nombre: "IVA retenido trigo", tipo: "R", tasa: 4, cambioSujetoTotal: 341 },
  36: { nombre: "IVA retenido arroz", tipo: "R", tasa: 10, cambioSujetoTotal: 361 },
  37: { nombre: "IVA retenido hidrobiológicas", tipo: "R", tasa: 10, cambioSujetoTotal: 371 },
  38: { nombre: "IVA retenido chatarra", tipo: "R", tasa: "agregado" },
  39: { nombre: "IVA retenido PPA", tipo: "R", tasa: "agregado" },
  40: { nombre: "IVA retenido opcional", tipo: "R", tasa: "agregado" },
  41: { nombre: "IVA retenido construcción", tipo: "R", tasa: "agregado" },
  46: { nombre: "IVA retenido oro", tipo: "R", tasa: 100 },
  47: { nombre: "IVA retenido cartones", tipo: "R", tasa: "agregado" },
  48: { nombre: "IVA retenido frambuesas", tipo: "R", tasa: 14, cambioSujetoTotal: 481 },
  49: { nombre: "FC sin retención (solo Bolsa de Productos)", tipo: "R", tasa: 0 },
  53: { nombre: "Impuesto retenido suplementeros (Art. 74 N°5 Renta)", tipo: "R", tasa: 0.5 },
  // ── Impuestos adicionales (tipo A) ──
  14: { nombre: "IVA de margen de comercialización", tipo: "A", tasa: "variable" },
  50: { nombre: "IVA de margen de comercialización (prepago)", tipo: "A", tasa: "variable" },
  17: { nombre: "IVA anticipado faenamiento carne", tipo: "A", tasa: 5 },
  18: { nombre: "IVA anticipado carne", tipo: "A", tasa: 5 },
  19: { nombre: "IVA anticipado harina", tipo: "A", tasa: 12 },
  23: { nombre: "Art. 37 a,b,c (oro/platino/marfil, joyas, pieles finas)", tipo: "A", tasa: 15 },
  24: { nombre: "Art. 42 b (licores, piscos, whisky, aguardiente)", tipo: "A", tasa: 31.5 },
  25: { nombre: "Art. 42 c (vinos)", tipo: "A", tasa: 20.5 },
  26: { nombre: "Art. 42 c (cervezas y bebidas alcohólicas)", tipo: "A", tasa: 20.5 },
  27: { nombre: "Art. 42 a (bebidas analcohólicas y minerales)", tipo: "A", tasa: 10 },
  271: { nombre: "Art. 42 a inc.2 (bebidas con alto contenido de azúcar)", tipo: "A", tasa: 18 },
  28: { nombre: "Impuesto específico diésel", tipo: "A", tasa: "UTM/m³" },
  35: { nombre: "Impuesto específico gasolina", tipo: "A", tasa: "UTM/m³" },
  44: { nombre: "Art. 37 e,h,i,l (alfombras, casas rodantes, caviar, armas)", tipo: "A", tasa: 15 },
  45: { nombre: "Art. 37 j (pirotecnia)", tipo: "A", tasa: 50 },
  51: { nombre: "Gas natural comprimido", tipo: "A", tasa: "UTM/volumen" },
  52: { nombre: "Gas licuado de petróleo", tipo: "A", tasa: "UTM/volumen" },
};

/** Tipos de documento de Referencia frecuentes (TpoDocRef). Acepta también cualquier TipoDTE. */
export const TIPOS_DOC_REFERENCIA: Record<string, string> = {
  "SET": "Set de pruebas de certificación",
  "801": "Orden de Compra",
  "802": "Nota de Pedido",
  "803": "Contrato",
  "804": "Resolución",
  "805": "Proceso ChileCompra",
  "806": "Ficha ChileCompra",
  "807": "DUS (Documento Único de Salida)",
  "808": "Conocimiento de Embarque (B/L)",
  "809": "Air Will Bill (AWB)",
  "810": "MIC/DTA",
  "811": "Carta de Porte",
  "812": "Resolución del SNA donde se autoriza el documento",
  "813": "Pasaporte",
  "HES": "Hoja de Entrada de Servicios",
  "HEM": "Hoja de Entrada de Mercancías",
};

function lookupByName<K extends string | number>(tabla: Record<K, string>, q: string): K | undefined {
  const s = q.trim().toUpperCase();
  for (const [code, name] of Object.entries(tabla) as [K, string][]) {
    if (name.toUpperCase() === s) return code;
  }
  return undefined;
}

/** Nombre legible de un tipo de DTE (ej. 33 → "Factura Electrónica"). */
export function nombreTipoDte(tipo: number): string | undefined {
  return TIPOS_DTE[tipo];
}

/** Forma de pago por nombre (ej. "Contado" → 1). */
export function formaPagoCodigo(nombre: string): number | undefined {
  return lookupByName(FORMA_PAGO, nombre);
}
