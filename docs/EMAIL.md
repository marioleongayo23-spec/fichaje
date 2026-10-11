# HITO 15 — Correo corporativo Bundy e invitaciones automáticas

**Estado: preparado en código / desactivado por defecto.** No hay entrega real validada ni se ha configurado un remitente corporativo en Supabase remoto. No activar para clientes antes de los gates definidos aquí.

## Dos sistemas distintos

1. **Supabase Auth** envía correos propios de registro, cambio de correo, enlaces de acceso y recuperación de contraseña. Se personalizan en Dashboard → Authentication → Email Templates, con los HTML versionados en `supabase/templates/`. El `supabase/config.toml` solo configura los templates **locales**; el despliegue GitHub/Cloudflare **NO** aplica automáticamente cambios a los templates remotos.
2. **Invitación a una empresa Bundy** no es `inviteUserByEmail` de Supabase Auth: permite también invitar usuarios Auth existentes. La Edge Function `send-invitation` utiliza el mismo `create_invitation` del motor, con validación de rol/tenant en servidor, y envía el código vigente a través de un proveedor de correo transaccional (API Resend), sin modificar la forma de aceptar invitaciones.

## Identidad visual y contenido

Paleta oficial: bosque `#1F4A33`, niebla `#EEF1EE`, aulaga `#F2C230`. Se usa el icono PNG ya existente `/icons/icon-192.png` (más compatible con clientes de correo que SVG), tipografía del sistema, tablas HTML con estilos inline y versión de texto plano para invitaciones. Los Auth templates enlazan al logo con `{{ .SiteURL }}`; revisar Site URL y dominio antes de activar. Botones con `{{ .ConfirmationURL }}` para flujos Auth. No incrustar tokens Auth propios en enlaces construidos manualmente.

Flujos Auth incluidos: confirmación, recuperación, enlace de acceso, cambio de correo e invitación Auth genérica. El correo de invitación de **Bundy** tiene mensaje diferente y contiene el código `organización.token` solo en el cuerpo; la URL lleva únicamente al origen conocido de la app (no query, fragmento ni token). Texto indica cuenta verificada y caducidad de 24 h.

## Activación de Supabase Auth (staging primero)

1. En **Supabase staging** → Authentication → URL Configuration, fijar la `Site URL` pública correcta de staging y allowlist de redirects, sin permitir orígenes no confiables.
2. En Authentication → Email Templates, copiar y verificar los cinco HTML/subjects de `supabase/templates/`. No asumir que `config.toml` los publica en hosted Supabase.
3. En Authentication → SMTP, configurar un servicio de correo transaccional con remitente **Bundy** y email bajo un **dominio propio verificado**; preparar SPF, DKIM, DMARC, política de rebotes y límites. No usar el SMTP predeterminado de Supabase como solución de correo comercial.
4. Desactivar tracking de enlaces del proveedor para no romper enlaces de confirmación Supabase. Enviar correos sintéticos de cada tipo, validar HTML/texto, visualización de PNG, URLs, expiración y entregabilidad.
5. Replicar en producción solamente después de aprobar staging y el dominio remitente. **No introducir API keys en repositorio, chats, logs, URLs ni variables `VITE_*`.**

## Activación de invitaciones automáticas (staging primero)

La `supabase/functions/send-invitation` debe desplegarse con `verify_jwt=true`. Variables **solo en secrets del runtime**, nunca en GitHub público:

- `SUPABASE_URL` y `SUPABASE_ANON_KEY` (variables estándar del entorno Edge)
- `BUNDY_INVITES_ENABLED=1` (apagada por defecto)
- `BUNDY_APP_ORIGIN`: origen HTTPS exacto de la app, **sin path**; se usa también para CORS y link
- `BUNDY_MAIL_FROM`: dirección de remitente validada y verificada por el proveedor
- `RESEND_API_KEY`: API token de proveedor con permisos mínimos

Tras verificar que el servicio está configurado y entrega correctamente, poner **solo** `VITE_BUNDY_INVITES_ENABLED=true` en el build Cloudflare de staging y publicar nuevo build. Esta bandera NO es un secreto; por defecto sigue apagada y el formulario genera el código manual como antes.

La función exige JWT Auth válido, correo del actor verificado, método POST, origen permitido, JSON pequeño, rol válido y petición UUID. Reutiliza `create_invitation` con JWT del actor: el servidor ya comprueba OWNER/ADMIN, `organization_id`, destinatario, rol e idempotencia. Solo después llama al proveedor. La petición al proveedor usa una clave de idempotencia por organización + request. No se guarda el token en texto plano en SQL. Respuesta de éxito significa **aceptado por proveedor**, nunca llegada garantizada a bandeja de entrada. Si el servidor crea la invitación pero la respuesta se pierde, el navegador confirma la misma RPC idempotente y muestra el **mismo** código por entrega manual. Sin reintentos automáticos ni regeneración silenciosa de token.

### Gates obligatorios antes de habilitar en clientes

- Unit tests: escaneo de templates, escaping, rechazo de origen/no manager, contrato Auth/RPC, no fuga de token en respuesta, provider idempotency, caída de proveedor.
- Test con Supabase local real: miembro OWNER/ADMIN autorizado y empleado rechazado en `create_invitation`, empresa ajena rechazada; repetición de UUID retorna misma invitación.
- E2E con proveedor en test mode y dominio verificado: el email recibido solo para destinatario designado, código aceptado por cuenta Auth con ese email y rechazado para email diferente; caducidad, reuso y cambio de rol.
- Test SMTP Auth: alta confirmada, recuperación, cambio de correo y enlaces con identidad Bundy; verificar que no aparecen marcas genéricas ni enlaces rotos.
- Control de abuso: límites de frecuencia por gestor/tenant y proveedor, métricas sin PII, cuota y coste revisados antes de usuarios reales. La implementación base no acredita estos límites ni una entrega real.
- Gates CI + Database + E2E H6 + OPS-02 + H7 en el HEAD final; PR abierto sin merge hasta aprobación explícita.

## Referencias

- Supabase: https://supabase.com/docs/guides/auth/auth-email-templates
- Supabase local: https://supabase.com/docs/guides/local-development/customizing-email-templates
- Supabase SMTP: https://supabase.com/docs/guides/auth/auth-smtp
- Resend idempotencia: https://resend.com/features/email-api
