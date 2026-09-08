## Qué cambia

<!-- Y sobre todo POR QUÉ. El qué se lee en el diff. -->

## Cómo lo verificaste

<!-- Un test que antes fallaba y ahora pasa vale más que un párrafo. Si tocaste
     la serialización o la firma, di qué test lo cubre. -->

- [ ] `deno task check && deno task test`
- [ ] `cd pdf-service && npm test` (si tocaste el PDF)

## Checklist

- [ ] Commits firmados (`git commit -s`) — [DCO](../CONTRIBUTING.md#2-dco-firma-tus-commits)
- [ ] Sin datos reales: ni RUT de personas, ni certificados, ni CAF
- [ ] Plata en pesos enteros (CLP no tiene centavos)
- [ ] Sin `try/catch` que se trague el error, sin tests saltados
