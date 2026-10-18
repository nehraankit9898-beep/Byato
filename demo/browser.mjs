/**
 * Shared Chromium launcher for the Byato demo recording.
 *
 * Uses @sparticuz/chromium (a self-contained Chromium build) so the demo can
 * be recorded on a headless server without a desktop session. The bundled
 * Amazon Linux shared libraries are extracted on first use and exposed via
 * LD_LIBRARY_PATH.
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const LIB_DIR = join(process.env.TMPDIR || "/tmp", "al2023", "lib");

/** Extract the Chromium runtime libraries (idempotent). */
function ensureLibs() {
  if (existsSync(join(LIB_DIR, "libnss3.so"))) return;
  const pkgDir = join(require.resolve("@sparticuz/chromium/package.json"), "..");
  const brotli = join(pkgDir, "bin", "al2023.tar.br");
  if (!existsSync(brotli)) return;
  mkdirSync(join(process.env.TMPDIR || "/tmp", "al2023"), { recursive: true });
  const zlib = require("node:zlib");
  const tar = zlib.brotliDecompressSync(readFileSync(brotli));
  const tarPath = join(process.env.TMPDIR || "/tmp", "al2023.tar");
  writeFileSync(tarPath, tar);
  execFileSync("tar", ["-xf", tarPath, "-C", join(process.env.TMPDIR || "/tmp", "al2023")]);
}

export async function launch() {
  ensureLibs();
  const chromium = (await import("@sparticuz/chromium")).default;
  const puppeteer = (await import("puppeteer-core")).default;
  const path = await chromium.executablePath();
  const libPath = existsSync(LIB_DIR) ? `${LIB_DIR}:${process.env.LD_LIBRARY_PATH || ""}` : process.env.LD_LIBRARY_PATH;

  return puppeteer.launch({
    executablePath: path,
    args: [
      // --single-process makes the browser die when a second target is created
      ...chromium.args.filter((a) => a !== "--single-process"),
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--force-device-scale-factor=1",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-color-profile=srgb",
      "--font-render-hinting=none",
    ],
    headless: true,
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    env: { ...process.env, LD_LIBRARY_PATH: libPath },
  });
}
