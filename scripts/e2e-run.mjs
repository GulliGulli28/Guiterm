#!/usr/bin/env node
// Real end-to-end test runner: builds nothing itself (run `cargo build` in
// src-tauri first), but starts the Vite dev server and tauri-driver, waits
// for both to be ready, drives the ACTUAL compiled Tauri binary through the
// real WebDriver protocol (WebKitWebDriver on Linux, msedgedriver/WebView2 on
// Windows), runs the scenarios below, then tears everything down. This is the
// only way to exercise `invoke(...)` for real — a plain headless browser
// never has `window.__TAURI__`.
//
// One-time setup this depends on (see CLAUDE.md for the full writeup):
//   Linux:   sudo apt-get install -y webkit2gtk-driver
//            cargo install tauri-driver
//            (in src-tauri) cargo build
//   Windows: winget install NASM.NASM   (aws-lc-sys needs it to build)
//            cargo install tauri-driver
//            download msedgedriver.exe matching the installed WebView2
//            Runtime version from https://msedgedriver.microsoft.com/
//            (in src-tauri) cargo build --release --features tauri/custom-protocol
//            — `--release` alone is NOT enough to embed frontendDist (still
//            loads devUrl without the custom-protocol feature, which the
//            `tauri` CLI normally enables for you); set CARGO_TARGET_DIR to a
//            native NTFS path if the repo is mounted over a UNC path
//            (\\wsl...\ or similar): incremental-compilation lock files can't
//            be created over that kind of network filesystem bridge.
//
// Usage: node scripts/e2e-run.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { remote } from "webdriverio";

const isWindows = process.platform === "win32";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");

// CARGO_TARGET_DIR: same variable cargo itself reads, so `cargo build` and
// this script agree on where the binary landed without duplicating the path
// in two places. Defaults mirror what each platform's setup actually uses.
const cargoTargetDir = process.env.CARGO_TARGET_DIR
  || (isWindows ? path.join(os.homedir(), "guiterm-target-windows") : path.join(projectRoot, "target"));

// Debug builds load `build.devUrl` (needs a running Vite dev server); release
// builds embed `frontendDist` (the already-built `dist/`, which is plain
// static output — portable across platforms even though `node_modules`
// itself isn't: esbuild/rollup ship OS-specific native binaries, so a
// `node_modules` installed under WSL can't run Vite natively on Windows).
// Windows therefore defaults to testing a release build to sidestep that
// entirely; override with E2E_BUILD_PROFILE=debug|release if needed.
const buildProfile = process.env.E2E_BUILD_PROFILE || (isWindows ? "release" : "debug");
const needsViteDevServer = buildProfile === "debug";
const appBinary = path.join(cargoTargetDir, buildProfile, isWindows ? "guiterm.exe" : "guiterm");

// Where the platform's native WebDriver binary lives.
const nativeDriverPath = isWindows
  ? (process.env.EDGEDRIVER_PATH || path.join(os.homedir(), "edgedriver", "msedgedriver.exe"))
  : "/usr/bin/WebKitWebDriver";

const outDir = path.join(scriptDir, ".output");

// GDK_BACKEND=x11 is Linux-only: GTK under WSLg renders via native Wayland by
// default, invisible to WebKitWebDriver/scrot, unless forced onto XWayland.
// Windows has no such concept — WebView2 is a native Win32 control.
const GUI_ENV = isWindows
  ? { ...process.env }
  : { ...process.env, DISPLAY: process.env.DISPLAY || ":0", GDK_BACKEND: "x11" };

function findTauriDriver() {
  const cargoBinPath = path.join(os.homedir(), ".cargo", "bin", isWindows ? "tauri-driver.exe" : "tauri-driver");
  return existsSync(cargoBinPath) ? cargoBinPath : "tauri-driver";
}

function waitForHttp(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      fetch(url).then(() => resolve()).catch(() => {
        if (Date.now() > deadline) reject(new Error(`timeout waiting for ${url}`));
        else setTimeout(tick, 300);
      });
    };
    tick();
  });
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.end(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`timeout waiting for port ${port}`));
        else setTimeout(tick, 300);
      });
    };
    tick();
  });
}

/** Add new real-window scenarios here as the suite grows. */
async function runScenarios(browser) {
  await browser.waitUntil(async () => (await browser.getTitle()) === "Guiterm", {
    timeout: 10_000,
    timeoutMsg: "le titre de la fenêtre n'est jamais devenu \"Guiterm\"",
  });

  const html = await browser.getPageSource();
  if (!html.includes('id="root"')) {
    throw new Error("le DOM rendu ne contient pas l'élément racine React (#root)");
  }

  // `<div id="root">` is static in index.html, so its mere presence proves
  // nothing. Assert React actually rendered *into* it (waiting for the async
  // mount): a strict CSP that blocks the app's scripts or stylesheet would leave
  // #root empty, which this catches where the string check above can't.
  await browser.waitUntil(
    async () => (await browser.execute(() => document.getElementById("root")?.childElementCount ?? 0)) > 0,
    {
      timeout: 10_000,
      timeoutMsg: "#root est resté vide : React n'a pas rendu — CSP trop stricte, script bloqué, ou erreur au montage",
    },
  );

  // Exercise a real `invoke(...)` over Tauri's IPC — the thing a plain headless
  // browser can't do. `master_password_status` is read-only (never creates or
  // migrates anything), so it's safe against the real profile while still
  // proving the command → core::vault path is wired end to end.
  const vaultStatus = await browser.execute(async () => {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") return { __error: "window.__TAURI_INTERNALS__.invoke absent" };
    try {
      return await internals.invoke("master_password_status");
    } catch (e) {
      return { __error: String(e) };
    }
  });
  if (!vaultStatus || typeof vaultStatus.enabled !== "boolean" || typeof vaultStatus.unlocked !== "boolean") {
    throw new Error(`invoke("master_password_status") n'a pas répondu correctement via IPC : ${JSON.stringify(vaultStatus)}`);
  }

  // Open a local terminal (Ctrl+T) and read back real command output — the
  // one path that exercises the `tauri::ipc::Channel`-based terminal-data
  // bridge end to end (PTY read -> `channel.send` -> IPC -> xterm.write ->
  // DOM), not just that some invoke() resolves. Doesn't touch the real
  // profile/workspace: opening a local shell subprocess mutates nothing
  // persisted.
  await browser.keys(["Control", "t"]);
  await browser.waitUntil(
    async () => (await browser.execute(() => document.querySelector(".xterm-rows") !== null)),
    { timeout: 10_000, timeoutMsg: "le terminal local ne s'est jamais ouvert (aucun .xterm-rows dans le DOM)" },
  );

  // A fresh terminal doesn't necessarily hold DOM focus the instant
  // `.xterm-rows` appears (its own focus effect runs on a later render than
  // the one that first mounts the element) — click it explicitly so the
  // keystrokes below land on xterm's hidden textarea instead of nowhere.
  await browser.$(".xterm").click();

  const marker = `E2E_CHANNEL_${Date.now()}`;
  // One `keys()` call per character rather than one bulk string: WebKitWebDriver
  // has been observed to silently coalesce/drop a character when a whole string
  // is sent as a single action, which isn't a real app bug — see the git history
  // of this comment for the flaky run that surfaced it.
  for (const ch of `echo ${marker}`) {
    await browser.keys(ch);
  }
  await browser.keys("Enter");
  try {
    await browser.waitUntil(
      async () => (await browser.execute((m) => document.body.innerText.includes(m), marker)),
      { timeout: 10_000, timeoutMsg: `la sortie "${marker}" n'est jamais apparue dans le terminal — canal binaire terminal-data cassé ?` },
    );
  } catch (e) {
    // The exact wait that failed above doesn't say what the terminal actually
    // rendered — print it so a future failure is diagnosable from CI logs
    // alone, without needing to reproduce locally first.
    const rendered = await browser.execute(() => document.querySelector(".xterm-rows")?.textContent ?? "<pas de .xterm-rows>");
    console.log("Contenu du terminal au moment de l'échec :", JSON.stringify(rendered));
    throw e;
  }

  await mkdir(outDir, { recursive: true });
  const screenshotPath = path.join(outDir, "e2e-smoke.png");
  await browser.saveScreenshot(screenshotPath);
  console.log("Capture d'écran réelle (via WebDriver) :", screenshotPath);
}

async function main() {
  if (!existsSync(appBinary)) {
    console.error(`Binaire introuvable : ${appBinary}`);
    console.error(`Lance d'abord : cd src-tauri && cargo build${buildProfile === "release" ? " --release --features tauri/custom-protocol" : ""}`);
    process.exit(1);
  }

  let vite = null;
  if (needsViteDevServer) {
    console.log("Démarrage du serveur Vite (build debug : charge devUrl)...");
    // Invoke Vite's JS entrypoint directly with node.exe rather than the
    // `npx`/`vite` shim: those are .cmd wrappers on Windows, which run
    // through cmd.exe — and cmd.exe cannot use a UNC path (\\wsl...\) as its
    // working directory (silently falls back to C:\Windows and fails to find
    // anything). node.exe itself handles UNC cwd fine; only the shell can't.
    const viteBin = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
    vite = spawn(process.execPath, [viteBin], { cwd: projectRoot, env: GUI_ENV, stdio: "ignore" });
    vite.on("error", (err) => console.error("Impossible de démarrer Vite :", err.message));
  } else {
    console.log("Build release : le binaire embarque déjà dist/, pas de serveur Vite nécessaire.");
  }
  const driverPath = findTauriDriver();
  console.log("Démarrage de tauri-driver (", driverPath, ") avec le pilote natif (", nativeDriverPath, ")...");
  const driver = spawn(driverPath, ["--native-driver", nativeDriverPath], { env: GUI_ENV, stdio: "ignore" });
  driver.on("error", (err) => console.error("Impossible de démarrer tauri-driver — `cargo install tauri-driver` a-t-il bien tourné ? :", err.message));

  let exitCode = 0;
  try {
    if (needsViteDevServer) await waitForHttp("http://localhost:1420", 20_000);
    await waitForPort(4444, 10_000);

    console.log("Connexion à tauri-driver, lancement de la vraie fenêtre...");
    const browser = await remote({
      hostname: "localhost",
      port: 4444,
      path: "/",
      capabilities: { "tauri:options": { application: appBinary } },
      logLevel: "warn",
      connectionRetryCount: 3,
    });

    try {
      await runScenarios(browser);
      console.log("PASS : fenêtre réelle lancée, rendue et pilotée via WebDriver.");
    } finally {
      await browser.deleteSession().catch(() => {});
    }
  } catch (err) {
    console.error("FAIL :", err instanceof Error ? err.message : err);
    exitCode = 1;
  } finally {
    driver.kill("SIGKILL");
    vite?.kill("SIGKILL");
  }
  process.exit(exitCode);
}

main();
