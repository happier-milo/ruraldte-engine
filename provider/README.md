# `provider/` — el contrato `DteProvider`

La fachada del motor. Una interfaz de cinco métodos y un adapter que la
implementa sobre `../engine/`:

```ts
interface DteProvider {
  emit(req):        Promise<ProviderEmitResult>;   // firma + arma el sobre + envía al SII
  poll(req):        Promise<ProviderPollResult>;   // consulta el estado de un trackId
  getXml(req):      Promise<string>;               // el XML firmado tal cual se envió
  getPdf(req):      Promise<Uint8Array>;           // representación gráfica (via pdf-service)
  healthcheck():    Promise<ProviderHealth>;       // ¿el SII está contestando?
}
```

## Por qué existe una interfaz si hay una sola implementación

Por los **errores**. `types.ts` define una jerarquía que distingue lo que hay que
reintentar de lo que no:

| Error | Qué significa | Qué hacer |
|---|---|---|
| `ProviderTransientError` | el SII no contestó, o contestó 5xx | reintentar con backoff |
| `ProviderRejectedError` | el SII rechazó el documento | **no reintentar**: arréglalo |
| `ProviderConfigError` | falta un CAF, el certificado venció, el folio no calza | intervención humana |
| `ProviderAuthError` | la semilla o el token no sirvieron | renovar token y reintentar una vez |

Un `catch` genérico convierte un rechazo definitivo en un reintento infinito.
Esa distinción es la mitad del valor de esta capa.

## Sin estado, a propósito

Las credenciales (`.pfx`, contraseña, CAF) viajan **dentro del request**. El
provider no las guarda, no las cachea y no las escribe en ningún log. Cómo las
custodias es tuyo — y esa separación es lo que hace auditable al motor.

## Alcance

Los 12 tipos autorizados. Boleta (39/41) va por el canal REST
`boleta.electronica.*` con sobre `EnvioBOLETA`; el resto (33/34/43/46/52/56/61 y
exportación 110/111/112) por el canal legacy `cgi_dte/UPL/DTEUpload` con sobre
`EnvioDTE`. Son dos protocolos distintos del SII, no una preferencia nuestra.
