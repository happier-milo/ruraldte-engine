// ============================================================================
// logo-emisor.mjs — el logo PROPIO del emisor en el membrete (boleta y factura).
//
// El emisor lo manda en `emisor.logo = { base64 }` (JPEG o PNG). Va arriba a la
// izquierda, al lado de sus datos: el Manual de Muestras Impresas del SII permite
// el logo en ese lugar mientras no ocupe más de 1/5 del documento (§1.1.3), y
// el recuadro del tipo de documento (arriba a la derecha) no se toca.
//
// El tipo se decide por los primeros bytes, no por lo que diga el pedido: un
// archivo que no es ni JPEG ni PNG, o que pdf-lib no puede leer, deja el
// membrete SIN logo y el documento sale igual. Un logo nunca puede impedir que
// salga el papel de un documento tributario ya emitido.
// ============================================================================

/** Caja del logo, en puntos. Alto: menos que el recuadro del SII (74-92 pt). */
export const LOGO_ALTO_MAX = 56;
export const LOGO_ANCHO_MAX = 90;
/** Aire entre el logo y los datos del emisor. */
export const LOGO_AIRE = 10;
/** Un logo de membrete pesa decenas de KB; más de esto es otra cosa. */
const LOGO_BYTES_MAX = 1024 * 1024;

/** @returns {"jpg"|"png"|null} */
export function tipoDeImagen(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e &&
    bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "png";
  return null;
}

/**
 * Incrusta el logo del emisor en `doc` y dice de qué tamaño se dibuja.
 * @param {import("pdf-lib").PDFDocument} doc
 * @param {{base64?:string}|undefined|null} logo  `input.emisor.logo`
 * @returns {Promise<{img: import("pdf-lib").PDFImage, w:number, h:number}|null>}
 */
export async function incrustarLogoEmisor(doc, logo) {
  const b64 = typeof logo?.base64 === "string" ? logo.base64.trim() : "";
  if (!b64) return null;
  let bytes;
  try {
    // Copia propia: un Buffer chico de Node vive dentro de un ArrayBuffer
    // compartido, y el lector de JPEG de pdf-lib mira el ArrayBuffer desde su
    // byte 0 ("SOI not found"). Un logo de menos de 4 KB no salía.
    bytes = new Uint8Array(Buffer.from(b64, "base64"));
  } catch {
    return null;
  }
  if (bytes.length === 0 || bytes.length > LOGO_BYTES_MAX) return null;
  const tipo = tipoDeImagen(bytes);
  if (!tipo) return null;
  let img;
  try {
    img = tipo === "jpg" ? await doc.embedJpg(bytes) : await doc.embedPng(bytes);
  } catch {
    return null;
  }
  if (!(img.width > 0 && img.height > 0)) return null;
  const escala = Math.min(LOGO_ALTO_MAX / img.height, LOGO_ANCHO_MAX / img.width);
  return { img, w: img.width * escala, h: img.height * escala };
}
