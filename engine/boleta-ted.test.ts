// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import {
  buildDd,
  buildTed,
  compactSiiDd,
  extractCafBlock,
  extractCafPrivateKeyPem,
  extractCafPublicKeyPem,
  verifySha1Rsa,
} from "./boleta-ted.ts";

// CAF de prueba con un par RSA generado (512 bits, como los CAF reales del SII).
function mockCaf(privPem: string, pubPem: string): string {
  return (
    `<?xml version="1.0"?><AUTORIZACION>` +
    `<CAF version="1.0"><DA><RE>78416626-0</RE><RS>COMUNIDAD RURAL SPA</RS>` +
    `<TD>39</TD><RNG><D>1</D><H>5</H></RNG><FA>2026-06-08</FA>` +
    `<RSAPK><M>abc==</M><E>Aw==</E></RSAPK><IDK>100</IDK></DA>` +
    `<FRMA algoritmo="SHA1withRSA">deadbeef==</FRMA></CAF>` +
    `<RSASK>${privPem}</RSASK><RSAPUBK>${pubPem}</RSAPUBK></AUTORIZACION>`
  );
}

function genCaf(): { cafXml: string; pubPem: string } {
  const kp = forge.pki.rsa.generateKeyPair({ bits: 512 });
  const privPem = forge.pki.privateKeyToPem(kp.privateKey);
  const pubPem = forge.pki.publicKeyToPem(kp.publicKey);
  return { cafXml: mockCaf(privPem, pubPem), pubPem };
}

Deno.test("buildTed: la FRMT firma el DD y verifica con la RSAPK del CAF (roundtrip)", () => {
  const { cafXml, pubPem } = genCaf();
  const { ted, dd, frmt } = buildTed({
    cafXml,
    rutEmisor: "78416626-0",
    tipoDte: 39,
    folio: 1,
    fechaEmision: "2026-06-08",
    montoTotal: 29800,
    item1: "Cambio de aceite",
    tstedIso: "2026-06-08T12:00:00",
  });

  // El corazón: la FRMT firma la forma COMPACTA del DD (lo que canonicaliza y
  // verifica el SII), NO el pretty emitido. Verifica contra la RSAPK del CAF.
  assert(
    verifySha1Rsa(compactSiiDd(dd), frmt, pubPem),
    "la FRMT debe verificar con la RSAPK del CAF sobre la forma COMPACTA",
  );
  // Lock del desacople emitido↔firmado: NO verifica sobre el pretty emitido.
  assert(
    !verifySha1Rsa(dd, frmt, pubPem),
    "la FRMT NO firma el DD pretty emitido (sólo el compacto)",
  );

  // El TED envuelve el MISMO dd (byte-idéntico) + la FRMT.
  assertStringIncludes(ted, '<TED version="1.0">');
  assertStringIncludes(ted, dd);
  assertStringIncludes(ted, `<FRMT algoritmo="SHA1withRSA">${frmt}</FRMT>`);
});

Deno.test("buildDd: formato canónico CRLF — cada elemento en su línea, CAF expandido", () => {
  const { cafXml } = genCaf();
  const dd = buildDd({
    cafXml,
    rutEmisor: "78416626-0",
    tipoDte: 41,
    folio: 7,
    fechaEmision: "2026-06-08",
    montoTotal: 12345,
    item1: "Consumo de agua",
    tstedIso: "2026-06-08T09:30:00",
  });
  // Cada elemento en su propia línea, separados por CRLF, sin indentación.
  assert(dd.startsWith("<DD>\r\n<RE>78416626-0</RE>\r\n<TD>41</TD>\r\n<F>7</F>\r\n<FE>2026-06-08</FE>\r\n"));
  assertStringIncludes(dd, "<MNT>12345</MNT>\r\n<IT1>Consumo de agua</IT1>\r\n");
  assertStringIncludes(dd, '<CAF version="1.0">\r\n<DA>\r\n');
  assertStringIncludes(dd, "</RSAPK>\r\n<IDK>100</IDK>\r\n</DA>\r\n");
  assert(dd.endsWith("<TSTED>2026-06-08T09:30:00</TSTED>\r\n</DD>"));
  // Invariante del formato canónico: NINGUNA frontera de tags queda compacta.
  assert(!/></.test(dd), "no debe quedar ningún `><` (toda frontera lleva CRLF)");
  // El whitespace DENTRO del texto se preserva (no se colapsa).
  assertStringIncludes(dd, "<RS>COMUNIDAD RURAL SPA</RS>");
});

Deno.test("buildDd: <MNT> = MntTotal del DTE sin redondear — entero CLP intacto, decimal export preservado (TED-3-640)", () => {
  const { cafXml } = genCaf();
  // CLP estándar/boleta: monto entero → <MNT> entero idéntico (sin '.0', sin cambio).
  const ddInt = buildDd({
    cafXml, rutEmisor: "78416626-0", tipoDte: 33, folio: 10,
    fechaEmision: "2026-06-08", montoTotal: 119000, item1: "Servicio", tstedIso: "2026-06-08T10:00:00",
  });
  assertStringIncludes(ddInt, "<MNT>119000</MNT>");
  assert(!/<MNT>119000\.\d/.test(ddInt), "monto entero NO debe llevar decimales");

  // Exportación (4903531-1): MntTotal decimal de moneda extranjera (106230.78). El <MNT> del DD
  // debe ser EXACTAMENTE ese decimal (= <MntTotal> del DTE), NO 106231 redondeado.
  const ddExp = buildDd({
    cafXml, rutEmisor: "78416626-0", tipoDte: 110, folio: 1,
    fechaEmision: "2026-06-14", montoTotal: 106230.78, item1: "CHATARRA DE ALUMINIO", tstedIso: "2026-06-14T10:00:00",
  });
  assertStringIncludes(ddExp, "<MNT>106230.78</MNT>");
  assert(!ddExp.includes("<MNT>106231</MNT>"), "export NO debe redondear el MntTotal en el TED (TED-3-640)");
});

// Golden fixture: DD de referencia REAL del oráculo de calibración (oráculo aceptado por el
// SII), capturado por la calibración (CASO-1 del set, RUT 78416626-0, CAF
// folios 1–5). El CAF de entrada se da en el formato MUTADO con que quedó
// almacenado (LF, RNG/RSAPK en una sola línea) para probar que la
// canonicalización lo normaliza al formato CRLF byte-a-byte del oráculo de calibración.
const REF_M_B64 =
  "slXqaeMpymlH/7DDBe9trnR5P1gxsePBttp/Mu/TnW9p4rgB25Txr/WOgsJVeiugkFafWQEINOugzdtM2+wb2Q==";
const REF_FRMA_B64 =
  "OxV+1Ze9bjVmBNME1V0Ww9PAPmsYNY1S5/QJi9vf9muJurNXawIzmNqAMDZuWjVdJYwiuefHYFOb0DneZEEGlA==";

const STORED_CAF_BLOCK =
  '<CAF version="1.0">\n' +
  "<DA>\n" +
  "<RE>78416626-0</RE>\n" +
  "<RS>COMUNIDAD RURAL SPA</RS>\n" +
  "<TD>39</TD>\n" +
  "<RNG><D>1</D><H>5</H></RNG>\n" +
  "<FA>2026-06-08</FA>\n" +
  "<RSAPK><M>" + REF_M_B64 + "</M><E>Aw==</E></RSAPK>\n" +
  "<IDK>100</IDK>\n" +
  "</DA>\n" +
  '<FRMA algoritmo="SHA1withRSA">' + REF_FRMA_B64 + "</FRMA>\n" +
  "</CAF>";

const GOLDEN_REF_DD =
  "<DD>\r\n" +
  "<RE>78416626-0</RE>\r\n" +
  "<TD>39</TD>\r\n" +
  "<F>1</F>\r\n" +
  "<FE>2026-06-08</FE>\r\n" +
  "<RR>66666666-6</RR>\r\n" +
  "<RSR>Set de pruebas SII</RSR>\r\n" +
  "<MNT>11900</MNT>\r\n" +
  "<IT1>Item afecto</IT1>\r\n" +
  '<CAF version="1.0">\r\n' +
  "<DA>\r\n" +
  "<RE>78416626-0</RE>\r\n" +
  "<RS>COMUNIDAD RURAL SPA</RS>\r\n" +
  "<TD>39</TD>\r\n" +
  "<RNG>\r\n" +
  "<D>1</D>\r\n" +
  "<H>5</H>\r\n" +
  "</RNG>\r\n" +
  "<FA>2026-06-08</FA>\r\n" +
  "<RSAPK>\r\n" +
  "<M>" + REF_M_B64 + "</M>\r\n" +
  "<E>Aw==</E>\r\n" +
  "</RSAPK>\r\n" +
  "<IDK>100</IDK>\r\n" +
  "</DA>\r\n" +
  '<FRMA algoritmo="SHA1withRSA">' + REF_FRMA_B64 + "</FRMA>\r\n" +
  "</CAF>\r\n" +
  "<TSTED>2026-06-08T13:37:07</TSTED>\r\n" +
  "</DD>";

Deno.test("buildDd: calza BYTE-A-BYTE con el DD de referencia del oráculo de calibración (motor propio validado sin Maullin)", () => {
  const cafXml = '<?xml version="1.0"?><AUTORIZACION>' + STORED_CAF_BLOCK +
    "<RSASK>x</RSASK><RSAPUBK>y</RSAPUBK></AUTORIZACION>";
  const dd = buildDd({
    cafXml,
    rutEmisor: "78416626-0",
    tipoDte: 39,
    folio: 1,
    fechaEmision: "2026-06-08",
    rutReceptor: "66666666-6",
    razonSocialReceptor: "Set de pruebas SII",
    montoTotal: 11900,
    item1: "Item afecto",
    tstedIso: "2026-06-08T13:37:07",
  });
  assertEquals(dd, GOLDEN_REF_DD);
});

// FRMT de referencia REAL del oráculo de calibración (SII-aceptada) para una 2ª captura del
// mismo CAF (CASO-1 real: "Cambio de aceite", total 29800). Prueba viva del
// desacople emitido↔firmado: la firma del oráculo de calibración verifica con la RSAPK del CAF
// SÓLO sobre la forma COMPACTA del DD — por eso `buildTed` firma `compactSiiDd`.
const REF_FRMT_ORACULO =
  "FjOivGt47RbgrlOQlWN9rsrWQCF/o+0wEFZmopO09oHtRaQp7UGbc9TQ0o9hsiekGbaDhcT0T0R9bhrYpllu6g==";

Deno.test("buildTed: firmar la forma COMPACTA reproduce la FRMT SII-aceptada del oráculo de calibración", () => {
  const cafXml = '<?xml version="1.0"?><AUTORIZACION>' + STORED_CAF_BLOCK +
    "<RSASK>x</RSASK></AUTORIZACION>";
  const dd = buildDd({
    cafXml,
    rutEmisor: "78416626-0",
    tipoDte: 39,
    folio: 1,
    fechaEmision: "2026-06-08",
    rutReceptor: "66666666-6",
    razonSocialReceptor: "Set de pruebas SII",
    montoTotal: 29800,
    item1: "Cambio de aceite",
    tstedIso: "2026-06-08T18:13:21",
  });
  // RSAPK pública del CAF reconstruida desde M (módulo) y E (exponente).
  const modulus = new forge.jsbn.BigInteger(forge.util.bytesToHex(forge.util.decode64(REF_M_B64)), 16);
  const exponent = new forge.jsbn.BigInteger(forge.util.bytesToHex(forge.util.decode64("Aw==")), 16);
  const pub = forge.pki.setRsaPublicKey(modulus, exponent);
  const verifyOver = (form: string): boolean => {
    const md = forge.md.sha1.create();
    md.update(form, "utf8");
    return pub.verify(md.digest().bytes(), forge.util.decode64(REF_FRMT_ORACULO));
  };
  assert(verifyOver(compactSiiDd(dd)), "la FRMT del oráculo de calibración verifica sobre el DD COMPACTO");
  assert(!verifyOver(dd), "la FRMT del oráculo de calibración NO verifica sobre el DD pretty emitido");
});

Deno.test("buildDd: RR genérico por defecto + IT1/RSR truncados a 40 + escape XML", () => {
  const { cafXml } = genCaf();
  const dd = buildDd({
    cafXml,
    rutEmisor: "78416626-0",
    tipoDte: 39,
    folio: 1,
    fechaEmision: "2026-06-08",
    montoTotal: 1000,
    item1: "x".repeat(60),
    razonSocialReceptor: "y".repeat(60),
    tstedIso: "2026-06-08T00:00:00",
  });
  assertStringIncludes(dd, "<RR>66666666-6</RR>");
  assertStringIncludes(dd, `<IT1>${"x".repeat(40)}</IT1>`);
  assertStringIncludes(dd, `<RSR>${"y".repeat(40)}</RSR>`);

  const ddEsc = buildDd({
    cafXml,
    rutEmisor: "78416626-0",
    tipoDte: 39,
    folio: 1,
    fechaEmision: "2026-06-08",
    montoTotal: 1000,
    item1: "Pan & Té <chico>",
    tstedIso: "2026-06-08T00:00:00",
  });
  assertStringIncludes(ddEsc, "<IT1>Pan &amp; Té &lt;chico&gt;</IT1>");
});

Deno.test("extractCafBlock / PrivateKey / PublicKey", () => {
  const { cafXml } = genCaf();
  const block = extractCafBlock(cafXml);
  assert(block.startsWith('<CAF version="1.0">'));
  assert(block.endsWith("</CAF>"));
  assert(!block.includes("RSASK"), "el bloque CAF del DD NO lleva la llave privada");
  assertStringIncludes(extractCafPrivateKeyPem(cafXml), "BEGIN RSA PRIVATE KEY");
  assertStringIncludes(extractCafPublicKeyPem(cafXml), "BEGIN PUBLIC KEY");
});

Deno.test("buildTed: detecta CAF inválido", () => {
  let threw = false;
  try {
    buildTed({
      cafXml: "<xml>no es un caf</xml>",
      rutEmisor: "78416626-0",
      tipoDte: 39,
      folio: 1,
      fechaEmision: "2026-06-08",
      montoTotal: 1000,
      item1: "x",
      tstedIso: "2026-06-08T00:00:00",
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});
