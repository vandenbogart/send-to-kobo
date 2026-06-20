# Send to Kobo

A Cloudflare-hosted e-reader handoff app inspired by [daniel-j/send2ereader](https://github.com/daniel-j/send2ereader).

Open `/receive` on a Kobo, Kindle, Tolino, or other e-reader browser to get a short key. Open `/send` on another device, enter the key, and send an ebook file or URL. The reader page polls for the key and exposes the download link when the upload arrives.

## What is different from send2ereader

- Runs as a Cloudflare Worker instead of a long-running Node server.
- Uses Workers KV for short-lived key/session state.
- Uses R2 for uploaded file storage.
- Sends files as-is. Workers cannot run external binaries such as `kepubify`, `kindlegen`, or `pdfCropMargins`.
- Stores session metadata for about 90 seconds after the reader stops polling. Uploaded objects are inaccessible after the session expires and are cleaned by a scheduled Worker, with a hard one-hour maximum.

## Local development

```sh
npm install
npm run dev
```

Then open:

- `http://localhost:8787/receive` for the e-reader view
- `http://localhost:8787/send` for the upload view

## Deploy to Cloudflare

This project is configured to deploy at:

- `https://kobo.nuc.ink`
- `https://send.nuc.ink`

```sh
npm run deploy
```

The `wrangler.toml` uses Cloudflare's automatic provisioning for KV and R2 bindings, so Wrangler can create the required resources on first deploy and write their IDs back into the config. If your account does not have automatic provisioning enabled, create them manually and add the IDs/bucket names to `wrangler.toml`:

```sh
npx wrangler kv namespace create SESSIONS
npx wrangler r2 bucket create send-to-kobo-files
```

Manual binding shape:

```toml
[[kv_namespaces]]
binding = "SESSIONS"
id = "your-kv-namespace-id"

[[r2_buckets]]
binding = "FILES"
bucket_name = "send-to-kobo-files"
```

## Configuration

`MAX_FILE_SIZE_BYTES` defaults to 100 MB in `wrangler.toml`. Keep it below the request size limit for your Cloudflare plan.

Allowed file extensions:

`azw`, `azw3`, `cbz`, `cbr`, `epub`, `kepub.epub`, `html`, `htm`, `mobi`, `pdf`, `txt`.

## Test

```sh
npm test
```
