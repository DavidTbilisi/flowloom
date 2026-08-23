// build-examples.mjs — one short narrated MP4 per ladder example, walking its
// syntax. Loads the (commented) model into the live editor, runs it, and the
// voiceover calls out the constructs. Reuses the same TTS → Playwright record →
// ffmpeg mux pipeline as build-tutorial.mjs.
//
// Usage: node tutorials/build-examples.mjs [NN ...]   (default: all)
import { chromium } from "playwright";
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, rmSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const LADDER = resolve(REPO, "examples/ladder");
const OUTDIR = resolve(LADDER, "videos");
const VOICE = "en-US-AriaNeural";
const RATE = "-2%";
const URL = "http://localhost:5174/";
const VP = { width: 1440, height: 810 };
const PAD = 0.6;

// per-model narration (segments). The model text comes from the .flow file.
const MODELS = [
  ["01", "bathtub", [
    "The simplest model: one stock. `stock Water` declares an accumulator, and the change line sets its net rate — a constant inflow minus a constant outflow.",
    "A stock is literally the integral of its change line, so a steady net inflow just raises the level in a straight line. No feedback yet.",
  ]],
  ["02", "exponential-decay", [
    "Still one stock, but now the outflow is a flow proportional to the stock: draining equals k times Water, subtracted in the change line.",
    "Losing a fixed fraction each step makes the water decay toward zero — fast at first, then slower. That's your first balancing loop.",
  ]],
  ["03", "exponential-growth", [
    "The mirror image. The flow — interest equals rate times Balance — feeds back into the stock through its change line.",
    "Inflow proportional to the stock means it compounds: the more you have, the faster it grows. A reinforcing loop, unbounded on its own.",
  ]],
  ["04", "goal-seeking", [
    "Here an aux computes the gap to a target, and the flow is proportional to that gap.",
    "So the stock eases into the set-point — quickly when far away, gently as the gap closes. The goal-seeking pattern behind thermostats and restocking.",
  ]],
  ["05", "logistic-growth", [
    "One flow combines both forces: growth times one minus the fill fraction, with param K as the ceiling.",
    "It's reinforcing while the population is small and balancing as it nears capacity — two loop polarities from a single structure.",
  ]],
  ["06", "two-tanks", [
    "Two stock lines now, and one shared flow: transfer appears in BOTH change lines — negative for the source, positive for the sink.",
    "That's how you chain stocks. The outflow of one becomes the inflow of the next, and the total is conserved.",
  ]],
  ["07", "predator-prey", [
    "Two stocks and four flows. The coupling terms — hunt times Prey times Predators — link them together.",
    "Each change line just nets its flows. The lag between the two stocks produces endless oscillation that never settles.",
  ]],
  ["08", "sir-epidemic", [
    "Three stocks in a chain: S, I, R. The infection flow couples Susceptible and Infected; recovery moves Infected to Recovered.",
    "Notice each change line simply sums the flows crossing its boundary — reinforcing early, then balancing as the susceptible pool runs out.",
  ]],
  ["09", "test-inputs", [
    "These aux lines use built-in drivers: step for a permanent change, pulse for a transient kick, and ramp for a trend.",
    "They all flow into one stock, so you can see each shape and how the level integrates them. Use these to stress-test any model.",
  ]],
  ["10", "lookup-table", [
    "The table line is a graphical function — a list of x-y breakpoints. Call it like drainCurve of Water, and it interpolates between the points.",
    "Reach for a table when a relationship is really a curve you'd rather draw than write as a formula. It clamps outside the range.",
  ]],
  ["11", "material-delay", [
    "The key line is receiving equals delay3 of orders and leadTime — a third-order material delay.",
    "When orders step up, receiving lags and eases in over the lead time. Delays like this are where overshoot and oscillation come from.",
  ]],
  ["12", "bass-diffusion", [
    "Two stocks, Potential and Adopters, with two adoption flows: advertising reaches the untapped market, and word-of-mouth scales with adopters.",
    "Word-of-mouth is the reinforcing loop; market saturation balances it. Together they give the classic S-shaped take-up curve.",
  ]],
  ["13", "seir-epidemic", [
    "Four stocks now. Note the Exposed stock is spelled out — E alone is reserved for Euler's number.",
    "Each stage transition is a flow whose rate is one over the stage's duration. A longer S, E, I, R chain gives richer dynamics.",
  ]],
  ["14", "supply-chain", [
    "An ordering policy: ordering corrects the inventory gap, clamped at zero, and delay3 ships it after a lead time.",
    "The delay fighting the correction policy creates the bullwhip — overshoot and oscillation after a single step in demand.",
  ]],
  ["15", "regions-subscripts", [
    "The dim line declares a dimension of named regions, and Population with a region subscript becomes one stock per element.",
    "Equations are written once and run elementwise; a scalar like birthRate broadcasts to all regions, and sum collapses the array to a total.",
  ]],
  ["16", "startup-capstone", [
    "Everything at once: three stocks, a table for market saturation, a delay3 for hiring, and several interacting loops.",
    "The reinforcing engine: customers bring revenue and cash, which funds salespeople, who win more customers.",
    "The brakes: the saturation table and customer churn. Read it top to bottom — every line is one of the building blocks you've now seen. That's the whole language.",
  ]],
];

const want = process.argv.slice(2);
const todo = want.length ? MODELS.filter((m) => want.includes(m[0])) : MODELS;

const sh = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString();
const probe = (f) => parseFloat(sh(`ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${f}"`).trim());

mkdirSync(OUTDIR, { recursive: true });

for (const [num, slug, segs] of todo) {
  const model = readFileSync(resolve(LADDER, `${num}-${slug}.flow`), "utf8");
  const BUILD = resolve(__dirname, "build", `ex-${num}-${slug}`);
  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(`${BUILD}/video`, { recursive: true });
  console.log(`[ex ${num}] ${slug} — ${segs.length} segments`);

  // 1. TTS
  const durs = [];
  for (let i = 0; i < segs.length; i++) {
    const mp3 = `${BUILD}/seg-${i}.mp3`;
    execFileSync(process.env.HOME + "/.local/bin/edge-tts",
      ["--voice", VOICE, `--rate=${RATE}`, "--text", segs[i], "--write-media", mp3],
      { stdio: ["ignore", "ignore", "inherit"] });
    durs.push(probe(mp3));
  }

  // 2. record
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VP, recordVideo: { dir: `${BUILD}/video`, size: VP } });
  await context.addInitScript(() => { try { localStorage.setItem("flowloom.toured", "1"); } catch {} });
  const page = await context.newPage();
  const t0 = Date.now();
  await page.goto(URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape").catch(() => {});
  // load the model and run it
  await page.fill("#src", model);
  await page.locator("#run").click();
  await page.waitForTimeout(300);
  await page.locator(".tbtn", { hasText: "▶" }).first().click({ timeout: 4000 }).catch(() => {});
  const leadIn = (Date.now() - t0) / 1000;
  for (let i = 0; i < segs.length; i++) await page.waitForTimeout(Math.round((durs[i] + PAD) * 1000));
  await page.waitForTimeout(300);
  await context.close();
  await browser.close();
  const webm = `${BUILD}/video/` + readdirSync(`${BUILD}/video`).find((f) => f.endsWith(".webm"));

  // 3. narration track (lead silence + segs + pads)
  sh(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${leadIn.toFixed(3)} -q:a 9 "${BUILD}/_lead.mp3"`);
  sh(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${PAD} -q:a 9 "${BUILD}/_pad.mp3"`);
  const list = [`${BUILD}/_lead.mp3`];
  for (let i = 0; i < segs.length; i++) { list.push(`${BUILD}/seg-${i}.mp3`, `${BUILD}/_pad.mp3`); }
  writeFileSync(`${BUILD}/concat.txt`, list.map((f) => `file '${f}'`).join("\n"));
  sh(`ffmpeg -y -f concat -safe 0 -i "${BUILD}/concat.txt" -c:a libmp3lame -q:a 4 "${BUILD}/narration.mp3"`);

  // 4. mux
  const mp4 = `${OUTDIR}/ex-${num}-${slug}.mp4`;
  sh(`ffmpeg -y -i "${webm}" -i "${BUILD}/narration.mp3" -map 0:v:0 -map 1:a:0 ` +
     `-c:v libopenh264 -b:v 2500k -pix_fmt yuv420p ` +
     `-vf "scale=${VP.width}:${VP.height}:force_original_aspect_ratio=decrease,pad=${VP.width}:${VP.height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p" ` +
     `-c:a aac -b:a 160k -shortest "${mp4}"`);
  console.log(`✓ ${mp4} (${probe(mp4).toFixed(1)}s)`);
}
console.log("ALL EXAMPLE VIDEOS DONE");
