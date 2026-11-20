---
name: reparar-extractor
description: Cómo reparar un extractor de car_registrations y poner al día su data en tesla-data. Usar al trabajar en cualquier país pendiente de docs/estado-extractores.md.
---

# Reparar un extractor

**Objetivo del proyecto:** los extractores dejaron de ejecutarse por meses. Hay que reparar cada uno y recuperar la data faltante en `tesla-data`, validada contra la fuente original.

Estado por país: `docs/estado-extractores.md`. Trabajar en un país pendiente, o en el que indique el usuario.

## 0. Entorno

- Ejecutar con `TESLA_DATA_LOCAL_PATH=../tesla-data TS_NODE_TRANSPILE_ONLY=1 TS_NODE_PROJECT=apps/extractor/tsconfig.app.json`. La ruta debe ser relativa: si es absoluta, escribe dentro del repo.
- Trabajar sobre una copia de tesla-data hasta tener todo validado.
- Para regenerar los CSV, usar `reindex()`. `save()` agrega al final y desordena los meses.

## 1. ¿Qué falta?

- Revisar los meses en el CSV y en `_/<fuente>/`: huecos y último mes.
- Buscar en la fuente el último mes publicado.

## 2. Descargar con el código actual

- Llamar `download(new MonthDateId(año, mes))` para cada mes faltante.
- Si funciona, ir al paso 4.
- Si devuelve `null` o falla, ir al paso 3.

## 3. Si falla `download`

- Abrir la página y ver qué cambió. Casos típicos:
  - HTML o selectores distintos;
  - texto de botones distinto;
  - nombre de archivo distinto;
  - la lista solo muestra los meses recientes;
  - el sitio se cuelga.
- Arreglar para que funcione con el último mes y, si es posible, con cualquier fecha.
- Si el mes no está publicado, debe devolver `null`, no fallar.
- Si el sitio es inestable: User-Agent de navegador, reintentos y verificar que el archivo llegó completo.

## 4. Validar `download`

- Descargar todos los meses con el código final.
- Los meses que ya están en el repo deben ser idénticos byte a byte.
- Cada archivo nuevo debe:
  - decir en su contenido el mes y año correctos;
  - tener el mismo tipo y estructura que los anteriores;
  - no estar duplicado (hash distinto).
- El mes siguiente al último publicado devuelve `null`.

## 5. Validar `transform`

- Correr `reindex` en la copia: los meses existentes deben quedar idénticos byte a byte.
- Leer la fuente con otra herramienta en Python (`pdftotext`, `openpyxl`, `xlrd`) y comparar cada fila del CSV.
- Cuadrar los totales y subtotales de la fuente.
- Si hay diferencias, buscar la causa (filas perdidas, filas basura, cambio de formato) y arreglar `transform` sin cambiar los meses que ya están bien.

## 6. Antes de cambiar código o data

Reportar al usuario qué falta, qué falla y la propuesta, y esperar aprobación.

## 7. PRs

- Rama nueva desde `main`.
- Un PR de extractor y otro de data (archivos nuevos y CSV regenerado), con los números de la validación.
- En el PR del extractor, actualizar la fila del país en `docs/estado-extractores.md`.
- No mergear sin autorización.

## Reglas

- Conservar las cifras publicadas por la fuente.
- Los hallazgos no corregidos van en `car_registrations/countries/<país>/NOTES.md`, en tesla-data.
