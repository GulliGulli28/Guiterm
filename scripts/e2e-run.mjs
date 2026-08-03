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

  await runZoomScenario(browser);
  await runFullscreenScenario(browser);
  await runProxyCommandFieldScenario(browser);

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
