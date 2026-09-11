// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import forge from "npm:node-forge@1.3.1";
import { consultarFoliosViaRuralDte, parseForm, parseSiiFolioErrorPage } from "./sii-folios.ts";

// HTML real de of_solicita_folios_dcto (SII, T61 seleccionado). Clave: el SII
// escribe `value = "4"` con ESPACIOS alrededor del `=`, y NAME en mayúsculas con
// atributos (readonly/color) entre el name y el value. parseForm debe igual leerlo.
const SOLICITUD_HTML = `<FORM NAME="form1" METHOD="POST" ACTION="/cvc_cgi/dte/of_confirma_folio">
<INPUT NAME="RUT_EMP" readonly="readonly"  value = "78416626" TYPE=Text SIZE=8 MAXLENGTH=8>
<INPUT NAME="DV_EMP"  readonly="readonly"  value = "0" TYPE=Text SIZE=1>
<SELECT name = COD_DOCTO onChange ="changeRegregion('/cvc_cgi/dte/');">
  <option value="56">NOTA DEBITO ELECTRONICA (COD. 56)</option>
  <option value="61" selected>NOTA CREDITO ELECTRONICA(COD. 61)</option>
</SELECT>
<INPUT NAME="MAX_AUTOR"   readonly="readonly"  color="#888" value = "4" type=text size=8 maxlength=8>
<font class="texto"><b>Ingrese N° de Folios a Timbrar</b></font>
<input name="CANT_DOCTOS" type=text size=8 maxlength=8>
<INPUT NAME="ACEPTAR" TYPE=SUBMIT VALUE="Solicitar Numeraci&oacute;n">
<INPUT NAME="FOLIOS_DISP"  readonly="readonly" bgColor="#cccccc" value = "3" type=text size=8 maxlength=8>
</form>`;

Deno.test("parseForm: lee MAX_AUTOR/FOLIOS_DISP con 'value = \"4\"' (espacios) del of_solicita_folios_dcto", () => {
  const { action, fields } = parseForm(SOLICITUD_HTML);
  assertEquals(action, "/cvc_cgi/dte/of_confirma_folio");
  assertEquals(fields.MAX_AUTOR, "4"); // rango máximo autorizado a timbrar
  assertEquals(fields.FOLIOS_DISP, "3"); // folios disponibles / sin usar
  assertEquals(fields.RUT_EMP, "78416626");
});

Deno.test("parseSiiFolioErrorPage: detecta la página de error del SII + extrae el código", () => {
  // Página real del SII tras pedir más folios que el máximo autorizado (1358b).
  const errorHtml =
    `<font class="texto">No ha sido posible completar su solicitud.  Int&eacute;ntelo m&aacute;s tarde ` +
    `y si el problema persiste, comun&iacute;quese con la <a href="http://www.sii.cl/x">Mesa de ayuda</a>, ` +
    `informando el siguiente c&oacute;digo <b>LIBRUD-OFSF-DTE-3-1-02</b>.</font>`;
  assertEquals(parseSiiFolioErrorPage(errorHtml)?.code, "LIBRUD-OFSF-DTE-3-1-02");
  // Una respuesta con CAF (o cualquier otra) NO es página de error.
  assertEquals(parseSiiFolioErrorPage("<AUTORIZACION><CAF/></AUTORIZACION>"), null);
});

// ── Consulta de cupos: los dos best-effort dejan el motivo en el trace ──────────
// El motor sale por el `fetch` global y busca `Deno.createHttpClient` en `globalThis`,
// así que consultarFoliosViaRuralDte se ejercita entera sin tocar al SII: se reemplazan
// los dos y se responde por URL. Los cupos en null son un resultado LEGÍTIMO (el SII no
// siempre los expone); lo que se prueba acá es que, cuando el null viene de una falla,
// la causa quede escrita — antes los dos `catch` la borraban y "no los expuso" se veía
// igual que "se cayó la página".

/** PFX sintético: el motor arma el cliente mTLS desde el PKCS#12 antes de salir a la red. */
function pfxDePrueba(): string {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [{ name: "commonName", value: "TEST" }, { name: "serialNumber", value: "11111111-1" }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "pass", { algorithm: "3des" });
  return forge.util.encode64(forge.asn1.toDer(p12).getBytes());
}

/** Responde 200 y siembra la cookie de sesión que `authenticate` exige para seguir. */
function okResp(body: string): Response {
  return new Response(body, { status: 200, headers: { "set-cookie": "TOKEN=t; path=/" } });
}

/** Corre `fn` con el `fetch` global y `Deno.createHttpClient` reemplazados; los restaura siempre. */
async function conRedFalsa(
  responder: (url: string, body: string) => Response,
  fn: () => Promise<void>,
): Promise<void> {
  const deno = (globalThis as unknown as { Deno: Record<string, unknown> }).Deno;
  const fetchPrevio = globalThis.fetch;
  const clientPrevio = deno.createHttpClient;
  const set = (v: unknown) =>
    Object.defineProperty(deno, "createHttpClient", { value: v, configurable: true, writable: true });
  set(() => ({}));
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(
      responder(String(input), typeof init?.body === "string" ? init.body : ""),
    )) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = fetchPrevio;
    set(clientPrevio);
  }
}

const PFX = pfxDePrueba();
const ARGS = {
  emisorRut: "11111111-1",
  documentTypes: [33],
  ambiente: 0 as const,
  pfxBase64: PFX,
  pfxPassword: "pass",
};

Deno.test("consultarFoliosViaRuralDte: si la página de cupos de un tipo falla, el trace dice por qué", async () => {
  await conRedFalsa((url, body) => {
    if (url.includes("of_consulta2_folio")) return okResp("<html>no tiene habilitado</html>");
    // El reload por tipo (el que trae COD_DOCTO) se cae; el resto del flujo responde bien.
    if (url.includes("of_solicita_folios_dcto")) {
      if (body.includes("COD_DOCTO")) throw new Error("reload cayó: 502");
      return okResp(SOLICITUD_HTML);
    }
    return okResp("<html>ok</html>");
  }, async () => {
    const { results, trace } = await consultarFoliosViaRuralDte(ARGS);
    // Best-effort intacto: la consulta igual devuelve su resultado, con los cupos en null.
    assertEquals(results.length, 1);
    assertEquals(results[0].maxTimbrar, null);
    assertEquals(results[0].foliosSinUsar, null);
    // Y la causa queda legible en el trace, que es lo que esta función devuelve para diagnosticar.
    const entrada = trace.find((t) => t.step === "solicita_doc_33_error");
    assert(entrada, `sin entrada en el trace; steps: ${trace.map((t) => t.step).join(",")}`);
    assertStringIncludes(entrada.body ?? "", "reload cayó: 502");
  });
});

Deno.test("consultarFoliosViaRuralDte: si se cae el form de solicitud, el trace lo dice y la consulta igual vuelve", async () => {
  await conRedFalsa((url) => {
    if (url.includes("of_consulta2_folio")) return okResp("<html>no tiene habilitado</html>");
    // Se cae el POST del RUT, antes del loop por tipo: cae en el catch de más afuera.
    if (url.includes("of_solicita_folios_dcto")) throw new Error("solicita_rut cayó: 500");
    return okResp("<html>ok</html>");
  }, async () => {
    const { results, trace } = await consultarFoliosViaRuralDte(ARGS);
    assertEquals(results.length, 1);
    const entrada = trace.find((t) => t.step === "solicita_cupos_error");
    assert(entrada, `sin entrada en el trace; steps: ${trace.map((t) => t.step).join(",")}`);
    assertStringIncludes(entrada.body ?? "", "solicita_rut cayó: 500");
    // No llegó al loop por tipo, así que esa otra entrada no existe.
    assertEquals(trace.some((t) => t.step === "solicita_doc_33_error"), false);
  });
});
