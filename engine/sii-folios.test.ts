// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import forge from "npm:node-forge@1.3.1";
import {
  consultarFoliosViaRuralDte,
  extractoTexto,
  leerCupoSolicitud,
  motivoSiiNoAutoriza,
  openSiiSession,
  parseForm,
  parseSiiFolioErrorPage,
  plazoDelPaso,
  RuralDteFolioError,
  SII_NO_AUTORIZA,
} from "./sii-folios.ts";

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

// La misma página con un formulario ANTES (un buscador en el encabezado). parseForm
// sin opciones lee el primero; la solicitud tiene que encontrar el suyo.
const CON_BUSCADOR_HTML = `<form name="buscar" action="/cgi_busca/buscador.cgi">
<input name="q" type="text" value=""><input type="submit" value="Buscar">
</form>
${SOLICITUD_HTML}`;

Deno.test("parseForm conCampo: con otro form antes, elige el que tiene COD_DOCTO", () => {
  assertEquals(parseForm(CON_BUSCADOR_HTML).action, "/cgi_busca/buscador.cgi"); // el default no cambia
  const { action, fields } = parseForm(CON_BUSCADOR_HTML, { conCampo: "COD_DOCTO" });
  assertEquals(action, "/cvc_cgi/dte/of_confirma_folio");
  // (El valor de COD_DOCTO no importa: los dos flujos lo sobrescriben con el tipo pedido.)
  assert("COD_DOCTO" in fields);
  assertEquals([fields.MAX_AUTOR, fields.RUT_EMP], ["4", "78416626"]);
  assert(!("q" in fields)); // nada del buscador
  // Sin ningún form que lo tenga, cae al primero (mismo comportamiento de siempre).
  assertEquals(parseForm(CON_BUSCADOR_HTML, { conCampo: "NO_EXISTE" }).action, "/cgi_busca/buscador.cgi");
});

Deno.test("leerCupoSolicitud: lee MAX_AUTOR/FOLIOS_DISP en toda la página, con o sin form delante", () => {
  assertEquals(leerCupoSolicitud(200, SOLICITUD_HTML), { maxTimbrar: 4, foliosSinUsar: 3, motivo: null });
  assertEquals(leerCupoSolicitud(200, CON_BUSCADOR_HTML).maxTimbrar, 4);
});

Deno.test("leerCupoSolicitud: sin MAX_AUTOR, el motivo cuenta qué mostró el SII", () => {
  const sinPermiso = `<html><body><font class="texto">Usted no est&aacute; autorizado para ` +
    `solicitar timbraje de folios para esta empresa.</font></body></html>`;
  const r = leerCupoSolicitud(200, sinPermiso);
  assertEquals(r.maxTimbrar, null);
  assertStringIncludes(r.motivo ?? "", "no trae MAX_AUTOR");
  assertStringIncludes(r.motivo ?? "", "Usted no está autorizado para solicitar timbraje");
  const vacio = leerCupoSolicitud(200, SOLICITUD_HTML.replace('value = "4"', 'value = ""'));
  assertEquals(vacio.maxTimbrar, null);
  assertStringIncludes(vacio.motivo ?? "", "trae MAX_AUTOR vacío");
});

Deno.test("leerCupoSolicitud: si el SII niega el timbraje, el motivo cita su razón y no el encabezado", () => {
  // Forma real de la página (30-sep-2026, folios de la plataforma): la razón va después
  // de un encabezado largo, y el extracto de 280 caracteres la cortaba en "Sr…".
  const negado = `<html><body><h1>Solicitud de Timbraje Electr&oacute;nico de Documentos</h1>` +
    `<p>SOLICITUD DE TIMBRAJE ELECTRONICO DE DOCUMENTOS</p><p>En esta p&aacute;gina podr&aacute; ` +
    `solicitar rangos de numeraci&oacute;n para utilizar en los Documentos Tributarios ` +
    `Electr&oacute;nicos autorizados para los contribuyentes.</p>` +
    `<font>NO SE AUTORIZA TIMBRAJE ELECTR&Oacute;NICO Sr. Contribuyente: usted presenta ` +
    `observaciones que debe regularizar.</font></body></html>`;
  const r = leerCupoSolicitud(200, negado);
  assertEquals(r.maxTimbrar, null);
  assertStringIncludes(r.motivo ?? "", SII_NO_AUTORIZA);
  assertStringIncludes(r.motivo ?? "", "Sr. Contribuyente: usted presenta observaciones que debe regularizar.");
  assertEquals((r.motivo ?? "").includes("En esta página podrá"), false);
  // La otra forma que devuelve el SII ("NO AUTORIZA TIMBRAJE ELECTRÓNICA - Sr.").
  assertStringIncludes(motivoSiiNoAutoriza("<p>NO AUTORIZA TIMBRAJE ELECTR&Oacute;NICA - Sr. X</p>") ?? "", "Sr. X");
  // Sin esa frase, el motivo de siempre.
  assertEquals(motivoSiiNoAutoriza("<p>Usted no est&aacute; autorizado</p>"), null);
});

Deno.test("extractoTexto: texto plano, entidades del SII resueltas y recortado", () => {
  assertEquals(extractoTexto("<b>Int&eacute;ntelo m&aacute;s tarde</b>"), "Inténtelo más tarde");
  assertEquals(extractoTexto("<script>x()</script>   "), "(página vacía)");
  assertEquals(extractoTexto("a".repeat(400), 10), `${"a".repeat(10)}…`);
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

// ── "Habilitado" no se lee de una respuesta que no es una respuesta ────────────
// `parseConsulta` da por habilitado un tipo cuando la página NO dice "no tiene
// habilitado". Una página vacía o un error del portal tampoco lo dicen: hasta el
// 9-oct-2026 salían como "habilitado, sin timbrajes", y de ese dato leen el autopilot
// de folios y la comprobación de que un comité ya emite.

for (const [nombre, respuesta] of [
  ["sin contenido", () => okResp("")],
  ["solo espacios", () => okResp("  \n ")],
  ["HTTP 503 (mantención)", () => new Response("<html>Servicio no disponible</html>", { status: 503 })],
] as const) {
  Deno.test(`consultarFoliosViaRuralDte: una respuesta ${nombre} no es "habilitado": la consulta falla`, async () => {
    let consultas = 0;
    await conRedFalsa((url) => {
      if (url.includes("of_consulta2_folio")) {
        consultas++;
        return respuesta();
      }
      return okResp("<html>ok</html>");
    }, async () => {
      let error: unknown = null;
      try {
        await consultarFoliosViaRuralDte(ARGS);
      } catch (err) {
        error = err;
      }
      assert(error instanceof Error, "la consulta devolvió un resultado con una respuesta que no dice nada");
      assertEquals((error as Error).name, "RuralDteFolioError");
      assertStringIncludes((error as Error).message, "consulta tipo 33 pág 1");
      assertEquals(consultas, 2, "se reintenta una vez antes de fallar");
    });
  });
}

/** Una página de timbrajes como la del portal: una fila por rango autorizado. */
const PAGINA_CON_UN_TIMBRAJE = `<html><body>Timbrajes para BOLETA EXENTA ELECTRONICA:<table>
<tr><td>Fecha</td><td>Cantidad</td><td>Inicial</td><td>Final</td><td>Mandatario</td></tr>
<tr><td>01-10-2026</td><td>500</td><td>1</td><td>500</td><td>11111111-1</td></tr>
</table></body></html>`;

for (const [nombre, segunda] of [
  ["sin contenido", () => okResp("")],
  ["con un 404", () => new Response("no existe", { status: 404 })],
] as const) {
  Deno.test(`consultarFoliosViaRuralDte: una página 2 ${nombre} termina la lista con lo leído, no tumba la consulta`, async () => {
    // Con un timbraje en la página 1 siempre se pide la 2. Quien pide folios consulta
    // antes: si esa página tumbara la consulta, las boletas que esperan folio quedarían
    // posponiéndose de a 10 minutos sin que nadie se entere.
    const pedidas: string[] = [];
    await conRedFalsa((url, body) => {
      if (url.includes("of_consulta2_folio")) {
        const pagina = new URLSearchParams(body).get("PAGINA") ?? "?";
        pedidas.push(pagina);
        return pagina === "1" ? okResp(PAGINA_CON_UN_TIMBRAJE) : segunda();
      }
      return okResp("<html>ok</html>");
    }, async () => {
      const { results } = await consultarFoliosViaRuralDte(ARGS);
      assertEquals(pedidas, ["1", "2"]);
      assertEquals(results[0].enabled, true);
      assertEquals(results[0].batches.length, 1);
      assertEquals([results[0].authorizedTotal, results[0].authorizedMax], [500, 500]);
    });
  });
}

// ── El plazo de cada paso ───────────────────────────────────────────────────

Deno.test("cada paso contra el portal sale con plazo, y los que otorgan folios esperan más", async () => {
  // Cortar una lectura a los 30 segundos no cuesta nada. Cortar el paso que otorga los
  // folios sí: el SII pudo haber timbrado, y quedan folios otorgados sin su CAF.
  assertEquals(plazoDelPaso("consulta2"), 30_000);
  assertEquals(plazoDelPaso("post_confirma"), 120_000);
  assertEquals(plazoDelPaso("post_confirm0"), 120_000);

  // Y la sesión se lo pone de verdad a cada salida, según el nombre del paso.
  const pedidos: number[] = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = (ms: number) => (pedidos.push(ms), original.call(AbortSignal, ms));
  try {
    await conRedFalsa(() => okResp("<html>ok</html>"), async () => {
      const sesion = await openSiiSession({ pfxBase64: PFX, pfxPassword: "pass", ambiente: 0 }, "https://maullin.sii.cl/x");
      assert(pedidos.length > 0 && pedidos.every((ms) => ms === 30_000), `la autenticación salió con ${pedidos.join(", ")}`);
      pedidos.length = 0;
      await sesion.fetch("solicita_doc", sesion.abs("/cvc_cgi/dte/of_solicita_folios_dcto"));
      await sesion.fetch("post_confirma", sesion.abs("/cvc_cgi/dte/of_confirma_folio"), { method: "POST", body: "a=1" });
      await sesion.fetch("post_confirm0", sesion.abs("/cvc_cgi/dte/of_genera_folio"), { method: "POST", body: "a=1" });
      assertEquals(pedidos, [30_000, 120_000, 120_000]);
    });
  } finally {
    AbortSignal.timeout = original;
  }
});

// ── El SII no contestó, o contestó y no abrió la sesión ─────────────────────────────

Deno.test("si la conexión se corta en los tres intentos, el error dice que el SII no contestó", async () => {
  // Lo que pasó el 10-oct-2026 con el portal de certificación: la red lanza, no hay
  // respuesta que leer. No es el certificado, y se pasa solo.
  const deno = (globalThis as unknown as { Deno: Record<string, unknown> }).Deno;
  const fetchPrevio = globalThis.fetch;
  const clientPrevio = deno.createHttpClient;
  const set = (v: unknown) =>
    Object.defineProperty(deno, "createHttpClient", { value: v, configurable: true, writable: true });
  set(() => ({}));
  let llamadas = 0;
  globalThis.fetch = (() => {
    llamadas++;
    return Promise.reject(new TypeError("connection error: peer closed connection without sending TLS close_notify"));
  }) as typeof fetch;
  try {
    const error = await openSiiSession({ pfxBase64: PFX, pfxPassword: "pass", ambiente: 0 }, "https://maullin.sii.cl/x")
      .then(() => null, (e) => e as RuralDteFolioError);
    assert(error instanceof RuralDteFolioError);
    assertEquals([error.stage, error.reachedGrant, error.sinRespuesta], ["auth", false, true]);
    assertEquals(llamadas, 3);
  } finally {
    globalThis.fetch = fetchPrevio;
    set(clientPrevio);
  }
});

Deno.test("si el SII contesta pero no abre la sesión, no se confunde con una caída: puede ser el certificado", async () => {
  await conRedFalsa(() => new Response("<html>sin sesion</html>", { status: 200 }), async () => {
    const error = await openSiiSession({ pfxBase64: PFX, pfxPassword: "pass", ambiente: 0 }, "https://maullin.sii.cl/x")
      .then(() => null, (e) => e as RuralDteFolioError);
    assert(error instanceof RuralDteFolioError);
    assertEquals([error.stage, error.sinRespuesta], ["auth", false]);
  });
});

Deno.test("todo paso que puede otorgar folios se llama post_confirm…: es por el nombre que espera más", () => {
  // Desde `reachedGrant = true` un POST puede timbrar. Un paso nuevo ahí con otro
  // nombre saldría con el plazo corto, sin error.
  const fuente = Deno.readTextFileSync(new URL("./sii-folios.ts", import.meta.url));
  const desde = fuente.indexOf("reachedGrant = true;");
  assert(desde > 0, "sii-folios.ts ya no marca reachedGrant");
  const hasta = fuente.indexOf("\nexport async function", desde);
  const pasos = [...fuente.slice(desde, hasta).matchAll(/session\.fetch\(\s*([`"'])([^`"']*)\1/g)].map((m) => m[2]);
  assert(pasos.length >= 2, `se esperaban los pasos que otorgan; hay ${pasos.join(", ")}`);
  for (const paso of pasos) assert(paso.startsWith("post_confirm"), `el paso "${paso}" puede otorgar folios y no espera el plazo largo`);
});
