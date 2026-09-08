// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Comunidad Rural SpA

// ============================================================================
// sii-oficinas.mjs — Mapeo comuna → Unidad/Oficina del SII (para el "S.I.I. — X"
// impreso bajo el recuadro del documento tributario).
// ============================================================================
//
// El campo "S.I.I. — <UNIDAD>" de una factura/boleta impresa indica la oficina
// del Servicio de Impuestos Internos que tiene JURISDICCIÓN sobre la comuna del
// domicilio del emisor. NO es la comuna: p.ej. un contribuyente de Quinta Normal
// pertenece a SANTIAGO PONIENTE; uno de Maullín a PUERTO MONTT; uno de Ovalle a OVALLE.
//
// Este dato NO viaja en el DTE (no está en el TED ni en <Documento>): es 100% de
// impresión. Por eso vive en la capa de render. La resolución es automática desde
// `emisor.comuna`; un `siiUnidad` explícito (config) siempre gana, y si la comuna
// no está mapeada se cae con gracia al nombre de la comuna (nunca rompe).
//
// FUENTE: directorio OFICIAL del SII de oficinas de atención y su jurisdicción
// comunal — https://www.sii.cl/transparencia/oficinas_atencion.html ("Oficina" /
// "Comunas que atiende"). Reconciliación de la Región Metropolitana al esquema
// vigente de 5 Direcciones Regionales: el directorio de transparencia es anterior
// a la creación de la DR Metropolitana SANTIAGO NORTE (Res. 2014, sii.cl/noticias
// 2014/130514) y aún pliega sus comunas en Centro/Poniente; acá se corrige a la
// jurisdicción vigente de Santiago Norte (Recoleta, Independencia, Huechuraba,
// Conchalí, Quilicura, Lampa, Colina, Til Til). Para casos límite o reorganizaciones
// posteriores, usar el override `siiUnidad` por contribuyente.
//
// El nombre se imprime en su forma corta (la del recuadro): "Santiago Poniente",
// "Puerto Montt", "Ovalle"… (sin el prefijo "Dirección Regional"/"Unidad de").
// ============================================================================

/** Oficina/Unidad del SII → comunas bajo su jurisdicción (incluye variantes de escritura). */
const OFICINA_COMUNAS = {
  // ── Arica y Parinacota ──
  "Arica": ["Arica", "Camarones", "Putre", "General Lagos"],
  // ── Tarapacá ──
  "Iquique": ["Iquique", "Pica", "Pozo Almonte", "Huara", "Camiña", "Colchane", "Alto Hospicio"],
  // ── Antofagasta ──
  "Antofagasta": ["Antofagasta", "Mejillones", "Sierra Gorda"],
  "Calama": ["Calama", "San Pedro de Atacama", "Ollagüe", "Ollague"],
  "Tal-Tal": ["Taltal", "Tal-Tal"],
  "Tocopilla": ["Tocopilla", "María Elena"],
  // ── Atacama ──
  "Copiapó": ["Copiapó", "Caldera", "Tierra Amarilla"],
  "Chañaral": ["Chañaral", "Diego de Almagro"],
  "Vallenar": ["Vallenar", "Freirina", "Huasco", "Alto del Carmen"],
  // ── Coquimbo ──
  "La Serena": ["La Serena", "La Higuera", "Paihuano", "Paiguano", "Andacollo", "Vicuña"],
  "Coquimbo": ["Coquimbo"],
  "Ovalle": ["Ovalle", "Monte Patria", "Punitaqui", "Combarbalá", "Río Hurtado"],
  "Illapel": ["Illapel", "Salamanca", "Los Vilos", "Canela"],
  // ── Valparaíso ──
  "Valparaíso": ["Valparaíso", "Casablanca", "Juan Fernández", "Isla de Pascua", "Viña del Mar", "Concón", "Quintero", "Puchuncaví"],
  "Quillota": ["Quillota", "Nogales", "Hijuelas", "La Calera", "La Cruz", "Limache", "Olmué"],
  "San Antonio": ["San Antonio", "Santo Domingo", "Navidad", "Cartagena", "El Tabo", "El Quisco", "Algarrobo"],
  "San Felipe": ["San Felipe", "Panquehue", "Catemu", "Putaendo", "Santa María", "Llaillay", "Llay Llay"],
  "Los Andes": ["Los Andes", "Calle Larga", "San Esteban", "Rinconada"],
  "La Ligua": ["La Ligua", "Petorca", "Cabildo", "Zapallar", "Papudo"],
  "Villa Alemana": ["Villa Alemana", "Quilpué"],
  // ── Libertador Bernardo O'Higgins ──
  "Rancagua": ["Rancagua", "Machalí", "Graneros", "Mostazal", "San Francisco de Mostazal", "Doñihue", "Codegua", "Rengo", "Coltauco", "Requínoa", "Requinoa", "Olivar", "Malloa", "Quinta de Tilcoco", "Coinco"],
  "San Fernando": ["San Fernando", "Chimbarongo", "Nancagua", "Placilla"],
  "Santa Cruz": ["Santa Cruz", "Lolol", "Palmilla", "Peralillo", "Chépica", "Pumanque"],
  "San Vicente de Tagua Tagua": ["San Vicente de Tagua Tagua", "San Vicente", "Las Cabras", "Peumo", "Pichidegua"],
  "Pichilemu": ["Pichilemu", "Paredones", "Marchihue", "Marchigue", "Litueche", "La Estrella"],
  // ── Maule ──
  "Talca": ["Talca", "San Clemente", "Pelarco", "Río Claro", "Pencahue", "Maule", "Villa Alegre", "Curepto", "San Javier", "San Rafael"],
  "Curicó": ["Curicó", "Teno", "Romeral", "Molina", "Hualañé", "Sagrada Familia", "Licantén", "Vichuquén", "Rauco"],
  "Linares": ["Linares", "Yerbas Buenas", "Colbún", "Longaví"],
  "Parral": ["Parral", "Retiro"],
  "Cauquenes": ["Cauquenes", "Pelluhue", "Chanco"],
  "Constitución": ["Constitución", "Empedrado"],
  // ── Ñuble ──
  "Chillán": ["Chillán", "Chillán Viejo", "Coihueco", "Pinto", "El Carmen", "San Ignacio", "Pemuco", "Yungay", "Bulnes", "Quillón", "Ránquil", "Ranquil", "Portezuelo", "Coelemu", "Trehuaco", "Treguaco", "Quirihue", "Cobquecura", "Ninhue"],
  "San Carlos": ["San Carlos", "Ñiquén", "San Gregorio de Ñiquén", "San Nicolás", "San Fabián", "San Fabián de Alico"],
  // ── Biobío ──
  "Concepción": ["Concepción", "Chiguayante", "San Pedro de la Paz", "Penco", "Hualqui", "Florida", "Tomé", "Coronel", "Lota", "Santa Juana", "Arauco"],
  "Talcahuano": ["Talcahuano", "Hualpén"],
  "Los Ángeles": ["Los Ángeles", "Santa Bárbara", "Laja", "Quilleco", "Nacimiento", "Negrete", "Mulchén", "Quilaco", "Yumbel", "Cabrero", "San Rosendo", "Tucapel", "Antuco", "Alto Biobío"],
  "Lebu": ["Lebu", "Curanilahue", "Los Álamos", "Cañete", "Contulmo", "Tirúa"],
  // ── La Araucanía ──
  "Temuco": ["Temuco", "Vilcún", "Freire", "Cunco", "Lautaro", "Perquenco", "Galvarino", "Nueva Imperial", "Carahue", "Puerto Saavedra", "Saavedra", "Pitrufquén", "Gorbea", "Toltén", "Loncoche", "Melipeuco", "Teodoro Schmidt", "Padre Las Casas", "Cholchol"],
  "Angol": ["Angol", "Purén", "Los Sauces", "Renaico", "Collipulli", "Ercilla"],
  "Victoria": ["Victoria", "Traiguén", "Lumaco", "Curacautín", "Lonquimay"],
  "Villarrica": ["Villarrica", "Pucón", "Curarrehue"],
  // ── Los Ríos ──
  "Valdivia": ["Valdivia", "Mariquina", "San José de la Mariquina", "Máfil", "Corral", "Los Lagos", "Paillaco", "Futrono"],
  "La Unión": ["La Unión", "Río Bueno", "Lago Ranco"],
  "Lanco": ["Lanco"],
  "Panguipulli": ["Panguipulli"],
  // ── Los Lagos ──
  "Puerto Montt": ["Puerto Montt", "Calbuco", "Maullín", "Los Muermos", "Hualaihué"],
  "Puerto Varas": ["Puerto Varas", "Cochamó", "Fresia", "Llanquihue", "Frutillar"],
  "Osorno": ["Osorno", "Puyehue", "Purranque", "Río Negro", "San Pablo", "San Juan de la Costa", "Puerto Octay"],
  "Castro": ["Castro", "Chonchi", "Dalcahue", "Puqueldón", "Queilén", "Quellón", "Quinchao", "Curaco de Vélez"],
  "Ancud": ["Ancud", "Quemchi"],
  "Chaitén": ["Chaitén", "Palena", "Futaleufú"],
  // ── Aysén ──
  "Coyhaique": ["Coyhaique", "Coihaique", "Río Ibáñez", "O'Higgins", "Tortel", "Cochrane"],
  "Aysén": ["Aysén", "Aisén", "Cisnes", "Lago Verde", "Guaitecas"], // Guaitecas: no listada en el directorio oficial; asignación geográfica.
  "Chile Chico": ["Chile Chico"],
  // ── Magallanes y la Antártica ──
  "Punta Arenas": ["Punta Arenas", "Río Verde", "San Gregorio", "Laguna Blanca", "Cabo de Hornos", "Antártica"], // Antártica: no listada en el directorio oficial; asignación geográfica.
  "Porvenir": ["Porvenir", "Primavera", "Timaukel"],
  "Puerto Natales": ["Puerto Natales", "Natales", "Torres del Paine"],
  // ── Región Metropolitana (esquema vigente de 5 Direcciones Regionales) ──
  "Santiago Centro": ["Santiago"],
  "Santiago Norte": ["Recoleta", "Independencia", "Huechuraba", "Conchalí", "Quilicura", "Lampa", "Colina", "Tiltil", "Til Til"],
  "Santiago Oriente": ["Providencia", "Las Condes", "Vitacura", "Lo Barnechea"],
  "Ñuñoa": ["Ñuñoa", "La Reina", "Macul", "Peñalolén"],
  "Santiago Poniente": ["Quinta Normal", "Cerro Navia", "Curacaví", "Estación Central", "Lo Prado", "Pudahuel", "Renca"],
  "Santiago Sur": ["San Miguel", "La Cisterna", "San Joaquín", "Pedro Aguirre Cerda", "Lo Espejo", "La Granja", "La Pintana", "San Ramón"],
  "Maipú": ["Maipú", "Cerrillos", "Padre Hurtado", "Peñaflor", "Talagante", "El Monte", "Isla de Maipo"],
  "San Bernardo": ["San Bernardo", "Calera de Tango", "El Bosque"],
  "La Florida": ["La Florida", "Puente Alto", "Pirque", "San José de Maipo"],
  "Melipilla": ["Melipilla", "San Pedro", "Alhué", "María Pinto"],
  "Buin": ["Buin", "Paine"],
};

/**
 * Normaliza un nombre de comuna para comparación robusta: minúsculas, sin tildes
 * ni diéresis (NFD + quita diacríticos → ñ→n, á→a, ü→u), y elimina TODO lo que no
 * sea [a-z0-9] (espacios, guiones, apóstrofes). Así "Quinta Normal", "QUINTA  NORMAL",
 * "O'Higgins", "Til Til"/"Tiltil" colapsan a una sola clave comparable.
 * @param {string} s
 * @returns {string}
 */
export function normalizeComuna(s) {
  return String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Índice invertido comuna-normalizada → oficina (se construye una vez al cargar).
const COMUNA_INDEX = (() => {
  /** @type {Record<string,string>} */
  const idx = {};
  for (const [oficina, comunas] of Object.entries(OFICINA_COMUNAS)) {
    for (const c of comunas) idx[normalizeComuna(c)] = oficina;
  }
  return idx;
})();

/**
 * Resuelve la Unidad/Oficina del SII a partir de la comuna del emisor.
 * @param {string|undefined|null} comuna
 * @returns {string|null} nombre de la oficina (p.ej. "Santiago Poniente") o null si no se conoce.
 */
export function resolveSiiOficina(comuna) {
  if (!comuna) return null;
  return COMUNA_INDEX[normalizeComuna(comuna)] ?? null;
}

export { OFICINA_COMUNAS };
