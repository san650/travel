# Configuración de Google Cloud (una sola vez)

La app usa Google Drive como backend invisible para viajes compartidos.
Hace falta un proyecto de Google Cloud con tres credenciales públicas de
navegador (no hay secretos: nunca pongas un client secret en la PWA).

**La guía canónica para usuarios es `setup-google.html`** (linkeada desde el
modal «Conectar con Google» de la app). Este archivo es la versión corta
para desarrollo. Vigente para la consola 2026: la configuración OAuth vive
en **Google Auth Platform** (el viejo «OAuth consent screen» ya no existe
como tal).

## Pasos

1. https://console.cloud.google.com → selector de proyectos → **Proyecto
   nuevo** (p. ej. `travel-42uy`).
2. **Número de proyecto**: tarjeta «Información del proyecto» del panel de
   inicio, o ☰ → IAM y administración → Configuración.
3. **☰ → APIs y servicios → Biblioteca**: habilitar **Google Drive API** y
   **Google Picker API**.
4. **☰ → Google Auth Platform** → «Comenzar» (asistente inicial):
   - Información de la app: nombre + email de asistencia.
   - Público (Audience): **Externo** (no se puede cambiar después).
   - La app queda en modo **Prueba** (Testing); publicarla después es un
     botón sin revisión (paso 8).
5. **Google Auth Platform → Público → Usuarios de prueba → + Add users**:
   agregar tu email y el de cada amigo. (Un invitado fuera de esta lista ve
   «Error 403: access_denied».) Solo necesario mientras la app siga en
   modo Prueba.
6. **Google Auth Platform → Clientes → + Crear cliente**:
   - Tipo: **Aplicación web**.
   - Orígenes de JavaScript autorizados: `https://travel.42.uy` y
     `http://localhost:8765`.
   - URIs de redireccionamiento autorizados: `https://travel.42.uy/`,
     `https://travel.42.uy/index.html`, `http://localhost:8765/` y
     `http://localhost:8765/index.html` — la PWA instalada en iOS cae a un
     flujo implícito por redirección cuando el popup está bloqueado.
   → copiar el **Client ID** (`…apps.googleusercontent.com`).
7. **☰ → APIs y servicios → Credenciales → + Crear credenciales → Clave de
   API** → copiar la **API key** (`AIza…`). Recomendado restringirla:
   Sitios web (los dos orígenes) + Restricciones de API → Google Picker API.
8. **Publicar** (recomendado, cuando todo funcione): **Google Auth Platform
   → Público → Publicar aplicación** → confirmar. Inmediato y sin revisión
   de Google: `drive.file` es un scope **no sensible**, así que no hay
   verificación, ni tope de usuarios, ni aviso de «app no verificada».
   Beneficios: cualquier cuenta de Google puede conectarse (adiós lista de
   test users y 403), y desaparece la re-autorización cada 7 días del modo
   Prueba. La seguridad no cambia: siguen mandando los permisos de la
   carpeta en Drive.

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
