# Si cualquiera puede usar cualquier software, ¿dónde están los controles?

Es la primera pregunta sensata que aparece cuando alguien ve un motor DTE abierto,
y la hizo textualmente un lector el día que se publicó este repositorio:

> *"O sea que a la larga uno puede ocupar cualquier cosa que se comunique según lo
> establece el servicio y ya? ¿Dónde quedarían algunas restricciones de seguridad,
> como por ejemplo para evitar ataques de denegación de servicio por parte de algún
> facturador electrónico?"*

La respuesta corta es **sí**: puedes emitir con cualquier software que hable el
protocolo. El SII dejó de certificar programas hace años.

Pero el control no desapareció. **Se movió del programa al protocolo**, y ahí sí se
puede verificar. Son cuatro puertas, y ninguna depende de qué software uses.

## 1. Quién eres — no hay endpoint anónimo

Para obtener un token hay que recorrer tres pasos: pedir una semilla, **firmarla con
el certificado digital** (XMLDSig) y canjear esa firma por el token que después viaja
en cada llamada.

Ese certificado se lo emitió un prestador de servicios de certificación acreditado a
una **persona natural**, y lleva su RUT adentro. Sin él no se obtiene token, y sin
token no se habla con el SII.

> En el código: [`engine/sii-client.ts`](../engine/sii-client.ts) (canal REST de
> boleta) y [`engine/sii-legacy-upload.ts`](../engine/sii-legacy-upload.ts) (canal
> legacy de factura). El token viaja como cookie `TOKEN` en cada request.

## 2. Que esa persona pueda actuar por esa empresa

Tener certificado no basta: el titular tiene que estar habilitado ante el SII para
representar a ese contribuyente.

Cuando no lo está, el SII no rechaza el documento — **rechaza a la persona**. Lo
vimos en vivo consultando el estado de un envío con un certificado no habilitado para
esa empresa:

```
106 — Usuario sin permiso de envío
```

Lo incómodo de ese código es que aparece en la respuesta de la *consulta*, no en la
del envío, así que es fácil confundirlo con "el documento sigue en proceso". Si tu
integración pollea para siempre sin cerrar, revisa esto antes que nada.

## 3. Que el RUT esté autorizado para ese tipo de documento

Es el proceso de certificación, y va **por contribuyente, no por software**: postular,
correr el set de pruebas que el SII te asigna, subir las muestras impresas y firmar la
declaración de cumplimiento. Se repite por cada tipo de documento que quieras agregar.

> El camino completo, con los rechazos que nos comimos:
> [`docs/DTE_CERT_APRENDIZAJES.md`](DTE_CERT_APRENDIZAJES.md).

## 4. El freno de verdad: los folios

Acá está la respuesta a la pregunta del abuso, y es la puerta más subestimada.

**No puedes emitir los documentos que quieras.** Cada documento consume un folio de un
CAF que el SII te otorgó, y ese CAF trae una llave privada con la que se timbra el
documento (el `<TED>`). Sin folio no hay documento válido, y los folios los reparte el
SII: su propio formulario publica un `MAX_AUTOR`, el máximo que te autoriza a timbrar
en ese momento. A un emisor nuevo le da poquísimos, y el tope sube después.

Es un límite **duro y cuantificado**, y bastante más efectivo que revisar el código de
alguien: un emisor no puede inundar el sistema con documentos que no tiene cómo
timbrar.

> En el código: [`engine/sii-folios.ts`](../engine/sii-folios.ts) lee `MAX_AUTOR` y
> `FOLIOS_DISP` del formulario del SII; pedir más que el máximo autorizado termina en
> rechazo.

## Y además, antiabuso explícito en el canal

El canal de subida deduplica por contenido. Reenviar el mismo archivo responde con el
track anterior y una espera forzada, en palabras del propio SII:

```
Archivo ya fue enviado 2 veces con Trackid 251550580.
Debe esperar 900 segundos antes de reintentar
```

> En el código: [`engine/sii-legacy-upload.ts`](../engine/sii-legacy-upload.ts),
> `STATUS 99` con `dedup: true`.

## Por qué el régimen está diseñado así

Aprobar software nunca fue un control real. Nadie puede auditar que el binario que
estás corriendo hoy es el que te aprobaron el año pasado, ni que no lo cambiaste
después. Es una firma sobre algo que no se puede verificar.

Así que la frontera de confianza está donde sí se verifica en cada request:
**autenticación con certificado, autorización del titular, autorización del RUT, y una
cuota de folios que el SII controla**. Y después de todo eso, el documento se valida
igual: estructura contra el XSD, timbre contra la llave del CAF, firma contra el
certificado. Uno por uno.

Que el software sea abierto no debilita nada de eso. Al contrario: puedes leer
exactamente qué se le manda al SII en tu nombre.

## Lo que este documento no sabe

Todo lo de arriba es **observable desde afuera**: son respuestas del SII que se pueden
reproducir. La política interna —con qué criterio sube los topes de folios, qué
umbrales de tasa aplica, qué mira su antifraude— no la conocemos y no la vamos a
inventar acá.

Si encuentras que algo de esto cambió, un issue es bienvenido: este documento envejece
con el servicio.
