# Política de seguridad

Este motor firma **documentos tributarios de terceros**. Un error acá no rompe
una app: deja mal parado a un contribuyente ante el SII. Tratamos los reportes
en consecuencia.

## Cómo reportar

**Canal preferido — reporte privado en GitHub:** pestaña *Security* →
*Report a vulnerability*. Queda privado entre tú y los mantenedores, y permite
publicar el aviso después con crédito.

**Alternativa por correo:** contacto@comunidadrural.cl con asunto
`[seguridad] ruraldte-engine`. Si quieres cifrar, pídenos la clave en un primer
correo sin detalles técnicos.

**No abras un issue público** para una vulnerabilidad. Tampoco un PR con el fix:
el commit describe el ataque antes de que exista el parche.

## NUNCA pegues material real en un reporte

- ❌ Un `.pfx`/`.p12` y su contraseña, o cualquier clave privada.
- ❌ Un CAF real (contiene la llave privada con la que se timbra un folio).
- ❌ Un DTE emitido de verdad, con RUT y montos de un tercero.

Si el reporte no se entiende sin material, dilo y te generamos un certificado y
un CAF de juguete para reproducir. Un reporte con una clave adentro obliga a
revocarla y nos hace perder tiempo a los dos.

## Alcance

**Dentro** (este repositorio):

- Falsificación o alteración de firma: que un `<Documento>` firmado admita una
  modificación que la firma no delate (C14N, digest, transformaciones).
- TED/CAF: timbre que valida contra una llave que no corresponde, folio
  reutilizable, `<DD>` que no calza con el documento que acompaña.
- Filtración de material de clave: que la clave privada del `.pfx` termine en un
  log, un mensaje de error, una excepción o un valor de retorno.
- Parsers XML: XXE, expansión de entidades, DoS por documento hostil — tanto en
  lo que recibimos del SII como en el intercambio entrante (Ley 19.983).
- El servicio de PDF: lectura de archivos por input, DoS por documento hostil.

**Fuera** (repórtalo igual por el mismo canal, pero no vive en este repo):

- La infraestructura de quien opere el motor (su base de datos, su panel, su API). El
  servicio alojado `api.ruraldte.cl` que existía hasta septiembre de 2026 se dio de baja.
- El SII. Si encuentras algo del SII, es del SII: escríbeles a ellos. Si lo que
  buscas es entender qué controla el SII y qué no —y por qué que este motor sea
  abierto no debilita nada—, está en [Cómo controla el SII](https://github.com/happier-milo/ruraldte-engine/blob/main/docs/COMO_CONTROLA_EL_SII.md).
- Que el SII rechace un documento: eso es un bug normal → issue público.

## Qué esperar

**No prometemos plazos.** Esto lo mantiene un equipo chico y un SLA que no
podamos sostener no te sirve de nada: preferimos no ofrecerlo a incumplirlo.

Lo que sí puedes esperar: un reporte de seguridad se lee y se prioriza por
encima de cualquier funcionalidad nueva, y si el problema es real te vamos a
decir qué encontramos y cuándo sale el parche. Si pasan días sin respuesta,
insiste — no es desinterés, es que somos pocos.

Tampoco hay programa de recompensas; decirlo derecho es mejor que insinuar que
podría haberlo. Sí damos crédito público en el aviso y en el CHANGELOG, salvo
que prefieras el anonimato.

Si tienes una fecha de publicación en mente, dínosla en el primer mensaje y la
coordinamos contigo.

## Versiones con soporte

Mientras estemos en `0.x`, solo la última versión publicada recibe parches de
seguridad.

## Lo que este repositorio no contiene

Ninguna clave, certificado, CAF ni credencial. Si crees haber encontrado una,
avísanos por el canal privado: sería un incidente, no una feature.
