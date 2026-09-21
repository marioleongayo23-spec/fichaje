# Cumplimiento — base de diseño revisada 2026-09-21
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
