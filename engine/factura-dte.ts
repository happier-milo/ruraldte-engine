// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Construye y firma el `<DTE>` de la familia comercial del SII chileno: factura afecta (33) y exenta
 * (34), factura de compra (46), guía de despacho (52), nota de débito (56), nota de crédito (61),
 * liquidación-factura (43) y los tres documentos de exportación (110/111/112).
 *
 * Arma el XML en el orden calibrado contra `DTE_v10.xsd` —el 43 sale con raíz `<Liquidacion>` y los
 * 110/111/112 con `<Exportaciones>`—, calcula el `MontoItem` de cada línea con sus descuentos y
 * recargos, embebe el TED timbrado con la llave del CAF y firma con tu `.pfx` (RSA-SHA1; el
 * `<Signature>` queda como hermano del `<Documento>`, dentro de `<DTE version="1.0">`). Todo en
 * memoria, sin red. Valida cuatro cosas y ninguna más: que haya al menos un ítem, que `documentId`
 * sirva de `xs:ID`, que 56/61/111/112 traigan referencia y que cada línea de un 43 declare
 * `tpoDocLiq`. No corre el XSD, en un 43 descarta los `descuentosGlobales` sin aviso, y `MntNeto`,
 * `IVA` y `MntTotal` salen tal cual se los pasas en `totals`: nadie cuadra esa suma contra el detalle
 * salvo el SII. Devuelve un string con declaración `iso-8859-1` — los bytes de transmisión salen de
 * `encodeLatin1` (`@ruraldte/engine/firma`), nunca de un `TextEncoder` UTF-8, o la firma deja de
 * validar. El sobre `EnvioDTE` vive en `/sobre-dte` y el envío al SII en `/sii-client`.
 *
 * @example
 * ```ts
 * import { buildSignedFacturaDte, type FacturaDteInput } from "@ruraldte/engine";
 *
 * const input: FacturaDteInput = {
 *   tipoDte: 33, folio: 1, fechaEmision: "2026-09-08", formaPago: 1,
 *   emisor: { rut: "77777777-7", razonSocial: "MI EMPRESA SPA", giro: "Servicios de tecnología",
 *             acteco: 620200, dirOrigen: "Av. Siempre Viva 742", cmnaOrigen: "Santiago" },
 *   receptor: { rut: "76543210-K", razonSocial: "CLIENTE SPA", giro: "Comercio",
 *               dirRecep: "Los Olmos 123", cmnaRecep: "Temuco" },
 *   items: [{ nombre: "Mantención mensual", cantidad: 1, precio: 100000 }],
 *   totals: { neto: 100000, iva: 19000, exento: 0, total: 119000 },
 *   cafXml: await Deno.readTextFile("CAF_33.xml"), // el CAF del tipo 33 que te otorgó el SII
 *   tstedIso: "2026-09-08T10:15:00", tmstFirma: "2026-09-08T10:15:00", documentId: "F33T1",
 * };
 *
 * const pfx = await Deno.readFile("firma.pfx");
 * const xml = buildSignedFacturaDte(input, pfx, Deno.env.get("PFX_PASSWORD")!);
 * // → <?xml … encoding="iso-8859-1"?><DTE version="1.0"><Documento ID="F33T1">…<TED>…</Documento>
 * //   <Signature>…</Signature></DTE>   ← listo para el sobre EnvioDTE
 * ```
 *
 * @module
 */
// ============================================================================
// factura-dte.ts — render del <DTE><Documento> de la FAMILIA COMERCIAL del SII:
//   33 factura afecta · 34 factura exenta · 46 factura de compra ·
//   52 guía de despacho · 56 nota de débito · 61 nota de crédito.
// ============================================================================
//
// Núcleo de la familia comercial del motor RuralDTE. Estructura calibrada contra
// el oráculo del SII `~/Documents/SII Dev/F60T33-ejemplo.xml` (factura 33 canónica)
// y el XSD `schema_dte/DTE_v10.xsd`:
//
//   <DTE version="1.0">
//     <Documento ID="F…">
//       <Encabezado>
//         <IdDoc><TipoDTE/><Folio/><FchEmis/>[<FmaPago/>][<FchVenc/>]</IdDoc>
//         <Emisor><RUTEmisor/><RznSoc/><GiroEmis/><Acteco/>[<CdgSIISucur/>]
//                 <DirOrigen/><CmnaOrigen/>[<CiudadOrigen/>]</Emisor>
//         <Receptor><RUTRecep/><RznSocRecep/>[<GiroRecep/>][<Contacto/>][<CorreoRecep/>]
//                   [<DirRecep/>][<CmnaRecep/>][<CiudadRecep/>]</Receptor>
//         <Totales>  ← afecta: MntNeto+TasaIVA+IVA+MntTotal · exenta: MntExe+MntTotal
//       </Encabezado>
//       <Detalle>NroLinDet,[CdgItem],[IndExe],NmbItem,[DscItem],QtyItem,[UnmdItem],PrcItem,MontoItem</Detalle> (1..N)
//       <Referencia>NroLinRef,TpoDocRef,FolioRef,FchRef,[CodRef],[RazonRef]</Referencia> (0..N)
//       <TED version="1.0">…</TED>               ← timbre (boleta-ted.ts, idéntico)
//       <TmstFirma/>
//     </Documento>
//   </DTE>
//
// DELTAS vs boleta (boleta-dte.ts): el Emisor usa RznSoc/GiroEmis (no RznSocEmisor/
// GiroEmisor) + Acteco OBLIGATORIO; el Receptor lleva GiroRecep/DirRecep/CmnaRecep
// (obligatorios en factura por práctica/validador); Totales lleva TasaIVA; el
// Detalle NO usa IndServicio; la Referencia lleva FchRef OBLIGATORIO (boleta lo
// omite) y CodRef es enum 1/2/3 (anula/corrige texto/corrige monto).
//
// La firma per-DTE (signDte = signBoletaDte) y el TED (buildTed) son genéricos —
// se reutilizan idénticos (verificado vs F60T33: misma forma DD + Reference c14n).
//
// Montos: pesos CLP enteros (sin centavos). Encoding final: iso-8859-1 (ensamblado).
// ============================================================================

import { buildTed, compactSiiDd } from "./boleta-ted.ts";
import { signDte } from "./xml-signature.ts";
import { sanitizeSiiText } from "./sii-text.ts";

/**
 * Tipos de la familia comercial que arma este builder:
 *   33 factura afecta · 34 factura exenta · 46 factura de compra ·
 *   52 guía de despacho · 56 nota de débito · 61 nota de crédito.
 */
export type FacturaDteType = 33 | 34 | 43 | 46 | 52 | 56 | 61 | 110 | 111 | 112;

function escText(s: string): string {
  return sanitizeSiiText(s) // puntuación Unicode → Latin-1 (el DTE va en iso-8859-1)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}
function el(tag: string, value: string | number): string {
  return `<${tag}>${escText(String(value))}</${tag}>`;
}
// Normaliza un RUT al formato canónico del SII (sin puntos, con guion, DV mayúscula):
// "76.123.456-k" → "76123456-K". El XSD de RUTRecep lo exige. Se aplica en UN punto
// (buildFacturaDocumento) para que el XML y el TED usen idéntico valor (evita "Firma TED
// no coincide"). Idempotente. El receptor extranjero (55555555-5) queda intacto.
function normRut(rut: string): string {
  const c = rut.replace(/[.\s-]/g, "").toUpperCase();
  return c.length < 2 ? c : `${c.slice(0, -1)}-${c.slice(-1)}`;
}
/** PrcItem Dec12_6: hasta 6 decimales sin ceros finales (round(Qty×Prc)=MontoItem). */
function fmtDec6(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

/**
 * Una línea del `<Detalle>`: qué se vende, en qué cantidad y a qué precio unitario neto.
 * El builder calcula `MontoItem` = `round(precio × cantidad) − descuentoMonto + recargoMonto`
 * (a 4 decimales si alguno de esos valores no es entero, el caso de exportación) y, si el precio
 * queda en 0, omite `QtyItem`/`UnmdItem`/`PrcItem` porque Dec12_6 no admite 0. Pasar `montoItem`
 * no es un override cualquiera: manda la línea por la rama de liquidación-factura (43), que emite
 * `QtyItem` + `UnmdItem` sin `PrcItem` y no escribe descuentos, recargos ni `Retenedor`.
 */
export type FacturaDteItem = {
  nombre: string;
  cantidad: number;
  /** Precio unitario NETO (sin IVA), pesos enteros. */
  precio: number;
  /** Unidad de medida (opcional en factura). */
  unidadMedida?: string;
  /** true = línea exenta/no afecta a IVA (agrega IndExe=1). */
  exento?: boolean;
  /** true = línea sujeta a retención por agente retenedor (FC 46 cambio de sujeto):
   *  emite <Retenedor><IndAgente>R</IndAgente></Retenedor> tras IndExe, antes de NmbItem
   *  (DTE_v10.xsd L1413). Obligatorio para que el set-review reconozca la línea como base
   *  de retención (si no → reparo "Los Valores de la Línea No Cuadran"). */
  indAgente?: boolean;
  /**
   * true = línea SIN valor comercial (guía 52 traslado interno, IndTraslado=5): emite
   * NmbItem + QtyItem + UnmdItem + MontoItem=0, sin PrcItem ni IndExe. No constituye
   * venta → MontoItem=0 con QtyItem es válido (a diferencia de QtyItem sin PrcItem en
   * líneas con valor, que repara "Valores de la Línea No Cuadran").
   */
  sinValor?: boolean;
  /** Descripción larga del ítem (DscItem). */
  descripcion?: string;
  /** Código del ítem (CdgItem → TpoCodigo/VlrCodigo). */
  codigo?: { tipo: string; valor: string };
  /** CPCS (Código de Producto de Cambio de Sujeto): segundo <CdgItem> que ancla la línea del FC 46
   *  como base de retención de cambio de sujeto. Sin él, el validador del SII no cuenta la línea en
   *  el campo 117 (Σ=0 → MontoImp esperado [0] → HED-2-302). Va ANTES de <Retenedor> (orden XSD). */
  cpcs?: string;
  /**
   * Descuento por línea en % (DescuentoPct). Si se da, el builder calcula
   * DescuentoMonto = round(MontoItem × pct/100) salvo que se pase explícito.
   */
  descuentoPct?: number;
  /** Descuento por línea en pesos (DescuentoMonto). Override del cálculo por pct. */
  descuentoMonto?: number;
  /**
   * Recargo por línea en % (RecargoPct, PctType = xs:decimal 3+2, minInclusive 0.01). Va tras
   * DescuentoPct/DescuentoMonto y antes de CodImpAdic/MontoItem (orden XSD).
   * ⚠️ RecargoMonto (campo par) es MntImpType=xs:positiveInteger en TODOS los subtipos → SOLO admite
   * enteros >0 (ni 0 ni 0.1). El builder emite RecargoMonto SOLO si el monto calculado es entero
   * positivo; si es fraccionario (ej. export 10% de 1 USD = 0.1) emite SOLO <RecargoPct> y omite
   * <RecargoMonto>, reflejando el recargo en MontoItem (decimal/4 en el subtipo Exportaciones).
   * El % se computa sobre grossItem (Qty×Prc). Caso 4903532-1 del set: PrcItem=1 + RecargoPct=10 →
   * MontoItem=1.1 (recargo "EN LA LÍNEA DE ITEM", no global ni plegado en el precio).
   */
  recargoPct?: number;
  /** Recargo por línea en pesos (RecargoMonto, positiveInteger). Override del cálculo por pct. */
  recargoMonto?: number;
  /**
   * Código de impuesto/retención adicional de la línea (CodImpAdic, ImpAdicDTEType).
   * FC 46 con retención total → 15 en cada línea afecta: el SII recalcula la retención
   * de Totales (ImptoReten) sumando el MontoItem de las líneas con este código por la
   * TasaImp; sin él, la base es 0 y reparós HED-2-300/302.
   */
  codImpAdic?: number;
  /**
   * MontoItem EXPLÍCITO (override de round(precio×cantidad)). Liquidación-Factura (43):
   * las líneas son AGREGADOS "CANTIDAD n / TOTAL LINEA m" sin precio unitario entero
   * (m/n suele ser decimal). El builder emite QtyItem=cantidad + PrcItem=m/n (Dec12_6,
   * hasta 6 decimales → round(Qty×Prc)=MontoItem) + MontoItem=este valor. Admite NEGATIVO
   * (NC/devoluciones dentro de la liquidación): si <0, omite Qty/Prc (Dec12_6 minInclusive
   * 0.000001 no admite ≤0) → línea = NmbItem + MontoItem negativo.
   */
  montoItem?: number;
  /**
   * Liquidación-Factura (43): TpoDocLiq — tipo de documento que se LIQUIDA en esta línea
   * (OBLIGATORIO en el Detalle de Liquidacion, tras CdgItem y antes de IndExe). Ej: 30=Factura,
   * 33=Factura Electrónica, 39=Boleta Electrónica, 61=NC, 43=Liquidación, 99=Anticipo/otros.
   */
  tpoDocLiq?: number;
};

/**
 * Descuento o recargo GLOBAL del documento (DscRcgGlobal) — afecta al total.
 * Orden XSD: NroLinDR, TpoMov, [GlosaDR], TpoValor, ValorDR, [ValorDROtrMnda], [IndExeDR].
 */
export type FacturaDscRcgGlobal = {
  /** "D" = descuento · "R" = recargo. */
  tipo: "D" | "R";
  /** "%" = porcentaje · "$" = monto en pesos. */
  valorTipo: "%" | "$";
  /** Valor del descuento/recargo (pct o pesos según valorTipo). */
  valor: number;
  /** Glosa descriptiva (opcional). */
  glosa?: string;
  /**
   * Exportación (110/111/112): valor del descuento/recargo en la OTRA moneda (CLP), Dec14_4.
   * Campo 6 del DscRcgGlobal (formato_dte): "Aplica en montos de desctos. o recargos" → es el
   * MONTO equivalente (no el porcentaje) en la otra moneda. OBLIGATORIO en export (flags 1/1/1),
   * mientras ValorDR baja a opcional. Va tras ValorDR y antes de IndExeDR (orden XSD).
   */
  valorDROtrMnda?: number;
  /** IndExeDR: 1 = sobre montos exentos/no afectos · 2 = no facturable. Omitir = sobre afectos. */
  exento?: 1 | 2;
};

/** Impuesto/retención adicional (ImptoReten). FC 46 / cambio de sujeto / IEPD, etc. */
export type FacturaImptoReten = {
  /** Código del impuesto/retención (tabla SII; ej. 15 = retención IVA cambio sujeto). */
  tipo: number;
  /** Tasa (%) — opcional para montos fijos. */
  tasa?: number;
  /** Monto del impuesto/retención. */
  monto: number;
};

/**
 * Montos del `<Totales>` del encabezado, en pesos enteros (o en la moneda del documento si hay
 * `tpoMoneda`). El builder no los cuadra contra el detalle: `neto`, `exento` e `iva` solo se emiten
 * si son mayores que 0 —y `TasaIVA`, 19 por defecto, solo cuando hay neto—, mientras `MntTotal` sale
 * siempre con el valor que le pases. Con `tpoMoneda` cambia a los Totales de exportación:
 * `TpoMoneda` + `MntExe` + `MntTotal`, sin `MntNeto` ni `IVA`; `otraMoneda` se emite solo en esa
 * rama y como hermano de `<Totales>`, no dentro.
 */
export type FacturaDteTotals = {
  /** Monto neto afecto (0 si documento totalmente exento). */
  neto: number;
  /** IVA (0 si exento). */
  iva: number;
  /** Monto exento. */
  exento: number;
  /** Monto total. */
  total: number;
  /** Tasa de IVA (%). Default 19. Solo se emite si hay neto>0. */
  tasaIva?: number;
  /**
   * IVA No Retenido (IVANoRet) — FC 46 / cambio de sujeto: parte del IVA que NO
   * fue retenida por el comprador. ⚠️ La matriz de retención de la FC 46 debe
   * calibrarse contra un oráculo real de calibración antes de certificar (igual que
   * boleta) — este campo es el slot, no la lógica fiscal completa.
   */
  ivaNoRet?: number;
  /** Impuestos y retenciones adicionales (ImptoReten), 0..20. */
  impuestosReten?: FacturaImptoReten[];
  /**
   * Liquidación-Factura (43): el IVA del encabezado se separa en IVA PROPIO (del mandatario,
   * = IVA de las comisiones) e IVA de TERCEROS (de los documentos liquidados). Formato DTE
   * campos 113/114 (<IVAProp>/<IVATerc>), van tras <IVA> y antes de <ImptoReten>/<Comisiones>.
   * Son ValorType (pueden ser negativos en liquidación) y opcionales — pero el ejemplo
   * CERTIFICADO del SII SIEMPRE los emite, así que el motor del 43 los emite
   * cuando hay IVA (IVAProp=IVA de comisiones, IVATerc=IVA−IVAProp).
   */
  ivaProp?: number;
  ivaTerc?: number;
  /**
   * Liquidación-Factura (43): totales de Comisiones y Otros Cargos (suma de la sección
   * <Comisiones>). Van en el encabezado <Totales> tras IVA, antes de MntTotal (formato
   * DTE §121-123). El MntTotal de la liquidación los RESTA: MntTotal = MntNeto + MntExe +
   * IVA − ValComNeto − ValComExe − ValComIVA (el mandatario se queda la comisión). Pueden
   * ser negativos en liquidación.
   */
  valComNeto?: number;
  valComExe?: number;
  valComIVA?: number;
  /**
   * Exportación (110/111/112): tipo de moneda del documento (TpoMoneda, ej. "DOLAR USA").
   * Si está presente, el builder emite los Totales de exportación: TpoMoneda + MntExe +
   * MntTotal (sin MntNeto/IVA — la exportación es exenta), montos en la moneda extranjera.
   */
  tpoMoneda?: string;
  /** Exportación: sección OtraMoneda (equivalente en otra moneda, típicamente CLP). */
  otraMoneda?: FacturaOtraMoneda;
};

/**
 * Sección <OtraMoneda> (exportación 110/111/112): los totales del documento expresados en
 * una segunda moneda (típicamente PESO CL). Orden XSD: TpoMoneda, [TpoCambio], [MntExeOtrMnda],
 * MntTotOtrMnda.
 */
export type FacturaOtraMoneda = {
  /** Tipo de la otra moneda (ej. "PESO CL"). */
  tpoMoneda: string;
  /** Tipo de cambio respecto de la moneda del documento (Dec6_4). */
  tpoCambio?: number;
  /** Monto exento en la otra moneda. */
  mntExeOtrMnda?: number;
  /** Monto total en la otra moneda (obligatorio si hay OtraMoneda). */
  mntTotOtrMnda: number;
};

/**
 * Una línea de la sección <Comisiones> (Comisiones y Otros Cargos) — obligatoria en
 * Liquidación-Factura (43), opcional en FC 46. Formato DTE §F (líneas 2647-2685).
 * "No modifican la base del impuesto de la operación principal" → el IVA de comisión es
 * aparte del IVA de las ventas. Todos los valores pueden ser negativos en liquidación.
 */
export type FacturaComision = {
  /** C = comisión · O = otros cargos (TipoMovim, obligatorio). */
  tipoMovim: "C" | "O";
  /** Glosa descriptiva (≤60). */
  glosa: string;
  /** Valor neto (afecto) de la comisión. */
  valComNeto?: number;
  /** Valor exento/no afecto de la comisión. */
  valComExe?: number;
  /** IVA de la comisión (= round(valComNeto × tasaIVA)). */
  valComIVA?: number;
};

/**
 * Referencia de factura/NC/ND. `FchRef` es OBLIGATORIO (XSD DTE_v10 línea 1865).
 * Orden XSD: NroLinRef, TpoDocRef, [IndGlobal], FolioRef, [RUTOtr], FchRef, [CodRef], [RazonRef].
 *
 * - NC/ND: `tipoDocRef`=tipo del doc corregido (ej "33"), `folioRef`=su folio,
 *   `fchRef`=su fecha, `codRef` 1=anula / 2=corrige texto / 3=corrige monto.
 * - Set de certificación: `tipoDocRef`="SET", `folioRef`=n° de caso,
 *   `fchRef`=fecha de emisión, `razonRef`="CASO N" (sin codRef).
 */
export type FacturaDteReferencia = {
  tipoDocRef: string;
  folioRef: number | string;
  /** AAAA-MM-DD (obligatorio). */
  fchRef: string;
  /** 1=anula · 2=corrige texto · 3=corrige montos. Omitir para SET. (El XSD restringe a 1/2/3.) */
  codRef?: 1 | 2 | 3;
  razonRef?: string;
};

/** Sección Transporte (guía de despacho 52 + exportación). Orden XSD: Patente, PatenteCarro, RUTTrans, Chofer, DirDest, CmnaDest, CiudadDest, [Aduana], [FchSalida], [HraSalida], [FchLlegada]. */
export type FacturaTransporte = {
  /** Patente del vehículo (máx 8). */
  patente?: string;
  /**
   * Patente del carro/remolque o semirremolque (PatenteCarro, máx 8). Campo de la
   * Res. Ex. SII N°154/2025 (oblig. 2026-05-01); va TRAS Patente en el XSD 2026-02-06.
   * "Relevante si Indicador Tipo de Despacho 2 o 3" → opcional (sólo si hay carro anexo).
   */
  patenteCarro?: string;
  /** RUT del transportista. */
  rutTransportista?: string;
  /** Chofer: RUT + nombre (máx 30). */
  chofer?: { rut: string; nombre: string };
  /** Dirección de destino del traslado. */
  dirDest?: string;
  /** Comuna de destino. */
  cmnaDest?: string;
  /** Ciudad de destino. */
  ciudadDest?: string;
  /** Exportación: sección Aduana (todos sus campos son opcionales en el XSD). */
  aduana?: FacturaAduana;
  /**
   * Res. Ex. SII N°154/2025 (guía de traslado, oblig. 2026-05-01). ⚠️ En el XSD 2026-02-06
   * estos 3 campos son los ÚLTIMOS del <Transporte> (TRAS Aduana), NO del IdDoc —a diferencia
   * del ejemplo de la resolución, que es ilustrativo; manda el XSD (validado con xmllint).
   *   fchSalida  = FchSalida  (AAAA-MM-DD, fecha efectiva de inicio del traslado),
   *   horaSalida = HraSalida  (HH:MM:SS, hora de inicio),
   *   fchLlegada = FchLlegada (AAAA-MM-DD, fecha de llegada).
   */
  fchSalida?: string;
  horaSalida?: string;
  fchLlegada?: string;
};

/**
 * Sección <Aduana> (exportación 110/111/112), dentro de <Transporte>. Todos los campos son
 * opcionales (XSD minOccurs=0). Orden XSD: CodModVenta, CodClauVenta, TotClauVenta, CodViaTransp,
 * NombreTransp, RUTCiaTransp, NomCiaTransp, IdAdicTransp, Booking, Operador, CodPtoEmbarque,
 * IdAdicPtoEmb, CodPtoDesemb, IdAdicPtoDesemb, Tara, …, TotItems, TotBultos, TipoBultos*, …,
 * MntFlete, MntSeguro, CodPaisRecep, CodPaisDestin. (Codificación por tablas Aduana del SII.)
 */
export type FacturaAduana = {
  /** Código modalidad de venta (tabla Aduana). */
  codModVenta?: number;
  /** Código cláusula de venta (FOB, CIF, etc. — tabla Aduana). */
  codClauVenta?: number;
  /** Total cláusula de venta (Dec16_2, en la moneda del documento). */
  totClauVenta?: number;
  /** Código vía de transporte (marítima, aérea, etc. — tabla Aduana). */
  codViaTransp?: number;
  /** Nombre del transporte (nave/vuelo). */
  nombreTransp?: string;
  /** Código puerto de embarque (tabla Aduana). */
  codPtoEmbarque?: number;
  /** Código puerto de desembarque (tabla Aduana). */
  codPtoDesemb?: number;
  /** Tara (positiveInteger, 7 díg) + código unidad de medida de tara (tabla Aduana). */
  tara?: number;
  codUnidMedTara?: number;
  /** Peso bruto total (Dec10_2) + código unidad de medida (tabla Aduana). */
  pesoBruto?: number;
  codUnidPesoBruto?: number;
  /** Peso neto total (Dec10_2) + código unidad de medida (tabla Aduana). */
  pesoNeto?: number;
  codUnidPesoNeto?: number;
  /** Total de ítems. */
  totItems?: number;
  /** Total de bultos. */
  totBultos?: number;
  /**
   * Tipos de bulto (Aduana, hasta 10). CodTpoBultos = tabla Tipos de Bultos; CantBultos = cantidad;
   * Marcas = identificación (cuando es distinto de contenedor). Para bultos tipo CONTENEDOR el SII
   * exige (regla de negocio, aunque el XSD los marque minOccurs=0): IdContainer = id del contenedor
   * (ISO 6346 con dígito verificador), Sello = sello del contenedor (con dígito verificador),
   * EmisorSello = nombre del emisor del sello. Omitirlos en un bulto contenedor → REPARO HED-2-804
   * "Campo obligatorio: Sello / Id. Container".
   */
  tipoBultos?: {
    codTpoBultos?: number;
    cantBultos?: number;
    marcas?: string;
    idContainer?: string;
    sello?: string;
    emisorSello?: string;
  }[];
  /** Monto del flete (en la moneda del documento). */
  mntFlete?: number;
  /** Monto del seguro (en la moneda del documento). */
  mntSeguro?: number;
  /** Código país receptor (tabla Aduana). */
  codPaisRecep?: number;
  /** Código país destino (tabla Aduana). */
  codPaisDestin?: number;
};

/**
 * Todo lo que `buildFacturaDocumento` necesita para armar el DTE: identificación, partes, detalle,
 * totales y el material del timbre (`cafXml`, `tstedIso`). Valida cuatro cosas —al menos un ítem,
 * `documentId` usable como `xs:ID`, referencia en 56/61/111/112 y `tpoDocLiq` en cada línea de un
 * 43—; los montos, el formato de las fechas (`AAAA-MM-DD`; los timestamps, `AAAA-MM-DDThh:mm:ss`)
 * y el calce del folio con el rango del CAF no se revisan. Del RUT se normaliza solo el del receptor
 * (sin puntos, con guion y DV en mayúscula, ej. `76543210-K`); el del emisor va tal cual.
 */
export type FacturaDteInput = {
  tipoDte: FacturaDteType;
  folio: number;
  /** AAAA-MM-DD. */
  fechaEmision: string;
  /** Forma de pago: 1=contado · 2=crédito · 3=sin costo. Opcional. */
  formaPago?: 1 | 2 | 3;
  /** Exportación: forma de pago exportación (FmaPagExp, tabla Aduana — ej. 32=ANTICIPO, 11=ACRED). */
  fmaPagExp?: number;
  /**
   * AAAA-MM-DD. Fecha de cancelación (FchCancel). Obligatoria en factura de exportación cuando
   * FmaPagExp indica ANTICIPO (campo 15 formato_dte). Va tras FmaPagExp y antes de FchVenc (orden XSD).
   */
  fchCancel?: string;
  /** AAAA-MM-DD. Fecha de vencimiento (opcional). */
  fchVenc?: string;
  /**
   * Guía de despacho (52): tipo de despacho + indicador de traslado (IdDoc).
   *   tipoDespacho 1=por cuenta del comprador · 2=del emisor a instalaciones del
   *   comprador · 3=del emisor a otras instalaciones.
   *   indTraslado 1=constituye venta · 2=venta por efectuar · 3=consignación ·
   *   4=promoción/donación · 5=traslado interno · 6=otros no-venta · 7=devolución ·
   *   8=traslado para exportación (no venta) · 9=venta para exportación (XSD 2026-02-06).
   * OJO: los campos de traslado de la Res.154 (fecha/hora de salida y fecha de llegada)
   * van en <Transporte> según el XSD 2026-02-06 (NO en IdDoc) → ver FacturaTransporte.
   */
  despacho?: { tipoDespacho?: 1 | 2 | 3; indTraslado: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 };
  /** Factura de compra (46): tipo de transacción de compra (TpoTranCompra). */
  tpoTranCompra?: number;
  /**
   * Exportación de SERVICIOS (110): indicador de servicio (IndServicio, formato_dte campo 9).
   * 3 = Factura de Servicios (servicios calificados por Aduana, ej. asesorías), 4 = Servicios de
   * Hotelería, 5 = Servicio Periódico Domiciliario, 6 = Servicio Periódico. Va en el IdDoc tras el
   * bloque de despacho (TipoDespacho/IndTraslado) y antes de TpoTranCompra/FmaPago (orden XSD: en
   * el subtipo Exportaciones, TipoDespacho → IndServicio → FmaPago; en Documento, IndTraslado →
   * TpoImpresion → IndServicio → MntBruto). Sólo se emite si está seteado (export de bienes no lo lleva).
   */
  indServicio?: number;
  /** Transporte (guía 52 y opcional en otros): vehículo, transportista, destino. */
  transporte?: FacturaTransporte;
  emisor: {
    rut: string;
    /** Razón social (RznSoc). */
    razonSocial: string;
    /** Giro (GiroEmis). */
    giro: string;
    /** Código de actividad económica (Acteco) — OBLIGATORIO en factura. */
    acteco: number;
    dirOrigen: string;
    cmnaOrigen: string;
    ciudadOrigen?: string;
    /** Código de sucursal SII (CdgSIISucur). */
    cdgSiiSucur?: string;
  };
  receptor: {
    rut: string;
    /** Razón social (RznSocRecep) — OBLIGATORIO. */
    razonSocial: string;
    /** Giro del receptor (GiroRecep) — obligatorio en factura por validador. */
    giro?: string;
    dirRecep?: string;
    cmnaRecep?: string;
    ciudadRecep?: string;
    contacto?: string;
    correo?: string;
    /**
     * Exportación (110/111/112): receptor extranjero. Va tras RznSocRecep (orden XSD:
     * RUTRecep, [CdgIntRecep], RznSocRecep, [Extranjero], [GiroRecep], …). nacionalidad =
     * código país (tabla Aduana). El RUTRecep para receptor extranjero suele ser 55555555-5.
     * NumId (id tributario extranjero) es de la Factura de Turista (TipoFactEsp=1), NO de la
     * exportación normal (que sólo lleva <Nacionalidad>) → opcional, se omite si no se setea.
     */
    extranjero?: { numId?: string; nacionalidad?: number };
  };
  items: FacturaDteItem[];
  totals: FacturaDteTotals;
  /** Descuentos/recargos globales del documento (DscRcgGlobal), entre Detalle y Referencia. */
  descuentosGlobales?: FacturaDscRcgGlobal[];
  /** Referencias (NC/ND obligan ≥1; factura/set también las usan). */
  referencias?: FacturaDteReferencia[];
  /** Liquidación-Factura (43): sección <Comisiones> (Comisiones y Otros Cargos), 0..20. */
  comisiones?: FacturaComision[];
  /** CAF XML completo (para el TED), del tipo correspondiente. */
  cafXml: string;
  /** Timestamp del timbre, AAAA-MM-DDThh:mm:ss. */
  tstedIso: string;
  /** Timestamp de firma del DTE, AAAA-MM-DDThh:mm:ss. */
  tmstFirma: string;
  /** Valor del atributo ID del <Documento> (Reference URI de la firma). */
  documentId: string;
};

/**
 * Lo que devuelve `buildFacturaDocumento`: el XML del documento compacto sin firmar y el ID al que
 * apunta la `Reference` de la firma. La raíz no siempre es `<Documento>` —el 43 sale como
 * `<Liquidacion>` y los 110/111/112 como `<Exportaciones>`—, pero la firma referencia el ID, no el
 * nombre del elemento.
 */
export type BuildFacturaDocumentoResult = {
  /** <Documento ID="…">…</Documento> compacto, SIN firma. */
  documento: string;
  documentId: string;
};

function buildEncabezado(input: FacturaDteInput): string {
  const { emisor, receptor, totals } = input;
  // IdDoc orden XSD: TipoDTE, Folio, FchEmis, [TipoDespacho], [IndTraslado], …, [IndServicio],
  // …, [TpoTranCompra], …, [FmaPago], [FmaPagExp], [FchCancel], …, [FchVenc].
  const idParts: string[] = [
    el("TipoDTE", input.tipoDte),
    el("Folio", input.folio),
    el("FchEmis", input.fechaEmision),
  ];
  if (input.despacho) {
    // TipoDespacho opcional: en traslado interno (IndTraslado=5) se OMITE (los bienes no se
    // despachan a un tercero) → si va, el SII repara "Indicadores no Corresponden".
    if (input.despacho.tipoDespacho !== undefined) idParts.push(el("TipoDespacho", input.despacho.tipoDespacho));
    idParts.push(el("IndTraslado", input.despacho.indTraslado));
  }
  // IndServicio (export de servicios): tras el bloque de despacho, antes de TpoTranCompra/FmaPago.
  // Posición válida en ambos subtipos del XSD (Exportaciones: TipoDespacho→IndServicio→FmaPago;
  // Documento: …IndTraslado→TpoImpresion→IndServicio→MntBruto→TpoTranCompra→FmaPago).
  if (input.indServicio !== undefined) idParts.push(el("IndServicio", input.indServicio));
  if (input.tpoTranCompra !== undefined) idParts.push(el("TpoTranCompra", input.tpoTranCompra));
  if (input.formaPago) idParts.push(el("FmaPago", input.formaPago));
  // Exportación: FmaPagExp va tras FmaPago, luego FchCancel, luego FchVenc (IdDoc, DTE_v10.xsd:
  // FmaPago, FmaPagExp, FchCancel, MntCancel, …, FchVenc). FchCancel obligatorio si FmaPagExp=anticipo.
  if (input.fmaPagExp !== undefined) idParts.push(el("FmaPagExp", input.fmaPagExp));
  if (input.fchCancel) idParts.push(el("FchCancel", input.fchCancel));
  if (input.fchVenc) idParts.push(el("FchVenc", input.fchVenc));
  const idDoc = `<IdDoc>${idParts.join("")}</IdDoc>`;

  // Emisor orden XSD: RUTEmisor, RznSoc, GiroEmis, …, Acteco, …, [CdgSIISucur],
  // [DirOrigen], [CmnaOrigen], [CiudadOrigen].
  const emisorParts: string[] = [
    el("RUTEmisor", emisor.rut),
    el("RznSoc", emisor.razonSocial.slice(0, 100)),
    el("GiroEmis", emisor.giro.slice(0, 80)),
    el("Acteco", emisor.acteco),
  ];
  if (emisor.cdgSiiSucur) emisorParts.push(el("CdgSIISucur", emisor.cdgSiiSucur));
  emisorParts.push(el("DirOrigen", emisor.dirOrigen.slice(0, 70)));
  emisorParts.push(el("CmnaOrigen", emisor.cmnaOrigen.slice(0, 20)));
  if (emisor.ciudadOrigen) emisorParts.push(el("CiudadOrigen", emisor.ciudadOrigen.slice(0, 20)));
  const emisorXml = `<Emisor>${emisorParts.join("")}</Emisor>`;

  // Receptor orden XSD: RUTRecep, [CdgIntRecep], RznSocRecep, [Extranjero],
  // [GiroRecep], [Contacto], [CorreoRecep], [DirRecep], [CmnaRecep], [CiudadRecep].
  const recParts: string[] = [
    el("RUTRecep", receptor.rut),
    el("RznSocRecep", receptor.razonSocial.slice(0, 100)),
  ];
  // Exportación: <Extranjero> ([NumId] + Nacionalidad) tras RznSocRecep, antes de GiroRecep.
  // NumId es de Factura de Turista (TipoFactEsp=1), NO de export normal → sólo se emite si está
  // seteado y no vacío; la exportación corriente lleva sólo <Nacionalidad>.
  if (receptor.extranjero) {
    const exParts: string[] = [];
    if (receptor.extranjero.numId && receptor.extranjero.numId.trim() !== "") {
      exParts.push(el("NumId", receptor.extranjero.numId.slice(0, 20)));
    }
    if (receptor.extranjero.nacionalidad !== undefined) exParts.push(el("Nacionalidad", receptor.extranjero.nacionalidad));
    recParts.push(`<Extranjero>${exParts.join("")}</Extranjero>`);
  }
  if (receptor.giro) recParts.push(el("GiroRecep", receptor.giro.slice(0, 40)));
  if (receptor.contacto) recParts.push(el("Contacto", receptor.contacto.slice(0, 80)));
  if (receptor.correo) recParts.push(el("CorreoRecep", receptor.correo.slice(0, 80)));
  if (receptor.dirRecep) recParts.push(el("DirRecep", receptor.dirRecep.slice(0, 70)));
  if (receptor.cmnaRecep) recParts.push(el("CmnaRecep", receptor.cmnaRecep.slice(0, 20)));
  if (receptor.ciudadRecep) recParts.push(el("CiudadRecep", receptor.ciudadRecep.slice(0, 20)));
  const receptorXml = `<Receptor>${recParts.join("")}</Receptor>`;

  // Transporte (guía 52): va entre Receptor y Totales (XSD: Receptor, [RUTSolicita], [Transporte], Totales).
  const transporteXml = input.transporte ? buildTransporte(input.transporte) : "";

  // Totales orden XSD: MntNeto, MntExe, …, TasaIVA, IVA, …, [ImptoReten], [IVANoRet], …, MntTotal.
  // Afecta (33/56/61 afecto): MntNeto + TasaIVA + IVA. Exenta (34/61 exento): MntExe.
  const totalesParts: string[] = [];
  if (totals.tpoMoneda) {
    // Exportación (110/111/112): Totales en moneda extranjera — TpoMoneda + MntExe + MntTotal
    // (sin MntNeto/IVA; la exportación es exenta) + OtraMoneda opcional (equivalente CLP).
    totalesParts.push(el("TpoMoneda", totals.tpoMoneda));
    if (totals.exento > 0) totalesParts.push(el("MntExe", totals.exento));
    totalesParts.push(el("MntTotal", totals.total));
    // OtraMoneda es hijo de ENCABEZADO (hermano de Totales), NO va dentro de Totales.
    let otraMonedaXml = "";
    if (totals.otraMoneda) {
      const om = totals.otraMoneda;
      const omParts = [el("TpoMoneda", om.tpoMoneda)];
      if (om.tpoCambio !== undefined) omParts.push(el("TpoCambio", om.tpoCambio));
      if (om.mntExeOtrMnda !== undefined) omParts.push(el("MntExeOtrMnda", Math.round(om.mntExeOtrMnda)));
      omParts.push(el("MntTotOtrMnda", Math.round(om.mntTotOtrMnda)));
      otraMonedaXml = `<OtraMoneda>${omParts.join("")}</OtraMoneda>`;
    }
    return `<Encabezado>${idDoc}${emisorXml}${receptorXml}${transporteXml}<Totales>${totalesParts.join("")}</Totales>${otraMonedaXml}</Encabezado>`;
  }
  if (totals.neto > 0) totalesParts.push(el("MntNeto", totals.neto));
  if (totals.exento > 0) totalesParts.push(el("MntExe", totals.exento));
  if (totals.neto > 0) totalesParts.push(el("TasaIVA", totals.tasaIva ?? 19));
  if (totals.iva > 0) totalesParts.push(el("IVA", totals.iva));
  // Liquidación-Factura (43): IVA propio (del mandatario = IVA de comisiones) e IVA de terceros
  // (de los documentos liquidados) — campos 113/114, tras <IVA>, antes de ImptoReten/Comisiones.
  // ValorType → admiten negativos en liquidación; el ejemplo CERTIFICADO los lleva siempre.
  if (totals.ivaProp !== undefined) totalesParts.push(el("IVAProp", Math.round(totals.ivaProp)));
  if (totals.ivaTerc !== undefined) totalesParts.push(el("IVATerc", Math.round(totals.ivaTerc)));
  for (const imp of totals.impuestosReten ?? []) {
    const impParts = [el("TipoImp", imp.tipo)];
    if (imp.tasa !== undefined) impParts.push(el("TasaImp", imp.tasa));
    impParts.push(el("MontoImp", Math.round(imp.monto)));
    totalesParts.push(`<ImptoReten>${impParts.join("")}</ImptoReten>`);
  }
  if (totals.ivaNoRet !== undefined && totals.ivaNoRet > 0) {
    totalesParts.push(el("IVANoRet", Math.round(totals.ivaNoRet)));
  }
  // Liquidación-Factura (43): totales de Comisiones y Otros Cargos en un WRAPPER <Comisiones>
  // (DTE_v10.xsd Liquidacion/Totales: tras ImptoReten, antes de MntTotal; ValComNeto/Exe/IVA son
  // ValorType → pueden ser negativos). El total ya viene con ellos restados (MntTotal =
  // MntNeto+MntExe+IVA − ValComNeto−ValComExe−ValComIVA).
  if (totals.valComNeto !== undefined || totals.valComExe !== undefined || totals.valComIVA !== undefined) {
    const cParts: string[] = [];
    if (totals.valComNeto !== undefined) cParts.push(el("ValComNeto", Math.round(totals.valComNeto)));
    if (totals.valComExe !== undefined) cParts.push(el("ValComExe", Math.round(totals.valComExe)));
    if (totals.valComIVA !== undefined) cParts.push(el("ValComIVA", Math.round(totals.valComIVA)));
    totalesParts.push(`<Comisiones>${cParts.join("")}</Comisiones>`);
  }
  totalesParts.push(el("MntTotal", totals.total));
  const totalesXml = `<Totales>${totalesParts.join("")}</Totales>`;

  return `<Encabezado>${idDoc}${emisorXml}${receptorXml}${transporteXml}${totalesXml}</Encabezado>`;
}

/** Sección <Transporte> de la guía de despacho (orden XSD). */
function buildTransporte(t: FacturaTransporte): string {
  const parts: string[] = [];
  if (t.patente) parts.push(el("Patente", t.patente.slice(0, 8)));
  // PatenteCarro (carro/remolque) — Res.154, va TRAS Patente y antes de RUTTrans (orden XSD).
  if (t.patenteCarro) parts.push(el("PatenteCarro", t.patenteCarro.slice(0, 8)));
  if (t.rutTransportista) parts.push(el("RUTTrans", t.rutTransportista));
  if (t.chofer) {
    parts.push(
      `<Chofer>${el("RUTChofer", t.chofer.rut)}${el("NombreChofer", t.chofer.nombre.slice(0, 30))}</Chofer>`,
    );
  }
  if (t.dirDest) parts.push(el("DirDest", t.dirDest.slice(0, 70)));
  if (t.cmnaDest) parts.push(el("CmnaDest", t.cmnaDest.slice(0, 20)));
  if (t.ciudadDest) parts.push(el("CiudadDest", t.ciudadDest.slice(0, 20)));
  // Exportación: sección <Aduana> al final del Transporte (orden XSD de campos respetado).
  if (t.aduana) {
    const a = t.aduana;
    const aParts: string[] = [];
    if (a.codModVenta !== undefined) aParts.push(el("CodModVenta", a.codModVenta));
    if (a.codClauVenta !== undefined) aParts.push(el("CodClauVenta", a.codClauVenta));
    if (a.totClauVenta !== undefined) aParts.push(el("TotClauVenta", a.totClauVenta));
    if (a.codViaTransp !== undefined) aParts.push(el("CodViaTransp", a.codViaTransp));
    if (a.nombreTransp) aParts.push(el("NombreTransp", a.nombreTransp.slice(0, 40)));
    if (a.codPtoEmbarque !== undefined) aParts.push(el("CodPtoEmbarque", a.codPtoEmbarque));
    if (a.codPtoDesemb !== undefined) aParts.push(el("CodPtoDesemb", a.codPtoDesemb));
    if (a.tara !== undefined) aParts.push(el("Tara", a.tara));
    if (a.codUnidMedTara !== undefined) aParts.push(el("CodUnidMedTara", a.codUnidMedTara));
    if (a.pesoBruto !== undefined) aParts.push(el("PesoBruto", a.pesoBruto));
    if (a.codUnidPesoBruto !== undefined) aParts.push(el("CodUnidPesoBruto", a.codUnidPesoBruto));
    if (a.pesoNeto !== undefined) aParts.push(el("PesoNeto", a.pesoNeto));
    if (a.codUnidPesoNeto !== undefined) aParts.push(el("CodUnidPesoNeto", a.codUnidPesoNeto));
    if (a.totItems !== undefined) aParts.push(el("TotItems", a.totItems));
    if (a.totBultos !== undefined) aParts.push(el("TotBultos", a.totBultos));
    // TipoBultos (hasta 10): orden XSD CodTpoBultos, CantBultos, [Marcas], [IdContainer],
    // [Sello], [EmisorSello]. Para bultos tipo CONTENEDOR el SII exige IdContainer + Sello +
    // EmisorSello (regla de negocio sobre minOccurs=0; sin ellos → REPARO HED-2-804).
    for (const tb of a.tipoBultos ?? []) {
      const tbParts: string[] = [];
      if (tb.codTpoBultos !== undefined) tbParts.push(el("CodTpoBultos", tb.codTpoBultos));
      if (tb.cantBultos !== undefined) tbParts.push(el("CantBultos", tb.cantBultos));
      if (tb.marcas) tbParts.push(el("Marcas", tb.marcas.slice(0, 255)));
      if (tb.idContainer) tbParts.push(el("IdContainer", tb.idContainer.slice(0, 25)));
      if (tb.sello) tbParts.push(el("Sello", tb.sello.slice(0, 20)));
      if (tb.emisorSello) tbParts.push(el("EmisorSello", tb.emisorSello.slice(0, 70)));
      if (tbParts.length > 0) aParts.push(`<TipoBultos>${tbParts.join("")}</TipoBultos>`);
    }
    if (a.mntFlete !== undefined) aParts.push(el("MntFlete", a.mntFlete));
    if (a.mntSeguro !== undefined) aParts.push(el("MntSeguro", a.mntSeguro));
    if (a.codPaisRecep !== undefined) aParts.push(el("CodPaisRecep", a.codPaisRecep));
    if (a.codPaisDestin !== undefined) aParts.push(el("CodPaisDestin", a.codPaisDestin));
    if (aParts.length > 0) parts.push(`<Aduana>${aParts.join("")}</Aduana>`);
  }
  // Res. Ex. 154/2025: FchSalida/HraSalida/FchLlegada son los ÚLTIMOS elementos del
  // <Transporte> en el XSD 2026-02-06 (tras Aduana). Sólo se emiten si vienen.
  if (t.fchSalida) parts.push(el("FchSalida", t.fchSalida));
  if (t.horaSalida) parts.push(el("HraSalida", t.horaSalida));
  if (t.fchLlegada) parts.push(el("FchLlegada", t.fchLlegada));
  return parts.length > 0 ? `<Transporte>${parts.join("")}</Transporte>` : "";
}

function buildDetalle(item: FacturaDteItem, nroLinea: number): string {
  // Orden XSD: NroLinDet, [CdgItem], [IndExe], [Retenedor], NmbItem, [DscItem], QtyItem,
  // [UnmdItem], PrcItem, [DescuentoPct], [DescuentoMonto], [RecargoPct], [RecargoMonto],
  // [CodImpAdic], MontoItem.
  const parts: string[] = [el("NroLinDet", nroLinea)];
  // CdgItem (0..5; XSD: TODOS van ANTES de Retenedor). El CPCS (Código de Producto de Cambio de
  // Sujeto) ancla la línea del FC 46 como base de retención → el campo 117 la cuenta (MontoImp != 0).
  if (item.cpcs) {
    parts.push(`<CdgItem>${el("TpoCodigo", "CPCS")}${el("VlrCodigo", item.cpcs.slice(0, 35))}</CdgItem>`);
  }
  if (item.codigo) {
    parts.push(
      `<CdgItem>${el("TpoCodigo", item.codigo.tipo.slice(0, 10))}${
        el("VlrCodigo", item.codigo.valor.slice(0, 35))
      }</CdgItem>`,
    );
  }
  // Línea SIN valor (guía 52 traslado interno): NmbItem + QtyItem + UnmdItem + MontoItem=0,
  // sin IndExe ni PrcItem. El traslado interno no constituye venta → MontoItem=0 con QtyItem
  // es válido y aceptado por el SII (XML real guía IndTraslado=5).
  if (item.sinValor) {
    parts.push(el("NmbItem", item.nombre.slice(0, 80)));
    if (item.descripcion) parts.push(el("DscItem", item.descripcion.slice(0, 1000)));
    parts.push(el("QtyItem", item.cantidad));
    if (item.unidadMedida) parts.push(el("UnmdItem", item.unidadMedida.slice(0, 4)));
    parts.push(el("MontoItem", 0));
    return `<Detalle>${parts.join("")}</Detalle>`;
  }
  // Línea de Liquidación-Factura (43) total-driven: la línea es un AGREGADO ("CANTIDAD n / TOTAL m"
  // del set) con MontoItem EXPLÍCITO. Estructura del ejemplo CERTIFICADO del SII:
  //   NroLinDet, [CdgItem], TpoDocLiq, [IndExe], NmbItem, [DscItem], QtyItem, UnmdItem, MontoItem.
  // ⚠️ QtyItem = la CANTIDAD del set (el CONTEO de documentos liquidados de la línea: 1 doc→QtyItem=1,
  // 129 docs→QtyItem=129) + UnmdItem="UN". EVIDENCIA: el ejemplo certificado del SII emite
  // QtyItem = ese conteo y MontoItem directo SIN PrcItem; emitir QtyItem=1 fijo dio el reparo del
  // set-review "Los Valores de la Línea No Cuadran" (2026-06, set 4903533). NO se emite PrcItem (el
  // ejemplo no lo lleva; sin PrcItem el validador toma MontoItem directo, sin recomputar Qty×Prc).
  // MontoItem es ValorType → admite negativos (NC/devolución/liquidación dentro de la liquidación).
  // QtyItem por defecto = 1 si no se pasa cantidad.
  if (item.montoItem !== undefined) {
    // TpoDocLiq (obligatorio en Liquidacion/Detalle): tras NroLinDet/CdgItem, antes de IndExe.
    if (item.tpoDocLiq !== undefined) parts.push(el("TpoDocLiq", item.tpoDocLiq));
    // IndExe en líneas de Liquidación-Factura: EXENTO (línea "EXENTO …" del set) → IndExe=1 (suma a
    // MntExe); AFECTO ("NETO …") → sin IndExe (suma a MntNeto). IGUAL para líneas POSITIVAS y
    // NEGATIVAS: el set de pruebas SII 4903533 lista CADA línea —incluidas las NC/devolución/
    // liquidación/anticipo negativas— como "NETO …"/"EXENTO …" con su CANTIDAD y su TOTAL LINEA (con
    // signo). NO se usa IndExe=2: una negativa es solo una línea NETO/EXENTO con TOTAL LINEA negativo.
    if (item.exento) parts.push(el("IndExe", 1));
    parts.push(el("NmbItem", item.nombre.slice(0, 80)));
    if (item.descripcion) parts.push(el("DscItem", item.descripcion.slice(0, 1000)));
    // Orden XSD Liquidacion/Detalle: …NmbItem, DscItem, …, QtyItem, …, UnmdItem, …, MontoItem.
    // CADA línea lleva QtyItem = CANTIDAD del set + UnmdItem="UN" + MontoItem = TOTAL LINEA (con signo;
    // ValorType admite negativo). SIN PrcItem: el set da el TOTAL directo (no precio unitario) y el
    // validador lo toma directo. EVIDENCIA: el set 4903533 da CANTIDAD en TODAS las líneas, también
    // las negativas (NC 328 CANTIDAD 1 / TOTAL -41335, NC 1981 CANTIDAD 1 / TOTAL -73304, etc.).
    // OMITIR QtyItem en las negativas era el bug del set-review ("Los Valores de la Línea del Detalle
    // No Cuadran": -2 líneas 5-7, -4 líneas 6-8) — el SII espera la CANTIDAD en cada línea.
    parts.push(el("QtyItem", item.cantidad && item.cantidad > 0 ? item.cantidad : 1));
    parts.push(el("UnmdItem", (item.unidadMedida ?? "UN").slice(0, 4)));
    parts.push(el("MontoItem", Math.round(item.montoItem)));
    return `<Detalle>${parts.join("")}</Detalle>`;
  }
  if (item.exento) parts.push(el("IndExe", 1));
  // Retenedor/IndAgente=R (FC 46 agente retenedor): tras IndExe, antes de NmbItem (DTE_v10 L1413).
  if (item.indAgente) parts.push("<Retenedor><IndAgente>R</IndAgente></Retenedor>");
  parts.push(el("NmbItem", item.nombre.slice(0, 80)));
  if (item.descripcion) parts.push(el("DscItem", item.descripcion.slice(0, 1000)));
  // QtyItem/UnmdItem/PrcItem son opcionales (XSD: Dec12_6Type con minInclusive
  // 0.000001 → NO admiten 0). En líneas de monto 0 (ej. NC "corrige texto/giro", ND
  // "anula NC") se OMITEN los tres y la línea queda solo con NmbItem + MontoItem=0.
  // Emitir QtyItem sin PrcItem da el reparo SII "Los Valores de la Línea N del
  // Detalle No Cuadran" (SETMAIL set básico/exenta, cert 2026-06-15).
  // Subtipo Exportaciones: PrcItem (Dec12_6 decimal/6) y MontoItem (xs:decimal totalDigits18/
  // fractionDigits4) ADMITEN decimales — la familia comercial (33/34/46/52/56/61) exige
  // MontoType=nonNegativeInteger, así que sólo se preservan decimales en líneas con valores
  // fraccionarios. Hay dos fuentes de decimal: (a) el PrecioUnitario NO es entero (export con precio
  // fraccionario), o (b) un RecargoPct/DescuentoPct deja un MONTO fraccionario sobre un precio entero
  // (caso 4903532-1: 10% de 1 USD = 0.1 → MontoItem=1.1). En ambos casos el MontoItem/grossItem debe
  // conservar decimales (round4) en vez de redondearse a entero. round4 evita arrastre de float64.
  const recDeltaRaw = item.recargoPct !== undefined
    ? (item.recargoMonto ?? item.precio * item.cantidad * item.recargoPct / 100)
    : (item.recargoMonto ?? 0);
  const descDeltaRaw = item.descuentoPct !== undefined
    ? (item.descuentoMonto ?? item.precio * item.cantidad * item.descuentoPct / 100)
    : (item.descuentoMonto ?? 0);
  const isDecimalPrice = !Number.isInteger(item.precio) ||
    !Number.isInteger(recDeltaRaw) || !Number.isInteger(descDeltaRaw);
  const round4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const prcItem = isDecimalPrice ? round4(item.precio) : Math.round(item.precio);
  if (prcItem > 0) {
    parts.push(el("QtyItem", item.cantidad));
    if (item.unidadMedida) parts.push(el("UnmdItem", item.unidadMedida.slice(0, 4)));
    // PrcItem decimal (export) → Dec12_6 hasta 6 decimales sin ceros finales; entero (familia) → tal cual.
    parts.push(el("PrcItem", isDecimalPrice ? fmtDec6(prcItem) : prcItem));
  }
  // MontoItem = NETO de la línea = Qty × Prc − DescuentoMonto (+ RecargoMonto). El
  // SII valida MontoItem == Qty×Prc − DescuentoMonto + RecargoMonto: emitir el BRUTO da el reparo
  // "Valor Detalle Distinto a Precio * Cantidad" (RVD T33 folio 2, cert 2026-06-14).
  // DescuentoPct/DescuentoMonto documentan el descuento de línea; DescuentoMonto se
  // calcula sobre el BRUTO (Qty×Prc), y MontoItem ya sale neto. En export el bruto conserva
  // decimales (round4); en la familia comercial es entero (Math.round).
  const grossItem = isDecimalPrice ? round4(item.precio * item.cantidad) : Math.round(item.precio * item.cantidad);
  let descMonto = 0;
  if (item.descuentoPct !== undefined) {
    descMonto = item.descuentoMonto ?? Math.round(grossItem * item.descuentoPct / 100);
    parts.push(el("DescuentoPct", item.descuentoPct));
    parts.push(el("DescuentoMonto", descMonto));
  } else if (item.descuentoMonto !== undefined) {
    descMonto = item.descuentoMonto;
    parts.push(el("DescuentoMonto", descMonto));
  }
  // RecargoPct/RecargoMonto: tras DescuentoPct/DescuentoMonto, antes de CodImpAdic/MontoItem
  // (orden XSD: DescuentoPct, DescuentoMonto, RecargoPct, RecargoMonto, CodImpAdic, MontoItem).
  // RecargoPct es PctType (xs:decimal 3+2, minInclusive 0.01) → admite el valor entero/decimal del %.
  // RecargoMonto es MntImpType=xs:positiveInteger → SOLO admite enteros >0; NO puede valer 0 ni 0.1.
  //
  // En el subtipo Exportaciones (formato_dte campos 33/34 = flag 3/Opcional para FACT-EXPOR; legend
  // L373-379) el recargo de línea SÍ aplica, y PrcItem (Dec12_6) + MontoItem (decimal/4) admiten
  // decimales. Cuando el monto del recargo es FRACCIONARIO (ej. caso 4903532-1: 10% de 1 USD = 0.1),
  // RecargoMonto no puede expresarlo → se emite SOLO <RecargoPct> y se OMITE <RecargoMonto> (minOccurs
  // =0), computando MontoItem = grossItem × (1 + pct/100) con decimales (round4). El set-review del SII
  // exige PrcItem = el VALOR LINEA especificado (1), por eso el +10% va como RecargoPct, NO plegado en
  // el precio (PrcItem=1.1 daba el reparo "Los Datos de la Línea No Cuadran"); y va a NIVEL DE LÍNEA,
  // NO como DscRcgGlobal (daba "Debe Tener 0 Línea(s) de Recargo Global" — el set lo pide "EN LA LÍNEA
  // DE ITEM"). Si el monto del recargo ES entero (familia comercial o export con monto entero), se
  // emite el par RecargoPct + RecargoMonto como antes.
  let recMonto = 0;
  if (item.recargoPct !== undefined) {
    const recRaw = item.recargoMonto ??
      (isDecimalPrice ? round4(grossItem * item.recargoPct / 100) : Math.round(grossItem * item.recargoPct / 100));
    recMonto = recRaw;
    parts.push(el("RecargoPct", item.recargoPct));
    // RecargoMonto solo si es entero positivo (MntImpType=positiveInteger). Fraccionario o 0 → omitir;
    // el recargo queda expresado por RecargoPct y reflejado en MontoItem (que en export es decimal).
    if (Number.isInteger(recRaw) && recRaw > 0) parts.push(el("RecargoMonto", recRaw));
  } else if (item.recargoMonto !== undefined) {
    recMonto = item.recargoMonto;
    parts.push(el("RecargoMonto", recMonto));
  }
  // CodImpAdic: tras descuentos/recargos, justo antes de MontoItem (DTE_v10.xsd L1649).
  // Ancla la retención/impuesto adicional a la línea (la base es el MontoItem).
  if (item.codImpAdic !== undefined) parts.push(el("CodImpAdic", item.codImpAdic));
  // MontoItem export decimal (round4) o familia entero. el() preserva el decimal de round4.
  const montoItem = grossItem - descMonto + recMonto;
  parts.push(el("MontoItem", isDecimalPrice ? round4(montoItem) : montoItem));
  return `<Detalle>${parts.join("")}</Detalle>`;
}

/** Sección <DscRcgGlobal> (descuento/recargo global). Orden XSD: NroLinDR, TpoMov, [GlosaDR], TpoValor, ValorDR, [ValorDROtrMnda], [IndExeDR]. */
function buildDscRcgGlobal(d: FacturaDscRcgGlobal, nroLinea: number): string {
  const parts: string[] = [el("NroLinDR", nroLinea), el("TpoMov", d.tipo)];
  if (d.glosa) parts.push(el("GlosaDR", d.glosa.slice(0, 45)));
  parts.push(el("TpoValor", d.valorTipo));
  parts.push(el("ValorDR", d.valor));
  // ValorDROtrMnda (Dec14_4, export obligatorio): monto del dscto/recargo en la otra moneda (CLP).
  // Tras ValorDR, antes de IndExeDR (orden XSD). el() preserva decimales (NO Math.round).
  if (d.valorDROtrMnda !== undefined) parts.push(el("ValorDROtrMnda", d.valorDROtrMnda));
  if (d.exento !== undefined) parts.push(el("IndExeDR", d.exento));
  return `<DscRcgGlobal>${parts.join("")}</DscRcgGlobal>`;
}

/**
 * Sección <Comisiones> (Comisiones y Otros Cargos) — Liquidación-Factura (43) / FC 46.
 * Orden XSD §F: NroLinCom, TipoMovim, Glosa, [TasaComision], [ValComNeto], [ValComExe],
 * [ValComIVA]. Valores pueden ser negativos en liquidación.
 */
function buildComisiones(c: FacturaComision, nroLinea: number): string {
  // ValComNeto y ValComExe son OBLIGATORIOS en la sección (DTE_v10.xsd Liquidacion/Comisiones,
  // sin minOccurs) → se emiten siempre, default 0. ValComIVA es opcional. Todos ValorType (±).
  const parts: string[] = [
    el("NroLinCom", nroLinea),
    el("TipoMovim", c.tipoMovim),
    el("Glosa", c.glosa.slice(0, 60)),
    el("ValComNeto", Math.round(c.valComNeto ?? 0)),
    el("ValComExe", Math.round(c.valComExe ?? 0)),
  ];
  if (c.valComIVA !== undefined) parts.push(el("ValComIVA", Math.round(c.valComIVA)));
  return `<Comisiones>${parts.join("")}</Comisiones>`;
}

function buildReferencia(ref: FacturaDteReferencia, nroLinea: number): string {
  // Orden XSD: NroLinRef, TpoDocRef, [IndGlobal], FolioRef, [RUTOtr], FchRef,
  // [CodRef], [RazonRef]. FchRef OBLIGATORIO en factura/NC/ND.
  const parts: string[] = [
    el("NroLinRef", nroLinea),
    el("TpoDocRef", ref.tipoDocRef.slice(0, 3)),
    el("FolioRef", ref.folioRef),
    el("FchRef", ref.fchRef),
  ];
  if (ref.codRef !== undefined) parts.push(el("CodRef", ref.codRef));
  if (ref.razonRef) parts.push(el("RazonRef", ref.razonRef.slice(0, 90)));
  return `<Referencia>${parts.join("")}</Referencia>`;
}

/** TED con el DD COMPACTO embebido (la FRMT firma el compacto; el SII canonicaliza). */
function buildTedCompact(input: FacturaDteInput): string {
  const { dd, frmt } = buildTed({
    cafXml: input.cafXml,
    rutEmisor: input.emisor.rut,
    tipoDte: input.tipoDte,
    folio: input.folio,
    fechaEmision: input.fechaEmision,
    rutReceptor: input.receptor.rut,
    razonSocialReceptor: input.receptor.razonSocial,
    montoTotal: input.totals.total,
    item1: input.items[0]?.nombre ?? "",
    tstedIso: input.tstedIso,
  });
  return `<TED version="1.0">${compactSiiDd(dd)}<FRMT algoritmo="SHA1withRSA">${frmt}</FRMT></TED>`;
}

/**
 * Arma el `<Documento>` compacto sin firma (factura/NC/ND). La firma XMLDSig la
 * agrega `signDte` (xml-signature.ts) en `buildSignedFacturaDte`.
 */
export function buildFacturaDocumento(input: FacturaDteInput): BuildFacturaDocumentoResult {
  if (input.items.length === 0) throw new Error("buildFacturaDocumento: sin ítems");
  // El atributo ID es xs:ID → NCName: empieza con letra/_ , sin espacios ni ':'.
  if (!/^[A-Za-z_][\w.-]*$/.test(input.documentId)) {
    throw new Error(
      `buildFacturaDocumento: documentId inválido como xs:ID: "${input.documentId}"`,
    );
  }
  // NC (61) y ND (56) requieren al menos una referencia (al documento corregido).
  if ((input.tipoDte === 56 || input.tipoDte === 61 || input.tipoDte === 111 || input.tipoDte === 112) && (!input.referencias?.length)) {
    throw new Error(
      `buildFacturaDocumento: el tipo ${input.tipoDte} (NC/ND) requiere al menos una Referencia`,
    );
  }
  // Liquidación-Factura (43): CADA línea del Detalle EXIGE TpoDocLiq (XSD: tras CdgItem, antes de
  // NmbItem) — el tipo de doc que se liquida. Sin él el SII rechaza el sobre por schema ("element
  // NmbItem: ... Expected is one of ( CdgItem, TpoDocLiq )"). Fallar acá, en build, no al Declarar
  // Avance en Maullín (lección del 46: los reparos estructurales no los ve el EPR, sólo el SETMAIL).
  if (input.tipoDte === 43) {
    const sinTpoDocLiq = input.items
      .map((it, i) => (it.tpoDocLiq === undefined ? i + 1 : 0))
      .filter((n) => n > 0);
    if (sinTpoDocLiq.length > 0) {
      throw new Error(
        `buildFacturaDocumento: Liquidación-Factura (43) requiere tpoDocLiq en cada línea del Detalle; falta en línea(s) ${sinTpoDocLiq.join(", ")}`,
      );
    }
  }
  // Normaliza el RUT del receptor en UN solo punto → el <RUTRecep> del XML y el del TED
  // (ambos leen input.receptor.rut) quedan idénticos y canónicos.
  input = { ...input, receptor: { ...input.receptor, rut: normRut(input.receptor.rut) } };
  const encabezado = buildEncabezado(input);
  const detalles = input.items.map((it, i) => buildDetalle(it, i + 1)).join("");
  // DscRcgGlobal va entre Detalle y Referencia (orden XSD del Documento).
  const dscRcgGlobal = (input.descuentosGlobales ?? [])
    .map((d, i) => buildDscRcgGlobal(d, i + 1))
    .join("");
  const referencias = (input.referencias ?? [])
    .map((ref, i) => buildReferencia(ref, i + 1))
    .join("");
  // Comisiones va entre Referencia y TED (orden XSD del Documento). Liquidación-Factura (43).
  const comisiones = (input.comisiones ?? [])
    .map((c, i) => buildComisiones(c, i + 1))
    .join("");
  const ted = buildTedCompact(input);
  const tmstFirma = el("TmstFirma", input.tmstFirma);
  // Liquidación-Factura (43) usa raíz <Liquidacion> (DTE_v10.xsd subtipo propio), el resto
  // <Documento>. La firma referencia el ID, no el nombre del elemento. La Liquidacion NO lleva
  // DscRcgGlobal (no está en su schema) → se omite para 43.
  const rootTag = input.tipoDte === 43
    ? "Liquidacion"
    : (input.tipoDte >= 110 ? "Exportaciones" : "Documento");
  const documento =
    `<${rootTag} ID="${escAttr(input.documentId)}">` +
    encabezado +
    detalles +
    (input.tipoDte === 43 ? "" : dscRcgGlobal) +
    referencias +
    comisiones +
    ted +
    tmstFirma +
    `</${rootTag}>`;
  return { documento, documentId: input.documentId };
}

/**
 * Arma el DTE completo de factura/NC/ND FIRMADO: render del Documento + firma
 * XMLDSig enveloped con el cert (.pfx). Devuelve el XML Unicode con declaración
 * iso-8859-1; los bytes de transmisión = `encodeLatin1`.
 */
export function buildSignedFacturaDte(
  input: FacturaDteInput,
  pfxBytes: Uint8Array,
  password: string,
): string {
  const { documento, documentId } = buildFacturaDocumento(input);
  return signDte(documento, documentId, pfxBytes, password);
}
