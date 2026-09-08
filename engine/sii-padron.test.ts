// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// Tests del padrón del SII. El fixture replica el markup REAL de `ce_consulta_e`
// (tablas legacy con <font>, entidades &oacute; y el "N°" mojibake en latin-1),
// con datos sintéticos. El parser se validó además contra la respuesta viva de
// Palena del 2026-07-31 antes de escribirlo.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { parsePadronConsulta, parsePadronCsvLine } from "./sii-padron.ts";

/** Igual forma que la respuesta real: tabla de antecedentes + tabla de tipos. */
function fixtureConsulta(o: { mail?: string; desautorizar39?: boolean } = {}): string {
  const mail = o.mail ?? "recepcion@dte.proveedor.cl";
  return `<html><body>
<table border="0"><tr><td><font class="texto">antecedentes del Contribuyente son :</font></td></tr></table>
<table border="1" cellspacing=0 cellpadding=1 width="600">
<TR><td width="200" align="left"><font class="texto">&nbsp; Rut </font></td>
    <td width="400" align="left"><font class="texto">&nbsp; 77777777-7 </font></td></tr>
<tr><td><font class="texto">&nbsp; Raz&oacute;n Social/Nombres </font></td>
    <td><font class="texto">&nbsp; PROVEEDOR SPA </font></td></tr>
<tr><td><font class="texto">&nbsp; N� Resoluci&oacute;n </font></td>
    <td><font class="texto">&nbsp; 80 </font></td></tr>
<tr><td><font class="texto">&nbsp; Fecha Resoluci&oacute;n </font></td>
    <td><font class="texto">&nbsp; 22-08-2014 </font></td></tr>
<tr><td><font class="texto">&nbsp; Mail de contacto </font></td>
    <td><font class="texto">&nbsp; ${mail} </font></td></tr>
</table>
<table border="1" cellspacing=1 width="630">
<TR><td><font class="texto"> C&oacute;digo </font></td><td><font class="texto"> Descripci&oacute;n </font></td>
    <td><font class="texto"> Autorizado </font></td><td><font class="texto"> Desautorizado </font></td></tr>
<tr><td><font class="texto"> 33 </font></td><td><font class="texto"> FACTURA ELECTRONICA </font></td>
    <td><font class="texto"> 01-02-2018 </font></td><td><font class="texto"> &nbsp; </font></td></tr>
<tr><td><font class="texto"> 39 </font></td><td><font class="texto"> BOLETA ELECTRONICA </font></td>
    <td><font class="texto"> 01-02-2018 </font></td>
    <td><font class="texto"> ${o.desautorizar39 ? "10-05-2024" : "&nbsp;"} </font></td></tr>
<tr><td><font class="texto"> 61 </font></td><td><font class="texto"> NOTA CREDITO ELECTRONICA </font></td>
    <td><font class="texto"> 01-02-2018 </font></td><td><font class="texto"> &nbsp; </font></td></tr>
</table></body></html>`;
}

Deno.test("parsePadronConsulta: saca la casilla de intercambio y los antecedentes", () => {
  const c = parsePadronConsulta(fixtureConsulta())!;
  assert(c, "debe parsear la ficha");
  assertEquals(c.rut, "77777777-7");
  assertEquals(c.razonSocial, "PROVEEDOR SPA");
  assertEquals(c.mailIntercambio, "recepcion@dte.proveedor.cl");
  assertEquals(c.nroResolucion, "80");
  assertEquals(c.fechaResolucion, "22-08-2014");
});

Deno.test("parsePadronConsulta: normaliza la casilla a minúsculas", () => {
  const c = parsePadronConsulta(fixtureConsulta({ mail: "Recepcion@DTE.Proveedor.CL" }))!;
  assertEquals(c.mailIntercambio, "recepcion@dte.proveedor.cl");
});

Deno.test("parsePadronConsulta: solo cuenta los tipos VIGENTES (con desautorización quedan fuera)", () => {
  assertEquals(parsePadronConsulta(fixtureConsulta())!.tiposAutorizados, [33, 39, 61]);
  assertEquals(
    parsePadronConsulta(fixtureConsulta({ desautorizar39: true }))!.tiposAutorizados,
    [33, 61],
    "un tipo con fecha de desautorización ya no está vigente",
  );
});

Deno.test("parsePadronConsulta: página sin antecedentes (RUT no autorizado) → null", () => {
  assertEquals(parsePadronConsulta("<html><body>No se encontraron datos</body></html>"), null);
});

Deno.test("parsePadronCsvLine: parsea una fila del padrón completo y descarta la cabecera", () => {
  const c = parsePadronCsvLine("76543210-3;EJEMPLO S.A.;80;22-08-2014 ;recepcion@dte.proveedor.cl;")!;
  assertEquals(c.rut, "76543210-3");
  assertEquals(c.mailIntercambio, "recepcion@dte.proveedor.cl");
  assertEquals(c.fechaResolucion, "22-08-2014");
  // La cabecera y las líneas basura no son filas.
  assertEquals(parsePadronCsvLine("RUT;RAZON SOCIAL;NUMERO RESOLUCION;FECHA RESOLUCION;MAIL INTERCAMBIO;URL"), null);
  assertEquals(parsePadronCsvLine(""), null);
  assertEquals(parsePadronCsvLine("basura;sin;rut;valido;x;"), null);
});

Deno.test("parsePadronCsvLine: contribuyente sin casilla registrada → mailIntercambio null", () => {
  const c = parsePadronCsvLine("11111111-1;SIN CASILLA LTDA;42;01-01-2020 ;;")!;
  assertEquals(c.mailIntercambio, null);
  assertEquals(c.razonSocial, "SIN CASILLA LTDA");
});
