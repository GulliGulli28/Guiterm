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

/** Requests a module from the dev server and reads it to the end, so Vite's
 * dependency pre-bundling happens before anything is being timed. */
async function warmViteEntry(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      await response.text();
      if (response.ok) {
        console.log(`Graphe de modules Vite préchauffé en ${Math.round((Date.now() - started) / 100) / 10}s.`);
        return;
      }
    } catch {
      // Dev server not answering for this path yet — keep trying.
    }
    if (Date.now() > deadline) throw new Error(`Vite n'a jamais servi ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
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
  //
  // The diagnostics are printed from a `catch` rather than passed as
  // `timeoutMsg`: that option is a string, and the async function that used to
  // be there was never awaited — so this wait failed with WebdriverIO's own
  // "condition timed out" and none of the context it was written to give.
  // Observed for real on a slow start, where the message said nothing at all.
  try {
    await browser.waitUntil(
      async () => (await browser.execute(() => document.getElementById("root")?.childElementCount ?? 0)) > 0,
      { timeout: 15_000, timeoutMsg: "#root est resté vide : React n a jamais monté" },
    );
  } catch (e) {
    const title = await browser.getTitle().catch(() => "<illisible>");
    const body = await browser
      .execute(() => document.body.innerHTML.slice(0, 600))
      .catch(() => "<illisible>");
    console.log(`#root vide. TITRE=${title} BODY=${body}`);
    throw e;
  }

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

  // The SSO expiry badge polls this every minute for the life of the window,
  // so what has to be proven here is that it *answers* — a command missing
  // from the `invoke_handler` list rejects, and the hook swallows rejections
  // by design (a machine with no ~/.aws is the common case, not a failure).
  // That silence is exactly what would hide an unregistered command, so the
  // assertion belongs here rather than in the app.
  //
  // Read-only and local-file-only: it never shells out to the `aws` CLI. An
  // empty array is the expected answer on a machine with no AWS setup, and is
  // a pass — the shape is the contract, not the contents.
  const alerts = await browser.execute(async () => {
    try {
      return await window.__TAURI_INTERNALS__.invoke("list_aws_session_alerts");
    } catch (e) {
      return { __error: String(e) };
    }
  });
  if (!Array.isArray(alerts)) {
    throw new Error(`invoke("list_aws_session_alerts") n'a pas rendu un tableau : ${JSON.stringify(alerts)}`);
  }
  for (const alert of alerts) {
    if (typeof alert?.session !== "string" || !Array.isArray(alert?.hosts) || typeof alert?.severity?.kind !== "string") {
      throw new Error(`alerte SSO mal formée : ${JSON.stringify(alert)}`);
    }
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

  await runZoomScenario(browser);
  await runFullscreenScenario(browser);
  await runProxyCommandFieldScenario(browser);
  await runAwsImportPanelScenario(browser);
  await runAwsDatabasePanelScenario(browser);
  await runAwsIdentitiesPanelScenario(browser);
  await runNetDiagScenario(browser);
  await runRemoteSearchScenario(browser);
  await runCertificateFieldScenario(browser);
  await runRollbackScenario(browser);
  await runDriftScenario(browser);
  await runAnsibleImportScenario(browser);
  await runBulkEditScenario(browser);
  await runTabShortcutScenario(browser);
  await runCloudImportScenario(browser);
  await runSshTerminalTabScenario(browser);
  await runSqlTabScenario(browser);
  await runFleetTabScenario(browser);
  await runSidebarPanelsScenario(browser);
  await runSidebarButtonsScenario(browser);
  await runTunnelEditScenario(browser);
  await runSsmTunnelScenario(browser);
  await runActivityScenario(browser);

  await mkdir(outDir, { recursive: true });
  const screenshotPath = path.join(outDir, "e2e-smoke.png");
  await browser.saveScreenshot(screenshotPath);
  console.log("Capture d'écran réelle (via WebDriver) :", screenshotPath);
}

/** Rendered font size of every open terminal, in DOM order (so index 0 is the
 * first tab). Read from the computed style rather than from React state:
 * what's asserted is what xterm actually painted. */
function terminalFontSizes(browser) {
  return browser.execute(() =>
    Array.from(document.querySelectorAll(".xterm-rows"), (el) => parseFloat(getComputedStyle(el).fontSize)),
  );
}

/** The `terminalFontSize` preference as persisted — the thing zooming must never touch. */
function storedDefaultFontSize(browser) {
  return browser.execute(() => {
    try {
      return JSON.parse(localStorage.getItem("gui-termius-prefs") ?? "{}").terminalFontSize ?? null;
    } catch {
      return null;
    }
  });
}

/**
 * Ctrl+±/Ctrl+0 resize *one* terminal.
 *
 * The isolation is the whole point of the feature, and it's what no unit test
 * can show: `lib/terminalZoom.test.ts` proves the key mapping and the
 * arithmetic, but only a real window with two live terminals proves that
 * zooming one leaves the other — and the saved default — alone.
 */
async function runZoomScenario(browser) {
  const [baseSize] = await terminalFontSizes(browser);
  if (!baseSize) throw new Error("impossible de lire la taille de police du terminal (.xterm-rows)");
  const storedBefore = await storedDefaultFontSize(browser);

  for (let i = 0; i < 3; i++) await browser.keys(["Control", "="]);
  await browser.waitUntil(
    async () => (await terminalFontSizes(browser))[0] === baseSize + 3,
    {
      timeout: 5_000,
      timeoutMsg: `Ctrl+= n'a pas agrandi la police du terminal (attendu ${baseSize + 3}px, toujours ${baseSize}px)`,
    },
  );

  // A second terminal must open at the configured size, not at the first
  // one's — this is the regression that "modifie tous les terminaux" would be.
  //
  // Focus has to leave xterm first: Ctrl+T is deliberately *not* in
  // `BUBBLE_THROUGH_TERMINAL_ACTIONS` (it's readline's transpose-chars), so
  // pressing it inside a terminal correctly goes to the shell instead of
  // opening a tab.
  await browser.execute(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await browser.keys(["Control", "t"]);
  await browser.waitUntil(
    async () => await browser.execute(() => document.querySelectorAll(".xterm").length === 2),
    { timeout: 10_000, timeoutMsg: "le deuxième terminal local ne s'est pas ouvert" },
  );
  // Clicked for the same reason as the first terminal above: under
  // WebKitWebDriver a freshly mounted terminal doesn't reliably end up
  // holding DOM focus, so the keystrokes below would land on <body>.
  const terminals = await browser.$$(".xterm");
  await terminals[1].click();
  try {
    await browser.waitUntil(
      async () => await browser.execute(() => {
        const all = document.querySelectorAll(".xterm");
        return all.length === 2 && !!document.activeElement && all[1].contains(document.activeElement);
      }),
      { timeout: 5_000, timeoutMsg: "le deuxième terminal n'a pas pris le focus après un clic" },
    );
  } catch (e) {
    const state = await browser.execute(() => ({
      terminals: document.querySelectorAll(".xterm").length,
      active: `${document.activeElement?.tagName}.${document.activeElement?.className}`,
    }));
    console.log("État au moment de l'échec :", JSON.stringify(state));
    throw e;
  }
  let sizes = await terminalFontSizes(browser);
  if (sizes[0] !== baseSize + 3 || sizes[1] !== baseSize) {
    throw new Error(`le zoom a fui d'un terminal à l'autre : attendu [${baseSize + 3}, ${baseSize}], obtenu [${sizes}]`);
  }

  // ...and in the other direction, on the terminal that now has focus.
  await browser.keys(["Control", "-"]);
  await browser.keys(["Control", "-"]);
  await browser.waitUntil(
    async () => (await terminalFontSizes(browser))[1] === baseSize - 2,
    { timeout: 5_000, timeoutMsg: "Ctrl+- n'a pas réduit la police du deuxième terminal" },
  );
  sizes = await terminalFontSizes(browser);
  if (sizes[0] !== baseSize + 3) {
    throw new Error(`réduire le deuxième terminal a changé le premier : ${sizes[0]}px au lieu de ${baseSize + 3}px`);
  }

  await browser.keys(["Control", "0"]);
  await browser.waitUntil(
    async () => (await terminalFontSizes(browser))[1] === baseSize,
    { timeout: 5_000, timeoutMsg: "Ctrl+0 n'a pas ramené le terminal à la taille par défaut" },
  );

  const storedAfter = await storedDefaultFontSize(browser);
  if (storedAfter !== storedBefore) {
    throw new Error(`le zoom a écrit dans les préférences : terminalFontSize ${storedBefore} → ${storedAfter}`);
  }

  // Leave the first terminal at the configured size too, so the screenshot at
  // the end of the run stays comparable between runs.
  await browser.keys(["Control", "Shift", "Tab"]);
  await browser.keys(["Control", "0"]);
  console.log("Zoom par terminal : OK (isolé entre onglets, préférence intacte).");
}

/**
 * F11 toggles real fullscreen, hides the app's own title bar, and the window
 * actually covers the screen.
 *
 * F11 is sent while a terminal has focus on purpose: xterm swallows every key
 * it handles, so this also covers `shouldBubbleToShortcut` letting F11
 * through — without which the shortcut would work everywhere *except* where
 * the user actually is.
 *
 * Entered from a **maximized** window on purpose too. That's the state the
 * gap-at-the-bottom bug needed: asking an already-maximized undecorated
 * window to go fullscreen left it at the work-area height (screen minus
 * taskbar) while still reporting itself as fullscreen. From a normal window
 * the same call has always worked, so testing only that would have proved
 * nothing.
 */
async function runFullscreenScenario(browser) {
  const titleBarVisible = () =>
    browser.execute(() => document.querySelector('[aria-label="Réduire"]') !== null);
  const viewport = () =>
    browser.execute(() => ({ inner: window.innerHeight, screen: window.screen.height }));

  if (!(await titleBarVisible())) throw new Error("la barre de titre est absente avant même de passer en plein écran");

  await browser.$('[aria-label="Agrandir"]').click();
  await browser.waitUntil(async () => (await viewport()).inner > 800, {
    timeout: 5_000,
    timeoutMsg: "la fenêtre ne s'est pas maximisée",
  });
  const maximizedHeight = (await viewport()).inner;

  await browser.keys("F11");
  await browser.waitUntil(async () => !(await titleBarVisible()), {
    timeout: 5_000,
    timeoutMsg: "F11 n'a pas masqué la barre de titre — plein écran refusé (capability manquante ?) ou raccourci avalé par xterm",
  });

  // The assertion the bug report came down to: "ça ne prend pas l'entièreté
  // de l'écran". A couple of pixels of tolerance for rounding at non-integer
  // display scaling; the bug itself was ~48px (the taskbar).
  await browser.waitUntil(async () => {
    const { inner, screen } = await viewport();
    return Math.abs(inner - screen) <= 2;
  }, {
    timeout: 5_000,
    timeoutMsg: async () => {
      const { inner, screen } = await viewport();
      return `la fenêtre plein écran ne couvre pas l'écran : ${inner}px de hauteur utile pour un écran de ${screen}px`;
    },
  });

  // Out again through the TabBar button rather than F11 — it's the control
  // the user reaches for, and in fullscreen it's the only one left on screen.
  await browser.$('[aria-label="Quitter le plein écran"]').click();
  await browser.waitUntil(async () => await titleBarVisible(), {
    timeout: 5_000,
    timeoutMsg: "le bouton plein écran de la barre d'onglets n'a pas fait revenir la barre de titre",
  });

  // ...and the window ends up back the way it was found, not restored to some
  // earlier smaller size. Waited for rather than read once: the title bar
  // comes back as soon as the window leaves fullscreen, which is *before* the
  // window manager has finished putting the geometry back, so an immediate
  // read catches the window mid-restore.
  await browser.waitUntil(async () => Math.abs((await viewport()).inner - maximizedHeight) <= 2, {
    timeout: 5_000,
    timeoutMsg: async () =>
      `sortie du plein écran : fenêtre restée à ${(await viewport()).inner}px au lieu de retrouver son état maximisé (${maximizedHeight}px)`,
  });
  console.log("Plein écran : OK (depuis une fenêtre maximisée, couvre l'écran, retour à l'état d'origine).");
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
    if (needsViteDevServer) {
      await waitForHttp("http://localhost:1420", 20_000);
      // Then warm the entry module. `index.html` is static and comes back
      // instantly, but the first request for `/src/main.tsx` is what makes
      // Vite scan the imports and pre-bundle every dependency — tens of
      // seconds on a cold cache, and the app window would otherwise pay that
      // inside the "React has mounted" wait. That is exactly how this suite
      // failed intermittently, with an empty #root and nothing else wrong.
      await warmViteEntry("http://localhost:1420/src/main.tsx", 120_000);
    }
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


/** Closes a dialog by its heading, clicking the close button *inside* it.
 *
 * Scoped on purpose: the title bar's own window-close button also carries
 * `aria-label="Fermer"`, and a document-wide query finds whichever comes first
 * in the DOM — which would close the application instead of the dialog, on a
 * JSX ordering nothing enforces. */
async function closeDialogTitled(browser, heading) {
  const closed = await browser.execute((title) => {
    const label = Array.from(document.querySelectorAll("p"))
      .find((el) => el.textContent?.trim() === title);
    const dialog = label?.closest("div.flex.max-h-full");
    const close = dialog?.querySelector('[aria-label="Fermer"]');
    if (!(close instanceof HTMLElement)) return false;
    close.click();
    return true;
  }, heading);
  if (!closed) throw new Error(`impossible de fermer la boite de dialogue « ${heading} »`);
}

/** Clicks the first <button> whose visible text is exactly `text`. */
async function clickButtonByText(browser, text) {
  const found = await browser.execute((label) => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === label);
    if (!button) return false;
    button.click();
    return true;
  }, text);
  if (!found) throw new Error(`bouton « ${text} » introuvable`);
}

/** Opens the cloud provider picker from the Hosts sidebar and picks one.
 *
 * Selects on `data-provider` rather than on text: each entry's label is a
 * name, a CLI hint and a sentence, so there is no exact string to match. */
async function pickCloudProvider(browser, provider) {
  await clickButtonByText(browser, "Ajouter…");
  await clickButtonByText(browser, "Importer depuis le cloud");
  await browser.waitUntil(async () => await browser.execute(() =>
    document.querySelectorAll("button[data-provider]").length === 3
  ), { timeout: 5_000, timeoutMsg: "le sélecteur cloud n a pas proposé les trois fournisseurs" });

  const picked = await browser.execute((id) => {
    const entry = document.querySelector(`button[data-provider="${id}"]`);
    if (!(entry instanceof HTMLElement)) return false;
    entry.click();
    return true;
  }, provider);
  if (!picked) throw new Error(`fournisseur « ${provider} » introuvable dans le sélecteur cloud`);
}

/** Same, for buttons whose label is only part of their text (an entry made of
 * a name, a hint and a code sample, say). */
async function clickButtonContaining(browser, text) {
  const found = await browser.execute((needle) => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.includes(needle));
    if (!button) return false;
    button.click();
    return true;
  }, text);
  if (!found) throw new Error(`aucun bouton ne contient « ${text} »`);
}

/**
 * The proxy-command field is actually reachable from the host form, and bound.
 *
 * This is the check that was missing when MongoDB shipped with a complete
 * backend and no way to get to it: `core/tests/ssh_integration.rs` proves the
 * tunnel works, but nothing there proves a user can ever configure one. Kept
 * to opening the form and typing — deliberately never saves, because this
 * runs against the real profile and must not add a host to it.
 */
async function runProxyCommandFieldScenario(browser) {
  await clickButtonByText(browser, "Ajouter…");
  await clickButtonByText(browser, "Nouvel hôte");

  const field = () => browser.execute(() => {
    const labels = Array.from(document.querySelectorAll("label, div"));
    const holder = labels.find((el) => el.textContent?.trim().startsWith("Commande de proxy"));
    const textarea = holder?.querySelector("textarea");
    return textarea ? { present: true, value: textarea.value } : { present: false, value: null };
  });

  await browser.waitUntil(async () => (await field()).present, {
    timeout: 5_000,
    timeoutMsg: "le champ « Commande de proxy » n'existe pas dans le formulaire d'hôte — la fonctionnalité serait inatteignable",
  });

  // The example buttons are the discoverable path in; clicking one must land
  // real text in the field rather than merely looking clickable.
  await browser.execute(() => {
    const summary = Array.from(document.querySelectorAll("summary"))
      .find((el) => el.textContent?.includes("Exemples"));
    summary?.click();
  });
  await clickButtonContaining(browser, "nc %h %p");

  await browser.waitUntil(async () => (await field()).value.includes("nc %h %p"), {
    timeout: 5_000,
    timeoutMsg: "cliquer un exemple n'a rien inséré dans le champ de commande de proxy",
  });

  await runProxyTestButtonScenario(browser);

  // Leave the form, saving nothing.
  await clickButtonByText(browser, "Annuler");
  console.log("Commande de proxy : OK (champ atteignable, exemples et bouton Tester fonctionnels).");
}

/**
 * The "Tester" button really runs the command and renders the verdict.
 *
 * Driven with a program that cannot exist, so the expected outcome is the same
 * on both platforms and needs nothing installed: `sh` says "command not
 * found", `cmd.exe` says "is not recognized", and both are mapped to the same
 * remediation. Proves the whole round trip — button, `invoke`, the helper
 * actually being spawned in Rust, and the result reaching the DOM — which is
 * the part no unit test can reach.
 */
async function runProxyTestButtonScenario(browser) {
  // React tracks its own value for controlled inputs, so assigning `.value`
  // updates the element while leaving the component's state stale. Going
  // through the prototype's setter and dispatching `input` is what makes
  // React notice, and is the difference between filling a form and only
  // appearing to.
  const fillFieldLabelled = async (labelPrefix, value) => {
    const filled = await browser.execute((prefix, text) => {
      const holder = Array.from(document.querySelectorAll("label"))
        .find((el) => el.textContent?.trim().startsWith(prefix));
      const control = holder?.querySelector("textarea, input");
      if (!control) return false;
      const proto = control.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(control, text);
      control.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }, labelPrefix, value);
    if (!filled) throw new Error(`champ « ${labelPrefix} » introuvable dans le formulaire`);
  };

  // The address is substituted into the command, so the button stays disabled
  // until there is one.
  await fillFieldLabelled("Adresse", "127.0.0.1");
  await fillFieldLabelled("Commande de proxy", "guiterm-programme-qui-nexiste-pas");
  await clickButtonByText(browser, "Tester la commande");

  const verdict = () => browser.execute(() => {
    const holder = Array.from(document.querySelectorAll("label, div"))
      .find((el) => el.textContent?.trim().startsWith("Commande de proxy"));
    return holder?.textContent ?? "";
  });

  await browser.waitUntil(async () => (await verdict()).includes("n'a pas établi de tunnel"), {
    timeout: 30_000,
    timeoutMsg: "le bouton Tester n'a produit aucun verdict — la commande n'atteint pas le backend, ou le résultat n'est pas rendu",
  });

  const text = await verdict();
  if (!text.includes("PATH")) {
    throw new Error(`le verdict doit expliquer quoi faire, obtenu : ${JSON.stringify(text.slice(0, 400))}`);
  }
}

/**
 * The AWS import panel opens and really reaches the backend.
 *
 * There is no AWS account here, so the assertion is about the path rather than
 * the data: the menu entry exists, the panel mounts, and pressing "Lister les
 * instances" produces a *verdict* — either a listing or the CLI failure
 * rendered with its remediation. Both prove the invoke round trip; only the
 * absence of either would mean the panel is decorative.
 *
 * Nothing is imported, so the real workspace is untouched.
 */
async function runAwsImportPanelScenario(browser) {
  // Since Azure and GCP joined, the menu holds one cloud entry and the
  // provider is chosen a step later — the databases sidebar still has its own
  // direct "Importer depuis AWS", which is a different panel.
  await pickCloudProvider(browser, "aws");

  const panelText = () => browser.execute(() => {
    const heading = Array.from(document.querySelectorAll("p"))
      .find((el) => el.textContent?.trim() === "Importer des instances EC2");
    return heading?.closest("div.flex.max-h-full")?.textContent ?? "";
  });

  await browser.waitUntil(async () => (await panelText()).length > 0, {
    timeout: 5_000,
    timeoutMsg: "le panneau d import AWS ne s est pas ouvert — entrée de menu inerte",
  });

  await clickButtonByText(browser, "Lister les instances");
  await browser.waitUntil(async () => {
    const text = await panelText();
    return text.includes("Aucune instance")
      || text.includes("aws")
      || text.includes("introuvable")
      || text.includes("joignable");
  }, {
    timeout: 60_000,
    timeoutMsg: "aucun verdict apres Lister les instances — la commande n atteint pas le backend",
  });

  await runAwsSsoPanelScenario(browser);
  await closeDialogTitled(browser, "Importer des instances EC2");
  console.log("Import AWS : OK (panneau atteignable depuis le menu, appel backend effectif).");
}

/**
 * The database import panel is reachable from the database sidebar and really
 * calls the backend.
 *
 * Same shape and same reason as the EC2 one: with no AWS account here the
 * assertion is about the path, not the data. A panel that opens but whose
 * button does nothing is exactly the MongoDB-class failure this suite exists
 * to catch. Nothing is imported, so the real workspace is untouched.
 */
async function runAwsDatabasePanelScenario(browser) {
  await browser.execute(() => {
    const tab = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.getAttribute("title") || "").toLowerCase().includes("base"));
    if (tab instanceof HTMLElement) tab.click();
  });
  // The database panel is lazy-loaded, so its button does not exist the
  // instant the tab is clicked — only once the chunk has resolved.
  await browser.waitUntil(async () => await browser.execute(() =>
    Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Importer depuis AWS")
  ), { timeout: 10_000, timeoutMsg: "le panneau Bases de donnees ne s est pas charge" });
  await clickButtonByText(browser, "Importer depuis AWS");

  const panelText = () => browser.execute(() => {
    const heading = Array.from(document.querySelectorAll("p"))
      .find((el) => el.textContent?.trim() === "Importer des bases depuis AWS");
    return heading?.closest("div.flex.max-h-full")?.textContent ?? "";
  });

  await browser.waitUntil(async () => (await panelText()).length > 0, {
    timeout: 5_000,
    timeoutMsg: "le panneau d import de bases AWS ne s est pas ouvert",
  });

  await clickButtonByText(browser, "Lister les bases");
  await browser.waitUntil(async () => {
    const text = await panelText();
    return text.includes("Aucune base")
      || text.includes("aws")
      || text.includes("introuvable")
      || text.includes("importable");
  }, {
    timeout: 60_000,
    timeoutMsg: "aucun verdict apres Lister les bases — la commande n atteint pas le backend",
  });

  // The SSO panel opens *from* this one, so it has to land on top of it.
  // Checked by hit-testing rather than by presence: it was being rendered
  // perfectly correctly and painted underneath, because both panels shared a
  // z-index and the one rendered later won. "Nothing happens" was the symptom.
  await clickButtonByText(browser, "Configurer une session SSO…");
  await browser.waitUntil(async () => await browser.execute(() => {
    const heading = Array.from(document.querySelectorAll("p"))
      .find((el) => el.textContent?.trim() === "Configurer une session SSO");
    const dialog = heading?.closest("div.flex.max-h-full");
    if (!dialog) return false;
    const topmost = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return !!topmost && dialog.contains(topmost);
  }), {
    timeout: 5_000,
    timeoutMsg: "le panneau SSO ne passe pas devant celui des bases — il s ouvre mais reste invisible",
  });
  await closeDialogTitled(browser, "Configurer une session SSO");

  await closeDialogTitled(browser, "Importer des bases depuis AWS");
  console.log("Import bases AWS : OK (panneau atteignable, appel backend, panneau SSO au-dessus).");
}

/**
 * The remote search panel is reachable from a host's menu.
 *
 * Stops at opening it: running a search would SSH into whichever machine the
 * developer's workspace happens to hold, and this suite doesn't touch anyone's
 * infrastructure. What it covers is the half no unit test can — that the entry
 * point exists and the panel mounts — while the search itself is proved
 * against a real `sshd` in `core/tests/remote_search_integration.rs`.
 *
 * Skips, loudly, on a workspace with no host: a scenario that silently passes
 * when it tested nothing is worse than one that isn't there.
 */
async function runRemoteSearchScenario(browser) {
  // The hosts panel is the launch default, but the previous scenarios moved
  // the sidebar elsewhere.
  await browser.execute(() => {
    const tab = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.getAttribute("title") || "") === "Hôtes");
    if (tab instanceof HTMLElement) tab.click();
  });
  // Every host's menu in turn, not just the first: the entry only exists on an
  // SSH host, and what sits at the top of the developer's list is whatever
  // they put there. One `execute` per step so React has re-rendered in between
  // — a click and a query in the same call would read the DOM from before.
  const menuCount = await browser.execute(() => document.querySelectorAll('button[title="Options"]').length);
  let clicked = false;
  for (let index = 0; index < menuCount && !clicked; index += 1) {
    await browser.execute((i) => document.querySelectorAll('button[title="Options"]')[i]?.click(), index);
    clicked = await browser.execute(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((b) => b.textContent?.trim() === "Rechercher");
      if (!(button instanceof HTMLElement)) return false;
      button.click();
      return true;
    });
    // Not an SSH host — fold this menu back before trying the next.
    if (!clicked) {
      await browser.execute((i) => document.querySelectorAll('button[title="Options"]')[i]?.click(), index);
    }
  }
  if (!clicked) {
    console.log(`Recherche distante : ignorée (aucun hôte SSH parmi les ${menuCount} de ce workspace).`);
    return;
  }

  await browser.waitUntil(async () => await browser.execute(() =>
    Array.from(document.querySelectorAll("p")).some((el) => (el.textContent || "").startsWith("Rechercher des fichiers"))
  ), { timeout: 5_000, timeoutMsg: "le panneau de recherche distante ne s est pas ouvert depuis le menu de l hôte" });

  await browser.execute(() => {
    const heading = Array.from(document.querySelectorAll("p"))
      .find((el) => (el.textContent || "").startsWith("Rechercher des fichiers"));
    const dialog = heading?.closest("div.flex.max-h-full");
    const close = dialog?.querySelector('button[aria-label="Fermer"]');
    if (close instanceof HTMLElement) close.click();
  });
  console.log("Recherche distante : OK (panneau atteignable depuis le menu d un hôte SSH).");
}

/**
 * The Ansible import panel opens from the Add menu, and its parser really runs.
 *
 * Stops before importing anything: creating hosts would write to the
 * developer's own workspace, which this suite never does. What it covers is
 * the entry point existing and the read command answering — the parsing itself
 * is pinned by unit tests, and the non-duplicating import by
 * `ansible_inventory`'s own tests.
 *
 * The read is asked for a path that doesn't exist, so the assertion is on the
 * *refusal*: a missing file must come back as an error naming the path, not as
 * an empty inventory that would look like a file with no hosts in it.
 */
async function runAnsibleImportScenario(browser) {
  await browser.execute(() => {
    const tab = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.getAttribute("title") || "") === "Hôtes");
    if (tab instanceof HTMLElement) tab.click();
  });
  // Matched on a prefix, not on equality: the label carries a trailing
  // ellipsis ("Ajouter…"), and an exact match silently found nothing — the
  // scenario then "passed" while proving none of what it exists to prove.
  // A missing entry point is the failure this whole scenario is about, so it
  // throws rather than degrading to a backend-only check.
  const openedMenu = await browser.execute(() => {
    const add = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.textContent || "").trim().startsWith("Ajouter"));
    if (!(add instanceof HTMLElement)) return false;
    add.click();
    return true;
  });
  if (!openedMenu) throw new Error("bouton « Ajouter… » introuvable dans le panneau Hôtes");

  const clicked = await browser.execute(() => {
    const entry = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "Importer un inventaire Ansible");
    if (!(entry instanceof HTMLElement)) return false;
    entry.click();
    return true;
  });
  if (!clicked) throw new Error("entrée « Importer un inventaire Ansible » absente du menu Ajouter");

  await browser.waitUntil(async () => await browser.execute(() =>
    Array.from(document.querySelectorAll("p")).some((el) => el.textContent?.trim() === "Importer un inventaire Ansible")
  ), { timeout: 5_000, timeoutMsg: "le panneau d import d inventaire ne s est pas ouvert" });
  await closeDialogTitled(browser, "Importer un inventaire Ansible");

  const missing = await browser.execute(async () => {
    try {
      return { __unexpected: await window.__TAURI_INTERNALS__.invoke("read_ansible_inventory", {
        path: "/nowhere/at/all/inventory.yml",
      }) };
    } catch (e) {
      return { message: String(e) };
    }
  });
  if (missing.__unexpected !== undefined) {
    throw new Error("un fichier absent doit être refusé, pas rendu comme un inventaire vide");
  }
  if (!/inventory\.yml/.test(missing.message)) {
    throw new Error(`l erreur doit nommer le fichier, reçu : ${missing.message}`);
  }
  console.log("Import Ansible : OK (panneau atteignable, lecture d un fichier absent refusée en nommant le chemin).");
}

/**
 * Selection mode and the bulk edit panel are reachable, and the backend
 * refuses an edit that changes nothing.
 *
 * Only runs when the developer's real workspace has more than one host — the
 * entry point is hidden below that, deliberately, so asserting it on a machine
 * with none would fail for the wrong reason. Nothing is ever applied: the
 * panel is opened and closed, and the refusal is checked over IPC against an
 * empty edit, which writes to no host.
 */
async function runBulkEditScenario(browser) {
  await browser.execute(() => {
    const tab = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.getAttribute("title") || "") === "Hôtes");
    if (tab instanceof HTMLElement) tab.click();
  });

  const opened = await browser.execute(() => {
    const entry = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "Sélectionner plusieurs hôtes…");
    if (!(entry instanceof HTMLElement)) return false;
    entry.click();
    return true;
  });

  if (opened) {
    await browser.waitUntil(async () => await browser.execute(() =>
      Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Tout")
    ), { timeout: 5_000, timeoutMsg: "le mode sélection ne s est pas activé" });

    await clickButtonByText(browser, "Tout");
    await clickButtonByText(browser, "Modifier…");
    await browser.waitUntil(async () => await browser.execute(() =>
      Array.from(document.querySelectorAll("p")).some((el) => (el.textContent || "").startsWith("Modifier ") && el.textContent.includes("hôte"))
    ), { timeout: 5_000, timeoutMsg: "le panneau de modification en lot ne s est pas ouvert" });

    // The button must refuse before anything is ticked — an edit that writes
    // nothing while reporting "50 hosts updated" is the failure worth
    // preventing here.
    const disabled = await browser.execute(() => {
      const button = Array.from(document.querySelectorAll("button"))
        .find((b) => (b.textContent || "").includes("Cocher un champ"));
      return button instanceof HTMLButtonElement ? button.disabled : null;
    });
    if (disabled !== true) {
      throw new Error(`le bouton d application doit être désactivé tant que rien n est coché (reçu ${disabled})`);
    }
    await clickButtonByText(browser, "Quitter");
    console.log("Édition en lot : OK (mode sélection, panneau atteignable, application refusée à vide).");
  } else {
    console.log("Édition en lot : mode sélection non proposé (moins de deux hôtes enregistrés) — partie UI non vérifiée.");
  }

  // The backend half, which runs whatever the workspace holds: an edit with no
  // chosen field must be refused with a sentence rather than silently succeed.
  const empty = await browser.execute(async () => {
    try {
      return { ok: await window.__TAURI_INTERNALS__.invoke("bulk_edit_hosts", {
        hostIds: [], edit: {}, secret: null,
      }) };
    } catch (e) {
      return { failed: String(e) };
    }
  });
  if (!/au moins un h/i.test(empty.failed ?? "")) {
    throw new Error(`bulk_edit_hosts doit refuser une sélection vide en le disant, reçu : ${JSON.stringify(empty)}`);
  }
  console.log("Édition en lot : OK (sélection vide refusée explicitement côté backend).");
}

/** Focuses the terminal that is actually on screen.
 *
 * `browser.$(".xterm").click()` picks the *first* match, which stops working
 * the moment a second terminal exists: the inactive one is still in the DOM,
 * has zero size, and WebDriver rejects it as not interactable. Focusing
 * xterm's hidden textarea directly is also closer to what a keystroke needs. */
async function focusVisibleTerminal(browser) {
  const focused = await browser.execute(() => {
    const term = Array.from(document.querySelectorAll(".xterm"))
      .find((el) => el.getBoundingClientRect().width > 0);
    const textarea = term?.querySelector("textarea");
    if (!(textarea instanceof HTMLElement)) return false;
    textarea.focus();
    return document.activeElement === textarea;
  });
  if (!focused) throw new Error("aucun terminal visible à focaliser");
}

/** Index of the active tab in the tab bar, or -1. */
function activeTabIndex(browser) {
  return browser.execute(() =>
    Array.from(document.querySelectorAll("[data-tab-id]"))
      .findIndex((el) => el.getAttribute("data-tab-active") === "true"),
  );
}

/**
 * Ctrl+1…9 jump straight to a tab, from inside a focused terminal.
 *
 * Two things no unit test can show. First that the combo *arrives at all*:
 * xterm calls `stopPropagation()` on everything it handles, so a shortcut not
 * declared `bubblesThroughTerminal` never fires while a terminal has focus —
 * which is nearly always. Second that Ctrl+9 means "last", not "ninth".
 *
 * `shortcuts.test.ts` covers the combo arithmetic, including the AZERTY digit
 * row; this covers the part that only a real window has, namely xterm sitting
 * in the middle.
 */
async function runTabShortcutScenario(browser) {
  // A second local terminal, so there is somewhere to jump to. One is already
  // open from the channel scenario above.
  await browser.keys(["Control", "t"]);
  await browser.waitUntil(
    async () => (await browser.execute(() => document.querySelectorAll("[data-tab-id]").length)) >= 2,
    { timeout: 10_000, timeoutMsg: "impossible d ouvrir un deuxième terminal local" },
  );
  const tabCount = await browser.execute(() => document.querySelectorAll("[data-tab-id]").length);

  // Focus the terminal itself: the whole point is that the shortcut survives
  // xterm's key handling, which it can only do if xterm sees the key first.
  await focusVisibleTerminal(browser);

  await browser.keys(["Control", "1"]);
  await browser.waitUntil(async () => (await activeTabIndex(browser)) === 0, {
    timeout: 5_000,
    timeoutMsg: "Ctrl+1 n a pas activé le premier onglet — la combinaison est-elle avalée par xterm ?",
  });

  await focusVisibleTerminal(browser);
  await browser.keys(["Control", "9"]);
  await browser.waitUntil(async () => (await activeTabIndex(browser)) === tabCount - 1, {
    timeout: 5_000,
    timeoutMsg: `Ctrl+9 doit activer le DERNIER onglet (index ${tabCount - 1}), convention des navigateurs`,
  });

  console.log(`Raccourcis d onglet : OK (Ctrl+1 et Ctrl+9 traversent xterm, ${tabCount} onglets).`);
}

/**
 * The Azure and GCP imports are reachable, and their commands are registered.
 *
 * This is the scenario that answers "can the user actually get there" — the
 * question that `cargo check`, clippy and `tsc` all answered yes to while the
 * MongoDB tab was unreachable. It walks the real path: Hôtes → Ajouter… →
 * Importer depuis le cloud → the provider picker → each provider's own panel.
 *
 * The backend half asserts something subtler than "it worked". Neither CLI can
 * be expected to be installed *and* signed in on a test machine — under WSL
 * neither is, and on Windows the Azure session may well have lapsed. So what
 * is asserted is that the failure is **typed**: a registered command answers
 * with a `CloudCliError` variant, while an unregistered one rejects with
 * Tauri's own "command not found" string and no `reason.kind` at all. That
 * tells a missing registration apart from an absent CLI, which is exactly the
 * distinction a plain try/catch would lose.
 */
async function runCloudImportScenario(browser) {
  await browser.execute(() => {
    const tab = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.getAttribute("title") || "") === "Hôtes");
    if (tab instanceof HTMLElement) tab.click();
  });

  for (const [provider, title] of [["azure", "Importer depuis Azure"], ["gcp", "Importer depuis GCP"]]) {
    // `pickCloudProvider` also asserts all three providers are offered — a
    // picker that silently lost one is a provider nobody can reach any more,
    // and nothing else in the suite would notice.
    await pickCloudProvider(browser, provider);
    await browser.waitUntil(async () => await browser.execute((t) =>
      Array.from(document.querySelectorAll("p")).some((el) => el.textContent?.trim() === t), title,
    ), { timeout: 5_000, timeoutMsg: `le panneau « ${title} » ne s est pas ouvert` });

    // The sign-in panel is the whole answer to "an expired session is a dead
    // end": if this entry point disappears, the only remedy left is a message
    // telling the user to go and run `az login` somewhere else. Nothing else
    // in the suite would notice, so it is asserted here.
    if (provider === "azure") {
      await clickButtonByText(browser, "Ajouter un abonnement / changer de compte…");
      await browser.waitUntil(async () => await browser.execute(() =>
        Array.from(document.querySelectorAll("p")).some((el) => el.textContent?.trim() === "Se connecter à Azure")
      ), { timeout: 5_000, timeoutMsg: "le panneau de connexion Azure ne s est pas ouvert" });
      // Not clicking "Se connecter": that would spawn a real `az login` and
      // block on a browser nobody is going to complete.
      await closeDialogTitled(browser, "Se connecter à Azure");
      console.log("Import cloud : panneau de connexion Azure atteignable.");
    }

    await closeDialogTitled(browser, title);
  }

  const KINDS = ["cliMissing", "notLoggedIn", "refused", "unreadable"];
  for (const command of ["list_azure_subscriptions", "list_gcp_projects"]) {
    const answer = await browser.execute(async (name) => {
      try {
        return { ok: await window.__TAURI_INTERNALS__.invoke(name) };
      } catch (e) {
        // Keep the shape, not just the text: `reason.kind` is the whole point.
        return { failed: typeof e === "object" && e !== null ? e : String(e) };
      }
    }, command);

    if (answer.ok !== undefined) {
      if (!Array.isArray(answer.ok)) {
        throw new Error(`invoke("${command}") n a pas rendu un tableau : ${JSON.stringify(answer.ok)}`);
      }
      console.log(`Import cloud : ${command} a répondu ${answer.ok.length} entrée(s).`);
      continue;
    }
    const kind = answer.failed?.reason?.kind;
    if (!KINDS.includes(kind)) {
      throw new Error(
        `invoke("${command}") a échoué sans raison typée — commande non enregistrée ? ` +
        `reçu : ${JSON.stringify(answer.failed)}`,
      );
    }
    console.log(`Import cloud : ${command} a échoué proprement (${kind}), commande bien enregistrée.`);
  }
  console.log("Import cloud : OK (sélecteur, panneaux Azure et GCP atteignables, commandes typées).");
}

/**
 * The drift check reaches the backend and refuses a program it can't parse.
 *
 * Run against an *empty* host list on purpose: the answer is then an empty
 * report, which touches nobody's infrastructure while still proving the whole
 * command → parser → response path is wired. The parse failure is the half
 * worth asserting — the check goes through the same strict parser as a run, so
 * a program that wouldn't execute must not be silently "checked" either.
 */
async function runDriftScenario(browser) {
  const empty = await browser.execute(async () => {
    try {
      return { value: await window.__TAURI_INTERNALS__.invoke("check_drift", {
        hostIds: [],
        programText: "install-package nginx",
      }) };
    } catch (e) {
      return { __error: String(e) };
    }
  });
  if (empty.__error !== undefined) {
    throw new Error(`invoke("check_drift") a échoué : ${empty.__error}`);
  }
  if (!Array.isArray(empty.value) || empty.value.length !== 0) {
    throw new Error(`aucun hôte doit donner un rapport vide, reçu : ${JSON.stringify(empty.value)}`);
  }

  const rejected = await browser.execute(async () => {
    try {
      return { __unexpected: await window.__TAURI_INTERNALS__.invoke("check_drift", {
        hostIds: [],
        programText: "target inconnu: x\ninstall-package nginx",
      }) };
    } catch (e) {
      return { message: String(e) };
    }
  });
  if (rejected.__unexpected !== undefined) {
    throw new Error("un programme invalide doit être refusé, pas vérifié");
  }
  if (!/inconnu/.test(rejected.message)) {
    throw new Error(`le refus doit nommer le champ fautif, reçu : ${rejected.message}`);
  }
  console.log("Dérive : OK (sonde atteignable, et un programme invalide est refusé).");
}

/**
 * A run that carries no DSL program is refused a rollback, by the backend
 * itself — not just greyed out in the UI.
 *
 * The refusal is the contract worth pinning down: the alternative to failing
 * here is inferring operations back out of rendered shell, which would undo
 * *something* on real machines and possibly not what the user asked. A
 * disabled button proves nothing on its own — a future refactor could re-enable
 * it — so this asserts the command rejects.
 *
 * Uses a run id that cannot exist: an absent run and a run with no program are
 * both "nothing to undo here", and neither may answer with a plan. Touches no
 * infrastructure and mutates nothing.
 */
async function runRollbackScenario(browser) {
  const refused = await browser.execute(async () => {
    try {
      const plan = await window.__TAURI_INTERNALS__.invoke("preview_rollback", {
        runId: "00000000-0000-4000-8000-000000000000",
      });
      return { __unexpected: plan };
    } catch (e) {
      return { message: String(e) };
    }
  });
  if (refused.__unexpected !== undefined) {
    throw new Error(
      `preview_rollback a rendu un plan pour un run inexistant : ${JSON.stringify(refused.__unexpected)}`,
    );
  }
  if (!refused.message) {
    throw new Error("preview_rollback a échoué sans message exploitable");
  }
  console.log("Rollback : OK (un run sans programme enregistré est refusé côté backend).");
}

/**
 * The certificate field exists under "Clé privée", and its prefill really
 * reaches the backend.
 *
 * Nothing is saved: the form is opened for a *new* host and cancelled, so the
 * developer's workspace is untouched. What this covers is the half the Rust
 * tests can't — that the field is rendered at all, and only for the key method
 * — plus one real `invoke` of `suggest_certificate_path`, which is the wiring
 * that a unit test would have to mock away.
 *
 * The authentication itself is proved against a real `sshd` with a real CA in
 * `core/tests/ssh_integration.rs`; there is no way to prove it from here
 * without an infrastructure of someone's own.
 */
async function runCertificateFieldScenario(browser) {
  await browser.execute(() => {
    const tab = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.getAttribute("title") || "") === "Hôtes");
    if (tab instanceof HTMLElement) tab.click();
  });
  const opened = await browser.execute(() => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.getAttribute("title") || "").startsWith("Nouvel hôte") || b.textContent?.trim() === "Nouvel hôte");
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  });
  if (!opened) {
    console.log("Certificat SSH : ignoré (bouton « Nouvel hôte » introuvable).");
    return;
  }

  await browser.waitUntil(async () => await browser.execute(() =>
    document.querySelector('select') !== null
  ), { timeout: 5_000, timeoutMsg: "le formulaire d hôte ne s est pas ouvert" });

  // Switch the auth method to "Clé privée" through React's own event, not by
  // assigning `.value` — a direct assignment updates the DOM without telling
  // React, so the field below would never appear and the scenario would fail
  // for a reason that has nothing to do with the feature.
  const switched = await browser.execute(() => {
    const select = Array.from(document.querySelectorAll("select"))
      .find((s) => Array.from(s.options).some((o) => o.value === "privateKey"));
    if (!(select instanceof HTMLSelectElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(select, "privateKey");
    select.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  if (!switched) throw new Error("aucun sélecteur de méthode d authentification ne propose « privateKey »");

  await browser.waitUntil(async () => await browser.execute(() =>
    Array.from(document.querySelectorAll("input"))
      .some((i) => (i.getAttribute("placeholder") || "").includes("-cert.pub"))
  ), {
    timeout: 5_000,
    timeoutMsg: "le champ Certificat n apparaît pas sous la méthode « Clé privée »",
  });

  // The prefill's backend call, exercised for real. A path with no certificate
  // beside it must answer `null` rather than inventing one — that is the whole
  // contract, and an unregistered command would reject here instead.
  const suggestion = await browser.execute(async () => {
    try {
      return {
        value: await window.__TAURI_INTERNALS__.invoke("suggest_certificate_path", {
          keyPath: "/nowhere/at/all/id_ed25519",
        }),
      };
    } catch (e) {
      return { __error: String(e) };
    }
  });
  if (!suggestion || suggestion.__error !== undefined) {
    throw new Error(`invoke("suggest_certificate_path") a échoué : ${JSON.stringify(suggestion)}`);
  }
  if (suggestion.value !== null) {
    throw new Error(`une clé sans certificat à côté doit donner null, reçu : ${JSON.stringify(suggestion.value)}`);
  }

  await clickButtonByText(browser, "Annuler");
  console.log("Certificat SSH : OK (champ présent sous « Clé privée », suggestion interrogée pour de vrai).");
}

/**
 * The activity journal, opened from the palette and read for real.
 *
 * This scenario runs *after* the local-terminal one above, which submits an
 * `echo E2E_CHANNEL_…` — so by the time we get here the command history has a
 * freshly timestamped entry, and finding it proves the whole chain: terminal →
 * `append_local_history` → the migrated on-disk format → `list_activity` →
 * the tab. That ordering is load-bearing; moving this call earlier makes the
 * assertion vacuous rather than failing, which is the worse outcome.
 */
async function runActivityScenario(browser) {
  await browser.keys(["Control", "k"]);
  for (const ch of "activit") await browser.keys(ch);
  await browser.keys("Enter");

  await browser.waitUntil(async () => await browser.execute(() =>
    Array.from(document.querySelectorAll("h2")).some((h) => h.textContent?.trim() === "Activité")
  ), { timeout: 10_000, timeoutMsg: "l onglet Activité ne s est pas ouvert depuis la palette" });

  // The command this very run typed into the local terminal, read back
  // through the journal — not a fixture, and not a command that could have
  // been on this machine already.
  try {
    await browser.waitUntil(async () => await browser.execute(() =>
      document.body.innerText.includes("E2E_CHANNEL_")
    ), {
      timeout: 10_000,
      timeoutMsg: "la commande saisie plus tôt dans ce test n apparaît pas dans le journal d activité",
    });
  } catch (e) {
    // The wait alone can't say whether the backend returned nothing, returned
    // events the tab failed to render, or rejected outright — print all three
    // so a CI failure is diagnosable without reproducing locally.
    const probe = await browser.execute(async () => {
      try {
        const events = await window.__TAURI_INTERNALS__.invoke("list_activity", { filter: {} });
        return { count: events.length, first: events.slice(0, 3) };
      } catch (err) {
        return { __error: String(err) };
      }
    });
    console.log("list_activity a répondu :", JSON.stringify(probe));
    const rendered = await browser.execute(() => {
      const heading = Array.from(document.querySelectorAll("h2")).find((h) => h.textContent?.trim() === "Activité");
      const panel = heading?.closest("div.flex.h-full");
      return {
        headingFound: !!heading,
        panelHidden: panel?.parentElement?.className ?? "<pas de parent>",
        bodyStart: document.body.innerText.slice(0, 300),
        panelText: (panel?.textContent ?? "").slice(0, 300),
      };
    });
    console.log("état du rendu :", JSON.stringify(rendered));
    throw e;
  }

  // The export path, exercised without a file dialog (which WebDriver can't
  // drive): the command is what the button calls, and an unregistered one
  // rejects here. Written to the OS temp dir, and the count is what proves it
  // exported the *filtered* set rather than an empty one.
  const exported = await browser.execute(async () => {
    try {
      const path = `${window.navigator.userAgent.includes("Windows") ? "C:\\\\Windows\\\\Temp" : "/tmp"}/guiterm-e2e-activity.csv`;
      return { count: await window.__TAURI_INTERNALS__.invoke("export_activity", { path, format: "csv" }) };
    } catch (e) {
      return { __error: String(e) };
    }
  });
  if (!exported || exported.__error !== undefined) {
    throw new Error(`invoke("export_activity") a échoué : ${JSON.stringify(exported)}`);
  }
  if (typeof exported.count !== "number" || exported.count < 1) {
    throw new Error(`l export doit compter au moins l évènement qu on vient de lire, reçu : ${JSON.stringify(exported)}`);
  }

  // An unknown format must be refused rather than writing something wrong to
  // a path the user chose.
  const refused = await browser.execute(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke("export_activity", { path: "/tmp/nope", format: "xlsx" });
      return { accepted: true };
    } catch (e) {
      return { rejected: String(e) };
    }
  });
  if (refused?.accepted) {
    throw new Error("un format d export inconnu a été accepté");
  }

  console.log("Activité : OK (onglet ouvert depuis la palette, commande de ce test retrouvée, export réel).");
}

/**
 * The SSM tunnel mode, from the connection form down to the real command.
 *
 * Two halves, because the feature has failed in both places before in this
 * repo: that the mode is *reachable* (a backend nobody can select is the
 * MongoDB failure — see `docs/dev-history.md`), and that its command is
 * registered and answers the documented shape.
 *
 * The probe uses an instance id that cannot exist, so the outcome is always
 * `failed`. That is the assertion: a *typed* failure means the whole path ran
 * — command registered, spec built, `aws` launched or reported missing,
 * output classified. An unregistered command rejects instead, which is what
 * this catches. Nothing is written and no real instance is contacted.
 */
/**
 * Un tunnel se crée, se modifie et se supprime **entièrement depuis l'UI**.
 *
 * Tout passe par des clics réels, y compris la création : une première version
 * appelait `add_forward` par `invoke` et échouait — la commande écrivait bien
 * côté Rust, mais l'état React d'`App` n'en savait rien, donc le panneau
 * restait vide et le bouton « Modifier » n'existait jamais. Un raccourci par
 * `invoke` teste le backend, pas le chemin que l'utilisateur emprunte.
 *
 * L'assertion qui porte la demande n'est pas seulement « Modifier existe »
 * mais aussi « Supprimer n'est plus un bouton de la ligne » : un bouton ajouté
 * à côté de l'ancien passerait autrement pour un succès.
 *
 * Le tunnel est créé sur le premier hôte du workspace réel avec un port haut,
 * n'est **jamais démarré** (aucune connexion SSH ouverte), et est supprimé par
 * le bouton du formulaire — ce qui fait de son propre nettoyage la dernière
 * assertion du scénario.
 */
/** Écrit dans un champ contrôlé par React.
 *
 * `input.value = …` seul ne suffit pas : React installe son propre setter sur
 * le prototype et ne verrait jamais la valeur. Il faut appeler le setter natif
 * puis émettre l'événement que React écoute. */
async function setFieldByLabel(browser, label, value) {
  const ok = await browser.execute((wanted, v) => {
    // Scopé au formulaire d'hôte : le panneau d'édition en lot peut être
    // ouvert en même temps et porte des champs « Adresse »/« Utilisateur »
    // homonymes. Sans ce scope, la saisie partait dedans et le formulaire
    // refusait avec « Adresse et utilisateur sont requis » — constaté.
    const heading = Array.from(document.querySelectorAll("h2"))
      .find((h) => h.textContent?.trim() === "Nouvel hôte" || h.textContent?.trim() === "Modifier l'hôte");
    const form = heading?.closest("div");
    const holder = Array.from((form ?? document).querySelectorAll("label"))
      .find((l) => l.querySelector("span")?.textContent?.trim() === wanted);
    const input = holder?.querySelector("input");
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, label, value);
  if (!ok) throw new Error(`champ « ${label} » introuvable dans le formulaire`);
}

/** Même chose, mais pour un champ désigné par son `placeholder` : le
 * formulaire de connexion SQL n'utilise pas de libellés séparés. */
async function setFieldByPlaceholder(browser, heading, placeholder, value) {
  const ok = await browser.execute((headingText, ph, v) => {
    const h = Array.from(document.querySelectorAll("h2")).find((el) => el.textContent?.trim() === headingText);
    const form = h?.closest("div");
    const input = Array.from((form ?? document).querySelectorAll("input"))
      .find((i) => (i.getAttribute("placeholder") || "").startsWith(ph));
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, heading, placeholder, value);
  if (!ok) throw new Error(`champ « ${placeholder} » introuvable dans « ${heading} »`);
}

/**
 * L'onglet d'une base de données, monté dans la vraie fenêtre.
 *
 * C'est la famille d'onglets où MongoDB était resté inatteignable : backend
 * complet, commandes enregistrées, tests verts, mais aucun chemin depuis
 * l'interface. Rien ne montait un `SqlConnectionTab` dans une vraie fenêtre —
 * ce scénario referme ça pour de bon.
 *
 * Comme pour le terminal SSH : la connexion vise 127.0.0.1:1, elle échoue
 * immédiatement, et ce qu'on vérifie est que l'onglet monte.
 */
async function runSqlTabScenario(browser) {
  const LABEL = `e2e-sql-${Date.now()}`;
  const HEADING = "Nouvelle connexion SQL";

  await browser.execute(() => {
    const btn = Array.from(document.querySelectorAll("aside nav button"))
      .find((b) => (b.getAttribute("title") || "") === "Bases de données");
    if (btn instanceof HTMLElement) btn.click();
  });
  await clickButtonContaining(browser, "Ajouter une connexion");

  await browser.waitUntil(async () => await browser.execute((h) =>
    Array.from(document.querySelectorAll("h2")).some((el) => el.textContent?.trim() === h), HEADING,
  ), { timeout: 10_000, timeoutMsg: "le formulaire de connexion SQL ne s est pas ouvert" });

  await setFieldByPlaceholder(browser, HEADING, "Nom", LABEL);
  await setFieldByPlaceholder(browser, HEADING, "Adresse", "127.0.0.1");
  await setFieldByPlaceholder(browser, HEADING, "Port", "1");
  await setFieldByPlaceholder(browser, HEADING, "Utilisateur", "e2e");
  await clickButtonByText(browser, "Ajouter");

  const lookup = () => browser.execute(async (label) => {
    try {
      const ws = await window.__TAURI_INTERNALS__.invoke("get_workspace");
      return { id: ws.sqlConnections.find((c) => c.label === label)?.id ?? null };
    } catch (e) {
      return { __error: String(e) };
    }
  }, LABEL);

  try {
    await browser.waitUntil(async () => !!(await lookup()).id,
      { timeout: 10_000, timeoutMsg: "la connexion SQL de test n a pas été enregistrée" });
  } catch (e) {
    const formError = await browser.execute(() =>
      Array.from(document.querySelectorAll("p")).map((p) => p.textContent?.trim()).filter((t) => t && t.length < 200).slice(0, 12),
    );
    console.log("Textes du formulaire au moment de l échec :", JSON.stringify(formError));
    throw e;
  }
  const created = await lookup();

  try {
    const tabsBefore = await browser.execute(() => document.querySelectorAll("[data-tab-id]").length);
    // La carte porte le libellé ; l'action est un bouton « Connexion » à
    // l'intérieur, pas la carte elle-même.
    const clicked = await browser.execute((label) => {
      const card = Array.from(document.querySelectorAll("aside div"))
        .find((d) => d.querySelector("span")?.textContent?.trim() === label && d.querySelector("button"));
      const connect = Array.from(card?.querySelectorAll("button") ?? [])
        .find((b) => b.textContent?.trim() === "Connexion");
      if (!connect) return false;
      connect.click();
      return true;
    }, LABEL);
    if (!clicked) throw new Error("le bouton « Connexion » de la carte de test est introuvable");

    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelectorAll("[data-tab-id]").length)) > tabsBefore,
      { timeout: 10_000, timeoutMsg: "cliquer sur « Connexion » n a pas ouvert d onglet" },
    );

    // L'arborescence bases/tables est le squelette de `SqlConnectionTab` : elle
    // s'affiche avant même qu'une connexion réussisse, donc sa présence prouve
    // le montage sans dépendre d'un serveur.
    await browser.waitUntil(async () => await browser.execute(() => {
      const panes = Array.from(document.querySelectorAll("div.absolute.inset-0"));
      const active = panes.find((p) => !p.classList.contains("hidden"));
      return !!active && (active.textContent || "").length > 0;
    }), { timeout: 20_000, timeoutMsg: "l onglet de base de données est resté vide — le module n a rien rendu" });

    console.log("Base de données : OK (connexion créée, onglet ouvert depuis le panneau, composant monté).");
  } finally {
    const cleanup = await browser.execute(async (id) => {
      try {
        await window.__TAURI_INTERNALS__.invoke("delete_sql_connection", { connectionId: id });
        return { ok: true };
      } catch (e) {
        return { __error: String(e) };
      }
    }, created.id);
    if (!cleanup || cleanup.__error !== undefined) {
      throw new Error(`la connexion de test n a pas pu être supprimée, workspace pollué : ${JSON.stringify(cleanup)}`);
    }
  }
}

/**
 * L'onglet terminal SSH, monté dans la vraie fenêtre.
 *
 * Ajouté avec la migration de `terminal`/`transfer`/`rdp` vers `src/modules/` :
 * ces trois-là étaient le morceau risqué du chantier (poignées de terminal,
 * split pane, broadcast) et **aucun scénario ne les montait**, faute d'hôte à
 * viser. Les tests unitaires prouvent qu'un rendu est enregistré, pas que
 * xterm s'attache pour de bon.
 *
 * L'hôte est créé pour l'occasion sur `127.0.0.1:1` — la connexion est donc
 * refusée immédiatement, sans attente réseau, ce qui suffit : ce qu'on vérifie
 * est que `TerminalTab` a monté, pas qu'une session s'ouvre. Il est supprimé
 * dans tous les cas, y compris en cas d'échec, pour ne pas laisser de déchet
 * dans le vrai workspace.
 */
async function runSshTerminalTabScenario(browser) {
  const LABEL = `e2e-registre-${Date.now()}`;

  // Créé **par le formulaire**, pas par un `invoke` direct : c'est le chemin
  // qui met aussi à jour le workspace côté React. Un hôte écrit derrière le dos
  // de l'app n'apparaîtrait tout simplement pas dans le panneau (constaté).
  await browser.execute(() => {
    const btn = Array.from(document.querySelectorAll("aside nav button"))
      .find((b) => (b.getAttribute("title") || "") === "Hôtes");
    if (btn instanceof HTMLElement) btn.click();
  });
  await clickButtonByText(browser, "Ajouter…");
  await clickButtonByText(browser, "Nouvel hôte");
  await setFieldByLabel(browser, "Nom", LABEL);
  await setFieldByLabel(browser, "Adresse", "127.0.0.1");
  await setFieldByLabel(browser, "Utilisateur", "e2e");
  await clickButtonByText(browser, "Enregistrer");

  const lookup = () => browser.execute(async (label) => {
    try {
      const ws = await window.__TAURI_INTERNALS__.invoke("get_workspace");
      return { id: ws.hosts.find((h) => h.label === label)?.id ?? null };
    } catch (e) {
      return { __error: String(e) };
    }
  }, LABEL);

  try {
    await browser.waitUntil(async () => !!(await lookup()).id,
      { timeout: 10_000, timeoutMsg: "l hôte de test n a pas été enregistré" });
  } catch (e) {
    // Le formulaire refuse en affichant son propre message — le lire vaut
    // mieux que de deviner quel champ manque.
    const formError = await browser.execute(() =>
      Array.from(document.querySelectorAll("p")).map((p) => p.textContent?.trim()).filter((t) => t && t.length < 200).slice(0, 12),
    );
    console.log("Textes du formulaire au moment de l échec :", JSON.stringify(formError));
    throw e;
  }
  const created = await lookup();

  try {
    const tabsBefore = await browser.execute(() => document.querySelectorAll("[data-tab-id]").length);

    // Un simple clic sur la ligne ouvre la connexion — c'est le chemin qui
    // traverse `openTab` puis le registre.
    await browser.execute((label) => {
      const row = Array.from(document.querySelectorAll("aside button"))
        .find((el) => el.textContent?.trim().startsWith(label));
      if (row instanceof HTMLElement) row.click();
    }, LABEL);

    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelectorAll("[data-tab-id]").length)) > tabsBefore,
      { timeout: 10_000, timeoutMsg: "cliquer sur l hôte n a pas ouvert d onglet" },
    );

    // Le terminal du nouvel onglet actif. `.xterm-screen` n'existe que si
    // xterm s'est réellement attaché à un conteneur monté — c'est ce qu'un
    // rendu de module qui ne serait jamais appelé ne produirait pas.
    await browser.waitUntil(async () => await browser.execute(() => {
      const panes = Array.from(document.querySelectorAll("div.absolute.inset-0"));
      return panes.some((p) => !p.classList.contains("hidden") && p.querySelector(".xterm-screen"));
    }), { timeout: 20_000, timeoutMsg: "l onglet terminal SSH n a pas monté xterm" });

    console.log("Terminal SSH : OK (hôte créé, onglet ouvert depuis le panneau Hôtes, xterm attaché).");
  } finally {
    const cleanup = await browser.execute(async (id) => {
      try {
        await window.__TAURI_INTERNALS__.invoke("delete_host", { hostId: id });
        return { ok: true };
      } catch (e) {
        return { __error: String(e) };
      }
    }, created.id);
    if (!cleanup || cleanup.__error !== undefined) {
      throw new Error(`l hôte de test n a pas pu être supprimé, workspace pollué : ${JSON.stringify(cleanup)}`);
    }
  }
}

/**
 * L'onglet Opérations de flotte, ouvert depuis la barre latérale.
 *
 * Ajouté avec la migration vers `src/modules/` : `netdiag` et `activity` ont
 * déjà leurs scénarios, mais rien ne montait `FleetTab` dans une vraie
 * fenêtre. `registry.test.ts` prouve qu'un rendu est enregistré pour ce
 * `kind`, pas que le composant qu'il renvoie s'affiche — et c'est le rendu qui
 * a changé de fichier.
 */
async function runFleetTabScenario(browser) {
  await browser.execute(() => {
    const btn = Array.from(document.querySelectorAll("aside nav button"))
      .find((b) => (b.getAttribute("title") || "").startsWith("Opérations de flotte"));
    if (btn instanceof HTMLElement) btn.click();
  });

  await browser.waitUntil(async () => await browser.execute(() =>
    Array.from(document.querySelectorAll("textarea")).some(
      (t) => (t.getAttribute("placeholder") || "").includes("Commande à exécuter sur les cibles"),
    )
  ), { timeout: 15_000, timeoutMsg: "l onglet Flotte ne s est pas rendu depuis la barre latérale" });

  // Le filtre de cibles est l'autre moitié du composant : sa présence
  // distingue « FleetTab a monté » de « un fallback de Suspense est resté ».
  const hasFilter = await browser.execute(() =>
    Array.from(document.querySelectorAll("input")).some(
      (i) => (i.getAttribute("placeholder") || "").startsWith("Filtrer (nom, groupe"),
    ));
  if (!hasFilter) throw new Error("l onglet Flotte est monté sans son filtre de cibles");

  console.log("Flotte : OK (onglet ouvert depuis la barre, composant monté avec son filtre et sa zone de commande).");
}

/**
 * Les neuf panneaux de la barre latérale, ouverts un par un.
 *
 * Ajouté avec la migration des panneaux vers `src/modules/` : `Sidebar.tsx`
 * n'a plus aucun dispatch, un panneau dont le module manquerait s'afficherait
 * simplement vide. `registry.test.ts` prouve qu'un rendu est enregistré pour
 * chacun ; seul ceci prouve qu'il monte pour de vrai.
 *
 * Un seul scénario en boucle plutôt que neuf : cinq panneaux étaient déjà
 * traversés par d'autres scénarios (hôtes, AWS, tunnels, bases, paramètres),
 * mais `knownHosts`, `sftp`, `snippets` et `keychain` n'étaient montés nulle
 * part — et c'est l'axe entier qui vient de changer de mécanisme.
 */
async function runSidebarPanelsScenario(browser) {
  const panels = [
    ["knownHosts", "Known Hosts"],
    ["hosts", "Hôtes"],
    ["sftp", "SFTP"],
    ["snippets", "Snippets"],
    ["tunnels", "Tunnels"],
    ["database", "Bases de données"],
    ["keychain", "Clés"],
    ["aws", "Identités AWS"],
    ["settings", "Paramètres"],
  ];

  for (const [kind, title] of panels) {
    const clicked = await browser.execute((t) => {
      const btn = Array.from(document.querySelectorAll("aside nav button"))
        .find((b) => (b.getAttribute("title") || "").split(" — ")[0].split("\n")[0] === t);
      if (!btn) return false;
      btn.click();
      return true;
    }, title);
    if (!clicked) throw new Error(`le bouton « ${title} » est absent de la barre latérale`);

    // Non vide : un module manquant laisserait le conteneur rendu mais sans
    // contenu, ce qu'aucune erreur ne signalerait par ailleurs.
    await browser.waitUntil(async () => await browser.execute((k) => {
      const host = document.querySelector(`[data-sidebar-panel="${k}"]`);
      return !!host && (host.textContent || "").trim().length > 0;
    }, kind), { timeout: 15_000, timeoutMsg: `le panneau « ${kind} » est resté vide` });
  }

  // Remettre la barre sur son panneau d'origine pour les scénarios suivants.
  await browser.execute(() => {
    const btn = Array.from(document.querySelectorAll("aside nav button"))
      .find((b) => (b.getAttribute("title") || "") === "Hôtes");
    if (btn instanceof HTMLElement) btn.click();
  });

  console.log(`Panneaux de la barre latérale : OK (${panels.length} panneaux ouverts, chacun rend du contenu).`);
}

/** Titres des boutons de la barre verticale, libellé seul (l'infobulle de
 * certains ajoute « — … »). */
function sidebarButtonTitles(browser) {
  return browser.execute(() =>
    Array.from(document.querySelectorAll("aside nav button"))
      .map((b) => (b.getAttribute("title") || "").split(" — ")[0].split("\n")[0]),
  );
}

function storedHiddenSidebarButtons(browser) {
  return browser.execute(() => {
    try {
      return JSON.parse(localStorage.getItem("gui-termius-prefs") ?? "{}").hiddenSidebarButtons ?? null;
    } catch {
      return null;
    }
  });
}

/** Coche/décoche une ligne du réglage, désignée par son libellé. `.click()`
 * natif plutôt qu'un élément WebdriverIO : React écoute l'événement `click`
 * pour les cases à cocher, donc `onChange` part bien. */
function toggleSidebarButtonRow(browser, label) {
  return browser.execute((wanted) => {
    const row = Array.from(document.querySelectorAll("label")).find(
      (l) => l.querySelector("span")?.textContent?.trim() === wanted && l.querySelector('input[type="checkbox"]'),
    );
    if (!row) return { found: false };
    const input = row.querySelector('input[type="checkbox"]');
    const before = input.checked;
    if (!input.disabled) input.click();
    return { found: true, disabled: input.disabled, before, after: input.checked };
  }, label);
}

/**
 * Masquer un bouton de la barre latérale, de bout en bout.
 *
 * `lib/sidebarButtons.test.ts` prouve la logique (catalogue exhaustif, repli,
 * `hosts` inmasquable) et `tsc` prouve qu'aucun bouton n'est sans icône — mais
 * aucun des deux ne prouve le **câblage** : que la case du panneau Paramètres
 * parle bien à la barre, et que le choix est réellement persisté. C'est
 * exactement le trou par lequel MongoDB était passé, d'où ce scénario.
 *
 * Le repli d'un panneau masqué pendant qu'il est ouvert n'est pas couvert ici :
 * ouvrir les Paramètres change déjà le panneau courant, donc la situation est
 * inatteignable depuis l'UI. Elle reste couverte par `resolveVisiblePanel` en
 * test unitaire.
 */
async function runSidebarButtonsScenario(browser) {
  await browser.execute(() => {
    const btn = Array.from(document.querySelectorAll("aside nav button"))
      .find((b) => (b.getAttribute("title") || "") === "Paramètres");
    if (btn instanceof HTMLElement) btn.click();
  });
  await browser.waitUntil(async () => await browser.execute(() =>
    Array.from(document.querySelectorAll("p")).some((p) => p.textContent?.trim() === "Boutons de la barre latérale")
  ), { timeout: 10_000, timeoutMsg: "la section « Boutons de la barre latérale » ne s est pas affichée dans Apparence" });

  // « Hôtes » est le point d'entrée : la case doit exister mais rester
  // inactionnable, sinon l'utilisateur peut s'enfermer hors de ses connexions.
  const hosts = await toggleSidebarButtonRow(browser, "Hôtes");
  if (!hosts.found) throw new Error("la ligne « Hôtes » est absente du réglage");
  if (!hosts.disabled) throw new Error("la ligne « Hôtes » est décochable : le point d entrée peut disparaître");
  if (!hosts.before) throw new Error("« Hôtes » n est pas coché alors qu il est toujours visible");

  // Remettre « Tunnels » visible plutôt que l'exiger : ces préférences sont
  // celles du vrai profil, et un run précédent interrompu au mauvais moment
  // aurait sinon fait échouer tous les suivants sur son propre résidu.
  const initial = await toggleSidebarButtonRow(browser, "Tunnels");
  if (!initial.found) throw new Error("la ligne « Tunnels » est absente du réglage");
  if (initial.before === false) {
    await browser.waitUntil(async () => (await sidebarButtonTitles(browser)).includes("Tunnels"),
      { timeout: 5_000, timeoutMsg: "« Tunnels » masqué par un run précédent n a pas pu être réaffiché" });
  } else {
    // Il était déjà visible : le clic ci-dessus vient de le masquer, on annule.
    await toggleSidebarButtonRow(browser, "Tunnels");
  }
  if (!(await sidebarButtonTitles(browser)).includes("Tunnels")) {
    throw new Error("« Tunnels » n est pas visible au moment de commencer le scénario");
  }

  const off = await toggleSidebarButtonRow(browser, "Tunnels");
  if (!off.found || off.before !== true || off.after !== false) {
    throw new Error(`décocher « Tunnels » n a pas pris : ${JSON.stringify(off)}`);
  }

  await browser.waitUntil(async () => !(await sidebarButtonTitles(browser)).includes("Tunnels"),
    { timeout: 5_000, timeoutMsg: "« Tunnels » est resté dans la barre après avoir été décoché" });

  const hidden = await storedHiddenSidebarButtons(browser);
  if (!Array.isArray(hidden) || !hidden.includes("tunnels")) {
    throw new Error(`le masquage n a pas été persisté dans les préférences : ${JSON.stringify(hidden)}`);
  }
  // Le réglage ne doit rien emporter d'autre avec lui.
  const remaining = await sidebarButtonTitles(browser);
  for (const kept of ["Hôtes", "Snippets", "Paramètres"]) {
    if (!remaining.includes(kept)) {
      throw new Error(`masquer « Tunnels » a aussi fait disparaître « ${kept} » : ${JSON.stringify(remaining)}`);
    }
  }

  const on = await toggleSidebarButtonRow(browser, "Tunnels");
  if (!on.found || on.after !== true) throw new Error(`recocher « Tunnels » n a pas pris : ${JSON.stringify(on)}`);
  await browser.waitUntil(async () => (await sidebarButtonTitles(browser)).includes("Tunnels"),
    { timeout: 5_000, timeoutMsg: "« Tunnels » n est pas revenu dans la barre après avoir été recoché" });

  // Ce scénario écrit dans les vraies préférences du profil : il doit les
  // laisser sans trace de son passage.
  const restored = await storedHiddenSidebarButtons(browser);
  if (Array.isArray(restored) && restored.includes("tunnels")) {
    throw new Error(`préférences non restaurées, « tunnels » toujours masqué : ${JSON.stringify(restored)}`);
  }

  console.log("Barre latérale : OK (case décochée → bouton retiré et persisté, recoché → revenu, « Hôtes » verrouillé).");
}

async function runTunnelEditScenario(browser) {
  const BIND_PORT = "59137";
  const NEW_PORT = "59138";

  await browser.execute(() => {
    const tab = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.getAttribute("title") || "") === "Tunnels");
    if (tab instanceof HTMLElement) tab.click();
  });

  await browser.waitUntil(async () => await browser.execute(() =>
    Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Ajouter un tunnel")
  ), { timeout: 10_000, timeoutMsg: "le panneau Tunnels ne s est pas ouvert" });

  await clickButtonByText(browser, "Ajouter un tunnel");

  const hasHost = await browser.execute(() => {
    const select = document.querySelector("select");
    return select instanceof HTMLSelectElement && select.options.length > 0 && select.value !== "";
  });
  if (!hasHost) {
    console.log("Modification de tunnel : ignoré (aucun hôte dans le workspace de cette machine).");
    await clickButtonByText(browser, "Ajouter un tunnel");
    return;
  }

  // Par les setters natifs + événement `input`, jamais par `.value = …` : une
  // affectation directe modifie le DOM sans prévenir React, et le formulaire
  // partirait avec des ports vides (même piège que `runNetDiagScenario`).
  const filled = await browser.execute((bind) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const ports = Array.from(document.querySelectorAll('input[placeholder="Port"]'));
    if (ports.length < 2) return false;
    setter.call(ports[0], bind);
    ports[0].dispatchEvent(new Event("input", { bubbles: true }));
    setter.call(ports[1], "5432");
    ports[1].dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, BIND_PORT);
  if (!filled) throw new Error("le formulaire d ajout de tunnel n expose pas ses deux champs de port");

  await clickButtonByText(browser, "Ajouter");

  await browser.waitUntil(async () => await browser.execute((port) =>
    Array.from(document.querySelectorAll("p")).some((p) => (p.textContent || "").includes(`127.0.0.1:${port}`)),
  BIND_PORT), { timeout: 5_000, timeoutMsg: "le tunnel ajouté n apparaît pas dans la liste" });

  const labels = await browser.execute(() =>
    Array.from(document.querySelectorAll("button")).map((b) => b.textContent?.trim()));
  if (!labels.includes("Modifier")) {
    throw new Error("la ligne de tunnel n offre pas de bouton « Modifier »");
  }
  if (labels.includes("Supprimer")) {
    throw new Error("« Supprimer » est encore un bouton de la ligne : il devait passer dans le formulaire de modification");
  }

  await clickButtonByText(browser, "Modifier");
  await browser.waitUntil(async () => await browser.execute(() => {
    const found = Array.from(document.querySelectorAll("button")).map((b) => b.textContent?.trim());
    return found.includes("Enregistrer") && found.includes("Supprimer ce tunnel");
  }), {
    timeout: 5_000,
    timeoutMsg: "« Modifier » n ouvre pas un formulaire portant « Enregistrer » et « Supprimer ce tunnel »",
  });

  // Le formulaire doit arriver rempli avec le tunnel existant, pas vide : une
  // modification qui repart de zéro écraserait ce qu'on ne touche pas.
  const prefilled = await browser.execute((port) => {
    const ports = Array.from(document.querySelectorAll('input[placeholder="Port"]'));
    return ports.some((i) => i.value === port);
  }, BIND_PORT);
  if (!prefilled) throw new Error("le formulaire de modification n est pas prérempli avec le tunnel choisi");

  const changed = await browser.execute((port) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const field = Array.from(document.querySelectorAll('input[placeholder="Port"]')).find((i) => i.value === "59137");
    if (!(field instanceof HTMLInputElement)) return false;
    setter.call(field, port);
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }, NEW_PORT);
  if (!changed) throw new Error("le champ de port du formulaire de modification est introuvable");

  await clickButtonByText(browser, "Enregistrer");

  await browser.waitUntil(async () => await browser.execute((port) =>
    Array.from(document.querySelectorAll("p")).some((p) => (p.textContent || "").includes(`127.0.0.1:${port}`)),
  NEW_PORT), { timeout: 10_000, timeoutMsg: "le nouveau port n apparaît pas dans la liste après enregistrement" });

  // Le nettoyage passe par le bouton du formulaire : c'est aussi la dernière
  // assertion, puisque « Supprimer ce tunnel » est ce que la demande a déplacé.
  await clickButtonByText(browser, "Modifier");
  await browser.waitUntil(async () => await browser.execute(() =>
    Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Supprimer ce tunnel")
  ), { timeout: 5_000, timeoutMsg: "le formulaire de modification n offre pas « Supprimer ce tunnel »" });
  await clickButtonByText(browser, "Supprimer ce tunnel");

  await browser.waitUntil(async () => await browser.execute((port) =>
    !Array.from(document.querySelectorAll("p")).some((p) => (p.textContent || "").includes(`127.0.0.1:${port}`)),
  NEW_PORT), { timeout: 10_000, timeoutMsg: "le tunnel de test n a pas été supprimé — il reste dans le workspace" });

  console.log("Modification de tunnel : OK (ajout, « Modifier » à la place de « Supprimer », formulaire prérempli, enregistrement, suppression depuis le formulaire).");
}

async function runSsmTunnelScenario(browser) {
  await browser.execute(() => {
    const tab = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.getAttribute("title") || "").toLowerCase().includes("base"));
    if (tab instanceof HTMLElement) tab.click();
  });
  const opened = await browser.execute(() => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "Ajouter une connexion");
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  });
  if (!opened) {
    console.log("Tunnel SSM : ignoré (bouton « Ajouter une connexion » introuvable).");
    return;
  }

  await browser.waitUntil(async () => await browser.execute(() =>
    Array.from(document.querySelectorAll("select")).some((s) => Array.from(s.options).some((o) => o.value === "ssm"))
  ), { timeout: 5_000, timeoutMsg: "le formulaire de connexion n offre pas le mode « ssm »" });

  // Through React's own event, not by assigning `.value`: a direct assignment
  // updates the DOM without telling React, so the SSM fields would never
  // appear and this would fail for a reason unrelated to the feature (same
  // trap as `runCertificateFieldScenario`).
  await browser.execute(() => {
    const select = Array.from(document.querySelectorAll("select"))
      .find((s) => Array.from(s.options).some((o) => o.value === "ssm"));
    if (!(select instanceof HTMLSelectElement)) return;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, "ssm");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });

  await browser.waitUntil(async () => await browser.execute(() =>
    Array.from(document.querySelectorAll("input")).some((i) => (i.getAttribute("placeholder") || "").includes("Instance SSM"))
  ), {
    timeout: 5_000,
    timeoutMsg: "choisir « Tunnel AWS SSM » n affiche pas le champ d instance — le mode est inatteignable",
  });

  const probe = await browser.execute(async () => {
    try {
      return { value: await window.__TAURI_INTERNALS__.invoke("test_ssm_tunnel", {
        target: "i-00000000000000000",
        profile: null,
        region: null,
        address: "127.0.0.1",
        port: 5432,
      }) };
    } catch (e) {
      return { __error: String(e) };
    }
  });
  if (!probe || probe.__error !== undefined) {
    throw new Error(`invoke("test_ssm_tunnel") a échoué : ${JSON.stringify(probe)}`);
  }
  if (probe.value?.kind !== "failed" || typeof probe.value.message !== "string") {
    throw new Error(`une instance inexistante doit rendre un échec typé, reçu : ${JSON.stringify(probe.value)}`);
  }

  await clickButtonByText(browser, "Annuler");
  console.log("Tunnel SSM : OK (mode sélectionnable, champs affichés, test_ssm_tunnel répond un échec typé).");
}

/**
 * The network diagnostics tab runs a real diagnostic, end to end.
 *
 * Replaces the reachability-panel scenario, which this tab absorbed. Opened
 * from the command palette rather than from a host's menu — the other entry
 * point — because that one needs a host to exist in the developer's real
 * workspace, and a test that only runs on some machines proves nothing on the
 * others.
 *
 * Diagnoses `127.0.0.1` **from this machine only**, so nothing touches anyone's
 * infrastructure: the round trip stays local while still going through
 * `invoke` → fleet executor → local shell → the real scripts. That also makes
 * it the one automated check of the flavour split — under WSL the local target
 * is POSIX, on Windows it is PowerShell, and each platform exercises its own
 * scripts here.
 *
 * The assertion is that verdicts come back for both tools, not which ones:
 * whether an sshd happens to be listening is not this test's business.
 */
async function runNetDiagScenario(browser) {
  await browser.keys(["Control", "k"]);
  for (const ch of "Diagnostic") await browser.keys(ch);
  await browser.keys("Enter");

  await browser.waitUntil(async () => await browser.execute(() =>
    Array.from(document.querySelectorAll("h2")).some((el) => el.textContent?.trim() === "Diagnostic réseau")
  ), { timeout: 10_000, timeoutMsg: "l onglet de diagnostic ne s est pas ouvert depuis la palette" });

  // The destination is the tab's first text input; the local machine is
  // preselected as the source, which is what the palette's way in means.
  const filled = await browser.execute(() => {
    const input = document.querySelector('input[placeholder^="Adresse à joindre"]');
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "127.0.0.1");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  });
  if (!filled) throw new Error("le champ adresse du diagnostic est introuvable");

  const started = await browser.execute(() => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.textContent || "").startsWith("Lancer sur"));
    if (!(button instanceof HTMLElement) || button.disabled) return false;
    button.click();
    return true;
  });
  if (!started) throw new Error("bouton « Lancer sur … » introuvable ou désactivé");

  // TCP and DNS are both on by default, so two cells must fill in. Each
  // rendered verdict is a button carrying its explanation as a `title` —
  // waiting on that is waiting on `describeVerdict` having run over a real
  // backend answer. (It was a `span` until the cells became unfoldable; the
  // scenario caught the change, which is the point of asserting on the DOM.)
  await browser.waitUntil(async () => (await browser.execute(() =>
    document.querySelectorAll("table td button[title]").length
  )) >= 2, {
    timeout: 60_000,
    timeoutMsg: "aucun verdict de diagnostic — la sonde n atteint pas le backend",
  });

  const verdicts = await browser.execute(() =>
    Array.from(document.querySelectorAll("table td button[title]"), (el) => el.textContent?.trim()),
  );
  console.log(`Diagnostic réseau : OK (palette → onglet → sonde réelle locale, verdicts : ${verdicts.join(" | ")}).`);

  // The other direction is a different execution path entirely — N local
  // processes rather than the fleet executor, because `run_on_hosts` is keyed
  // by target and every probe here runs on `Local`. Asserting the command is
  // registered and typed is what tells that apart from a wiring mistake.
  const toHosts = await browser.execute(async () => {
    try {
      return { ok: await window.__TAURI_INTERNALS__.invoke("run_netdiag_to_hosts", {
        runId: "e2e", hostIds: [], tools: [{ kind: "dns" }],
      }) };
    } catch (e) {
      return { failed: String(e) };
    }
  });
  // An empty host list must be refused with a sentence, not accepted silently.
  if (!/au moins un h/i.test(toHosts.failed ?? "")) {
    throw new Error(`run_netdiag_to_hosts doit refuser une liste vide en le disant, reçu : ${JSON.stringify(toHosts)}`);
  }
  console.log("Diagnostic réseau : OK (sens « vers les hôtes » enregistré, liste vide refusée explicitement).");
}

/**
 * The AWS identities sidebar tab is reachable, loads, and opens the SSO panel.
 *
 * This is the assertion the MongoDB release didn't have: a backend that
 * answers, commands registered, bindings typed — and a tab nothing renders.
 * `tauriCommands.test.ts` catches an unreachable *command*; only clicking the
 * tab catches an unreachable *panel*.
 *
 * The verdict waited for is deliberately "the panel finished loading, however
 * that turned out": with no `aws` CLI on the machine the honest outcome is the
 * failure block, and demanding a listing would make this fail for the wrong
 * reason. Nothing is written — the panel only reads until a button is pressed.
 */
async function runAwsIdentitiesPanelScenario(browser) {
  await browser.execute(() => {
    const tab = Array.from(document.querySelectorAll("button"))
      .find((b) => (b.getAttribute("title") || "") === "Identités AWS");
    if (tab instanceof HTMLElement) tab.click();
  });

  // Lazy-loaded like every other sidebar panel: the chunk resolves a tick
  // after the click.
  await browser.waitUntil(async () => await browser.execute(() =>
    Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Nouvelle session SSO")
  ), { timeout: 10_000, timeoutMsg: "l onglet Identités AWS ne rend rien — onglet inerte ou panneau jamais monté" });

  const panelText = () => browser.execute(() => document.querySelector("aside")?.textContent ?? "");
  await browser.waitUntil(async () => {
    const text = await panelText();
    return text.includes("Aucune identité AWS")
      || text.includes("Sans session SSO")
      || text.includes("Se connecter")
      || text.includes("Ajouter des profils")
      || text.includes("introuvable")
      || text.includes("aws");
  }, {
    timeout: 30_000,
    timeoutMsg: "le panneau des identités n a jamais rendu de verdict — les commandes n atteignent pas le backend",
  });

  // "No session configured" and "the command never answered" render almost
  // identically — an empty list either way. This distinguishes them, and is
  // what catches a command dropped from `generate_handler!` or renamed on one
  // side only. It really did fail here first, against a binary built before
  // the command existed.
  if ((await panelText()).includes("Les sessions SSO n'ont pas pu être lues")) {
    throw new Error("list_aws_sso_status n a pas repondu — commande absente du binaire ou renommee d un seul cote");
  }

  // The SSO modal opens from the sidebar too, not only from the import panels
  // — same z-index question, and here the opener is behind rather than above.
  await clickButtonByText(browser, "Nouvelle session SSO");
  await browser.waitUntil(async () => await browser.execute(() => {
    const heading = Array.from(document.querySelectorAll("p"))
      .find((el) => el.textContent?.trim() === "Configurer une session SSO");
    const dialog = heading?.closest("div.flex.max-h-full");
    if (!dialog) return false;
    const topmost = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return !!topmost && dialog.contains(topmost);
  }), {
    timeout: 5_000,
    timeoutMsg: "le panneau SSO ne s ouvre pas depuis l onglet Identités AWS",
  });
  await closeDialogTitled(browser, "Configurer une session SSO");
  console.log("Identités AWS : OK (onglet atteignable, backend interrogé, panneau SSO ouvrable).");
}

/**
 * The SSO setup panel opens from the EC2 import panel and its form works.
 *
 * Stops short of pressing Connect: that runs a real `aws sso login`, which
 * opens a browser and waits for a human. What is checked is everything up to
 * it — the entry point exists, the form mounts, and the action is only enabled
 * once the three fields it needs are filled, which is the part a user hits
 * first and the part no unit test can see.
 */
async function runAwsSsoPanelScenario(browser) {
  await clickButtonByText(browser, "Configurer une session SSO…");

  const panelText = () => browser.execute(() => {
    const heading = Array.from(document.querySelectorAll("p"))
      .find((el) => el.textContent?.trim() === "Configurer une session SSO");
    return heading?.closest("div.flex.max-h-full")?.textContent ?? "";
  });
  await browser.waitUntil(async () => (await panelText()).length > 0, {
    timeout: 5_000,
    timeoutMsg: "le panneau de configuration SSO ne s est pas ouvert",
  });

  const connectDisabled = () => browser.execute(() => {
    const button = Array.from(document.querySelectorAll("button"))
      .find((b) => b.textContent?.trim() === "Se connecter");
    return button instanceof HTMLButtonElement ? button.disabled : null;
  });
  if ((await connectDisabled()) !== true) {
    throw new Error("« Se connecter » doit rester desactive tant que le formulaire est vide");
  }

  const fill = async (labelPrefix, value) => {
    const done = await browser.execute((prefix, text) => {
      const holder = Array.from(document.querySelectorAll("label"))
        .find((el) => el.textContent?.trim().startsWith(prefix));
      const input = holder?.querySelector("input");
      if (!input) return false;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set?.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }, labelPrefix, value);
    if (!done) throw new Error(`champ « ${labelPrefix} » introuvable`);
  };
  await fill("Nom de la session", "e2e-session");
  await fill("URL du portail", "https://exemple.awsapps.com/start");

  await browser.waitUntil(async () => (await connectDisabled()) === false, {
    timeout: 5_000,
    timeoutMsg: "« Se connecter » est reste desactive alors que le formulaire est rempli",
  });

  await closeDialogTitled(browser, "Configurer une session SSO");
  console.log("Session SSO : OK (panneau atteignable depuis l import EC2, formulaire fonctionnel).");
}
