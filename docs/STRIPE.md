# Stripe — preparación de facturación

Estado HITO 13: **IMPLEMENTACIÓN TEST MODE**. Checkout, webhook, portal, UI OWNER y sincronización de empleados quedan integrados con fail-closed. El runtime rechaza claves live; no se cobra a clientes reales y ningún secreto se almacena en GitHub.

## Objetivo

La integración se hará con Stripe-hosted Checkout para el alta de suscripciones, webhooks firmados como fuente autoritativa del estado de pago y Stripe Customer Portal para autogestión de facturación. El redirect de Checkout nunca concede acceso por sí solo.

La activación real queda fuera de este cambio: no hay claves Stripe en el repositorio, no se crean clientes Stripe, no se cobran tarjetas y no se bloquea ninguna organización por estado de pago.

## Catálogo V1 propuesto

Moneda: EUR. Periodicidad: mensual.

- Cuota base: **12,99 EUR/mes**.
- Incluye hasta 5 empleados.
- Empleados 6–20: **1,99 EUR/empleado/mes**.
- Empleados 21–100: **1,49 EUR/empleado/mes**.
- Empleados 101+: **1,29 EUR/empleado/mes**.

Representación prevista en Stripe:

1. Un Product `Fichaje APP`.
2. Un Price recurrente fijo `fichaje_base_monthly_v1` de 12,99 EUR.
3. Un Price recurrente `licensed`, `billing_scheme=tiered`, `tiers_mode=graduated`, con lookup key `fichaje_employees_monthly_v1`.
4. La cantidad del segundo Price será el número autoritativo de empleados activos de la organización. Los cinco primeros tramos tienen unit_amount 0.

El script `scripts/stripe_catalog.mjs` puede inspeccionar el catálogo en seco o crear/reutilizar Product y Prices. No almacena la clave ni imprime su valor.

## Uso del bootstrap de catálogo

Solo inspección, sin red y sin modificar Stripe:

```sh
node scripts/stripe_catalog.mjs --mode test
```

Aplicar en **test mode**:

```sh
STRIPE_SECRET_KEY='...' node scripts/stripe_catalog.mjs --mode test --apply
```

Aplicar en **live mode** requiere una confirmación adicional deliberada:

```sh
STRIPE_SECRET_KEY='...' node scripts/stripe_catalog.mjs --mode live --apply --confirm-live FICHAJE-LIVE
```

Nunca pegar la clave en un fichero del repositorio, issue, PR, log o variable `VITE_*`.

Al terminar, el script devuelve únicamente identificadores no secretos de Product/Prices y los nombres de las variables que deberá recibir el runtime.

## Variables de entorno previstas

Servidor, nunca frontend:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_BASE_MONTHLY`
- `STRIPE_PRICE_EMPLOYEES_MONTHLY`
- `FICHAJE_BILLING_ENABLED`
- URLs de retorno permitidas construidas desde el origen productivo conocido, no recibidas desde el navegador.

Ninguna variable Stripe se incluirá como `VITE_*`.

## Contrato de runtime HITO 13

### Checkout

Ruta prevista: `POST /gateway/billing/checkout`.

- Solo OWNER autenticado de la organización.
- El navegador aporta únicamente `organization_id` y `request_id`.
- El servidor vuelve a calcular el número de empleados activos.
- Creación de Customer y Checkout Session mediante POST idempotente.
- `mode=subscription`.
- Dos line items: base (qty 1) + empleados (cantidad autoritativa).
- Metadata técnica mínima: `organization_id`, nunca datos laborales.
- La respuesta contiene únicamente una URL Stripe-hosted.
- Una respuesta perdida no debe crear una segunda suscripción.

### Customer Portal

Ruta prevista: `POST /gateway/billing/portal`.

- Solo OWNER autenticado.
- El servidor resuelve el Stripe Customer asociado a la organización.
- La URL de retorno se fija en servidor.
- No se expone la secret key ni se construye un portal propio para tarjetas.

### Webhook

Ruta prevista directa de Stripe a la función server-side de billing.

- `verify_jwt=false` en plataforma porque Stripe no envía JWT Supabase.
- Verificación obligatoria de `Stripe-Signature` con el **raw body** y `STRIPE_WEBHOOK_SECRET`.
- El evento se rechaza antes de tocar datos si la firma no es válida.
- Cada `event.id` se procesa una sola vez.
- Nunca se almacena el payload completo del webhook, PAN, CVC ni datos de tarjeta.
- Eventos antiguos no pueden pisar un estado de suscripción más reciente.

Eventos mínimos a soportar antes de activar:

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`

El estado local de suscripción se deriva del webhook; el success URL de Checkout es solo UX.

## Sincronización de empleados

La cantidad facturable no se confiará al frontend.

Antes de producción con cobro debe existir un mecanismo duradero que sincronice a Stripe cualquier alta, baja o reactivación de empleados. La operación debe:

- leer el count autoritativo de empleados activos en PostgreSQL;
- actualizar el subscription item de empleados con una idempotency key estable;
- tolerar reintentos y respuestas perdidas;
- no hacer I/O a Stripe dentro de la transacción laboral que modifica empleados;
- dejar un outbox/job persistente hasta recibir ACK de Stripe;
- no impedir fichar por un fallo temporal de Stripe.

Este punto es obligatorio antes de activar facturación real.

## Modelo de datos previsto

Tabla privada por organización:

- `organization_id` PK/FK;
- `stripe_customer_id` UNIQUE;
- `stripe_subscription_id` UNIQUE nullable;
- `stripe_employee_item_id` nullable;
- `status` cerrado a estados admitidos;
- `seat_quantity`;
- `cancel_at_period_end`;
- último `stripe_event_created` aplicado;
- timestamps servidor.

Ledger privado de eventos:

- `stripe_event_id` PK;
- tipo;
- instante Stripe;
- organización resuelta;
- procesado en servidor.

No guardar facturas completas ni datos de pago salvo que exista una necesidad contable concreta y aprobada.

## Activación y control de acceso

HITO 13 añade la entrada pública `/contratar`, la pantalla OWNER `/gestion/facturacion` y el despacho de seat-sync tras cambios de empleados. La mutación laboral confirma primero en PostgreSQL; la llamada a Stripe es best-effort y el outbox privado conserva la revisión si falla.

La facturación real sigue desactivada. El runtime H13 acepta exclusivamente `sk_test_*`; una clave live hace que billing quede DOWN. Checkout + webhook + portal + seat sync deben superar además la prueba real en Stripe test mode antes de cerrar el hito.

No se debe reutilizar `organizations.status='SUSPENDED'` de forma automática ante un único fallo de pago: ese estado hoy bloquea las RPC laborales. La política de grace period, dunning y acceso a evidencias debe definirse expresamente para no impedir el acceso legal a registros históricos por un incidente de cobro.

Hasta esa decisión, billing permanece informativo y desacoplado del motor horario.

## Seguridad

- Stripe secret key y webhook secret solo en secret stores server-side.
- Price/Product IDs pueden tratarse como configuración no secreta, pero no se incrustan en el frontend.
- Nunca confiar en cantidad, precio, Customer ID, Subscription ID ni estado enviados por navegador.
- Toda asociación Stripe↔organización se valida en servidor.
- POST a Stripe con idempotency key.
- Sin logs de cuerpos de webhook, tokens, secretos ni datos laborales.
- Webhooks con tamaño máximo y tipos de eventos allowlist.
- URLs de retorno allowlist; no open redirects.
- Stripe no recibe fichajes, horarios, motivos de corrección ni histórico laboral.

## Puerta de activación

No activar cobros hasta que estén PASS:

1. catálogo test creado con los lookup keys previstos;
2. Checkout E2E en Stripe test mode;
3. webhook con firma válida/incorrecta, replay, out-of-order y duplicados;
4. Customer Portal test;
5. seat sync ante alta/baja/reintento;
6. aislamiento cross-tenant;
7. ningún secreto en bundle/Git/logs;
8. política IVA/facturación y datos fiscales definida;
9. política de impago/grace period aprobada;
10. test de recuperación que conserve el mapping Stripe↔organización;
11. activación manual de `FICHAJE_BILLING_ENABLED=1` únicamente después de aprobación.

## Referencias

- Stripe API — Prices / tiered pricing: https://docs.stripe.com/api/prices/create
- Stripe Checkout subscriptions: https://docs.stripe.com/payments/checkout/build-subscriptions
- Stripe webhooks/signatures: https://docs.stripe.com/webhooks
- Stripe Customer Portal: https://docs.stripe.com/customer-management
- Stripe idempotent requests: https://docs.stripe.com/api/idempotent_requests
