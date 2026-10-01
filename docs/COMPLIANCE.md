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

Fuentes primarias consultadas mediante lectura web el 2026-09-28:

| Fuente | Comprobación | Naturaleza |
|---|---|---|
| [ET consolidado, BOE-A-2015-11430](https://www.boe.es/buscar/act.php?id=BOE-A-2015-11430), arts. 34.9, 12.4.c y 35.5 | Inicio y fin diarios, conservación durante cuatro años, disponibilidad a personas trabajadoras, representantes e Inspección; registro y resumen mensual del tiempo parcial, y totalización de horas extraordinarias. La organización del registro se remite a negociación/acuerdo o decisión empresarial previa consulta. | Obligación vigente |
| [RGPD, EUR-Lex](https://eur-lex.europa.eu/legal-content/ES/TXT/HTML/?uri=CELEX:32016R0679), arts. 5, 6, 13, 28, 32–35 y 44 y ss. | Minimización, información, encargo, seguridad, gestión de brechas y transferencias según el supuesto. | Obligación vigente |
| [LOPDGDD, BOE-A-2018-16673](https://www.boe.es/buscar/act.php?id=BOE-A-2018-16673), art. 32 y arts. 87–91 | Bloqueo cuando proceda; derechos digitales y límites en el ámbito laboral. Los arts. 89–90 tratan de vídeo y geolocalización, que V1 no incorpora. | Obligación vigente según supuesto |
| [AEPD, pregunta sobre control horario](https://www.aepd.es/preguntas-frecuentes/3-proteccion-de-datos-en-el-ambito-laboral/FAQ-0311-es-necesario-el-consentimiento-del-trabajador-para-implantar-un-sistema-de-control-horario) y [guía de relaciones laborales](https://www.aepd.es/guias/la-proteccion-de-datos-en-las-relaciones-laborales.pdf) | La AEPD indica que no se precisa consentimiento para el registro horario ordinario: base del art. 6.1.c RGPD y art. 34.9 ET. La guía es orientación de la autoridad. | Interpretación/orientación |
| [Texto de proyecto del Ministerio de Trabajo](https://expinterweb.mites.gob.es/participa/listado/download/6cb63e79-48a8-4e99-9784-3a0b26ae6106) | La digitalización y otros requisitos del texto son una **propuesta**. No se incorporan como obligación vigente sin publicación y entrada en vigor. La búsqueda de esta fecha no demuestra por sí sola la ausencia de publicación posterior: comprobar el BOE en el alta real. | Borrador, sujeto a vigilancia |

Decisiones técnicas propias: originales inmutables y correcciones append-only; borde con ingreso firmado; cifrado age, journal independiente y alertas minimizadas; cuatro años desde el cierre del periodo y extensión de la cadena tras correcciones. Estas decisiones sirven al diseño y a la auditabilidad; la ley no prescribe este stack ni estos mecanismos concretos.

Las [plantillas legales](legal/README.md) siguen siendo revisables. Antes de usar datos reales hacen falta revisión jurídica del caso y convenio, encargo, subencargados/transferencias, información a la plantilla y valoración de riesgos/EIPD cuando corresponda. Esta revisión no certifica cumplimiento ni autoriza el piloto.


## PREPROD-01 — revisión normativa 2026-10-01

Fuentes primarias verificadas para abrir la puerta previa al primer cliente real:

- Estatuto de los Trabajadores, art. 34.9, BOE-A-2015-11430:
  https://www.boe.es/buscar/act.php?id=BOE-A-2015-11430
- RGPD, especialmente arts. 28 y 32:
  https://eur-lex.europa.eu/eli/reg/2016/679/oj?locale=es
- AEPD, FAQ sobre control horario:
  https://www.aepd.es/preguntas-frecuentes/3-proteccion-de-datos-en-el-ambito-laboral/FAQ-0311-es-necesario-el-consentimiento-del-trabajador-para-implantar-un-sistema-de-control-horario
- Como evidencia de que la negociación colectiva puede concretar el registro en 2026:
  III Convenio de centros y servicios veterinarios, BOE-A-2026-19605:
  https://www.boe.es/diario_boe/txt.php?id=BOE-A-2026-19605
  y Convenio de seguros/reaseguros, BOE-A-2026-16077:
  https://www.boe.es/buscar/doc.php?id=BOE-A-2026-16077

Conclusión operativa para PREPROD-01: el producto conserva como baseline inicio/fin diarios, conservación mínima
de cuatro años y disponibilidad; el tratamiento ordinario se apoya en obligación legal y exige información.
La empresa cliente sigue tratándose como responsable y Fichaje como encargado, sujeto a contrato del art. 28
y medidas del art. 32. El convenio/empresa concreta puede añadir reglas sobre pausas, trabajo efectivo,
incidencias, flexibilidad, accesibilidad y entrega; por eso PRE-01 se completa por cliente antes de producción.

Esta revisión no certifica el producto ni sustituye revisión jurídica independiente. No autoriza datos reales.
