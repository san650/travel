// Google Drive como backend invisible. Todo se carga perezosamente: ni el
// script de Google Identity ni el Picker se piden hasta que el usuario toca
// una acción de compartir/sincronizar, así el arranque sigue siendo 100%
// offline. Los tokens duran ~1 h y no se pueden persistir en un PWA sin
// backend: toda operación de red tolera re-autorización, y la autorización
// solo se dispara desde un gesto del usuario (popups).

import { loadDriveConfig, saveDriveConfig } from './db.js';

// Config — crear en Google Cloud Console (ver docs/drive-setup.md):
// OAuth client ID (Web), API key de navegador y número de proyecto.
// Estos valores son defaults opcionales de build; lo que el usuario carga
// en el modal de configuración (persistido en IndexedDB) los pisa.
const CLIENT_ID = '';
const API_KEY = '';
const APP_ID = '';

const config = { clientId: CLIENT_ID, apiKey: API_KEY, appId: APP_ID };
let configLoaded = false;

export const loadConfig = async () => {
  if (!configLoaded) {
    configLoaded = true;
    try {
      const saved = await loadDriveConfig();
      if (saved) {
        for (const k of ['clientId', 'apiKey', 'appId']) {
          if (saved[k]) config[k] = saved[k];
        }
      }
    } catch (err) {
      console.error('drive config load failed', err);
    }
  }
  return { ...config };
};

export const setConfig = async ({ clientId, apiKey, appId }) => {
  config.clientId = (clientId ?? '').trim();
  config.apiKey = (apiKey ?? '').trim();
  config.appId = (appId ?? '').trim();
  configLoaded = true;
  tokenClient = null; // recrear el token client con el nuevo client id
  accessToken = null;
  expiresAt = 0;
  await saveDriveConfig({ ...config });
};

export const getConfig = () => ({ ...config });

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export class DriveError extends Error {
  constructor(message, { status = 0, code = 'DRIVE_ERROR' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const isConfigured = () => Boolean(config.clientId);
export const isPickerConfigured = () => Boolean(config.apiKey && config.appId);

const scriptPromises = new Map();
const loadScript = (src) => {
  if (!scriptPromises.has(src)) {
    scriptPromises.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        scriptPromises.delete(src);
        reject(new DriveError('No se pudo cargar Google. ¿Estás sin conexión?', { code: 'OFFLINE' }));
      };
      document.head.appendChild(s);
    }));
  }
  return scriptPromises.get(src);
};

let tokenClient = null;
let accessToken = null;
let expiresAt = 0;

const ensureGsi = async () => {
  await loadConfig();
  if (!isConfigured()) {
    throw new DriveError('Falta la configuración de Google.', { code: 'NOT_CONFIGURED' });
  }
  await loadScript('https://accounts.google.com/gsi/client');
  if (!window.google?.accounts?.oauth2) {
    throw new DriveError('Google Identity no está disponible.', { code: 'GSI_UNAVAILABLE' });
  }
  if (!tokenClient) {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: config.clientId,
      scope: SCOPE,
      callback: () => {},
    });
  }
};

export const authorize = async ({ prompt = '' } = {}) => {
  await ensureGsi();
  return new Promise((resolve, reject) => {
    tokenClient.callback = (response) => {
      if (response.error) {
        reject(new DriveError(response.error_description || response.error, { code: 'AUTH_FAILED' }));
        return;
      }
      accessToken = response.access_token;
      expiresAt = Date.now() + Number(response.expires_in || 3600) * 1000;
      resolve(response);
    };
    tokenClient.error_callback = (error) => {
      reject(new DriveError(error?.message || 'Autorización cancelada.', { code: 'AUTH_FAILED' }));
    };
    tokenClient.requestAccessToken({ prompt });
  });
};

export const hasToken = () => Boolean(accessToken) && Date.now() < expiresAt - 60_000;

const ensureToken = async () => {
  if (hasToken()) return;
  await authorize({ prompt: '' });
};

const request = async (url, options = {}) => {
  await ensureToken();
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${accessToken}`);
  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch {
    throw new DriveError('Sin conexión.', { code: 'OFFLINE' });
  }
  if (response.status === 401) {
    accessToken = null;
    expiresAt = 0;
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new DriveError(`Google Drive (${response.status}): ${body.slice(0, 300)}`, {
      status: response.status,
      code: response.status === 404 || response.status === 403 ? 'NO_ACCESS' : 'DRIVE_ERROR',
    });
  }
  return response;
};

// ---------- archivos ----------

const multipartBody = (metadata, content, contentType) => {
  const boundary = `travel42uy-${crypto.randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    content,
    `\r\n--${boundary}--`,
  ]);
  return { body, contentType: `multipart/related; boundary=${boundary}` };
};

const FILE_FIELDS = 'id,name,mimeType,version,modifiedTime,capabilities,trashed,parents';

// writersCanShare: false en todo lo que crea la app: los escritores editan
// pero solo el dueño puede invitar o cambiar permisos (equivale a destildar
// «Los editores pueden cambiar permisos y compartir» en la UI de Drive).
export const createFolder = async (name) => {
  const res = await request(`${API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, writersCanShare: false }),
  });
  return res.json();
};

export const createJsonFile = async ({ name, parentId, data }) => {
  const metadata = {
    name,
    mimeType: 'application/json',
    parents: parentId ? [parentId] : undefined,
    appProperties: { application: 'travel-42uy' },
    writersCanShare: false,
  };
  const { body, contentType } = multipartBody(metadata, JSON.stringify(data, null, 2), 'application/json; charset=UTF-8');
  const res = await request(
    `${UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`,
    { method: 'POST', headers: { 'Content-Type': contentType }, body },
  );
  return res.json();
};

export const updateJsonFile = async ({ fileId, data }) => {
  const res = await request(
    `${UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=${encodeURIComponent(FILE_FIELDS)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(data, null, 2),
    },
  );
  return res.json();
};

export const getMetadata = async (fileId) => {
  const res = await request(
    `${API}/files/${encodeURIComponent(fileId)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
  );
  return res.json();
};

export const readJsonFile = async (fileId) => {
  const [metadata, contentRes] = await Promise.all([
    getMetadata(fileId),
    request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`),
  ]);
  return { metadata, data: await contentRes.json() };
};

export const listChildren = async (folderId, { name } = {}) => {
  const q = [`'${folderId}' in parents`, 'trashed = false'];
  if (name) q.push(`name = '${name.replaceAll("'", "\\'")}'`);
  const params = new URLSearchParams({
    q: q.join(' and '),
    fields: `files(${FILE_FIELDS})`,
    pageSize: '100',
  });
  const res = await request(`${API}/files?${params}`);
  return (await res.json()).files ?? [];
};

// ---------- adjuntos ----------

export const uploadFile = async ({ name, parentId, blob, mimeType }) => {
  const metadata = { name, parents: parentId ? [parentId] : undefined, writersCanShare: false };
  const { body, contentType } = multipartBody(metadata, blob, mimeType || blob.type || 'application/octet-stream');
  const res = await request(
    `${UPLOAD_API}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}`,
    { method: 'POST', headers: { 'Content-Type': contentType }, body },
  );
  return res.json();
};

export const downloadFile = async (fileId) => {
  const res = await request(`${API}/files/${encodeURIComponent(fileId)}?alt=media`);
  return res.blob();
};

export const deleteFile = async (fileId) => {
  await request(`${API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
};

// ---------- permisos ----------

export const shareWith = async ({ fileId, emailAddress, role = 'writer' }) => {
  if (!['reader', 'writer'].includes(role)) throw new DriveError('Rol inválido.');
  const params = new URLSearchParams({
    sendNotificationEmail: 'true',
    fields: 'id,type,role,emailAddress,displayName',
  });
  const res = await request(
    `${API}/files/${encodeURIComponent(fileId)}/permissions?${params}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'user', role, emailAddress }),
    },
  );
  return res.json();
};

export const listPermissions = async (fileId) => {
  const params = new URLSearchParams({
    fields: 'permissions(id,type,role,emailAddress,displayName,deleted)',
  });
  const res = await request(`${API}/files/${encodeURIComponent(fileId)}/permissions?${params}`);
  return (await res.json()).permissions ?? [];
};

export const removePermission = async ({ fileId, permissionId }) => {
  await request(
    `${API}/files/${encodeURIComponent(fileId)}/permissions/${encodeURIComponent(permissionId)}`,
    { method: 'DELETE' },
  );
};

// ---------- Picker (recuperación / flujo de invitación) ----------
// Con el scope drive.file, un colaborador NO puede abrir un archivo por ID
// aunque Drive se lo haya compartido: la app recién obtiene acceso cuando el
// usuario lo elige explícitamente con el Picker. Devuelve el doc elegido o
// null si canceló.

export const pickSharedFolder = async () => {
  await loadConfig();
  if (!isPickerConfigured()) {
    throw new DriveError('Falta la clave del selector (API key y número de proyecto).', { code: 'NOT_CONFIGURED' });
  }
  await ensureToken();
  await loadScript('https://apis.google.com/js/api.js');
  await new Promise((resolve, reject) => {
    gapi.load('picker', { callback: resolve, onerror: () => reject(new DriveError('No se pudo cargar el selector.')) });
  });
  return new Promise((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setOwnedByMe(false);
    const picker = new google.picker.PickerBuilder()
      .setOAuthToken(accessToken)
      .setDeveloperKey(config.apiKey)
      .setAppId(config.appId)
      .addView(view)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) resolve(data.docs?.[0] ?? null);
        else if (data.action === google.picker.Action.CANCEL) resolve(null);
      })
      .build();
    picker.setVisible(true);
  });
};
