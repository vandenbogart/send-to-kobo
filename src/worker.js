const KEY_CHARS = "23456789ACDEFGHJKLMNPRSTUVWXYZ";
const DEFAULT_KEY_LENGTH = 5;
const SESSION_TTL_SECONDS = 90;
const MAX_SESSION_SECONDS = 60 * 60;
const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const MAX_URLS_PER_SESSION = 10;
const R2_PREFIX = "sessions/";

const ALLOWED_EXTENSIONS = new Set([
  "azw",
  "azw3",
  "cbz",
  "cbr",
  "epub",
  "htm",
  "html",
  "kepub.epub",
  "mobi",
  "pdf",
  "txt"
]);

const ALLOWED_MIME_TYPES = new Set([
  "application/epub",
  "application/epub+zip",
  "application/octet-stream",
  "application/pdf",
  "application/vnd.amazon.ebook",
  "application/vnd.comicbook+zip",
  "application/vnd.comicbook-rar",
  "application/x-cbr",
  "application/x-cbz",
  "application/x-mobipocket-ebook",
  "application/x-rar-compressed",
  "application/zip",
  "text/html",
  "text/plain",
  ""
]);

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error(error);
      const message = status === 500 ? "Internal server error" : error.message;
      return textResponse(message, status);
    }
  },

  scheduled(event, env, ctx) {
    ctx.waitUntil(cleanupExpiredFiles(env));
  }
};

export async function handleRequest(request, env, ctx = {}) {
  const url = new URL(request.url);
  const pathname = normalizePath(url.pathname);
  const method = request.method.toUpperCase();
  const isReadMethod = method === "GET" || method === "HEAD";

  if (isReadMethod && pathname === "/style.css") {
    return maybeHead(method, cssResponse(STYLES));
  }

  if (isReadMethod && pathname === "/healthz") {
    return maybeHead(method, jsonResponse({ ok: true }));
  }

  if (isReadMethod && (pathname === "/" || pathname === "/send" || pathname === "/upload")) {
    const agent = getUserAgent(request);
    return maybeHead(method, htmlResponse(isEreader(agent) ? receivePage() : uploadPage()));
  }

  if (isReadMethod && pathname === "/receive") {
    return maybeHead(method, htmlResponse(receivePage()));
  }

  if (method === "POST" && pathname === "/generate") {
    assertBindings(env);
    return generateSession(request, env);
  }

  if (method === "POST" && pathname === "/upload") {
    assertBindings(env);
    return uploadToSession(request, env, ctx);
  }

  const statusMatch = pathname.match(/^\/status\/([A-Za-z0-9]+)$/);
  if (isReadMethod && statusMatch) {
    assertBindings(env);
    return maybeHead(method, await getSessionStatus(request, env, statusMatch[1]));
  }

  const deleteMatch = pathname.match(/^\/file\/([A-Za-z0-9]+)$/);
  if (method === "DELETE" && deleteMatch) {
    assertBindings(env);
    return deleteSessionFile(env, deleteMatch[1]);
  }

  const fileMatch = pathname.match(/^\/files\/([A-Za-z0-9]+)\/(.+)$/);
  if (isReadMethod && fileMatch) {
    assertBindings(env);
    return maybeHead(method, await downloadSessionFile(request, env, fileMatch[1], fileMatch[2]));
  }

  return textResponse("Not found", 404);
}

async function generateSession(request, env) {
  const agent = getUserAgent(request);
  const now = Date.now();
  const maxExpiresAt = now + MAX_SESSION_SECONDS * 1000;
  let key = "";

  for (let attempt = 0; attempt < 25; attempt += 1) {
    key = randomKey(DEFAULT_KEY_LENGTH);
    const existing = await getSession(env, key);
    if (!existing) break;
    key = "";
  }

  if (!key) {
    throw httpError(503, "Could not allocate a key");
  }

  const session = {
    key,
    agent,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
    maxExpiresAt: new Date(maxExpiresAt).toISOString(),
    file: null,
    urls: []
  };

  await putSession(env, session);

  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8"
  });
  headers.append("set-cookie", makeKeyCookie(key, request.url));

  return new Response(key, { headers });
}

async function uploadToSession(request, env, ctx) {
  const maxFileSize = readPositiveInteger(env.MAX_FILE_SIZE_BYTES, DEFAULT_MAX_FILE_SIZE_BYTES);
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength && contentLength > maxFileSize + 1024 * 1024) {
    throw httpError(413, `Upload is larger than the ${formatBytes(maxFileSize)} limit`);
  }

  const form = await request.formData();
  const key = normalizeKey(String(form.get("key") || ""));
  if (!key) throw httpError(400, "Missing key");

  let session = await getSession(env, key);
  if (!session || isPastMaxExpiry(session)) {
    throw httpError(404, `Unknown or expired key ${key}`);
  }

  session = refreshSession(session);

  const messages = [];
  const rawUrl = String(form.get("url") || "").trim();
  if (rawUrl) {
    const cleanUrl = normalizeSubmittedUrl(rawUrl);
    if (!session.urls.includes(cleanUrl)) {
      if (session.urls.length >= MAX_URLS_PER_SESSION) {
        throw httpError(400, "Too many URLs for this key");
      }
      session.urls.push(cleanUrl);
    }
    messages.push(`Added URL: ${cleanUrl}`);
  }

  const file = form.get("file");
  if (isUploadFile(file)) {
    const normalized = normalizeUploadedFile(file, session.agent, form);

    if (file.size > maxFileSize) {
      throw httpError(413, `File is larger than the ${formatBytes(maxFileSize)} limit`);
    }

    const objectKey = buildObjectKey(key, normalized.filename);
    const previousObjectKey = session.file && session.file.objectKey;

    await env.FILES.put(objectKey, file.stream(), {
      httpMetadata: {
        contentType: normalized.contentType,
        contentDisposition: contentDisposition(normalized.filename)
      },
      customMetadata: {
        sessionKey: key,
        filename: normalized.filename,
        uploadedAt: new Date().toISOString(),
        expiresAt: session.maxExpiresAt
      }
    });

    session.file = {
      objectKey,
      name: normalized.filename,
      size: file.size,
      type: normalized.contentType,
      uploadedAt: new Date().toISOString()
    };

    if (previousObjectKey && previousObjectKey !== objectKey) {
      waitUntil(ctx, env.FILES.delete(previousObjectKey));
    }

    messages.push(`Sent ${normalized.filename}`);
  }

  if (!messages.length) {
    throw httpError(400, "Choose a file or enter a URL");
  }

  await putSession(env, session);

  return htmlSnippetResponse(messages.join("<br>"));
}

async function getSessionStatus(request, env, rawKey) {
  const key = normalizeKey(rawKey);
  let session = await getSession(env, key);
  if (!session || isPastMaxExpiry(session)) {
    if (session && session.file && session.file.objectKey) {
      await env.FILES.delete(session.file.objectKey);
    }
    await deleteSession(env, key);
    return jsonResponse({ error: "Unknown key" }, 404);
  }

  if (!sameDevice(session.agent, getUserAgent(request))) {
    return jsonResponse({ error: "Device mismatch" }, 403);
  }

  session = refreshSession(session);
  await putSession(env, session);

  return jsonResponse({
    alive: session.updatedAt,
    file: session.file
      ? {
          name: session.file.name,
          size: session.file.size,
          url: `/files/${encodeURIComponent(key)}/${encodeURIComponent(session.file.name)}`
        }
      : null,
    urls: session.urls
  });
}

async function downloadSessionFile(request, env, rawKey, rawFilename) {
  const key = normalizeKey(rawKey);
  const requestedFilename = decodeURIComponent(rawFilename);
  let session = await getSession(env, key);

  if (!session || !session.file || isPastMaxExpiry(session)) {
    return textResponse("File not found", 404);
  }

  if (!sameDevice(session.agent, getUserAgent(request))) {
    return textResponse("Device mismatch", 403);
  }

  if (session.file.name !== requestedFilename) {
    return textResponse("File not found", 404);
  }

  session = refreshSession(session);
  await putSession(env, session);

  const object = await env.FILES.get(session.file.objectKey);
  if (!object) {
    return textResponse("File not found", 404);
  }

  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-disposition": contentDisposition(session.file.name),
    "content-type": session.file.type || "application/octet-stream"
  });

  if (typeof object.writeHttpMetadata === "function") {
    object.writeHttpMetadata(headers);
  }
  headers.set("content-disposition", contentDisposition(session.file.name));
  headers.set("content-type", session.file.type || headers.get("content-type") || "application/octet-stream");
  if (object.size !== undefined) headers.set("content-length", String(object.size));

  return new Response(object.body, { headers });
}

async function deleteSessionFile(env, rawKey) {
  const key = normalizeKey(rawKey);
  const session = await getSession(env, key);
  if (!session) throw httpError(404, `Unknown key ${key}`);

  if (session.file && session.file.objectKey) {
    await env.FILES.delete(session.file.objectKey);
  }
  session.file = null;
  await putSession(env, refreshSession(session));

  return textResponse("ok");
}

export async function cleanupExpiredFiles(env, now = Date.now()) {
  assertBindings(env);
  let cursor;
  let deleted = 0;

  do {
    const listed = await env.FILES.list({
      prefix: R2_PREFIX,
      cursor,
      limit: 1000
    });

    const removals = [];
    for (const object of listed.objects || []) {
      const expiresAt = Number(object.customMetadata && object.customMetadata.expiresAt);
      const uploadedAt = object.uploaded ? new Date(object.uploaded).getTime() : now;
      const fallbackExpiry = uploadedAt + MAX_SESSION_SECONDS * 1000;
      if ((expiresAt || fallbackExpiry) <= now) {
        removals.push(env.FILES.delete(object.key));
      }
    }

    if (removals.length) {
      await Promise.all(removals);
      deleted += removals.length;
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return deleted;
}

function normalizeUploadedFile(file, deviceAgent, form) {
  const originalName = sanitizeFilename(file.name || "ebook");
  const extension = extensionOf(originalName);
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw httpError(400, `Unsupported file extension: ${extension || "none"}`);
  }

  const contentType = normalizeMimeType(file.type, extension);
  if (!ALLOWED_MIME_TYPES.has(contentType)) {
    throw httpError(400, `Unsupported file type: ${file.type || "unknown"}`);
  }

  let filename = originalName;
  if (form.get("transliteration")) {
    filename = transliterateFilename(filename);
  }
  if (deviceAgent.includes("Kindle")) {
    filename = filename.replace(/[^\.\w\-"'\(\)]/g, "_");
  }

  return {
    filename: limitFilenameLength(sanitizeFilename(filename)),
    contentType
  };
}

function normalizeMimeType(type, extension) {
  if (extension === "epub" || extension === "kepub.epub") return "application/epub+zip";
  if (extension === "pdf") return "application/pdf";
  if (extension === "mobi") return "application/x-mobipocket-ebook";
  if (extension === "azw" || extension === "azw3") return "application/vnd.amazon.ebook";
  if (extension === "txt") return "text/plain";
  if (extension === "html" || extension === "htm") return "text/html";
  if (extension === "cbz") return "application/vnd.comicbook+zip";
  if (extension === "cbr") return "application/vnd.comicbook-rar";
  return String(type || "").toLowerCase();
}

function isUploadFile(value) {
  return value && typeof value === "object" && typeof value.name === "string" && typeof value.size === "number" && value.size > 0;
}

function normalizeSubmittedUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw httpError(400, "Enter a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw httpError(400, "Only http and https URLs are supported");
  }
  return parsed.toString();
}

function randomKey(length) {
  const output = [];
  const maxValid = Math.floor(256 / KEY_CHARS.length) * KEY_CHARS.length;

  while (output.length < length) {
    const bytes = new Uint8Array(length * 2);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= maxValid) continue;
      output.push(KEY_CHARS[byte % KEY_CHARS.length]);
      if (output.length === length) break;
    }
  }

  return output.join("");
}

async function getSession(env, rawKey) {
  const key = normalizeKey(rawKey);
  if (!key) return null;
  const value = await env.SESSIONS.get(sessionStorageKey(key));
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    await env.SESSIONS.delete(sessionStorageKey(key));
    return null;
  }
}

async function putSession(env, session) {
  const ttlSeconds = ttlForSession(session);
  await env.SESSIONS.put(sessionStorageKey(session.key), JSON.stringify(session), {
    expirationTtl: ttlSeconds
  });
}

async function deleteSession(env, rawKey) {
  await env.SESSIONS.delete(sessionStorageKey(rawKey));
}

function refreshSession(session) {
  const now = Date.now();
  const maxExpiresAt = new Date(session.maxExpiresAt).getTime();
  const expiresAt = Math.min(now + SESSION_TTL_SECONDS * 1000, maxExpiresAt);
  return {
    ...session,
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(expiresAt).toISOString()
  };
}

function ttlForSession(session) {
  const expiresAt = new Date(session.expiresAt).getTime();
  const seconds = Math.ceil((expiresAt - Date.now()) / 1000);
  return Math.max(60, seconds);
}

function isPastMaxExpiry(session) {
  return Date.now() >= new Date(session.maxExpiresAt).getTime();
}

function sessionStorageKey(rawKey) {
  return `session:${normalizeKey(rawKey)}`;
}

function normalizeKey(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
}

function buildObjectKey(key, filename) {
  return `${R2_PREFIX}${key}/${randomObjectId()}-${encodeURIComponent(filename)}`;
}

function randomObjectId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extensionOf(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".kepub.epub")) return "kepub.epub";
  const index = lower.lastIndexOf(".");
  return index === -1 ? "" : lower.slice(index + 1);
}

function sanitizeFilename(filename) {
  const cleaned = String(filename)
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
  if (!cleaned || cleaned === "." || cleaned === "..") return "ebook";
  return limitFilenameLength(cleaned);
}

function limitFilenameLength(filename) {
  if (filename.length <= 180) return filename;
  const extension = extensionOf(filename);
  const suffix = extension ? `.${extension}` : "";
  return `${filename.slice(0, 180 - suffix.length)}${suffix}`;
}

function transliterateFilename(filename) {
  return filename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_");
}

function contentDisposition(filename) {
  const fallback = transliterateFilename(filename).replace(/["\\]/g, "_");
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function sameDevice(expectedAgent, actualAgent) {
  return expectedAgent === actualAgent;
}

function isEreader(agent) {
  const lower = agent.toLowerCase();
  return lower.includes("kobo") || lower.includes("kindle") || lower.includes("tolino") || lower.includes("ereader");
}

function getUserAgent(request) {
  return request.headers.get("user-agent") || "";
}

function makeKeyCookie(key, requestUrl) {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return `key=${key}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; SameSite=Strict${secure}`;
}

function normalizePath(pathname) {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

function waitUntil(ctx, promise) {
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(promise);
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function assertBindings(env) {
  if (!env || !env.SESSIONS) throw httpError(500, "SESSIONS KV binding is not configured");
  if (!env.FILES) throw httpError(500, "FILES R2 binding is not configured");
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function textResponse(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      ...headers
    }
  });
}

function htmlSnippetResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8"
    }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function htmlResponse(body) {
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer"
    }
  });
}

function cssResponse(body) {
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=86400",
      "content-type": "text/css; charset=utf-8"
    }
  });
}

function maybeHead(method, response) {
  if (method !== "HEAD") return response;
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

function uploadPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Send to Kobo</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <h1>Send to Kobo</h1>
      <a class="navlink" href="/receive">E-reader page</a>
    </header>

    <section class="panel">
      <form id="uploadForm" action="/upload" method="post" enctype="multipart/form-data">
        <label class="field">
          <span>Key</span>
          <input id="keyInput" name="key" class="keyInput" inputmode="latin-prose" maxlength="5" pattern="[A-Za-z0-9]{5}" autocomplete="off" required>
        </label>

        <label class="field">
          <span>File</span>
          <input id="fileInput" name="file" type="file" accept=".azw,.azw3,.cbz,.cbr,.epub,.kepub.epub,.html,.htm,.mobi,.pdf,.txt,application/epub+zip,application/pdf,text/html,text/plain">
        </label>

        <label class="field">
          <span>URL</span>
          <input id="urlInput" name="url" type="url" autocomplete="off" placeholder="https://">
        </label>

        <label class="check">
          <input type="checkbox" name="transliteration" value="1">
          <span>ASCII filename</span>
        </label>

        <button class="primary" type="submit">Send</button>
      </form>
      <div id="fileMeta" class="meta"></div>
      <div id="status" class="status" role="status" aria-live="polite"></div>
    </section>
  </main>

  <script>
  (function () {
    var form = document.getElementById("uploadForm");
    var keyInput = document.getElementById("keyInput");
    var fileInput = document.getElementById("fileInput");
    var fileMeta = document.getElementById("fileMeta");
    var status = document.getElementById("status");

    keyInput.addEventListener("input", function () {
      keyInput.value = keyInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 5);
    }, false);

    fileInput.addEventListener("change", function () {
      var file = fileInput.files && fileInput.files[0];
      fileMeta.textContent = file ? file.name + " - " + Math.ceil(file.size / 1024) + " KB" : "";
    }, false);

    function show(message, mode) {
      status.className = "status " + (mode || "");
      status.innerHTML = message || "";
    }

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      show("Sending...", "pending");
      var request = new XMLHttpRequest();
      request.open("POST", form.action, true);
      request.upload.onprogress = function (event) {
        if (event.lengthComputable) {
          show("Sending... " + Math.round((event.loaded / event.total) * 100) + "%", "pending");
        }
      };
      request.onload = function () {
        show(request.responseText, request.status >= 200 && request.status < 300 ? "success" : "error");
      };
      request.onerror = function () {
        show("Upload failed", "error");
      };
      request.send(new FormData(form));
    }, false);
  }());
  </script>
</body>
</html>`;
}

function receivePage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Receive ebook</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body class="reader">
  <main class="shell">
    <header class="topbar">
      <h1>Receive</h1>
      <button id="newKey" class="secondary" type="button">New key</button>
    </header>

    <section class="panel readerPanel">
      <div class="label">Key</div>
      <div id="keyOutput" class="keyOutput">-----</div>
      <div id="readerStatus" class="meta">Waiting</div>
      <div id="downloads" class="downloads"></div>
      <div id="urls" class="downloads"></div>
    </section>

    <footer class="foot">
      <a id="sendUrl" href="/send">Upload page</a>
    </footer>
  </main>

  <script>
  (function () {
    var key = "";
    var pollTimer = null;
    var keyOutput = document.getElementById("keyOutput");
    var status = document.getElementById("readerStatus");
    var downloads = document.getElementById("downloads");
    var urls = document.getElementById("urls");
    var newKey = document.getElementById("newKey");
    var sendUrl = document.getElementById("sendUrl");

    sendUrl.href = window.location.protocol + "//" + window.location.host + "/send";
    sendUrl.textContent = sendUrl.href;

    function xhr(method, path, callback) {
      var request = new XMLHttpRequest();
      request.open(method, path, true);
      request.onload = function () { callback(request); };
      request.onerror = function () { callback(request); };
      request.send(null);
    }

    function clearDownloads() {
      downloads.innerHTML = "";
      urls.innerHTML = "";
    }

    function render(data) {
      clearDownloads();
      if (data.file) {
        var link = document.createElement("a");
        link.className = "downloadLink";
        link.href = data.file.url;
        link.textContent = data.file.name;
        downloads.appendChild(link);
        status.textContent = "Ready";
      } else {
        status.textContent = "Waiting";
      }

      if (data.urls && data.urls.length) {
        for (var i = 0; i < data.urls.length; i += 1) {
          var item = document.createElement("a");
          item.className = "downloadLink";
          item.href = data.urls[i];
          item.textContent = data.urls[i];
          urls.appendChild(item);
        }
      }
    }

    function poll() {
      if (!key) return;
      xhr("GET", "/status/" + encodeURIComponent(key), function (request) {
        if (request.status !== 200) {
          key = "";
          keyOutput.textContent = "-----";
          status.textContent = "Expired";
          clearDownloads();
          if (pollTimer) window.clearInterval(pollTimer);
          return;
        }
        try {
          render(JSON.parse(request.responseText));
        } catch (error) {
          status.textContent = "Error";
        }
      });
    }

    function generate() {
      clearDownloads();
      keyOutput.textContent = "-----";
      status.textContent = "Waiting";
      if (pollTimer) window.clearInterval(pollTimer);
      xhr("POST", "/generate", function (request) {
        if (request.status === 200) {
          key = request.responseText;
          keyOutput.textContent = key;
          pollTimer = window.setInterval(poll, 5000);
          poll();
        } else {
          status.textContent = "Error";
        }
      });
    }

    newKey.onclick = generate;
    generate();
  }());
  </script>
</body>
</html>`;
}

const STYLES = `
html {
  box-sizing: border-box;
}

*, *:before, *:after {
  box-sizing: inherit;
}

body {
  margin: 0;
  background: #f4f1ea;
  color: #181818;
  font-family: Georgia, "Times New Roman", serif;
  line-height: 1.4;
}

a {
  color: #174f74;
}

.shell {
  width: min(720px, 100%);
  margin: 0 auto;
  padding: 24px 18px;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

h1 {
  margin: 0;
  font-size: 34px;
  font-weight: 400;
  letter-spacing: 0;
}

.panel {
  background: #fffdfa;
  border: 1px solid #cfc6b6;
  border-radius: 8px;
  padding: 18px;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.04);
}

.field {
  display: block;
  margin-bottom: 16px;
}

.field span,
.label {
  display: block;
  margin-bottom: 6px;
  color: #545047;
  font-size: 15px;
}

input[type="text"],
input[type="url"],
input[type="file"],
.keyInput {
  width: 100%;
  border: 1px solid #aaa292;
  border-radius: 6px;
  background: #ffffff;
  color: #111111;
  font: inherit;
  padding: 12px;
}

.keyInput {
  max-width: 220px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 34px;
  text-align: center;
  text-transform: uppercase;
  letter-spacing: 0;
}

.check {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 6px 0 18px;
}

button,
.primary,
.secondary,
.navlink,
.downloadLink {
  appearance: none;
  border: 1px solid #1d5e75;
  border-radius: 6px;
  background: #1d5e75;
  color: #ffffff;
  cursor: pointer;
  display: inline-block;
  font: inherit;
  min-height: 44px;
  padding: 10px 16px;
  text-align: center;
  text-decoration: none;
}

.secondary,
.navlink {
  background: #ffffff;
  color: #1d5e75;
}

button:focus,
a:focus,
input:focus {
  outline: 3px solid #d08b25;
  outline-offset: 2px;
}

.primary {
  width: 100%;
  font-size: 18px;
}

.meta {
  color: #5e5a50;
  min-height: 24px;
  margin-top: 12px;
}

.status {
  min-height: 24px;
  margin-top: 14px;
  padding: 12px;
  border-radius: 6px;
  display: none;
}

.status.pending,
.status.success,
.status.error {
  display: block;
}

.status.pending {
  background: #eef3f5;
  border: 1px solid #b6ccd6;
}

.status.success {
  background: #edf6ec;
  border: 1px solid #9fc99a;
}

.status.error {
  background: #fbefec;
  border: 1px solid #d49b90;
}

.reader .shell {
  max-width: 620px;
}

.readerPanel {
  text-align: center;
}

.keyOutput {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: clamp(54px, 16vw, 96px);
  line-height: 1;
  margin: 12px 0 8px;
  letter-spacing: 0;
  overflow-wrap: anywhere;
}

.downloads {
  margin-top: 14px;
}

.downloadLink {
  width: 100%;
  margin-top: 10px;
  overflow-wrap: anywhere;
}

.foot {
  margin-top: 18px;
  text-align: center;
  overflow-wrap: anywhere;
}

@media (max-width: 520px) {
  .shell {
    padding: 16px 12px;
  }

  .topbar {
    align-items: stretch;
    flex-direction: column;
  }

  .navlink,
  .secondary {
    width: 100%;
  }
}
`;
