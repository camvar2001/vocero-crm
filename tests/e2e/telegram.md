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
