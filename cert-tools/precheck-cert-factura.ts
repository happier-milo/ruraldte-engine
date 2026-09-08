// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// precheck-cert-factura.ts — ORÁCULO DE VALORES del set de cert factura (offline).
//
// Construye los 22 DTEs del set con el MOTOR REAL y compara los totales y la
// estructura EMITIDOS contra la "tabla dorada" (valores que el SII espera, derivados
// del set 784166260 + las reglas de los manuales: FC retención total, NC devolución
// con descuentos, NC/ND corrige-texto monto 0, guía traslado interno sin IVA).
//
// Es el equivalente al oráculo de boletas: corre ANTES de cada envío definitivo, NO
// toca el SII y NO gasta folios. Si algo no cuadra, NO enviar.
//
//   deno run --allow-all scripts/precheck-cert-factura.ts
// ============================================================================

import forge from "npm:node-forge@1.3.1";
import {
  assignCertReceptores,
  buildCertFacturaDtes,
  DEFAULT_FACTURA_CERT_CASES,
  DEFAULT_FACTURA_CERT_RECEPTOR,
  FC46_CERT_CASES,
} from "../engine/cert-factura.ts";

// Tabla dorada: valores esperados por el SII por caso (neto/exento/iva/retención/total).
// Fuente: SIISetDePruebas784166260.txt (set 4907369-77, 2026-06-18) + manuales (casos_especiales
// §I.1, compra_venta N°16/31/33/37, inst_set_pruebas §4.e, DTE_v10.xsd). Verificada aritméticamente
// + recomputada de forma independiente (workflow de verificación, 7 agentes, 0 discrepancias).
const GOLDEN: Record<string, { neto: number; exento: number; iva: number; reten: number; total: number }> = {
  // SET BÁSICO 4907369 (33/61/56) — set nuevo 2026-06-18.
  "4907369-1": { neto: 229572, exento: 0, iva: 43619, reten: 0, total: 273191 },
  "4907369-2": { neto: 778871, exento: 0, iva: 147985, reten: 0, total: 926856 },
  "4907369-3": { neto: 520856, exento: 34740, iva: 98963, reten: 0, total: 654559 },
  "4907369-4": { neto: 251413, exento: 13542, iva: 47768, reten: 0, total: 312723 },
  "4907369-5": { neto: 0, exento: 0, iva: 0, reten: 0, total: 0 },
  "4907369-6": { neto: 354899, exento: 0, iva: 67431, reten: 0, total: 422330 },
  "4907369-7": { neto: 520856, exento: 34740, iva: 98963, reten: 0, total: 654559 },
  "4907369-8": { neto: 0, exento: 0, iva: 0, reten: 0, total: 0 },
  // SET FACTURA EXENTA 4907375 (34/61/56): solo MntExe + MntTotal, sin IVA.
  "4907375-1": { neto: 0, exento: 69828, iva: 0, reten: 0, total: 69828 },
  "4907375-2": { neto: 0, exento: 8734, iva: 0, reten: 0, total: 8734 },
  "4907375-3": { neto: 0, exento: 586632, iva: 0, reten: 0, total: 586632 },
  "4907375-4": { neto: 0, exento: 0, iva: 0, reten: 0, total: 0 },
  "4907375-5": { neto: 0, exento: 0, iva: 0, reten: 0, total: 0 },
  "4907375-6": { neto: 0, exento: 568913, iva: 0, reten: 0, total: 568913 },
  "4907375-7": { neto: 0, exento: 169591, iva: 0, reten: 0, total: 169591 },
  "4907375-8": { neto: 0, exento: 45946, iva: 0, reten: 0, total: 45946 },
  // SET GUÍA 4907373 (52).
  "4907373-1": { neto: 0, exento: 0, iva: 0, reten: 0, total: 0 }, // traslado interno: sin valor → MntTotal=0
  "4907373-2": { neto: 3618358, exento: 0, iva: 687488, reten: 0, total: 4305846 },
  "4907373-3": { neto: 2681628, exento: 0, iva: 509509, reten: 0, total: 3191137 },
  // SET EXPORTACIÓN (1) 4907376 (FRANCO SZ) — 110/112/111, todo exento (MntExe=MntTotal, sin IVA).
  "4907376-1": { neto: 0, exento: 112517.50, iva: 0, reten: 0, total: 112517.50 }, // 109233 (687×159) + flete 2069.28 + seguro 1215.22
  "4907376-2": { neto: 0, exento: 36411, iva: 0, reten: 0, total: 36411 }, // NC 229 × 159
  "4907376-3": { neto: 0, exento: 36411, iva: 0, reten: 0, total: 36411 }, // ND anula NC
  // SET EXPORTACIÓN (2) 4907377 (YEN + DOLAR USA) — 110 × 3.
  "4907377-1": { neto: 0, exento: 103.4, iva: 0, reten: 0, total: 103.4 }, // 94 + 10% recargo línea (YEN)
  "4907377-2": { neto: 0, exento: 233792.38, iva: 0, reten: 0, total: 233792.38 }, // 223011 + com 617.45 + flete 5251.25 + seguro 4912.68 (YEN)
  "4907377-3": { neto: 0, exento: 281, iva: 0, reten: 0, total: 281 }, // alojamiento (DOLAR USA)
  // SET FC 46 (4917063, vigente) — RETENCIÓN TOTAL del IVA (cambio de sujeto): ImptoReten/15 MontoImp=IVA,
  // MntTotal = Neto (el IVA se retiene). El SETMAIL del set EXIGE la retención; desde ~2026-06-24 el
  // validador del SII ya no repara con HED-2-302 (FC_TEST folio 31 → EPR 0 reparos; set 0252160934 → EPR 0).
  "4917063-1": { neto: 2132992, exento: 0, iva: 405268, reten: 405268, total: 2132992 }, // FC 46: 500×4152 + 26×2192
  "4917063-2": { neto: 713112, exento: 0, iva: 135491, reten: 135491, total: 713112 }, // NC devolución: 167×4152 + 9×2192
  "4917063-3": { neto: 713112, exento: 0, iva: 135491, reten: 135491, total: 713112 }, // ND anula NC (replica ítems)
};

function genCafXml(td: number): string {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  return `<?xml version="1.0"?><AUTORIZACION><CAF version="1.0"><DA>` +
    `<RE>78416626-0</RE><RS>COMUNIDAD RURAL SPA</RS><TD>${td}</TD>` +
    `<RNG><D>1</D><H>200</H></RNG><FA>2026-06-15</FA>` +
    `<RSAPK><M>abc==</M><E>Aw==</E></RSAPK><IDK>100</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">deadbeef==</FRMA></CAF>` +
    `<RSASK>${forge.pki.privateKeyToPem(kp.privateKey)}</RSASK></AUTORIZACION>`;
}
function makeTestPfx(): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [{ name: "commonName", value: "TEST" }, { name: "serialNumber", value: "22222222-2" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "pass", { algorithm: "3des" });
  const der = forge.asn1.toDer(p12).getBytes();
  const out = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) out[i] = der.charCodeAt(i);
  return out;
}

const num = (xml: string, tag: string): number => {
  // Acepta decimales (exportación: MntExe/MntTotal son xs:decimal, ej. 106230.78).
  const m = xml.match(new RegExp(`<${tag}>(\\d+(?:\\.\\d+)?)</${tag}>`));
  return m ? Number(m[1]) : 0;
};
const has = (xml: string, re: RegExp) => re.test(xml);

const EMISOR = {
  rut: "78416626-0",
  legalName: "COMUNIDAD RURAL SPA",
  giro: "SERVICIOS",
  acteco: 620200,
  dirOrigen: "Martínez de Rozas 3550",
  cmnaOrigen: "Quinta Normal",
  ciudadOrigen: "Santiago",
};

const tipos = [33, 34, 46, 52, 56, 61, 110, 111, 112];
const cafByType: Record<number, string> = {};
const firstFolioByType: Record<number, number> = {};
for (const t of tipos) {
  cafByType[t] = genCafXml(t);
  firstFolioByType[t] = 1;
}

const dtes = buildCertFacturaDtes(
  {
    cases: assignCertReceptores([...DEFAULT_FACTURA_CERT_CASES, ...FC46_CERT_CASES]),
    emisor: EMISOR,
    receptor: { ...DEFAULT_FACTURA_CERT_RECEPTOR },
    firstFolioByType,
    cafByType,
    fechaEmision: "2026-06-15",
    tstedIso: "2026-06-15T12:00:00",
  },
  makeTestPfx(),
  "pass",
);

// DUMP=1 → escribe el DTE firmado de cada caso a /tmp/precheck-<caso>.xml (para verificación).
if (Deno.env.get("DUMP") === "1") {
  for (const d of dtes) {
    Deno.writeTextFileSync(`/tmp/precheck-${d.caso}.xml`, d.signedDte.replace(/\r\n/g, "\n"));
  }
  console.log(`Dump: /tmp/precheck-<caso>.xml (${dtes.length} casos)`);
}

let fails = 0;
console.log("Caso        Tipo  Neto         Exento      IVA         Reten       Total        Estructura");
console.log("-".repeat(110));
for (const d of dtes) {
  const xml = d.signedDte.replace(/\r\n/g, "");
  const g = GOLDEN[d.caso];
  // Totales emitidos
  const neto = num(xml, "MntNeto");
  const exento = num(xml, "MntExe");
  const iva = num(xml, "IVA");
  const total = num(xml, "MntTotal");
  const reten = (() => {
    const m = xml.match(/<ImptoReten><TipoImp>\d+<\/TipoImp>.*?<MontoImp>(\d+)<\/MontoImp><\/ImptoReten>/);
    return m ? Number(m[1]) : 0;
  })();
  const okTotals = g && neto === g.neto && exento === g.exento && iva === g.iva && reten === g.reten && total === g.total;

  // Chequeos estructurales por clase de fix
  const structIssues: string[] = [];
  // (Este set 4907369 NO trae liquidación 43 ni emisión de FC 46 → sin chequeos de retención total
  // ni de raíz <Liquidacion>; el motor mantiene ese soporte para producción/mesa de ayuda.)
  // monto-0 (NC/ND corrige-texto): el primer Detalle NO debe tener QtyItem ni PrcItem.
  // EXCEPTO la guía traslado interno (4907373-1), que SÍ lleva QtyItem + UnmdItem + MontoItem=0.
  if (g && g.total === 0 && d.caso !== "4907373-1") {
    const det = xml.match(/<Detalle>[\s\S]*?<\/Detalle>/)?.[0] ?? "";
    if (/<QtyItem>/.test(det) || /<PrcItem>/.test(det)) structIssues.push("línea monto-0 con Qty/Prc");
  }
  // guía traslado interno: sin valor → QtyItem + UnmdItem + MontoItem=0, sin PrcItem/IndExe/IVA, MntTotal=0.
  if (d.caso === "4907373-1") {
    if (has(xml, /<IVA>/)) structIssues.push("guía interna con IVA");
    if (has(xml, /<MntExe>/)) structIssues.push("guía interna con MntExe (debe ser MntTotal=0)");
    if (has(xml, /<IndExe>/)) structIssues.push("guía interna con IndExe (traslado sin valor no lo lleva)");
    const det = xml.match(/<Detalle>[\s\S]*?<\/Detalle>/)?.[0] ?? "";
    if (!/<QtyItem>/.test(det) || !/<UnmdItem>/.test(det)) structIssues.push("guía interna sin QtyItem/UnmdItem");
    if (/<PrcItem>/.test(det)) structIssues.push("guía interna con PrcItem (debe ser sin valor)");
  }

  const ok = okTotals && structIssues.length === 0;
  if (!ok) fails++;
  const flag = ok ? "✅" : "❌";
  const pad = (n: number) => String(n).padStart(11);
  const struct = structIssues.length ? structIssues.join(", ") : (g && g.reten > 0 ? "reten✓" : d.caso === "4907373-1" ? "interno✓" : g && g.total === 0 ? "monto0✓" : "ok");
  console.log(`${flag} ${d.caso}  ${String(d.tipoDocumento).padStart(3)}  ${pad(neto)} ${pad(exento)} ${pad(iva)} ${pad(reten)} ${pad(total)}  ${struct}`);
  if (g && !okTotals) {
    console.log(`     ESPERADO:  neto=${g.neto} exento=${g.exento} iva=${g.iva} reten=${g.reten} total=${g.total}`);
  }
}
console.log("-".repeat(110));
if (fails === 0) {
  console.log(`✅ PRECHECK OK: los ${dtes.length} casos cuadran con la tabla dorada del SII. Seguro para enviar.`);
} else {
  console.log(`❌ PRECHECK FALLÓ: ${fails} caso(s) no cuadran. NO ENVIAR — revisar arriba.`);
  Deno.exit(1);
}
