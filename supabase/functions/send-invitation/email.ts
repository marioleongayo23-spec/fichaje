// HITO 15: deterministic, plaintext-free-in-storage invitation email.
// No HTML is constructed from unescaped organization names.
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}
export function renderInviteEmail(origin: string, company: string, code: string): { subject: string; html: string; text: string } {
  const safeCompany = escapeHtml(company);
  const safeCode = escapeHtml(code);
  const subject = 'Bundy · Te han invitado a fichar';
  const text = `Hola,

${company} te ha invitado a usar Bundy, la app de registro horario.

1. Entra en ${origin}
2. Si no tienes cuenta, créala con este mismo correo y confirma tu dirección.
3. Inicia sesión y elige «Aceptar una invitación».
4. Introduce este código:

${code}

El código caduca a las 24 horas, solo sirve una vez y está vinculado a tu correo verificado.

Si no esperabas esta invitación, ignora este mensaje. Nunca compartas tu contraseña.
— Equipo Bundy`;
  const html = `<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#EEF1EE;font-family:Arial,Helvetica,sans-serif;color:#1F4A33">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EEF1EE"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:540px;background:#fff;border-radius:22px;overflow:hidden">
<tr><td style="background:#1F4A33;padding:26px 32px"><img src="${origin}/icons/icon-192.png" alt="Logo de Bundy" width="46" height="46" style="display:inline-block;vertical-align:middle;border:0;border-radius:11px"><span style="display:inline-block;vertical-align:middle;margin-left:14px;font-size:28px;letter-spacing:-1px;font-weight:800;color:#fff">bundy<span style="color:#F2C230">.</span></span></td></tr>
<tr><td style="padding:32px"><p style="font-size:12px;color:#52695B;letter-spacing:1.4px;font-weight:700">TU TIEMPO, CLARO</p>
<h1 style="font-size:26px;line-height:33px;margin:10px 0;color:#1F4A33">¡Te damos la bienvenida!</h1>
<p style="font-size:16px;line-height:25px;color:#354E3E"><strong>${safeCompany}</strong> te ha invitado a registrar tu jornada con Bundy.</p>
<p style="font-size:15px;line-height:24px;color:#354E3E">Entra en Bundy, crea tu cuenta con este correo si todavía no la tienes, confirma tu dirección e inicia sesión. En <strong>«Aceptar una invitación»</strong> pega el código:</p>
<p style="padding:18px 12px;text-align:center;font:700 12px/20px monospace;letter-spacing:.25px;overflow-wrap:anywhere;word-break:break-all;background:#EEF1EE;color:#1F4A33;border-radius:12px">${safeCode}</p>
<table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#F2C230;border-radius:999px"><a href="${origin}/" style="display:inline-block;padding:15px 25px;font-size:15px;font-weight:800;color:#1F4A33;text-decoration:none">Entrar en Bundy</a></td></tr></table>
<p style="font-size:13px;line-height:21px;color:#52695B;margin-top:24px">Válido 24 horas · Un solo uso · Solo para este correo verificado.</p></td></tr>
<tr><td style="padding:18px 32px;border-top:1px solid #DFE7DF;font-size:12px;line-height:19px;color:#52695B">Correo enviado por Bundy. Si no esperabas esta invitación, ignórala. Nunca te pediremos tu contraseña por correo.</td></tr></table></td></tr></table></body></html>`;
  return { subject, html, text };
}
