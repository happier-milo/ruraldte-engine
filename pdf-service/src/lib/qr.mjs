// ============================================================================
// qr.mjs — un código QR para una dirección corta.
//
// Lo usa la boleta para llevar a quien la tiene en la mano a una página del
// emisor (su cuenta, su portal de pago). No es parte del documento tributario:
// el timbre del SII es el PDF417 de pdf417.mjs, y este QR no lo reemplaza ni lo
// toca.
//
// IMPLEMENTACIÓN: el mismo writer de `zxing-wasm` del timbre. Se entrega como
// geometría vectorial (un <path> en unidades de módulo), sin zona quieta: quien
// lo dibuja la agrega, en blanco, porque depende del fondo donde lo pone.
// ============================================================================

import { writeBarcode } from "zxing-wasm/writer";
// Importar pdf417.mjs deja cargado el .wasm del writer desde el paquete local
// (sin salir a buscarlo a una CDN): es un efecto de ese módulo.
import "./pdf417.mjs";

/** Módulos en blanco que el estándar pide a cada lado del símbolo. */
export const QR_ZONA_QUIETA = 4;

/** Corrección de errores media: aguanta una boleta doblada o con una mancha. */
export const QR_WRITER_OPTS = Object.freeze({ format: "QRCode", ecLevel: "M" });

/** El resultado crudo de zxing (svg + PNG, con su zona quieta). Para los tests de ida y vuelta. */
export async function encodeQr(texto) {
  if (typeof texto !== "string" || texto.trim().length === 0) {
    throw new Error("encodeQr: texto vacío");
  }
  const res = await writeBarcode(texto.trim(), QR_WRITER_OPTS);
  if (res.error) throw new Error(`encodeQr: zxing error: ${res.error}`);
  return res;
}

/**
 * El QR de un texto como geometría vectorial, SIN zona quieta.
 * @param {string} texto  Una dirección corta. Más de ~120 caracteres da un
 *   símbolo demasiado denso para el tamaño al que se imprime en una boleta.
 * @returns {Promise<{ size:number, path:string }>}  `size` = módulos por lado;
 *   `path` = el atributo `d` listo para `page.drawSvgPath` (1 unidad = 1 módulo).
 */
export async function buildQr(texto) {
  if (typeof texto !== "string" || texto.trim().length === 0) {
    throw new Error("buildQr: texto vacío");
  }
  const res = await writeBarcode(texto.trim(), { ...QR_WRITER_OPTS, withQuietZones: false });
  if (res.error) throw new Error(`buildQr: zxing error: ${res.error}`);
  const svg = res.svg ?? "";
  const width = Number(svg.match(/width="(\d+)"/)?.[1]);
  const height = Number(svg.match(/height="(\d+)"/)?.[1]);
  const path = svg.match(/<path d="([^"]+)"/)?.[1];
  if (!width || !height || width !== height || !path) {
    throw new Error("buildQr: no se pudo leer la geometría del QR");
  }
  return { size: width, path };
}
