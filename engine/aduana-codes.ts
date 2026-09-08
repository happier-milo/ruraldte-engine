// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

/**
 * Tablas de códigos de Aduana para los DTE de exportación (110/111/112): países, puertos, monedas,
 * vías de transporte, cláusulas de compraventa, tipos de bulto, unidades de medida, modalidades de
 * venta y formas de pago de exportación, más helpers de mapeo nombre → código.
 *
 * El grueso sale del Anexo 51 de Aduana; el mapeo ISO → `TpoMoneda` y las formas de pago de
 * exportación vienen del formato DTE del SII y de la tabla DUS. Es catálogo puro: acá no se valida
 * ni se arma ningún DTE — el builder de `factura-dte.ts` recibe los códigos ya resueltos en su
 * `FacturaAduana`. Los lookups por nombre comparan en mayúsculas sin normalizar acentos
 * (`puertoCodigo("VALPARAISO")` sin tilde devuelve `undefined`) y, si no hay match exacto, caen a
 * coincidencia por substring y entregan el primer código que calce: `paisCodigo("COREA")` te da 333
 * (Corea del Sur), no un error, así que revisa el resultado antes de mandarlo al SII. La moneda del
 * documento viaja como STRING ("DOLAR USA") y eso lo entrega `monedaSii()`; `MONEDAS_ADUANA` es
 * otro catálogo, indexado por código de Aduana y con la abreviatura oficial ("DÓLAR USA").
 *
 * @example
 * ```ts
 * import {
 *   clausulaVentaCodigo,
 *   monedaSii,
 *   paisCodigo,
 *   puertoCodigo,
 * } from "@ruraldte/engine/aduana-codes";
 *
 * // Sección <Aduana> de una factura de exportación (110), con los códigos ya resueltos.
 * const aduana = {
 *   codClauVenta: clausulaVentaCodigo("FOB"),              // 5
 *   codPtoEmbarque: puertoCodigo("VALPARAÍSO"),            // 905 — con tilde, o devuelve undefined
 *   codPaisRecep: paisCodigo("ESTADOS UNIDOS DE AMÉRICA"), // 225
 * };
 *
 * const tpoMoneda = monedaSii("USD"); // "DOLAR USA" — string del DTE, no código numérico
 * ```
 *
 * @module
 */
// ============================================================================
// aduana-codes.ts — Tablas de códigos de Aduana para EXPORTACIÓN (DTE 110/111/112).
// ============================================================================
// FUENTE OFICIAL: Servicio Nacional de Aduanas, Compendio de Normas, ANEXO 51
// (https://www.aduana.cl/compendio-de-normas-anexo-51/aduana/2009-11-19/163937.html):
//   51-9 Países · 51-11 Puertos · 51-13 Vías de Transporte · 51-20 Monedas ·
//   51-21 Cláusulas de Compraventa · 51-23 Tipo de Bulto · 51-24 Unidades de Medida ·
//   51-26 Modalidad de Venta. El formato DTE del SII (formato_dte 2026-02) remite a
//   "tabla publicada en www.aduana.cl" para cada uno de estos campos.
// Extraídas y verificadas contra el Anexo 51 oficial (NO terceros). El motor
// `factura-dte.ts` recibe los CÓDIGOS numéricos directamente; estas tablas son la
// capa de catálogo para validación y para que la UI ofrezca selección amigable.
//
// MONEDA: en el DTE va el STRING (TipMonType del XSD: "DOLAR USA", "EURO"…), no el código.

/** ISO de moneda (USD/EUR…) → string TpoMoneda del DTE (forma aceptada por el SII, verificada en certificación). */
export const MONEDA_ISO_A_SII: Record<string, string> = {
  "ARS": "PESO AR", "GBP": "LIBRA EST", "SEK": "CORONA SC", "HKD": "DOLAR HK",
  "ZAR": "RAND", "COP": "PESO CO", "USD": "DOLAR USA", "MXN": "PESO MX",
  "VES": "BOLIVAR", "SGD": "DOLAR SIN", "INR": "RUPIA IN", "TWD": "DOLAR TAI",
  "AED": "DIRHAM", "KRW": "WON KR", "PLN": "ZLOTY PL", "EUR": "EURO",
  "CZK": "CORONA CZ", "HUF": "FORINT HU", "THB": "BAHT TH", "TRY": "LIRA TR",
  "MYR": "RINGGIT MY", "RUB": "RUBLO RU", "IDR": "RUPIA ID", "UAH": "HRYVNIA UA",
  "ILS": "SHEKEL IL", "PHP": "PESO PH", "SAR": "RIYAL SA", "PKR": "RUPIA PK",
  "VND": "DONG VN", "EGP": "LIBRA EG", "RON": "LEU RO", "ISK": "CORONA IS",
  "IRR": "RIAL IR", "CRC": "COLON CR", "PAB": "BALBOA PA", "CLP": "PESO CL",
  "PYG": "GUARANI", "PEN": "NUEVO SOL", "UYU": "PESO UY", "AUD": "DOLAR AUST",
  "BOB": "BOLIVIANO", "CNY": "YUAN CN", "BRL": "REAL BR", "DKK": "CORONA DIN",
  "CAD": "DOLAR CAN", "JPY": "YEN", "CHF": "FRANCO SZ", "XXX": "OTRAS MONEDAS",
  "NOK": "CORONA NOR", "NZD": "DOLAR NZ",
};

/** Anexo 51-20: código de moneda de Aduana → abreviatura oficial (catálogo para UI). */
export const MONEDAS_ADUANA: Record<number, string> = {
  1: "PESO AR", 4: "BOLIVIANO", 5: "REAL BR", 6: "DÓLAR CAN", 13: "DÓLAR USA",
  23: "GUARANI", 24: "NUEVO SOL", 26: "PESO UY", 36: "DOLAR AUST", 48: "YUAN CN",
  51: "CORONA DIN", 72: "YEN", 82: "FRANCO SZ", 96: "CORONA NOR", 97: "DÓLAR NZ",
  102: "LIBRA EST", 113: "CORONA SC", 127: "DÓLAR HK", 128: "RAND", 129: "PESO CO",
  132: "PESO MX", 134: "BOLIVAR", 136: "DÓLAR SIN", 137: "RUPIA IN", 138: "DÓLAR TAI",
  139: "DIRHAM", 140: "WOR KR", 141: "ZLOTY PL", 142: "EURO", 143: "CORONA CZ",
  144: "FORINT HU", 145: "BAHT TH", 146: "LIRA TR", 147: "RINGGIT MY", 148: "RUBLO RU",
  149: "RUPIA ID", 150: "HRYVNIA UA", 151: "SHEKEL IL", 152: "PESO PH", 153: "RIYAL SA",
  154: "RUPIA PK", 155: "DONG VN", 156: "LIBRA EG", 157: "LEU RO", 158: "CORONA IS",
  159: "RIAL IR", 160: "COLON CR", 161: "BALBOA PA", 162: "PESO DO", 163: "PESO CU",
  200: "PESO CL",
};

/** Anexo 51-13: Vía de transporte (CodViaTransp). */
export const VIA_TRANSPORTE: Record<number, string> = {
  1: "MARÍTIMA, FLUVIAL Y LACUSTRE", 4: "AÉREO", 5: "POSTAL",
  6: "FERROVIARIO", 7: "CARRETERO / TERRESTRE", 8: "OLEODUCTOS, GASODUCTOS",
  9: "TENDIDO ELÉCTRICO (Aéreo, Subterráneo)", 10: "OTRA", 11: "COURIER/AEREO",
};

/** Anexo 51-26: Modalidad de venta (CodModVenta). */
export const MODALIDAD_VENTA: Record<number, string> = {
  1: "A FIRME", 2: "BAJO CONDICION", 3: "EN CONSIGNACION LIBRE",
  4: "EN CONSIGNACION CON UN MINIMO A FIRME", 9: "SIN PAGO",
};

/** Anexo 51-21: Cláusula de compraventa / Incoterm (CodClauVenta) → sigla. El cód. 8 ("OTRA") agrupa CPT/CIP/DPU/DAP. */
export const CLAUSULA_VENTA: Record<number, string> = {
  1: "CIF", 2: "CFR", 3: "EXW",
  4: "FAS", 5: "FOB", 6: "S/CL",
  7: "FCA", 8: "OTRA", 9: "DDP",
};

/** Anexo 51-9: País (CodPaisRecep / CodPaisDestin / Nacionalidad) — código → nombre. 236 entradas. */
export const PAISES: Record<number, string> = {
  101: "SENEGAL", 102: "GAMBIA", 103: "GUINEA - BISSAU", 104: "GUINEA", 105: "SIERRA LEONA",
  106: "LIBERIA", 107: "COSTA DE MARFIL", 108: "GHANA", 109: "TOGO", 111: "NIGERIA",
  112: "SUDAFRICA", 113: "BOTSWANA", 114: "LESOTHO", 115: "MALAWI", 116: "ZIMBABWE",
  117: "ZAMBIA", 118: "COMORAS", 119: "MAURICIO", 120: "MADAGASCAR", 121: "MOZAMBIQUE",
  122: "SWAZILANDIA", 123: "SUDAN", 124: "EGIPTO", 125: "LIBIA", 126: "TUNEZ",
  127: "ARGELIA", 128: "MARRUECOS", 129: "CABO VERDE", 130: "CHAD", 131: "NIGER",
  133: "MALI", 134: "MAURITANIA", 135: "TANZANIA", 136: "UGANDA", 137: "KENIA",
  138: "SOMALIA", 139: "ETIOPIA", 140: "ANGOLA", 141: "BURUNDI", 142: "RWANDA",
  143: "REPUBLICA DEMOCRATICA DEL CONGO", 144: "CONGO", 145: "GABON", 146: "SAO TOME Y PRINCIPE", 147: "GUINEA ECUATORIAL",
  149: "CAMERUN", 150: "BENIN", 151: "TERRITORIO BRITÁNICO EN AFRICA", 152: "TERRITORIO ESPAÑOL EN AFRICA", 153: "TERRITORIO FRANCES EN AFRICA",
  155: "DJIBOUTI", 156: "SEYCHELLES", 159: "NAMIBIA", 160: "SUDAN DEL SUR", 161: "BURKINA FASO",
  163: "ERITREA", 164: "ISLAS MARSHALL", 165: "SAHARA OCCIDENTAL", 201: "VENEZUELA", 202: "COLOMBIA",
  203: "TRINIDAD Y TOBAGO", 204: "BARBADOS", 205: "JAMAICA", 207: "BAHAMAS", 208: "HAITI",
  209: "CUBA", 210: "PANAMA", 211: "COSTA RICA", 212: "NICARAGUA", 213: "EL SALVADOR",
  214: "HONDURAS", 215: "GUATEMALA", 216: "MEXICO", 217: "GUYANA", 218: "ECUADOR",
  219: "PERU", 220: "BRASIL", 221: "BOLIVIA", 222: "PARAGUAY", 223: "URUGUAY",
  224: "ARGENTINA", 225: "ESTADOS UNIDOS DE AMÉRICA", 226: "CANADA", 227: "TERRITORIO BRITÁNICO EN AMERICA", 228: "TERRITORIO FRANCES EN AMERICA",
  229: "TERRITORIO HOLANDES EN AMERICA", 230: "TERRITORIO DE DINAMARCA", 231: "DOMINICA", 232: "GRANADA", 233: "SANTA LUCIA (ISLAS OCCIDENTALES)",
  234: "SAN VICENTE Y LAS GRANADINAS", 235: "SURINAM", 236: "BELICE", 240: "ANTIGUA Y BARBUDA", 241: "SAINT KITTS & NEVIS",
  242: "ANGUILA", 243: "ARUBA", 244: "BERMUDAS", 245: "ISLAS VIRGENES BRITANICAS", 246: "ISLAS CAYMAN",
  247: "ANTILLAS NEERLANDESAS", 248: "TURCAS Y CAICOS", 249: "ISLAS VIRGENES (ESTADOS UNIDOS DE AMERICA)", 250: "MARTINICA", 251: "PUERTO RICO",
  252: "MONSERRAT", 253: "GROENLANDIA", 301: "JORDANIA", 302: "ARABIA SAUDITA", 303: "KUWAIT",
  304: "OMAN", 305: "CHIPRE", 306: "ISRAEL", 307: "IRAK", 308: "AFGHANISTAN",
  309: "IRAN", 310: "SIRIA", 311: "LIBANO", 312: "QATAR", 313: "BAHREIN",
  314: "SRI LANKA", 315: "CAMBODIA", 316: "LAOS", 317: "INDIA", 318: "BUTAN",
  319: "THAILANDIA", 320: "NEPAL", 321: "BANGLADESH", 322: "PALESTINA", 324: "PAKISTAN",
  325: "VIETNAM", 326: "MYANMAR (EX BIRMANIA)", 327: "ISLAS MALDIVAS", 328: "INDONESIA", 329: "MALASIA",
  330: "TAIWAN (FORMOSA)", 331: "JAPON", 332: "SINGAPUR", 333: "COREA DEL SUR", 334: "COREA DEL NORTE",
  335: "FILIPINAS", 336: "CHINA", 337: "MONGOLIA", 341: "EMIRATOS ARABES UNIDOS", 342: "HONG KONG - REGIÓN ADMINISTRATIVA ESPECIAL DE CHINA",
  343: "TERRITORIO PORTUGUES EN ASIA", 344: "BRUNEI", 345: "MACAO", 346: "REPUBLICA DE YEMEN", 401: "FIJI",
  402: "NAURU", 403: "ISLAS TONGA", 404: "SAMOA OCCIDENTAL", 405: "NUEVA ZELANDIA", 406: "AUSTRALIA",
  407: "TERRITORIO BRITÁNICO EN OCEANIA Y EL PACIFICO", 408: "TERRITORIO FRANCES EN OCEANIA Y EL PACIFICO", 409: "TERRITORIO NORTEAMERICANO EN OCEANIA Y EL PACIFICO", 415: "VANUATU", 416: "KIRIBATI",
  417: "MICRONESIA", 418: "ISLAS SALOMON", 419: "TUVALU", 420: "BELAU", 421: "NIUE",
  422: "POLINESIA FRANCESA", 423: "NUEVA CALEDONIA", 424: "ISLAS MARIANAS DEL NORTE", 425: "GUAM", 426: "TIMOR ORIENTAL",
  427: "ISLAS COOK", 501: "PORTUGAL", 504: "ITALIA", 505: "FRANCIA", 506: "IRLANDA",
  507: "DINAMARCA", 508: "SUIZA", 509: "AUSTRIA", 510: "REINO UNIDO", 511: "SUECIA",
  512: "FINLANDIA", 513: "NORUEGA", 514: "BELGICA", 515: "PAÍSES BAJOS", 516: "ISLANDIA",
  517: "ESPAÑA", 518: "ALBANIA", 519: "RUMANIA", 520: "GRECIA", 522: "TURQUIA",
  523: "MALTA", 524: "SANTA SEDE", 525: "ANDORRA", 527: "BULGARIA", 528: "POLONIA",
  530: "HUNGRIA", 532: "LUXEMBURGO", 534: "LIECHTENSTEIN", 535: "MONACO", 536: "SAN MARINO",
  540: "ARMENIA", 541: "AZERBAIJAN", 542: "BELARUS", 543: "BOSNIA Y HERZEGOVINA", 544: "REPUBLICA CHECA (D)",
  546: "REPUBLICA DE SERBIA", 547: "CROACIA", 548: "ESLOVENIA", 549: "ESTONIA", 550: "GEORGIA",
  551: "KASAJSTAN", 552: "KIRGISTAN", 553: "LETONIA", 554: "LITUANIA", 555: "MACEDONIA",
  556: "MOLDOVA", 557: "TADJIKISTAN", 558: "TURKMENISTAN", 559: "UCRANIA", 560: "UZBEKISTAN",
  561: "MONTENEGRO", 562: "RUSIA (B)", 563: "ALEMANIA", 565: "GIBRALTAR", 566: "GUERNSEY",
  567: "ISLAS DE MAN", 568: "JERSEY", 901: "Combustibles y lubricantes destinados al consumo de naves y aeronaves extranjeras y de revistas con el mismo objeto", 902: "Rancho de Naves y Aeronaves Extranjeras y de maderas para estibar mercancías cargadas en puertos chilenos", 904: "Orígenes o Destinaciones no precisadas por razones comerciales o militares",
  905: "Zona Franca Iquique", 906: "Depósito Franco", 907: "Zona Franca Punta Arenas", 910: "Zona Franca Arica, Zona Industrial", 997: "CHILE",
  999: "Otros (País Desconocido)",
};

/** Anexo 51-11: Puerto (CodPtoEmbarque / CodPtoDesemb) — código → nombre. 352 entradas. */
export const PUERTOS: Record<number, string> = {
  111: "MONTREAL", 112: "COSTA DEL PACÍFICO, OTROS NO ESPECIFICADOS", 113: "HALIFAX", 114: "VANCOUVER", 115: "SAINT JOHN",
  116: "TORONTO", 117: "OTROS PUERTOS DE CANADÁ NO IDENTIFICADOS", 118: "BAYSIDE", 120: "PORT CARTIES", 121: "COSTA DEL ATLÁNTICO, OTROS NO ESPECIFICADOS COMPRENDIDOS ENTRE MAINE Y KEY WEST",
  122: "PUERTOS DEL GOLFO DE MÉXICO, OTROS NO ESPECIFICADOS COMPRENDIDOS ENTRE KEY WEST Y BROWNSVILLE", 123: "COSTA DEL PACÍFICO, OTROS NO ESPECIFICADOS", 124: "QUEBEC", 125: "PRINCE RUPERT", 126: "HAMILTON",
  131: "BOSTON", 132: "NEW HAVEN", 133: "BRIDGEPORT", 134: "NEW YORK", 135: "FILADELFIA",
  136: "BALTIMORE", 137: "NORFOLK", 139: "CHARLESTON", 140: "SAVANAH", 141: "MIAMI",
  142: "EVERGLADES", 143: "JACKSONVILLE", 145: "PALM BEACH", 146: "BATON ROUGE", 147: "COLUMBRES",
  148: "PITTSBURGH", 149: "DULUTH", 150: "MILWAUKEE", 151: "TAMPA", 152: "PENSACOLA",
  153: "MOBILE", 154: "NEW ORLEANS", 155: "PORT ARTHUR", 156: "GALVESTON", 157: "CORPUS CRISTI",
  158: "BROWNSVILLE", 159: "HOUSTON", 160: "OAKLAND", 161: "STOCKTON", 171: "SEATTLE",
  172: "PORTLAND", 173: "SAN FRANCISCO", 174: "LOS ANGELES", 175: "LONG BEACH", 176: "SAN DIEGO",
  180: "OTROS PUERTOS DE ESTADOS UNIDOS NO ESPECIFICADOS", 190: "PUNTA CHUNGO", 199: "LOS VILOS", 204: "PATACHE", 205: "CALBUCO",
  206: "MICHILLA", 207: "PUERTO ANGAMOS", 208: "POSEIDON", 209: "TRES PUENTES", 210: "OTROS PUERTOS DE MÉXICO NO ESPECIFICADOS",
  211: "TAMPICO", 212: "COSTA DEL PACÍFICO, OTROS PUERTOS", 213: "VERACRUZ", 214: "COATZACOALCOS", 215: "GUAYMAS",
  216: "MAZATLAN", 217: "MANZANILLO", 218: "ACAPULCO", 219: "GOLFO DE MÉXICO, OTROS NO ESPECIFICADOS", 220: "ALTAMIRA",
  221: "CRISTOBAL", 222: "BALBOA", 223: "COLON", 224: "OTROS PUERTOS DE PANAMÁ NO ESPECIFICADOS", 225: "PASO GUANACO SONSO",
  231: "OTROS PUERTOS DE COLOMBIA NO ESPECIFICADOS", 232: "BUENAVENTURA", 233: "BARRANQUILLA", 241: "OTROS PUERTOS DE ECUADOR NO ESPECIFICADOS", 242: "GUAYAQUIL",
  251: "OTROS PUERTOS DE PERÚ NO ESPECIFICADOS", 252: "CALLAO", 253: "ILO", 254: "IQUITOS", 261: "OTROS PUERTOS DE ARGENTINA NO ESPECIFICADOS",
  262: "BUENOS AIRES", 263: "NECOCHEA", 264: "MENDOZA", 265: "CÓRDOBA", 266: "BAHIA BLANCA",
  267: "COMODORO RIVADAVIA", 268: "PUERTO MADRYN", 269: "MAR DEL PLATA", 270: "ROSARIO", 271: "OTROS PUERTOS DE URUGUAY NO ESPECIFICADOS",
  272: "MONTEVIDEO", 281: "OTROS PUERTOS DE VENEZUELA NO ESPECIFICADOS", 282: "LA GUAIRA", 285: "MARACAIBO", 291: "OTROS PUERTOS DE BRASIL NO ESPECIFICADOS",
  292: "SANTOS", 293: "RIO DE JANEIRO", 294: "RIO GRANDE DEL SUR", 295: "PARANAGUA", 296: "SAO PAULO",
  297: "SALVADOR", 301: "OTROS PUERTOS DE LAS ANTILLAS HOLANDESAS NO ESPECIFICADOS", 302: "CURAZAO", 399: "OTROS PUERTOS DE AMÉRICA NO ESPECIFICADOS", 411: "SHANGAI",
  412: "DAIREN", 413: "OTROS PUERTOS DE CHINA NO ESPECIFICADOS", 420: "OTROS PUERTOS DE COREA DEL NORTE NO ESPECIFICADOS", 421: "NAMPO", 422: "BUSAN",
  423: "OTROS PUERTOS DE COREA DEL SUR NO ESPECIFICADOS", 431: "MANILA", 432: "OTROS PUERTOS DE FILIPINAS NO ESPECIFICADOS", 441: "OTROS PUERTOS DE JAPON NO ESPECIFICADOS", 442: "OSAKA",
  443: "KOBE", 444: "YOKOHAMA", 445: "NAGOYA", 446: "SHIMIZUI", 447: "MOJI",
  448: "YAWATA", 449: "FUKUYAMA", 451: "KAOHSIUNG", 452: "KEELUNG", 453: "OTROS PUERTOS DE TAIWAN NO ESPECIFICADOS",
  461: "KARHG ISLAND", 462: "OTROS PUERTOS DE IRAN NO ESPECIFICADOS", 471: "CALCUTA", 472: "OTROS PUERTOS DE INDIA NO ESPECIFICADOS", 481: "CHALNA",
  482: "OTROS PUERTOS DE BANGLADESH NO ESPECIFICADOS", 491: "OTROS PUERTOS DE SINGAPUR NO ESPECIFICADOS", 492: "HONG KONG", 499: "OTROS PUERTOS ASIÁTICOS NO ESPECIFICADOS", 511: "CONSTANZA",
  512: "OTROS PUERTOS DE RUMANIA NO ESPECIFICADOS", 521: "VARNA", 522: "OTROS PUERTOS DE BULGARIA NO ESPECIFICADOS", 533: "BELGRADO", 534: "OTROS PUERTOS DE SERBIA NO ESPECIFICADOS",
  535: "PODGORITSA", 536: "OTROS PUERTOS DE MONTENEGRO NO ESPECIFICADOS", 537: "OTROS PUERTOS DE CROACIA NO ESPECIFICADOS", 538: "RIJEKA", 541: "OTROS PUERTOS DE ITALIA NO ESPECIFICADOS",
  542: "GENOVA", 543: "LIORNA, LIVORNO", 544: "NAPOLES", 545: "SALERNO", 546: "AUGUSTA",
  547: "SAVONA", 551: "OTROS PUERTOS DE FRANCIA NO ESPECIFICADOS", 552: "LA PALLICE", 553: "LE HAVRE", 554: "MARSELLA",
  555: "BURDEOS", 556: "CALAIS", 557: "BREST", 558: "RUAN", 561: "OTROS PUERTOS DE ESPAÑA NO ESPECIFICADOS",
  562: "CADIZ", 563: "BARCELONA", 564: "BILBAO", 565: "HUELVA", 566: "SEVILLA",
  567: "TARRAGONA", 568: "ALGECIRAS", 569: "VALENCIA", 571: "LIVERPOOL", 572: "LONDRES",
  573: "ROCHESTER", 574: "ETEN SALVERRY", 576: "OTROS PUERTOS DE INGLATERRA NO ESPECIFICADOS", 577: "DOVER", 578: "PLYMOUTH",
  581: "HELSINSKI", 582: "OTROS PUERTOS DE FINLANDIA NO ESPECIFICADOS", 583: "HANKO", 584: "KEMI", 585: "KOKKOLA",
  586: "KOTKA", 587: "OULO", 588: "PIETARSAARI", 589: "PORI", 591: "BREMEN",
  592: "HAMBURGO", 593: "NUREMBERG", 594: "FRANKFURT", 595: "DUSSELDORF", 596: "OTROS PUERTOS DE ALEMANIA NO ESPECIFICADOS",
  597: "CUXHAVEN", 598: "ROSTOCK", 599: "OLDENBURG", 601: "AMBERES", 602: "OTROS PUERTOS DE BÉLGICA NO ESPECIFICADOS",
  603: "ZEEBRUGGE", 604: "GHENT", 605: "OOSTENDE", 611: "LISBOA", 612: "OTROS PUERTOS DE PORTUGAL NO ESPECIFICADOS",
  613: "SETUBAL", 621: "AMSTERDAM", 622: "ROTTERDAM", 623: "OTROS PUERTOS DE PAÍSES BAJOS NO ESPECIFICADOS", 631: "GOTEMBURGO",
  632: "OTROS PUERTOS DE SUECIA NO ESPECIFICADOS", 633: "MALMO", 634: "HELSIMBORG", 635: "KALMAR", 641: "AARHUS",
  642: "COPENHAGEN", 643: "OTROS PUERTOS DE DINAMARCA NO ESPECIFICADOS", 644: "AALBORG", 645: "ODENSE", 651: "OSLO",
  652: "OTROS PUERTOS DE NORUEGA NO ESPECIFICADOS", 653: "STAVANGER", 699: "OTROS PUERTOS DE EUROPA NO ESPECIFICADOS", 711: "DURBAM", 712: "CIUDAD DEL CABO",
  713: "OTROS PUERTOS DE SUDÁFRICA NO ESPECIFICADOS", 714: "SALDANHA", 715: "PORT-ELIZABETH", 716: "MOSSEL-BAY", 717: "EAST-LONDON",
  799: "OTROS PUERTOS DE ÁFRICA NO ESPECIFICADOS", 811: "SIDNEY", 812: "FREMANTLE", 813: "OTROS PUERTOS DE AUSTRALIA NO ESPECIFICADOS", 814: "ADELAIDA",
  815: "DARWIN", 816: "GERALDTON", 817: "PUERTO CABO FROWARD", 818: "MUELLE HUACHIPATO", 819: "TERMINAL MARÍTIMO ESCUADRÓN",
  820: "TERMINAL PORTUARIO TERQUIM", 821: "TERMINAL MUELLE MECANIZADO ESPERANZA", 822: "TERMINAL MARÍTIMO ENAEX", 823: "TERMINAL MARÍTIMO OXIQUIM", 824: "PASO BUTA MALLIN",
  825: "AERÓDROMO LA ARAUCANÍA", 826: "ESTACIÓN DE MEDICIÓN RECINTO", 827: "TERMINAL GRANELES DEL NORTE", 828: "MUELLE INTERACID TRADING (CHILE) S.A.", 829: "TERMINAL MARITIMO ABASTIBLE",
  830: "TERMINAL MARITIMO ENAP", 831: "AERÓDROMO PICHOY", 899: "OTROS PUERTOS DE OCEANÍA NO ESPECIFICADOS", 900: "COMBUSTIBLES Y LUBRICANTES DESTINADOS AL CONSUMO DE NAVES Y AERONAVES DE TRANSPORTE INTERNACIONAL", 901: "ARICA",
  902: "IQUIQUE", 903: "ANTOFAGASTA", 904: "COQUIMBO", 905: "VALPARAÍSO", 906: "SAN ANTONIO",
  907: "TALCAHUANO", 908: "SAN VICENTE", 909: "LIRQUEN", 910: "PUERTO MONTT", 911: "CHACABUCO PUERTO AYSEN",
  912: "PUNTA ARENAS", 913: "PATILLOS", 914: "TOCOPILLA", 915: "MEJILLONES", 916: "TALTAL",
  917: "CHAÑARAL BARQUITO", 918: "CALDERA", 919: "CALDERILLA", 920: "HUASCO GUACOLDA", 921: "QUINTERO",
  922: "JUAN FERNANDEZ", 923: "CONSTITUCION", 924: "TOME", 925: "PENCO", 926: "CORONEL",
  927: "LOTA", 928: "LEBU", 929: "ISLA DE PASCUA", 930: "CORRAL", 931: "ANCUD",
  932: "CASTRO", 933: "QUELLÓN", 934: "CHAITÉN", 935: "TORTEL", 936: "NATALES",
  937: "GUARELLO", 938: "PUERTO ANDINO", 939: "PERCY", 940: "CLARENCIA", 941: "GREGORIO",
  942: "CABO NEGRO", 943: "PUERTO WILLIAMS", 944: "TERRITORIO ANTÁRTICO CHILENO", 945: "AEROPUERTO CARRIEL SUR", 946: "GUAYACAN",
  947: "PASO PEHUENCHE", 948: "VENTANAS", 949: "PINO HACHADO (LIUCURA)", 950: "CALETA COLOSO", 951: "AGUAS NEGRAS",
  952: "ZONA FRANCA IQUIQUE", 953: "ZONA FRANCA PUNTA ARENAS", 954: "RÍO MAYER", 955: "RÍO MOSCO", 956: "VISVIRI",
  957: "CHACALLUTA", 958: "CHUNGARÁ", 959: "COLCHANE", 960: "ABRA DE NAPA", 961: "OLLAGUE",
  962: "SAN PEDRO DE ATACAMA", 963: "SOCOMPA", 964: "SAN FRANCISCO", 965: "LOS LIBERTADORES", 966: "MAHUIL MALAL",
  967: "CARDENAL SAMORE", 968: "PEREZ ROSALES", 969: "FUTALEUFU", 970: "PALENA CARRENLEUFU", 971: "PANGUIPULLI",
  972: "HUAHUM", 973: "LAGO VERDE", 974: "APPELEG", 975: "PAMPA ALTA", 976: "HUEMULES",
  977: "CHILE CHICO", 978: "BAKER", 979: "DOROTEA", 980: "CASAS VIEJAS", 981: "MONTE AYMOND",
  982: "SAN SEBASTIAN", 983: "COYHAIQUE ALTO", 984: "TRIANA", 985: "IBAÑEZ PALAVICINI", 986: "VILLA O'HIGGINS",
  987: "AEROP. CHACALLUTA", 988: "AEROP. DIEGO ARACENA", 989: "AEROP. CERRO MORENO", 990: "AEROP. EL TEPUAL", 991: "AEROP. C.I. DEL CAMPO",
  992: "AEROP. A.M. BENITEZ", 993: "AERÓDROMO EL LOA", 994: "ARICA-TACNA", 995: "ARICA-LA PAZ", 997: "OTROS PUERTOS CHILENOS",
  998: "PASO JAMA", 999: "GNL MEJILLONES",
};

/** Formas de Pago de Exportación (FmaPagExp, IdDoc) — tabla DUS de Aduana (verificado en certificación). */
export const FORMAS_PAGO_EXP: Record<number, string> = {
  1: "COB1", 2: "COBRANZA", 11: "ACRED",
  12: "CBOF", 21: "S/PAGO", 32: "ANTICIPO",
  50: "ANT/COB", 60: "ANT/CRED", 80: "S/PAGO/COB",
};

/** Anexo 51-24: Unidad de Medida (CodUnidMedTara / CodUnidPesoBruto / CodUnidPesoNeto) → sigla. KN (06) = kilo neto, default. */
export const UNIDADES_MEDIDA: Record<number, string> = {
  1: "TMB", 2: "QMB", 3: "MKWH", 4: "TMN", 5: "KLT",
  6: "KN", 7: "GN", 8: "HL", 9: "LT", 10: "U",
  11: "DOC", 12: "U(JGO)", 13: "MU", 14: "MT", 15: "MT2",
  16: "MT3", 17: "PAR", 18: "KNFC", 19: "CARTON", 20: "KWH",
  23: "BAR", 24: "M2/1MM", 99: "S.U.M",
};

/** Anexo 51-23: Tipo de Bulto (CodTpoBultos) — código → nombre. 69 entradas. */
export const TIPOS_BULTO: Record<number, string> = {
  0: "SIN EMBALAR", 1: "GRANEL SÓLIDO PARTICULAS FINAS", 2: "GRANEL SÓLIDO PARTICULAS GRANULARES",
  3: "GRANEL SÓLIDO PARTICULAS GRANDES", 4: "GRANEL LÍQUIDO", 5: "GRANEL GASEOSO",
  10: "PIEZAS", 11: "TUBOS", 12: "CILINDROS, TRONCOS",
  13: "ROLLOS", 16: "BARRAS", 17: "LINGOTE",
  18: "TRONCOS", 19: "BLOQUE", 20: "ROLLIZO",
  21: "CAJON, CAJA DE MADERA", 22: "CAJAS DE CARTÓN, LATA O DE CUALQUIER OTRO MATERIAL EXCEPTO MADERA", 23: "FARDO",
  24: "BAÚL, COFRE", 25: "COFRE", 26: "ARMAZÓN, JAULA, JABA",
  27: "BANDEJA, CESTA", 28: "CAJAS DE MADERA", 29: "CAJAS DE LATA",
  31: "BOTELLA DE GAS", 32: "BOTELLA", 33: "JAULAS",
  34: "BIDON", 35: "JABAS", 36: "CESTAS",
  37: "BARRILETE", 38: "TONEL", 39: "PIPAS",
  40: "CAJAS NO ESPECIFICADAS", 41: "JARRO", 42: "FRASCO",
  43: "DAMAJUANA", 44: "BARRIL, BARRILETE, TONEL, PIPA", 45: "TAMBOR, CUNETE, TARRO",
  46: "CUÑETES", 47: "TARROS", 51: "CUBO",
  61: "PAQUETE, BOLSA", 62: "SACOS", 63: "MALETA",
  64: "BOLSA", 65: "BALAS", 66: "RED",
  67: "SOBRES", 73: "CONTENEDOR DE 20 PIES DRY", 74: "CONTENEDOR DE 40 PIES DRY",
  75: "CONTENEDOR REFRIGERADO", 76: "CONTENEDOR REFRIGERADO 40 PIES", 77: "ESTANQUE",
  78: "CONTENEDOR NO REFRIGERADO", 80: "PALLETS, TABLEROS", 81: "TABLERO",
  82: "LAMINAS", 83: "CARRETE", 85: "AUTOMOTOR",
  86: "ATAUD", 88: "MAQUINARIAS", 89: "PLANCHAS, LAMINAS",
  90: "ATADOS", 91: "BOBINA, CARRETE", 92: "OTROS",
  93: "OTROS BULTOS NO ESPECIFICADOS", 98: "NO EXISTE BULTO", 99: "SIN EMBALAR",
};


// ── Helpers de mapeo (valor amigable → código/string del SII) ──────────────
function lookupByName(tabla: Record<number, string>, q: string): number | undefined {
  const s = q.trim().toUpperCase();
  for (const [code, name] of Object.entries(tabla)) if (name.toUpperCase() === s) return Number(code);
  for (const [code, name] of Object.entries(tabla)) if (name.toUpperCase().includes(s)) return Number(code);
  return undefined;
}
/** ISO de moneda (ej. "USD") → string TpoMoneda del DTE (ej. "DOLAR USA"). */
export function monedaSii(iso: string): string | undefined {
  return MONEDA_ISO_A_SII[iso.trim().toUpperCase()];
}
/** Nombre de país → CodPais de Aduana (ej. "ESTADOS UNIDOS" → 225). */
export function paisCodigo(nombre: string): number | undefined { return lookupByName(PAISES, nombre); }
/** Nombre de puerto → CodPto de Aduana (ej. "VALPARAISO" → 905). */
export function puertoCodigo(nombre: string): number | undefined { return lookupByName(PUERTOS, nombre); }
/** Sigla de forma de pago exportación (ej. "ANTICIPO" → 32). */
export function formaPagoExpCodigo(sigla: string): number | undefined { return lookupByName(FORMAS_PAGO_EXP, sigla); }
/** Sigla de unidad de medida (ej. "KN" → 6, "MT3" → 16). */
export function unidadMedidaCodigo(sigla: string): number | undefined { return lookupByName(UNIDADES_MEDIDA, sigla); }
/** Nombre de tipo de bulto (ej. "PALLETS"). */
export function tipoBultoCodigo(nombre: string): number | undefined { return lookupByName(TIPOS_BULTO, nombre); }
/** Sigla Incoterm de cláusula de venta (ej. "FOB" → 5). */
export function clausulaVentaCodigo(sigla: string): number | undefined { return lookupByName(CLAUSULA_VENTA, sigla); }
/** Nombre de vía de transporte (ej. "AÉREO" → 4). */
export function viaTransporteCodigo(nombre: string): number | undefined { return lookupByName(VIA_TRANSPORTE, nombre); }
/** Nombre de modalidad de venta (ej. "A FIRME" → 1). */
export function modalidadVentaCodigo(nombre: string): number | undefined { return lookupByName(MODALIDAD_VENTA, nombre); }
