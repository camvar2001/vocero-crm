# Chats web Century 21

## Recorrido del propietario

1. Con INMOB habilitado, abrir Buscador y Secretaria desde la navegación. Cada apartado muestra su nombre, descripción breve y su propio historial.
2. Enviar un mensaje con Enter. Shift+Enter agrega una línea. Durante la espera se anuncia el estado y no se permite un segundo envío concurrente.
3. Recargar y cambiar entre agentes. El historial del agente actual vuelve a consultarse y nunca aparece en el otro chat.
4. Distinguir un rechazo conocido de una respuesta incierta. Si se pierde la respuesta, consultar el estado vuelve a hacer GET; nunca reenvía el POST ni repite la acción.
5. Verificar que contenido del agente se trata como texto y que solo enlaces HTTP(S) se vuelven clicables con `rel="noopener noreferrer"`.
6. Repetir el recorrido a 390px de ancho y comprobar que el composer sigue usable sin desplazamiento horizontal.

## E2E con API simulada

`node scripts/e2e-inmob.mjs` empaqueta el componente de chat y usa Chromium contra un servidor HTTP efímero en memoria. El guion cubre carga accesible, teclado, respuesta pendiente, historial, aislamiento de agentes, rechazo conocido, incertidumbre sin reenvío, XSS, enlaces seguros y layout móvil. No inicia Next ni requiere sesión, PostgreSQL o n8n; los límites de autenticación, owner, flag apagada y tenant se validan en las pruebas de rutas de CI.
