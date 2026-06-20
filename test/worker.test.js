import { describe, expect, it } from "vitest";
import worker, { cleanupExpiredFiles } from "../src/worker.js";

describe("send-to-kobo worker", () => {
  it("serves page headers for HEAD probes", async () => {
    const env = testEnv();
    const response = await dispatch(new Request("https://example.test/send", { method: "HEAD" }), env);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    await expect(response.text()).resolves.toBe("");
  });

  it("creates a reader-bound key and rejects other user agents for status", async () => {
    const env = testEnv();
    const response = await dispatch(
      new Request("https://example.test/generate", {
        method: "POST",
        headers: { "user-agent": "Kobo Touch" }
      }),
      env
    );

    expect(response.status).toBe(200);
    const key = await response.text();
    expect(key).toMatch(/^[23456789ACDEFGHJKLMNPRSTUVWXYZ]{5}$/);

    const status = await dispatch(
      new Request(`https://example.test/status/${key}`, {
        headers: { "user-agent": "Kobo Touch" }
      }),
      env
    );
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ file: null, urls: [] });

    const mismatch = await dispatch(
      new Request(`https://example.test/status/${key}`, {
        headers: { "user-agent": "Desktop Browser" }
      }),
      env
    );
    expect(mismatch.status).toBe(403);
  });

  it("uploads an ebook to a key and serves it back to the reader", async () => {
    const env = testEnv();
    const key = await createKey(env, "Kobo Clara");

    const form = new FormData();
    form.set("key", key);
    form.set("file", new File(["hello ebook"], "My Book.epub", { type: "application/epub+zip" }));

    const upload = await dispatch(
      new Request("https://example.test/upload", {
        method: "POST",
        body: form,
        headers: { "user-agent": "Desktop Browser" }
      }),
      env,
      waitContext()
    );

    expect(upload.status).toBe(200);
    await expect(upload.text()).resolves.toContain("Sent My Book.epub");

    const status = await dispatch(
      new Request(`https://example.test/status/${key}`, {
        headers: { "user-agent": "Kobo Clara" }
      }),
      env
    );
    const data = await status.json();
    expect(data.file).toMatchObject({ name: "My Book.epub", size: 11 });

    const download = await dispatch(
      new Request(`https://example.test${data.file.url}`, {
        headers: { "user-agent": "Kobo Clara" }
      }),
      env
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-disposition")).toContain("My Book.epub");
    await expect(download.text()).resolves.toBe("hello ebook");
  });

  it("shares URLs without requiring a file", async () => {
    const env = testEnv();
    const key = await createKey(env, "Kindle");

    const form = new FormData();
    form.set("key", key);
    form.set("url", "https://example.com/article");

    const upload = await dispatch(
      new Request("https://example.test/upload", {
        method: "POST",
        body: form,
        headers: { "user-agent": "Desktop Browser" }
      }),
      env
    );
    expect(upload.status).toBe(200);

    const status = await dispatch(
      new Request(`https://example.test/status/${key}`, {
        headers: { "user-agent": "Kindle" }
      }),
      env
    );
    await expect(status.json()).resolves.toMatchObject({
      urls: ["https://example.com/article"]
    });
  });

  it("rejects unsupported file extensions", async () => {
    const env = testEnv();
    const key = await createKey(env, "Kobo Libra");
    const form = new FormData();
    form.set("key", key);
    form.set("file", new File(["nope"], "script.js", { type: "text/javascript" }));

    const response = await dispatch(
      new Request("https://example.test/upload", {
        method: "POST",
        body: form
      }),
      env
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain("Unsupported file extension");
  });

  it("cleans expired R2 objects", async () => {
    const env = testEnv();
    await env.FILES.put("sessions/OLD/file.epub", "old", {
      customMetadata: { expiresAt: String(Date.now() - 1000) }
    });
    await env.FILES.put("sessions/NEW/file.epub", "new", {
      customMetadata: { expiresAt: String(Date.now() + 60_000) }
    });

    const deleted = await cleanupExpiredFiles(env);

    expect(deleted).toBe(1);
    await expect(env.FILES.get("sessions/OLD/file.epub")).resolves.toBeNull();
    await expect(env.FILES.get("sessions/NEW/file.epub")).resolves.not.toBeNull();
  });
});

async function createKey(env, agent) {
  const response = await dispatch(
    new Request("https://example.test/generate", {
      method: "POST",
      headers: { "user-agent": agent }
    }),
    env
  );
  return response.text();
}

function dispatch(request, env, ctx) {
  return worker.fetch(request, env, ctx || waitContext());
}

function testEnv() {
  return {
    SESSIONS: new MemoryKV(),
    FILES: new MemoryR2(),
    MAX_FILE_SIZE_BYTES: "104857600"
  };
}

function waitContext() {
  return {
    waitUntil(promise) {
      return promise;
    }
  };
}

class MemoryKV {
  constructor() {
    this.map = new Map();
  }

  async get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key, value, options = {}) {
    this.map.set(key, {
      value,
      expiresAt: options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null
    });
  }

  async delete(key) {
    this.map.delete(key);
  }
}

class MemoryR2 {
  constructor() {
    this.map = new Map();
  }

  async put(key, value, options = {}) {
    const bytes = await toBytes(value);
    this.map.set(key, {
      key,
      bytes,
      size: bytes.byteLength,
      uploaded: new Date(),
      httpMetadata: options.httpMetadata || {},
      customMetadata: options.customMetadata || {}
    });
  }

  async get(key) {
    const entry = this.map.get(key);
    if (!entry) return null;
    return {
      key: entry.key,
      size: entry.size,
      uploaded: entry.uploaded,
      customMetadata: entry.customMetadata,
      httpMetadata: entry.httpMetadata,
      body: new Blob([entry.bytes]).stream(),
      writeHttpMetadata(headers) {
        if (entry.httpMetadata.contentType) headers.set("content-type", entry.httpMetadata.contentType);
        if (entry.httpMetadata.contentDisposition) headers.set("content-disposition", entry.httpMetadata.contentDisposition);
      }
    };
  }

  async delete(key) {
    this.map.delete(key);
  }

  async list({ prefix = "", cursor, limit = 1000 } = {}) {
    const keys = Array.from(this.map.keys()).filter((key) => key.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const selected = keys.slice(start, start + limit);
    return {
      objects: selected.map((key) => {
        const entry = this.map.get(key);
        return {
          key,
          size: entry.size,
          uploaded: entry.uploaded,
          customMetadata: entry.customMetadata
        };
      }),
      truncated: start + limit < keys.length,
      cursor: String(start + limit)
    };
  }
}

async function toBytes(value) {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (value && typeof value.arrayBuffer === "function") {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (value && typeof value.getReader === "function") {
    return new Uint8Array(await new Response(value).arrayBuffer());
  }
  throw new TypeError("Unsupported R2 test body");
}
