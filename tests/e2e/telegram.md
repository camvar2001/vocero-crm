# E2E de Telegram UI con API simulada

Ejecutar desde `source/vocero-crm`:

```sh
node scripts/e2e-telegram.mjs
```

El script empaqueta los componentes reales de ajustes Telegram, composer, hilo y panel de contacto, y los monta en un servidor HTTP efímero en `127.0.0.1`. Las rutas HTTP son fixtures en memoria. No arranca Next, no lee `.env`, no usa sesión/DB, no activa el poller y no contacta Telegram ni servicios externos. Requiere las dependencias ya instaladas del proyecto y Chrome o Chromium ya disponible; no instala navegadores.

La prueba verifica:

- Estado inicial desconectado, contadores y acceso de propietario denegado.
- Limpieza del campo de token tras guardar y ausencia del token en el DOM/respuestas mock.
- Guardado sin conexión automática, allowlist decimal y conexión/detención explícitas.
- Revocación visual y desconexión.
- Aviso de entrega incierta, controles de medios ocultos y límite de 4096 puntos de código.
- Reintento de envío fallido conservando el mismo `actionId`.
- Acción de “Reactivar IA” desde el panel de contacto.
- Requests limitados al servidor local del harness.

La prueba de 403 verifica el manejo visual de un rechazo simulado. Autorización, persistencia, token cifrado y polling se validan aparte mediante pruebas unitarias/integración del backend.

## Integración con PostgreSQL aislado

`scripts/e2e-telegram-server.ts` ejercita las funciones reales de credenciales, ingestión y entrega contra la base `postgres` del compose aislado. El fixture usa organización, IDs y token sintéticos; reemplaza `global.fetch` para permitir solo el `sendMessage` de Telegram del fixture y bloquear cualquier otro destino. No inicia Next, poller ni pipeline de IA.

Compilar dentro del checkout:

```sh
pnpm exec esbuild scripts/e2e-telegram-server.ts --bundle --platform=node --format=esm --alias:@=./src --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);" --outfile=/tmp/telegram-e2e-server.mjs
```

Copiar el bundle a `/tmp` del servicio de aplicación del compose **aislado** y ejecutar allí con `TELEGRAM_E2E_ISOLATED=1 CHANNELS=telegram`. Requiere `DATABASE_URL` con hostname exactamente `postgres` y la clave de cifrado configurada para esa base. El arnés falla cerrado si no se cumplen esas condiciones.

No ejecutar este arnés con una base activa de usuario, piloto, desarrollo compartido o producción. Antes de correrlo, confirma que el servicio `postgres` es el fixture aislado y que la app no comparte una red o volumen con una instalación activa. El script borra únicamente la organización aleatoria que crea; ante un error de limpieza, inspecciona solo esa base aislada.
