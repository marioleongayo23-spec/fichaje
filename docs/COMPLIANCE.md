# Cumplimiento — base de diseño revisada 2026-09-21; revisión H7 2026-09-28 (ver al final)
No es certificación de producto ni validación jurídica del piloto. H0 no procesa datos reales.

## Base normativa consultada
[Estatuto de los Trabajadores, BOE](https://www.boe.es/buscar/act.php?id=BOE-A-2015-11430):
art. 34.9: registro diario con inicio y fin, conservación cuatro años y disponibilidad para
trabajadores, representantes e Inspección. La organización del registro exige el cauce de
negociación/acuerdo o decisión empresarial con consulta que establece el artículo.
Art. 12.4.c: registro y resumen mensual para tiempo parcial, entrega de copia y conservación mínima
cuatro años. Art. 35.5: registro y totalización de jornada a efectos de horas extraordinarias.
La app requiere procedimiento empresarial de acceso y entrega, también sin email.
No presume que todo exceso sea hora extra ni que toda pausa sea no computable.
No se incorporan propuestas legislativas como obligaciones vigentes; revisar BOE y convenio antes H7.

[RGPD, EUR-Lex](https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=es): arts. 5/6 (finalidad,
minimización, plazo y base jurídica), 13 (información), 28 (encargo), 32 (seguridad), 33/34
(brechas), 44 y ss. (transferencias). Empresa responsable; proveedor encargado para registro horario.
Base ordinaria de registro: obligación legal del empleador, no consentimiento forzado.
[LOPDGDD, BOE](https://www.boe.es/buscar/act.php?id=BOE-A-2018-16673): considerar bloqueo de datos
cuando proceda; no equiparar baja de cuenta y supresión inmediata de evidencias legales.

## Retención propuesta
| Categoría | Plazo base / tratamiento |
|---|---|
| Eventos, sesiones, correcciones, políticas aplicadas, clasificación y evidencia vinculada | Mínimo 4 años desde cierre del periodo correspondiente; ajustes posteriores conservados con la cadena hasta el mayor vencimiento aplicable |
| Identificación de empleado/autor | Solo campos necesarios para interpretar evidencia; conservar junto a esta, no perfil completo indefinido |
| Sesión incompleta | Resolver incidencia antes de purgar; revisión mensual, no retención indefinida silenciosa |
| Claves idempotentes de negocio | Misma vida que evidencia; previene recrear acciones por replay antiguo |
| Logs de seguridad sin evidencia laboral | 90 días por decisión técnica revisable; minimizar IP y eliminar PIN/token |
| Challenges y buckets kiosco | Expiración 60 s / ventana 15 min; purga en 24 h, conservar solo agregados necesarios |
| Exportaciones temporales | 24 h; manifiesto de entrega mínimo ligado al periodo conservado |
| Backups DB cifrados futuros | Rotación móvil 35 días; recuperación, no archivo legal único |
| Backups repo | Artefactos CI 14 días; Drive futuro 30 diarios + 12 mensuales, sin datos de empleados |

Retención computada por política versionada, no botón de usuario. Legal hold justificado suspende
purga del ámbito afectado hasta liberación auditada; revisión trimestral. Exportar antes de baja de
cliente y acordar devolución/supresión en contrato sin destruir evidencia aún obligatoria.
Borrado autorizado al vencer plazo/hold: eliminar derivados, Storage y copias al rotar; manifiesto
mínimo de purga. Tras restore, reaplicar borrados/holds antes de abrir acceso. No restaurar datos
suprimidos como si fueran vigentes. Inmutabilidad rige operación; purga legal es proceso excepcional.

## Puertas comerciales H7
Contrato de encargo, subencargados, ubicación UE y transferencias verificadas con proveedores;
información al empleado; procedimiento de representantes e Inspección; contingencia y entrega sin email;
convenio y pausas documentados; valoración de riesgos/EIPD cuando proceda; bajas y ejercicio de derechos;
pruebas de aislamiento/restore y revisión normativa vigente. No ofertar a sectores especiales sin evaluación.
Tiempos de respuesta/recuperación y costes solo se comprometen después de medición real.

## Revisión normativa HITO 7 — 2026-09-28
**Estado: revisión PARCIAL. La verificación en fuente primaria sigue pendiente (bloqueo externo).** El entorno de
ejecución de H7 no permite acceder a las fuentes primarias: la política de red denegó `www.boe.es`,
`eur-lex.europa.eu` y `www.mites.gob.es` (también mediante la herramienta de lectura web). No se afirma haber
releído ningún texto consolidado a esta fecha. Lo que sí se hizo:

| Fuente | Tipo | Resultado |
|---|---|---|
| Estatuto de los Trabajadores, arts. 34.9, 12.4.c y 35.5 ([BOE-A-2015-11430](https://www.boe.es/buscar/act.php?id=BOE-A-2015-11430)) | Primaria | **No accesible** desde H7. Se mantiene la lectura de 2026-09-21. Verificar la versión consolidada vigente antes del piloto: `[[FECHA Y RESPONSABLE DE LA VERIFICACIÓN]]` |
| RGPD, arts. 5, 6, 12–22, 28, 30, 32–35, 44–49 ([EUR-Lex](https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=es)) | Primaria | **No accesible** desde H7. Las plantillas citan artículos del texto de 2016 revisado el 2026-09-21 |
| LOPDGDD ([BOE-A-2018-16673](https://www.boe.es/buscar/act.php?id=BOE-A-2018-16673)), en especial art. 32 (bloqueo) y arts. 87–91 | Primaria | **No accesible** desde H7 |
| Proyecto de Real Decreto de registro de jornada digital | Secundaria (búsqueda web, 2026-09-28) | Según fuentes secundarias, a 9 de septiembre de 2026 **no** estaba aprobado por el Consejo de Ministros ni publicado en el BOE (dictamen desfavorable del Consejo de Estado de 23-03-2026 y aplazamiento). **No es obligación vigente**; es un punto de vigilancia. Si se publica, revisar: medios exclusivamente digitales, contenido mínimo, trazabilidad, acceso inmediato de trabajadores/representantes y acceso remoto de la Inspección, y el periodo de adaptación |

Requisito legal (se mantiene de la base 2026-09-21, pendiente de verificación en fuente primaria):
- Registro diario con hora concreta de inicio y fin de jornada, conservación cuatro años y disponibilidad para
  personas trabajadoras, representación legal e Inspección (art. 34.9 ET); organización mediante negociación
  colectiva, acuerdo de empresa o decisión empresarial previa consulta con la representación.
- Tiempo parcial (art. 12.4.c ET) y horas extraordinarias (art. 35.5 ET): totalización y copia a la persona.
- RGPD: obligación legal como base (6.1.c), información (13), encargo (28), seguridad (32), violaciones (33–34),
  EIPD cuando proceda (35), transferencias (44 y ss.).

Decisiones técnicas de H7 que apoyan el cumplimiento (no son requisitos legales por sí mismas): borde
same-origin sin CORS y con cabeceras de seguridad, ingreso firmado a las funciones, backup lógico cifrado con age
y clave en custodia separada, restauración ensayada con journal independiente, alertas sin datos personales,
retención técnica documentada en [`docs/legal/RETENCION.md`](legal/RETENCION.md).

Plantillas preparadas (revisables, con marcadores `[[…]]`, sin datos ficticios): [`docs/legal/`](legal/README.md).

Pendiente antes del piloto real (no lo resuelve H7): verificación en fuente primaria por asesoría jurídica;
firma del encargo y verificación de subencargados, regiones y garantías de transferencia; checklist de
convenio/pausas y valoración de EIPD por cada empresa; confirmación del estado del Real Decreto de registro
digital en el BOE en la fecha de alta. **No se declara cumplimiento certificado.**
