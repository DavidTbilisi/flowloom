// build-tutorial.mjs — turn a tutorial spec into a narrated MP4 of the live app.
//
// Pipeline per tutorial:
//   1. edge-tts synthesizes one MP3 per narration segment (offline neural voice).
//   2. Playwright drives the live flowloom app, performing each segment's visual
//      action then holding for that segment's audio duration → records one .webm.
//   3. A narration track is concatenated from the segment MP3s with matching pads.
//   4. ffmpeg muxes the webm (video) + narration (audio) → <NN>-<slug>.mp4.
//
// The leading-in (page load) is measured and prepended to the audio as silence
// so narration stays aligned with the recorded video.
//
// Usage: node tutorials/build-tutorial.mjs tutorials/specs/01-language.mjs
import { chromium } from "playwright";
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAD = 0.6; // seconds of hold (and audio silence) after each segment

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: node tutorials/build-tutorial.mjs <spec.mjs>");
  process.exit(1);
}
const spec = (await import(pathToFileURL(resolve(specPath)).href)).default;

const OUT = resolve(__dirname, "out");
const BUILD = resolve(__dirname, "build", `${spec.num}-${spec.slug}`);
rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });
mkdirSync(OUT, { recursive: true });

const sh = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const probeDur = (f) =>
  parseFloat(sh(`ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${f}"`).trim());

// ── 1. TTS each segment ────────────────────────────────────────────────────
console.log(`[${spec.num}] ${spec.title} — ${spec.segments.length} segments`);
const voice = spec.voice ?? "en-US-GuyNeural";
const rate = spec.rate ?? "-6%";
const durations = [];
for (let i = 0; i < spec.segments.length; i++) {
  const mp3 = `${BUILD}/seg-${String(i).padStart(2, "0")}.mp3`;
  execFileSync(
    process.env.HOME + "/.local/bin/edge-tts",
    ["--voice", voice, `--rate=${rate}`, "--text", spec.segments[i].text, "--write-media", mp3],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  durations.push(probeDur(mp3));
  console.log(`  tts seg ${i}: ${durations[i].toFixed(2)}s`);
}

// ── 2. record the app with Playwright, synced to segment durations ──────────
const vp = spec.viewport ?? { width: 1440, height: 810 };
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: vp,
  recordVideo: { dir: `${BUILD}/video`, size: vp },
  deviceScaleFactor: 1,
});
// suppress the first-run tour overlay (fresh profile has no dismissal flag)
await context.addInitScript(() => {
  try {
    localStorage.setItem("flowloom.toured", "1");
  } catch {
    /* ignore */
  }
});
const page = await context.newPage();
const tRecStart = Date.now();
await page.goto(spec.url ?? "http://localhost:5174/", { waitUntil: "networkidle" });
await page.waitForTimeout(400); // settle fonts/layout
// defensive: close any tour overlay that slipped through
await page.keyboard.press("Escape").catch(() => {});
const skip = page.locator(".tour-skip");
if (await skip.count()) await skip.first().click().catch(() => {});

const helpers = makeHelpers(page);
const tFirstSegment = Date.now();
const leadInSec = (tFirstSegment - tRecStart) / 1000;

for (let i = 0; i < spec.segments.length; i++) {
  const seg = spec.segments[i];
  if (seg.do) await seg.do(page, helpers);
  await page.waitForTimeout(Math.round((durations[i] + PAD) * 1000));
}
await page.waitForTimeout(300);
await context.close();
await browser.close();

const webm = readdirSync(`${BUILD}/video`).find((f) => f.endsWith(".webm"));
const webmPath = `${BUILD}/video/${webm}`;
console.log(`  recorded ${webmPath} (lead-in ${leadInSec.toFixed(2)}s)`);

// ── 3. build the narration track: leadIn silence + each seg + PAD silence ───
const list = [];
// silent lead-in
const silenceLead = `${BUILD}/_lead.mp3`;
sh(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${leadInSec.toFixed(3)} -q:a 9 "${silenceLead}"`);
list.push(silenceLead);
const silencePad = `${BUILD}/_pad.mp3`;
sh(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${PAD} -q:a 9 "${silencePad}"`);
for (let i = 0; i < spec.segments.length; i++) {
  list.push(`${BUILD}/seg-${String(i).padStart(2, "0")}.mp3`);
  list.push(silencePad);
}
const concatFile = `${BUILD}/concat.txt`;
writeFileSync(concatFile, list.map((f) => `file '${f}'`).join("\n"));
const narration = `${BUILD}/narration.mp3`;
sh(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c:a libmp3lame -q:a 4 "${narration}"`);

// ── 4. mux video + narration → mp4 ──────────────────────────────────────────
const mp4 = `${OUT}/${spec.num}-${spec.slug}.mp4`;
sh(
  `ffmpeg -y -i "${webmPath}" -i "${narration}" ` +
    `-map 0:v:0 -map 1:a:0 -c:v libopenh264 -b:v 2500k -pix_fmt yuv420p ` +
    `-vf "scale=${vp.width}:${vp.height}:force_original_aspect_ratio=decrease,pad=${vp.width}:${vp.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p" ` +
    `-c:a aac -b:a 160k -shortest "${mp4}"`,
);
const finalDur = probeDur(mp4);
console.log(`✓ ${mp4}  (${finalDur.toFixed(1)}s)`);

// ── editor / app helpers passed to each segment's do() ──────────────────────
function makeHelpers(page) {
  const ta = () => page.locator("#src"); // the editor textarea (transparent-text)
  return {
    page,
    async clearEditor() {
      await ta().click();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Delete");
    },
    async setModel(text) {
      await ta().fill(text);
      await ta().dispatchEvent("input");
    },
    async typeLines(text, delay = 16) {
      await ta().focus();
      await page.keyboard.press("End");
      await page.keyboard.type(text, { delay });
    },
    async run() {
      await page.locator("#run").click();
      await page.waitForTimeout(250);
    },
    async tab(name) {
      await page.locator(".tabs button", { hasText: new RegExp(`^${name}$`, "i") }).first().click();
    },
    async example(label) {
      await page.selectOption("#example", { label });
      await page.waitForTimeout(400);
    },
    async method(m) {
      await page.selectOption("#method", m);
      await page.locator("#run").click();
      await page.waitForTimeout(250);
    },
    async setDt(v) {
      await page.fill("#dt", String(v));
      await page.locator("#dt").press("Enter").catch(() => {});
    },
    async setTo(v) {
      await page.fill("#to", String(v));
      await page.locator("#to").press("Enter").catch(() => {});
    },
    async ai() {
      await page.locator("#ai").click();
      await page.waitForTimeout(300);
    },
    async aiClose() {
      await page.locator("#aiClose").click().catch(() => {});
    },
    async play() {
      await page
        .locator(".tbtn", { hasText: "▶" })
        .first()
        .click({ timeout: 5000 })
        .catch(() => {});
    },
    async loadModel(text) {
      const b64 = Buffer.from(text, "utf8").toString("base64");
      const base = (spec.url ?? "http://localhost:5174/").split("#")[0];
      // a hash-only change doesn't re-read the model; force a full reload
      await page.goto(`${base}#m=${b64}`, { waitUntil: "domcontentloaded" });
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(400);
    },
    async clickText(name) {
      await page.getByText(name, { exact: false }).first().click();
    },
    async pause(ms) {
      await page.waitForTimeout(ms);
    },
  };
}
