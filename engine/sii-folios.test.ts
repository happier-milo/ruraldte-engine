// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { parseForm, parseSiiFolioErrorPage } from "./sii-folios.ts";

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
