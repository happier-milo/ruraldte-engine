// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// sii-client.test.ts — cliente del API SII de boletas (Fase 3).
// Verifica: firma enveloped del getToken (verifica RSA), parsers de semilla/token/
// trackid, y las formas de request (URL, Cookie TOKEN, User-Agent, campos multipart).
// ============================================================================

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import forge from "npm:node-forge@1.3.1";
import {
  buildSignedToken,
  type FetchFn,
  getSemilla,
  getToken,
  parseSemilla,
  parseToken,
  parseTrackId,
  sendEnvio,
  splitRut,
} from "./sii-client.ts";
import { canonicalize, parseXml } from "./c14n.ts";
import { sha1Base64 } from "./xml-signature.ts";

function makeTestPfx(): { pfxBytes: Uint8Array; publicKey: forge.pki.rsa.PublicKey } {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 1024, e: 0x10001 });
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
  const attrs = [{ name: "commonName", value: "TEST" }, {
    name: "serialNumber",
    value: "22222222-2",
  }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], "pass", { algorithm: "3des" });
  const der = forge.asn1.toDer(p12).getBytes();
  const bytes = new Uint8Array(der.length);
  for (let i = 0; i < der.length; i++) bytes[i] = der.charCodeAt(i);
  return { pfxBytes: bytes, publicKey: keys.publicKey };
}

type Call = { url: string; init: RequestInit };
function mockFetch(body: string, status = 200): { fn: FetchFn; calls: Call[] } {
  const calls: Call[] = [];
  const fn = ((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(new Response(body, { status }));
  }) as unknown as FetchFn;
  return { fn, calls };
}

const SEMILLA_RESP =
  `<?xml version="1.0" encoding="UTF-8"?><SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema">` +
  `<SII:RESP_BODY><SEMILLA>162802760102</SEMILLA></SII:RESP_BODY>` +
  `<SII:RESP_HDR><ESTADO>00</ESTADO></SII:RESP_HDR></SII:RESPUESTA>`;
const TOKEN_RESP = `<?xml version="1.0"?><SII:RESPUESTA xmlns:SII="http://www.sii.cl/XMLSchema">` +
  `<SII:RESP_HDR><ESTADO>00</ESTADO></SII:RESP_HDR>` +
  `<SII:RESP_BODY><TOKEN>XAuSbYXiNh9Ik</TOKEN></SII:RESP_BODY></SII:RESPUESTA>`;

Deno.test("parseSemilla / parseToken: extraen el valor y validan ESTADO", () => {
  assertEquals(parseSemilla(SEMILLA_RESP), "162802760102");
  assertEquals(parseToken(TOKEN_RESP), "XAuSbYXiNh9Ik");
  let threw = false;
  try {
    parseSemilla(
      `<SII:RESPUESTA><SII:RESP_HDR><ESTADO>10</ESTADO><GLOSA>error</GLOSA></SII:RESP_HDR></SII:RESPUESTA>`,
    );
  } catch {
    threw = true;
  }
  assert(threw, "ESTADO!=00 debe lanzar");
});

Deno.test("splitRut: separa cuerpo y dígito verificador", () => {
  assertEquals(splitRut("78416626-0"), { rut: 78416626, dv: "0" });
  assertEquals(splitRut("60803000-K"), { rut: 60803000, dv: "K" });
  assertEquals(splitRut("22.222.222-2"), { rut: 22222222, dv: "2" });
});

Deno.test("parseTrackId: tolera distintas claves JSON", () => {
  assertEquals(parseTrackId(`{"trackid":123456}`), "123456");
  assertEquals(parseTrackId(`{"trackId":"789"}`), "789");
  assertEquals(parseTrackId(`no es json`), null);
});

Deno.test('buildSignedToken: getToken con firma enveloped (URI="") que VERIFICA', () => {
  const { pfxBytes, publicKey } = makeTestPfx();
  const seed = "162802760102";
  const signed = buildSignedToken(seed, pfxBytes, "pass");

  // estructura
  assert(signed.includes(`<getToken><item><Semilla>${seed}</Semilla></item>`));
  assert(signed.includes(`<Reference URI="">`), "Reference URI vacío (enveloped, todo el doc)");
  assert(signed.includes(`http://www.w3.org/2000/09/xmldsig#enveloped-signature`));

  // DigestValue = SHA1(C14N(getToken SIN la Signature))
  const noSig = `<getToken><item><Semilla>${seed}</Semilla></item></getToken>`;
  const expectedDigest = sha1Base64(canonicalize(parseXml(noSig).documentElement));
  const digestInDoc = signed.match(/<DigestValue>([^<]+)<\/DigestValue>/)?.[1];
  assertEquals(digestInDoc, expectedDigest);

  // SignatureValue verifica sobre C14N(SignedInfo)
  const si = parseXml(signed).getElementsByTagName("SignedInfo")[0];
  const md = forge.md.sha1.create();
  md.update(canonicalize(si), "utf8");
  const sv = signed.match(/<SignatureValue>([^<]+)<\/SignatureValue>/)?.[1] ?? "";
  assert(
    publicKey.verify(md.digest().getBytes(), forge.util.decode64(sv)),
    "la firma de la semilla debe verificar",
  );
});

Deno.test("getSemilla: GET correcto + parseo", async () => {
  const { fn, calls } = mockFetch(SEMILLA_RESP);
  const seed = await getSemilla("cert", { userAgent: "ua/1", fetchFn: fn });
  assertEquals(seed, "162802760102");
  assertEquals(calls[0].url, "https://apicert.sii.cl/recursos/v1/boleta.electronica.semilla");
  assertEquals(calls[0].init.method, "GET");
  assertEquals((calls[0].init.headers as Record<string, string>)["User-Agent"], "ua/1");
});

Deno.test("getToken: POST xml + parseo del token", async () => {
  const { fn, calls } = mockFetch(TOKEN_RESP);
  const token = await getToken("cert", `<?xml version="1.0"?><getToken/>`, {
    userAgent: "ua/1",
    fetchFn: fn,
  });
  assertEquals(token, "XAuSbYXiNh9Ik");
  assertEquals(calls[0].url, "https://apicert.sii.cl/recursos/v1/boleta.electronica.token");
  assertEquals(calls[0].init.method, "POST");
  assertEquals(
    (calls[0].init.headers as Record<string, string>)["Content-Type"],
    "application/xml",
  );
});

Deno.test("sendEnvio: multipart con los 5 campos + Cookie TOKEN + User-Agent", async () => {
  const { fn, calls } = mockFetch(`{"trackid":987654}`);
  const res = await sendEnvio("cert", {
    xmlBytes: new TextEncoder().encode("<EnvioBOLETA/>"),
    token: "TKN123",
    rutSender: "22222222-2",
    rutCompany: "78416626-0",
    userAgent: "rural-saas-dte/1.0",
    fetchFn: fn,
  });
  assertEquals(res.trackId, "987654");
  assertEquals(res.status, 200);

  const call = calls[0];
  // El envío VA a pangal (cert) — en apicert el path cae a un SOAP muerto
  // ("Acceso Denegado"), verificado vivo 2026-06-10.
  assertEquals(call.url, "https://pangal.sii.cl/recursos/v1/boleta.electronica.envio");
  assertEquals(call.init.method, "POST");
  const h = call.init.headers as Record<string, string>;
  assertEquals(h["User-Agent"], "rural-saas-dte/1.0");
  assertEquals(h["Cookie"], "TOKEN=TKN123");

  // Multipart serializado A MANO (bytes + Content-Length implícito): el gateway
  // del SII no soporta chunked — con FormData el archivo llegaba truncado a
  // ~4 KB (verificado vivo 2026-06-10).
  const ct = h["Content-Type"];
  const boundary = ct.match(/^multipart\/form-data; boundary=(.+)$/)?.[1];
  assert(boundary, "Content-Type debe declarar el boundary");
  const body = call.init.body as ArrayBuffer;
  assert(body instanceof ArrayBuffer, "el body debe ser bytes (ArrayBuffer), no FormData");
  const text = new TextDecoder().decode(body);
  assertStringIncludes(
    text,
    `--${boundary}\r\nContent-Disposition: form-data; name="rutSender"\r\n\r\n22222222\r\n`,
  );
  assertStringIncludes(text, `name="dvSender"\r\n\r\n2\r\n`);
  assertStringIncludes(text, `name="rutCompany"\r\n\r\n78416626\r\n`);
  assertStringIncludes(text, `name="dvCompany"\r\n\r\n0\r\n`);
  assertStringIncludes(
    text,
    `name="archivo"; filename="envio.xml"\r\nContent-Type: application/xml\r\n\r\n<EnvioBOLETA/>\r\n--${boundary}--\r\n`,
  );
  assert(text.endsWith(`--${boundary}--\r\n`), "el multipart debe cerrar con el boundary final");
});
