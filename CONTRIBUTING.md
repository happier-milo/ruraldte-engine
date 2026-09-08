# Cómo contribuir

Gracias por venir. Antes de escribir código, dos cosas que te van a ahorrar
tiempo: **cómo se sincroniza este repo** y **el DCO**.

## 1. Este repositorio es un espejo generado

El motor se desarrolla dentro del monorepo privado de RuralDTE (donde también
viven el API, el panel y la custodia de certificados) y se **exporta** acá con un
script determinista. En la práctica:

- El árbol de archivos que ves es **generado**: `engine/`, `provider/`,
  `cert-tools/`, `pdf-service/` salen tal cual del canónico, más las cabeceras
  SPDX que inyecta el exportador.
- Un guardián en CI regenera el export y **falla si el árbol público no calza**
  byte a byte. Nada se cuela ni se pierde en la traducción.
- La historia acá es **append-only**: cada sincronización es un commit nuevo.
  Nunca hacemos force-push, así que tus commits no desaparecen.

**Tu PR sí se merge acá.** Lo aplicamos también upstream en el canónico; la
siguiente sincronización llega vacía porque el árbol ya calza. Tu autoría queda
en el historial público. Lo único que pedimos es paciencia: un cambio en el motor
pasa además por la suite del API antes de quedar.

## 2. DCO: firma tus commits

Este proyecto usa el [Developer Certificate of Origin](https://developercertificate.org)
1.1 — no un CLA. Al firmar un commit declaras que tienes derecho a aportar ese
código bajo Apache-2.0.

```bash
git commit -s -m "fix(engine): ..."
```

Eso agrega `Signed-off-by: Tu Nombre <tu@correo>`. CI lo verifica. Si se te
olvidó: `git commit --amend -s` (o `git rebase --signoff HEAD~N`).

## 3. Levantar el proyecto

Necesitas [Deno](https://deno.com) 2.x y Node 24 (solo para el servicio de PDF).

```bash
deno task check     # typecheck del motor + provider
deno task test      # 161 tests del motor + 43 del provider
cd pdf-service && npm install && npm test   # 85 tests del PDF y del timbre
```

No hace falta certificado, ni CAF, ni conexión al SII: la suite completa corre
offline con material de juguete.

## 4. Qué va acá y qué no

**Sí va:** construcción y firma de DTE, C14N, TED/CAF, sobres, libros, cesión,
intercambio, códigos oficiales, clientes del SII, representación gráfica, y todo
lo que necesite un emisor para hablar con el SII.

**No va:** persistencia, multi-tenant, colas, API keys, custodia de certificados,
facturación de clientes. El motor no sabe de bases de datos — la única forma de
darle credenciales es por parámetro, y eso es a propósito: lo hace auditable y
testeable sin infraestructura. Un PR que meta un cliente de base de datos acá lo
vamos a rechazar aunque el código esté impecable.

## 5. Reglas que hacen cumplir los tests

- **Plata en pesos enteros.** CLP no tiene centavos. Nada de flotantes ni de
  sufijos `_cents`.
- **Los bytes firmados son los bytes que se serializan.** Si tocas la
  serialización, el digest tiene que recomputarse sobre lo mismo que se firmó.
  Hay tests que verifican la firma RSA de verdad, no un mock.
- **Latin-1.** El SII recibe `ISO-8859-1`. Un carácter fuera de esa página
  (una raya `—`, una comilla tipográfica) rompe la firma del TED. Usa
  `sanitizeSiiText()`.
- **Conformidad XSD.** `xsd-conformance.test.ts` valida contra los esquemas v2.5
  oficiales. Si tu cambio mueve el orden de un elemento, ese test lo caza.
- **Nada de tragarse errores.** Prohibido `try/catch` que silencia, `?? ""` que
  esconde, `skip` de tests, lints apagados. Un síntoma parchado en material
  tributario deja la causa viva para el próximo.

## 6. Reportar bugs

Un buen reporte del motor trae: **tipo de DTE**, el XML generado (con los datos
cambiados por sintéticos), lo que respondió el SII —código y glosa completa— y
qué esperabas. Si es un rechazo del SII, la glosa literal vale más que tu
interpretación.

**Vulnerabilidades no van a issues** → lee [SECURITY.md](SECURITY.md).

## 7. Estilo

- Español para comentarios y mensajes de commit; nombres de símbolos en inglés
  o español, como esté el archivo que tocas.
- Tuteo chileno. Nada de voseo (`-ás`/`-és`/`-ís`).
- Commits [Conventional](https://www.conventionalcommits.org):
  `fix(engine): ...`, `feat(provider): ...`, `docs: ...`.
- Un comentario explica **por qué**, no qué. El qué ya está en el código.
