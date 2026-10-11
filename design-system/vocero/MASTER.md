# VOCERO — Liquid Glass esmerilado

2026-10-11. Resultado de ui-ux-pro-max (Liquid Glass + Glassmorphism) adaptado al CRM y a la marca vigente. Spec: `/Users/camvar/Documents/ChatGPT/VOCERO/specs/003-liquid-glass/spec.md`.

## Material

Cristal esmerilado, fondos atmosféricos estáticos, borde luminoso fino, radios 12/16/24px y reflejos internos. Blur de fondo 24px (panel), 20px (barra), 32px (overlay). Saturación moderada 135%. No desenfocar texto; no animar filtros. Sidebar navy translúcido con la misma geometría del espacio principal. Sombras suaves, sin halos intensos ni refracción que distorsione lectura.

## Marca y legibilidad

Conservar el acento white-label actual, Archivo para UI, Instrument Serif para titulares editoriales e IBM Plex Mono para etiquetas. Fuentes self-hosted. Tokens de estado semánticos conservados. Texto de lectura mínimo AA4.5:1 sobre fondo compuesto; foco visible. Botones primarios con acento sólido y reflejo ligero para conservar contraste.

## Alcance

Login/registro, sidebar/barra móvil, bandeja/hilo/compositor, Pipeline, Calendario, Buscador, Secretaria, Contactos, Resultados, Agente, Laboratorio, Ajustes, tarjetas, formularios, menús/diálogos/cajones. Usar material compartido; filas y celdas densas heredan el panel sin filtro individual.

## Movimiento, soporte y responsive

Transiciones 180–220ms de color/sombra, sin animar blur. Respetar reduced-motion; superficie opaca para reduced-transparency, forced-colors y navegadores sin backdrop-filter. Móvil sin margen externo innecesario; escritorio marco de 12px y paneles flotantes. Revisar 375/768/1440px, foco y composición de capas sticky.
