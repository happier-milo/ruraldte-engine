// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// validate-cert-factura-xsd.ts — PRE-FLIGHT de la certificación de factura.
// ============================================================================
//
// Genera el sobre EnvioDTE con los 22 casos del set + los 3 libros (IEV/IEC/Guías)
// y valida su ESTRUCTURA contra los XSD OFICIALES del SII con xmllint — SIN tocar
// Maullín, sin gastar folios, sin red. Cacha errores de schema (orden de
// elementos, tipos, campos faltantes) antes de la corrida real.
//
// Lo que NO valida (solo el SII puede): la semántica de negocio de los casos
// "terse" (¿la NC modifica-monto va con cantidad 1 o 9? ¿la guía de traslado
// interno es afecta o exenta?) — eso lo dice la revisión del set en Maullín.
// Pero la ARITMÉTICA y la ESTRUCTURA sí quedan validadas acá.
//
// Uso:
//   deno run --allow-all scripts/validate-cert-factura-xsd.ts ["~/Documents/SII Dev"]
//   (xsdDir default: $HOME/Documents/SII Dev)
// ============================================================================

import forge from "npm:node-forge@1.3.1";
import {
  buildCertFacturaDtes,
  buildCertLibros,
  type BuildCertFacturaArgs,
  DEFAULT_FACTURA_CERT_CASES,
  DEFAULT_FACTURA_CERT_RECEPTOR,
} from "../engine/cert-factura.ts";
import { buildEnvioDte } from "../engine/envio-dte.ts";
import { buildSignedLibroIecv } from "../engine/libro-iecv.ts";
import { buildSignedLibroGuia } from "../engine/libro-guia.ts";

const HOME = Deno.env.get("HOME") ?? "";
const xsdDir = (Deno.args[0] ?? `${HOME}/Documents/SII Dev`).replace(/\/+$/, "");

const EMISOR = {
  rut: "78416626-0",
  legalName: "COMUNIDAD RURAL SPA",
  giro: "Servicios informaticos",
  acteco: 620200,
  dirOrigen: "Martinez de Rozas 3550",
  cmnaOrigen: "Quinta Normal",
  ciudadOrigen: "Santiago",
};
const RUT_ENVIA = "22222222-2";
const FCH_RESOL = "2026-06-14"; // familia factura autorizada 14-06-2026 (≠ boletas 06-06)
const FECHA = "2026-06-14";

function genCafXml(td: number): string {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  // M/E/FRMA deben ser base64 VÁLIDO (xs:base64Binary) o el XSD rebota; usamos el
  // módulo real del par + base64 dummy para FRMA (no se verifica firma localmente).
  let hex = kp.publicKey.n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const modB64 = forge.util.encode64(forge.util.hexToBytes(hex));
  const frmaB64 = forge.util.encode64("caf-signature-placeholder-bytes-xsd-format-only");
  return `<?xml version="1.0"?><AUTORIZACION><CAF version="1.0"><DA>` +
    `<RE>${EMISOR.rut}</RE><RS>${EMISOR.legalName}</RS><TD>${td}</TD>` +
    `<RNG><D>1</D><H>200</H></RNG><FA>2026-06-12</FA>` +
    `<RSAPK><M>${modB64}</M><E>AQAB</E></RSAPK><IDK>100</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">${frmaB64}</FRMA></CAF>` +
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
  const attrs = [{ name: "commonName", value: "TEST" }, { name: "serialNumber", value: RUT_ENVIA }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "pass", { algorithm: "3des" });
  const der = forge.asn1.toDer(p12).getBytes();
  const out = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) out[i] = der.charCodeAt(i);
  return out;
}

// ── Generar sobre + libros ────────────────────────────────────────────────
const pfx = makeTestPfx();
const tipos = [...new Set(DEFAULT_FACTURA_CERT_CASES.map((c) => c.tipoDocumento))];
const cafByType: Record<number, string> = {};
const firstFolioByType: Record<number, number> = {};
for (const t of tipos) {
  cafByType[t] = genCafXml(t);
  firstFolioByType[t] = 1;
}

const args: BuildCertFacturaArgs = {
  cases: DEFAULT_FACTURA_CERT_CASES,
  emisor: EMISOR,
  receptor: {
    rut: DEFAULT_FACTURA_CERT_RECEPTOR.rut,
    razonSocial: DEFAULT_FACTURA_CERT_RECEPTOR.razonSocial,
    giro: DEFAULT_FACTURA_CERT_RECEPTOR.giro,
    dirRecep: DEFAULT_FACTURA_CERT_RECEPTOR.dirRecep,
    cmnaRecep: DEFAULT_FACTURA_CERT_RECEPTOR.cmnaRecep,
  },
  firstFolioByType,
  cafByType,
  fechaEmision: FECHA,
  tstedIso: `${FECHA}T12:00:00`,
};

const dtes = buildCertFacturaDtes(args, pfx, "pass");
const sobre = buildEnvioDte({
  setId: "SetDoc",
  signedDtes: dtes.map((d) => d.signedDte),
  caratula: {
    rutEmisor: EMISOR.rut,
    rutEnvia: RUT_ENVIA,
    rutReceptor: "60803000-K",
    fchResol: FCH_RESOL,
    nroResol: 0,
    tmstFirmaEnv: `${FECHA}T12:00:00`,
  },
  pfxBytes: pfx,
  password: "pass",
});
const libros = buildCertLibros(dtes, {
  emisor: EMISOR,
  receptor: { rut: DEFAULT_FACTURA_CERT_RECEPTOR.rut, razonSocial: DEFAULT_FACTURA_CERT_RECEPTOR.razonSocial },
  rutEnvia: RUT_ENVIA,
  fchResol: FCH_RESOL,
  nroResol: 0,
  fechaEmision: FECHA,
});
const ventas = buildSignedLibroIecv(libros.ventas, pfx, "pass");
const compras = buildSignedLibroIecv(libros.compras, pfx, "pass");
const guias = buildSignedLibroGuia(libros.guias, pfx, "pass");

const dir = await Deno.makeTempDir({ prefix: "cert-factura-xsd-" });
await Deno.writeFile(`${dir}/sobre.xml`, sobre.bytes);
await Deno.writeFile(`${dir}/libro-ventas.xml`, ventas.bytes);
await Deno.writeFile(`${dir}/libro-compras.xml`, compras.bytes);
await Deno.writeFile(`${dir}/libro-guias.xml`, guias.bytes);

// Los XSD de libros traen dos problemas de TOOLING (no de nuestro XML): el de
// LibroGuia (suelto) importa xmldsignature_v10.xsd que no está a su lado, y
// LceSiiTypes_v10.xsd trae un facet decimal de 34 dígitos que libxml no compila.
// Armamos un dir plano con todos los XSD juntos y parchamos el facet.
async function prepareLibroSchemas(): Promise<string> {
  const tmp = await Deno.makeTempDir({ prefix: "sii-xsd-" });
  // RECURSIVO a propósito. El kit del SII llega de dos formas: plano (como queda
  // cuando alguien descomprime todo junto) o una carpeta por zip —schema_dte/,
  // schema_iecv/, schema_lgd/…—, que es como lo deja `scripts/fetch-xsd.sh`.
  // La versión anterior miraba una lista fija de tres rutas, así que con el kit
  // recién bajado NO encontraba `LibroGuia_v10.xsd` (vive en schema_lgd/) y el
  // pre-vuelo del libro de guías terminaba en ❌ sin que faltara nada: el archivo
  // estaba ahí, el buscador no.
  // Primero-gana, no último-gana. El mismo esquema viene repetido en varios zips
  // del SII —`xmldsignature_v10.xsd` está en casi todos— y algunas copias llegan
  // en 444: al copiar la segunda encima de un destino de solo-lectura, EACCES.
  // La versión anterior lo tapaba con `.catch(() => {})`; acá simplemente no se
  // copia dos veces, lo que además hace el resultado determinista (el orden de
  // `readDir` es el del sistema de archivos, no alfabético).
  const vistos = new Set<string>();
  let copiados = 0;
  async function juntarXsd(dir: string): Promise<void> {
    const entradas = [];
    for await (const e of Deno.readDir(dir)) entradas.push(e);
    entradas.sort((a, b) => a.name.localeCompare(b.name)); // orden estable
    for (const e of entradas) {
      const ruta = `${dir}/${e.name}`;
      if (e.isDirectory) await juntarXsd(ruta);
      else if (e.isFile && e.name.endsWith(".xsd") && !vistos.has(e.name)) {
        await Deno.copyFile(ruta, `${tmp}/${e.name}`);
        await Deno.chmod(`${tmp}/${e.name}`, 0o644); // el parche del facet lo reescribe
        vistos.add(e.name);
        copiados++;
      }
    }
  }
  try {
    await juntarXsd(xsdDir);
  } catch (e) {
    throw new Error(`no pude leer el kit XSD en ${xsdDir}: ${e instanceof Error ? e.message : e}`);
  }
  // Cero esquemas no es "todo en orden": es el buscador midiendo el vacío.
  if (copiados === 0) {
    throw new Error(
      `no hay ningún .xsd bajo ${xsdDir}. Baja el kit del SII con \`bash scripts/fetch-xsd.sh\` ` +
        `y pásale el directorio: \`deno task cert:xsd .sii-xsd\``,
    );
  }
  for await (const e of Deno.readDir(tmp)) {
    if (!e.name.endsWith(".xsd")) continue;
    const p = `${tmp}/${e.name}`;
    const txt = await Deno.readTextFile(p);
    const patched = txt.replaceAll("999999999999999999999999999999.9999", "99999999999999.9999");
    if (patched !== txt) await Deno.writeTextFile(p, patched);
  }
  return tmp;
}
const libroXsdDir = await prepareLibroSchemas();

// ── Validar contra los XSD oficiales del SII con xmllint ───────────────────
const checks: { file: string; xsd: string }[] = [
  { file: "sobre.xml", xsd: `${xsdDir}/schema_dte/EnvioDTE_v10.xsd` },
  { file: "libro-ventas.xml", xsd: `${libroXsdDir}/LibroCV_v10.xsd` },
  { file: "libro-compras.xml", xsd: `${libroXsdDir}/LibroCV_v10.xsd` },
  { file: "libro-guias.xml", xsd: `${libroXsdDir}/LibroGuia_v10.xsd` },
];

console.log(`Sobre: ${dtes.length} DTEs · libros IEV/IEC/Guías · XSD: ${xsdDir}\n`);
let allOk = true;
for (const { file, xsd } of checks) {
  try {
    await Deno.stat(xsd);
  } catch {
    console.log(`⚠️  ${file}: XSD no encontrado (${xsd}) — sáltalo o pasa el dir correcto`);
    allOk = false;
    continue;
  }
  const cmd = new Deno.Command("xmllint", {
    args: ["--noout", "--schema", xsd, `${dir}/${file}`],
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  const err = new TextDecoder().decode(stderr).trim();
  if (code === 0) {
    console.log(`✅ ${file}  válido vs ${xsd.split("/").pop()}`);
  } else {
    allOk = false;
    console.log(`❌ ${file}  (vs ${xsd.split("/").pop()}):`);
    console.log(err.split("\n").map((l) => `     ${l}`).join("\n"));
  }
}

// ── Capa 2: reglas de negocio / aritmética de montos ──────────────────────
// Re-deriva los totales parseando el XML EMITIDO (independiente de
// computeFacturaCertTotals) → detecta cualquier desajuste Detalle↔Totales que el
// XSD no ve (el XSD valida estructura, no que las cifras cuadren).
function checkMontos(): string[] {
  const errs: string[] = [];
  for (const d of dtes) {
    const flat = d.signedDte.replace(/\r\n/g, "");
    // Exportación (110/111/112): TODO exento, montos DECIMALES (xs:decimal/4). MntExe = MntTotal =
    // Σ(líneas) + Σ(recargos R). Flete/seguro/comisión van como recargos globales (TpoMov=R).
    if (d.tipoDocumento === 110 || d.tipoDocumento === 111 || d.tipoDocumento === 112) {
      const dec = (re: RegExp): number => parseFloat(flat.match(re)?.[1] ?? "0");
      const mntExe = dec(/<MntExe>([\d.]+)<\/MntExe>/);
      const mntTotal = dec(/<MntTotal>([\d.]+)<\/MntTotal>/);
      let lineas = 0;
      for (const m of flat.matchAll(/<Detalle>([\s\S]*?)<\/Detalle>/g)) {
        // Export: MontoItem de línea puede ser DECIMAL (Dec/4), ej. 4903532-1 PrcItem=1 + RecargoPct=10
        // → MontoItem=1.1 (recargo de línea, no plegado). parseFloat, no parseInt (que truncaría a 1).
        lineas += parseFloat(m[1].match(/<MontoItem>([\d.]+)<\/MontoItem>/)?.[1] ?? "0");
      }
      let recargos = 0;
      for (const rg of flat.matchAll(/<DscRcgGlobal>([\s\S]*?)<\/DscRcgGlobal>/g)) {
        const blk = rg[1];
        if (!/<TpoMov>R<\/TpoMov>/.test(blk)) continue;
        const valor = parseFloat(blk.match(/<ValorDR>([\d.]+)<\/ValorDR>/)?.[1] ?? "0");
        recargos += /<TpoValor>%<\/TpoValor>/.test(blk) ? lineas * valor / 100 : valor;
      }
      const r4 = (n: number) => Math.round(n * 10000) / 10000;
      const exp = r4(lineas + recargos);
      if (r4(mntExe) !== exp) errs.push(`${d.caso}: MntExe ${mntExe} ≠ esperado ${exp} (líneas ${lineas} + recargos ${r4(recargos)})`);
      if (r4(mntTotal) !== exp) errs.push(`${d.caso}: MntTotal ${mntTotal} ≠ ${exp}`);
      if (!/<TpoMoneda>/.test(flat)) errs.push(`${d.caso}: export sin TpoMoneda en Totales`);
      if (!/<TED /.test(flat)) errs.push(`${d.caso}: falta TED`);
      if (!/<TpoDocRef>SET<\/TpoDocRef>/.test(flat)) errs.push(`${d.caso}: falta referencia al SET`);
      continue;
    }
    const isLiq = d.tipoDocumento === 43; // Liquidación-Factura: ValorType (±), comisiones restadas.
    const one = (re: RegExp): number => parseInt(flat.match(re)?.[1] ?? "0", 10);
    const mntNeto = one(/<MntNeto>(-?\d+)<\/MntNeto>/);
    const mntExe = one(/<MntExe>(-?\d+)<\/MntExe>/);
    const iva = one(/<IVA>(-?\d+)<\/IVA>/);
    const mntTotal = one(/<MntTotal>(-?\d+)<\/MntTotal>/);
    const tasaIva = one(/<TasaIVA>(\d+)<\/TasaIVA>/) || 19;

    let afecto = 0, exento = 0;
    for (const m of flat.matchAll(/<Detalle>([\s\S]*?)<\/Detalle>/g)) {
      const det = m[1];
      const montoItem = parseInt(det.match(/<MontoItem>(-?\d+)<\/MontoItem>/)?.[1] ?? "0", 10);
      const descMonto = parseInt(det.match(/<DescuentoMonto>(\d+)<\/DescuentoMonto>/)?.[1] ?? "0", 10);
      const descPct = det.match(/<DescuentoPct>([\d.]+)<\/DescuentoPct>/)?.[1];
      // EXENTO (suma a MntExe) ⟺ IndExe=1 ("no afecto o exento", campo 38 nota [11]). En el resto de
      // casos el valor es NETO. En Liquidación-Factura, IndExe=2 marca un ítem no facturable NEGATIVO
      // (rebaja del neto, campo 5) → va a MntNeto, NO a MntExe. (Fuera de liquidación, IndExe 2/4 sólo
      // aparece en guía traslado interno con MontoItem=0 → indiferente; se mantiene [124]→exe.)
      const isExe = isLiq ? /<IndExe>1<\/IndExe>/.test(det) : /<IndExe>[124]<\/IndExe>/.test(det);
      // MontoItem es NETO (Qty×Prc − DescuentoMonto). El bruto = MontoItem + DescuentoMonto.
      const gross = montoItem + descMonto;
      if (isExe) exento += montoItem;
      else afecto += montoItem;
      if (descPct !== undefined) {
        const exp = Math.round(gross * parseFloat(descPct) / 100);
        if (descMonto !== exp) errs.push(`${d.caso}: DescuentoMonto ${descMonto} ≠ round(bruto ${gross}×${descPct}%)=${exp}`);
      }
    }
    // Descuento global (DscRcgGlobal D %/$ sobre afectos)
    let globalDisc = 0;
    const g = flat.match(/<DscRcgGlobal>([\s\S]*?)<\/DscRcgGlobal>/)?.[1];
    if (g && /<TpoMov>D<\/TpoMov>/.test(g)) {
      const valor = parseFloat(g.match(/<ValorDR>([\d.]+)<\/ValorDR>/)?.[1] ?? "0");
      globalDisc = /<TpoValor>%<\/TpoValor>/.test(g) ? Math.round(afecto * valor / 100) : Math.round(valor);
    }
    // Retenciones (ImptoReten, ej. FC 46 IVA Retenido Total TipoImp=15): se RESTAN
    // del total (compra_venta N°16/33). Con retención total → MntTotal = Neto.
    let reten = 0;
    for (const im of flat.matchAll(/<ImptoReten>[\s\S]*?<MontoImp>(\d+)<\/MontoImp>[\s\S]*?<\/ImptoReten>/g)) {
      reten += parseInt(im[1], 10);
    }
    if (isLiq) {
      // ── Liquidación-Factura (43) — modelo del ejemplo CERTIFICADO del SII:
      //   MntNeto = SOLO netoDocs (NO la comisión) · IVA = round(MntNeto×tasa) · IVAProp = ValComIVA ·
      //   IVATerc = IVA − IVAProp · MntTotal = MntNeto + MntExe + IVA − ValComNeto−ValComExe−ValComIVA.
      // `afecto` = Σ(MontoItem de líneas no exentas) = netoDocs (admite ±). El wrapper <Comisiones>
      // de Totales lleva ValComNeto/Exe/IVA (±) — el mandatario se queda la comisión → se RESTA.
      const totBlock = flat.match(/<Totales>([\s\S]*?)<\/Totales>/)?.[1] ?? "";
      const comWrap = totBlock.match(/<Comisiones>([\s\S]*?)<\/Comisiones>/)?.[1] ?? "";
      const comVal = (tag: string) =>
        parseInt(comWrap.match(new RegExp(`<${tag}>(-?\\d+)</${tag}>`))?.[1] ?? "0", 10);
      const valComNeto = comVal("ValComNeto");
      const valComExe = comVal("ValComExe");
      const valComIVA = comVal("ValComIVA");
      const ivaProp = parseInt(totBlock.match(/<IVAProp>(-?\d+)<\/IVAProp>/)?.[1] ?? "0", 10);
      const ivaTerc = parseInt(totBlock.match(/<IVATerc>(-?\d+)<\/IVATerc>/)?.[1] ?? "0", 10);
      const expNeto = afecto; // MntNeto = SOLO docs afectos (NO la comisión) — ejemplo certificado completo el ejemplo certificado del SII.
      const expIva = expNeto > 0 ? Math.round(expNeto * tasaIva / 100) : 0;
      const expTotal = expNeto + exento + expIva - valComNeto - valComExe - valComIVA;
      if (mntNeto !== expNeto) errs.push(`${d.caso}: MntNeto ${mntNeto} ≠ netoDocs ${afecto}`);
      if (mntExe !== exento) errs.push(`${d.caso}: MntExe ${mntExe} ≠ esperado ${exento}`);
      if (iva !== expIva) errs.push(`${d.caso}: IVA ${iva} ≠ round(MntNeto ${expNeto}×${tasaIva}%)=${expIva}`);
      // IVAProp/IVATerc (opcionales): se emiten con IVA>0 y comisión IVA ≥ 0 (IVAProp=ValComIVA,
      // IVATerc=IVA−IVAProp, ambos ≤ IVA). Con comisión IVA NEGATIVA el split degenera (IVATerc>IVA,
      // prohibido campos 113/114) → se OMITEN. (Caso -1/-2 sin comisión: ValComIVA=0 → IVATerc=IVA, ok.)
      const hasProp = /<IVAProp>/.test(totBlock) && /<IVATerc>/.test(totBlock);
      if (expIva > 0 && valComIVA >= 0) {
        if (!hasProp) errs.push(`${d.caso}: faltan IVAProp/IVATerc (IVA>0 y comisión IVA ≥ 0 — modelo certificado)`);
        if (ivaProp !== valComIVA) errs.push(`${d.caso}: IVAProp ${ivaProp} ≠ ValComIVA ${valComIVA}`);
        if (ivaTerc !== expIva - valComIVA) errs.push(`${d.caso}: IVATerc ${ivaTerc} ≠ IVA−IVAProp=${expIva - valComIVA}`);
        if (ivaTerc > expIva) errs.push(`${d.caso}: IVATerc ${ivaTerc} > IVA ${expIva} (viola campo 114)`);
      } else if (expIva > 0 && valComIVA < 0 && hasProp) {
        errs.push(`${d.caso}: comisión IVA negativa NO debe emitir IVAProp/IVATerc (split degenerado IVATerc>IVA)`);
      }
      if (mntTotal !== expTotal) errs.push(`${d.caso}: MntTotal ${mntTotal} ≠ ${expNeto}+${exento}+${expIva}−${valComNeto}−${valComExe}−${valComIVA}=${expTotal}`);
    } else {
      const expNeto = Math.max(0, afecto - globalDisc);
      const expIva = expNeto > 0 ? Math.round(expNeto * tasaIva / 100) : 0;
      const expTotal = expNeto + expIva + exento - reten;
      if (mntNeto !== expNeto) errs.push(`${d.caso}: MntNeto ${mntNeto} ≠ esperado ${expNeto}`);
      if (mntExe !== exento) errs.push(`${d.caso}: MntExe ${mntExe} ≠ esperado ${exento}`);
      if (iva !== expIva) errs.push(`${d.caso}: IVA ${iva} ≠ esperado ${expIva}`);
      if (mntTotal !== expTotal) errs.push(`${d.caso}: MntTotal ${mntTotal} ≠ ${expNeto}+${expIva}+${exento}−${reten}=${expTotal}`);
    }
    if (!/<TED /.test(flat)) errs.push(`${d.caso}: falta TED`);
    if (!/<TpoDocRef>SET<\/TpoDocRef>/.test(flat)) errs.push(`${d.caso}: falta referencia al SET`);
  }
  return errs;
}

// Cuadratura de LIBROS (lo que el XSD NO ve, pero el SII valida — LBR-2/LBR-3): cada
// detalle con ≥1 de [MntExe MntNeto MntIVA], y el resumen (TotalesPeriodo) cuadra con
// el detalle, incluyendo TotIVARetTotal (FC con retención total → se resta del total).
function checkLibro(name: string, xml: string): string[] {
  const errs: string[] = [];
  const flat = xml.replace(/\r\n/g, "");
  const numIn = (s: string, tag: string) => parseInt(s.match(new RegExp(`<${tag}>(\\d+)</${tag}>`))?.[1] ?? "0", 10);
  for (const m of flat.matchAll(/<Detalle>([\s\S]*?)<\/Detalle>/g)) {
    const det = m[1];
    if (!/<MntExe>/.test(det) && !/<MntNeto>/.test(det) && !/<MntIVA>/.test(det)) {
      errs.push(`${name}: Detalle T${numIn(det, "TpoDoc")}-F${numIn(det, "NroDoc")} sin [MntExe/MntNeto/MntIVA] (LBR-3 "Falta")`);
    }
  }
  for (const m of flat.matchAll(/<TotalesPeriodo>([\s\S]*?)<\/TotalesPeriodo>/g)) {
    const tp = m[1];
    const tipo = numIn(tp, "TpoDoc");
    const exe = numIn(tp, "TotMntExe"), neto = numIn(tp, "TotMntNeto"), iva = numIn(tp, "TotMntIVA");
    const usoComun = numIn(tp, "TotIVAUsoComun");
    const ret = numIn(tp, "TotIVARetTotal"), total = numIn(tp, "TotMntTotal");
    // IVA no recuperable (TotIVANoRec por código) → suma al total.
    let noRec = 0;
    for (const nm of tp.matchAll(/<TotIVANoRec>([\s\S]*?)<\/TotIVANoRec>/g)) noRec += numIn(nm[1], "TotMntIVANoRec");
    // OtrosImp: CodImp 15 (IVA retenido total) es retención → se RESTA del total.
    let otrosRet = 0;
    for (const om of tp.matchAll(/<TotOtrosImp>([\s\S]*?)<\/TotOtrosImp>/g)) {
      if (numIn(om[1], "CodImp") === 15) otrosRet += numIn(om[1], "TotMntImp");
    }
    let dExe = 0, dNeto = 0, dIva = 0, dRet = 0, dNoRec = 0, dOtrosRet = 0;
    for (const dm of flat.matchAll(/<Detalle>([\s\S]*?)<\/Detalle>/g)) {
      const det = dm[1];
      if (numIn(det, "TpoDoc") !== tipo) continue;
      dExe += numIn(det, "MntExe"); dNeto += numIn(det, "MntNeto"); dIva += numIn(det, "MntIVA"); dRet += numIn(det, "IVARetTotal");
      for (const nm of det.matchAll(/<IVANoRec>([\s\S]*?)<\/IVANoRec>/g)) dNoRec += numIn(nm[1], "MntIVANoRec");
      for (const om of det.matchAll(/<OtrosImp>([\s\S]*?)<\/OtrosImp>/g)) if (numIn(om[1], "CodImp") === 15) dOtrosRet += numIn(om[1], "MntImp");
    }
    if (ret !== dRet) errs.push(`${name} T${tipo}: TotIVARetTotal ${ret} ≠ Σdetalle ${dRet}`);
    if (noRec !== dNoRec) errs.push(`${name} T${tipo}: TotMntIVANoRec ${noRec} ≠ Σdetalle ${dNoRec}`);
    if (otrosRet !== dOtrosRet) errs.push(`${name} T${tipo}: TotOtrosImp(15) ${otrosRet} ≠ Σdetalle ${dOtrosRet}`);
    if (exe !== dExe) errs.push(`${name} T${tipo}: TotMntExe ${exe} ≠ Σdetalle ${dExe}`);
    if (neto !== dNeto) errs.push(`${name} T${tipo}: TotMntNeto ${neto} ≠ Σdetalle ${dNeto}`);
    if (iva !== dIva) errs.push(`${name} T${tipo}: TotMntIVA ${iva} ≠ Σdetalle ${dIva}`);
    // SII (LibroCV, validación N°16): TotMntTotal = Exe + Neto + IVA + IVANoRec + IVAUsoComun − IVARetTotal − retención(OtrosImp 15).
    const exp = exe + neto + iva + noRec + usoComun - ret - otrosRet;
    if (total !== exp) errs.push(`${name} T${tipo}: TotMntTotal ${total} ≠ ${exe}+${neto}+${iva}+${noRec}+${usoComun}−${ret}−${otrosRet}=${exp}`);
  }
  return errs;
}

console.log("");
const montoErrs = checkMontos();
if (montoErrs.length === 0) {
  console.log(`✅ Montos/aritmética OK en los ${dtes.length} DTEs (Detalle↔Totales cuadran, IVA, descuentos, TED, ref SET)`);
} else {
  allOk = false;
  console.log(`❌ Reglas de negocio (${montoErrs.length}):`);
  for (const e of montoErrs) console.log(`     ${e}`);
}

const dec = (b: Uint8Array) => new TextDecoder("latin1").decode(b);
const libroErrs = [...checkLibro("IEV/ventas", dec(ventas.bytes)), ...checkLibro("IEC/compras", dec(compras.bytes))];
if (libroErrs.length === 0) {
  console.log(`✅ Cuadratura de libros OK (detalle con montos, resumen cuadra, TotIVARetTotal de la FC)`);
} else {
  allOk = false;
  console.log(`❌ Cuadratura de libros (${libroErrs.length}):`);
  for (const e of libroErrs) console.log(`     ${e}`);
}

console.log(`\nArtefactos generados en: ${dir}`);
console.log(allOk ? "\n✅ Estructura (XSD) + montos OK." : "\n❌ Hay errores — revisa arriba.");
Deno.exit(allOk ? 0 : 1);
