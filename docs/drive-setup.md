# Configuración de Google Cloud (una sola vez)

La app usa Google Drive como backend invisible para viajes compartidos.
Hace falta un proyecto de Google Cloud con tres credenciales públicas de
navegador (no hay secretos: nunca pongas un client secret en la PWA).

## Pasos

1. https://console.cloud.google.com → crear proyecto (p. ej. `travel-42uy`).
2. **APIs y servicios → Biblioteca**: habilitar
   - Google Drive API
   - Google Picker API
3. **Pantalla de consentimiento OAuth**:
   - Tipo de usuario: Externo. Estado: *Testing* alcanza para un grupo de
     amigos (hasta 100 test users; hay que agregar el email de cada amigo
     en "Test users").
   - Scope: `https://www.googleapis.com/auth/drive.file` (no restringido,
     no requiere verificación).
4. **Credenciales → Crear credenciales → ID de cliente OAuth**:
   - Tipo: Aplicación web.
   - Orígenes de JavaScript autorizados:
     - `https://travel.42.uy`
     - `http://localhost:8765`
   - Sin redirect URIs (se usa el flujo de token en el navegador).
   → copiar el **CLIENT_ID**.
5. **Credenciales → Crear credenciales → Clave de API**:
   - Restringirla a la Google Picker API y a los mismos orígenes.
   → copiar la **API_KEY**.
6. El **APP_ID** es el *número* de proyecto (Configuración del proyecto →
   Número del proyecto).

## Dónde van

La app los pide sola la primera vez que tocás «Compartir este viaje» (o al
abrir una invitación) y los guarda en IndexedDB del dispositivo. Para
corregirlos después: diálogo Compartir → «Configuración de Google…».

Opcionalmente se pueden dejar como defaults de build en las constantes de
`drive.js` (`CLIENT_ID` / `API_KEY` / `APP_ID`); lo guardado en el modal
pisa esos defaults.

Los tres valores son públicos por diseño; la autorización real la hacen
los permisos de Drive sobre la carpeta compartida.

## Spike Step 0 (antes de construir adjuntos)

`spike.html` verifica con dos cuentas que el permiso que otorga el Picker
sobre una carpeta cubre archivos creados después por otra persona
(limitación conocida del scope `drive.file`). Instrucciones dentro del
propio archivo. Si B4 falla, no construir la Fase E sin decidir fallback.
