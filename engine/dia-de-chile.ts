// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// El día de calendario de Chile, para las edge functions.
//
// El runtime corre en UTC, y `new Date().toISOString().slice(0, 10)` da el día
// de UTC: desde las 20 h de Chile en invierno (UTC-4) y las 21 h en verano
// (UTC-3) ese día ya es MAÑANA. Una lectura que alguien manda por WhatsApp a
// las 22:00 quedaba fechada al día siguiente, y la última noche del mes caía en
// el mes siguiente. Medido en la web el 3-oct-2026 a las 23:00: una lectura
// registrada quedó con fecha 4 de octubre.
//
// GEMELO de `todayLocalISO` (acá `chileDay`) y `localISODateOf` (acá
// `chileDayOf`) de apps/web/src/lib/helpers.ts: las edge functions no pueden
// importar de la web. `chileToday`
// (flowSubscriptions.ts) y `chileYmd` (monthlyCloseReminder.ts) hacen lo mismo
// y nacieron antes, cada una dentro del módulo que la necesitó; este archivo
// existe para que quien solo quiere el día no arrastre esos módulos a su bundle.
//
// Lo cuida `npm run check:dia-de-chile` (scripts/check-dia-de-chile.mjs).

const CHILE_TZ = "America/Santiago";

/**
 * El día de Chile ("YYYY-MM-DD") de un instante; sin argumento, el de ahora.
 * Una fecha inválida devuelve "".
 *
 * Se arma por partes: cómo escribe la fecha un locale lo deciden los datos de
 * idioma del runtime, que cambian entre versiones.
 */
export function chileDay(at: Date = new Date()): string {
  if (Number.isNaN(at.getTime())) return "";
  const parts: Record<string, string> = {};
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: CHILE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  for (const part of dtf.formatToParts(at)) {
    if (part.type !== "literal") parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * El día de Chile ("YYYY-MM-DD") de un valor GUARDADO: lo que llega de una
 * columna de la base o de un proveedor. Es el gemelo de `localISODateOf` de la
 * web.
 *
 *   - Una fecha sin hora ("2026-08-14", una columna `date`) ya es un día de
 *     calendario y vuelve tal cual. `new Date("2026-08-14")` es medianoche UTC,
 *     que en Chile todavía es el 13.
 *   - Un instante ("2026-08-15T02:01:28+00:00", lo que entrega un
 *     `timestamptz`) da su día de Chile: el 14. Cortarlo con `.slice(0, 10)` da
 *     el día de UTC, el 15.
 *   - Lo vacío o lo que no se puede leer devuelve "".
 *
 * Medido en producción el 4-oct-2026: un pago en línea hecho el 14 de agosto a
 * las 22:01 quedó en el libro de la comunidad con fecha 15 de agosto.
 */
export function chileDayOf(value: string | Date | null | undefined): string {
  if (value instanceof Date) return chileDay(value);
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return chileDay(new Date(raw));
}
