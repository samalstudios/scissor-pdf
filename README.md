# Scissor PDF

Free PDF tools that run entirely in your browser. Merge, split, compress, sign, redact, convert and protect PDFs without uploading them anywhere.

**Live:** [pdf.scissor.studio](https://pdf.scissor.studio)

The PDF engine is written in Rust and compiled to WebAssembly. It runs in a web worker inside the visitor's tab, so documents are read from disk, processed in memory and saved back to disk. The site is plain static files: there is no backend, no upload endpoint and no analytics, and the Content Security Policy blocks the page from contacting any other origin.

## Tools

49 tools, each with its own page:

- **Organize:** Merge PDF, Split PDF, Organize PDF, Rotate PDF, Reverse PDF, Delete pages, Remove blank pages, Extract pages, Insert blank pages, Combine odd and even pages, Split PDF by size, Split PDF by bookmarks, Split PDF pages in half, Crop PDF, Resize PDF pages, Add margins to PDF, Pages per sheet, Booklet PDF
- **Optimize and convert:** Compress PDF, JPG to PDF, PNG to PDF, WebP to PDF, PDF to JPG, PDF to PNG, PDF to long image, PDF to Text, Extract images from PDF, Grayscale PDF, Remove images from PDF, Repair PDF
- **Edit and secure:** Sign PDF, Fill PDF form, Add text to PDF, Add image to PDF, Highlight PDF, Redact PDF, Page numbers, Add header and footer, Bates numbering, Watermark PDF, Logo watermark, Flatten PDF, Remove annotations, Protect PDF, Unlock PDF, PDF metadata
- **View and check:** PDF viewer, Compare PDF, PDF info

**The app** ([/app/](https://pdf.scissor.studio/app/)) puts every tool in one window: open several PDFs or a whole folder, apply any tool, undo any step, download one file or all of them. It installs as a PWA and, in Chrome and Edge, can open PDFs from the operating system.

Everything works offline after the first visit (service worker). The interface is available in 21 languages, including right-to-left Arabic, Persian and Sorani Kurdish.

## How it is built

```
engine/        Rust crate: every PDF operation (lopdf, image), exported with wasm-bindgen
site/
  tools.mjs    tool list: slug, icon, mode, related tools
  i18n/        all visible text, one JSON file per language (en.json is the source)
  assets/      app.js (UI), worker.js (runs the engine), app.css
  pages/       extra content pages
  public/      icons and social images
scripts/
  build.mjs    builds the engine and renders every page in every language into dist/
  i18n-check.mjs  validates translations against en.json
  assets.mjs   regenerates icons and social images (macOS)
```

- **Engine:** [lopdf](https://github.com/J-F-Liu/lopdf) for reading and writing PDFs; [image](https://github.com/image-rs/image) for re-encoding photos when compressing. Rendering (previews, PDF to JPG) uses [PDF.js](https://mozilla.github.io/pdf.js/).
- **Pages:** each tool and language gets a static, pre-rendered HTML page with its own title, description, `hreflang` alternates and JSON-LD, so search engines and AI crawlers see real content without running JavaScript.
- **No framework:** the UI is a single vanilla JavaScript module.

## Development

Requirements: Rust with the `wasm32-unknown-unknown` target, [`wasm-bindgen-cli`](https://rustwasm.github.io/wasm-bindgen/) matching the version in `engine/Cargo.lock`, Node.js 20+. `wasm-opt` (Binaryen) is optional and shrinks the engine.

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129
npm install
npm run build     # engine + site into dist/
npm run serve     # http://localhost:4173
```

`npm run build:site` skips the Rust build when only the site changed.

The engine can also be exercised natively on real files:

```bash
cd engine
cargo run --release --example cli -- merge out.pdf a.pdf b.pdf
```

## Translations

All text lives in `site/i18n/<code>.json`. To add a language, copy `en.json`, translate the values (keep every `{placeholder}` and HTML tag), set `meta`, add the code to `ORDER` in `scripts/build.mjs`, and run:

```bash
npm run check:i18n -- <code>
```

Keys missing from a translation fall back to English at build time.

## Self-hosting

`dist/` is a static site. Serve it from any web server; send the same Content Security Policy as the pages' meta tag, cache files with a `?v=` query for a long time, and serve `404.html` for unknown paths. Example for Caddy:

```
example.com {
    root * /srv/scissor-pdf
    encode zstd gzip
    header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self' blob: data:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'"
    @versioned expression {query.v} != ""
    header @versioned Cache-Control "public, max-age=31536000, immutable"
    file_server
    handle_errors {
        @missing expression {err.status_code} == 404
        rewrite @missing /404.html
        file_server
    }
}
```

The canonical domain is set in `site/tools.mjs` (`SITE.origin`).

## License

[MIT](LICENSE).

PDF.js is bundled under the Apache License 2.0; its license is copied into `dist/vendor/` at build time.
