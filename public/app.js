/**
 * Makes Felix an installable app: registers the service worker, and shows any [data-install] button
 * while the browser offers to install Felix. Once installed, Felix opens in its own window.
 * window.FelixApp tells pages whether Felix is installed; a "felix:app" event fires when that changes.
 * The browser only offers the install to the window itself, so a page inside Felix's outer page (shell.js) uses
 * the outer page's FelixApp, which keeps the framed page's buttons and event in step too.
 */
(() => {
  const outer = window.frameElement?.classList.contains("felix-page") ? window.parent : null;
  if (outer?.FelixApp) {
    window.FelixApp = outer.FelixApp;
    document.addEventListener("click", (event) => {
      if (event.target.closest?.("[data-install]")) outer.FelixApp.install();
    });
    return;
  }

  let installPrompt = null;

  /**
   * Whether this page is running in the installed app's own window.
   * @returns {boolean}
   */
  const isApp = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  /**
   * Whether the browser offers to install Felix here.
   * @returns {boolean}
   */
  const canInstall = () => Boolean(installPrompt) && !isApp();

  /**
   * Shows the Install buttons only while the browser can install Felix, and tells the pages: this window and the
   * pages in its frames (shell.js).
   */
  const sync = () => {
    for (const w of window.FelixShell?.windows() ?? [window]) {
      w.document.querySelectorAll("[data-install]").forEach((button) => { button.hidden = !canInstall(); });
      w.dispatchEvent(new w.Event("felix:app"));
    }
  };

  /**
   * Opens the browser's install dialog, then hides the buttons whatever the answer.
   */
  const install = async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    sync();
  };

  addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    installPrompt = event;
    sync();
  });
  addEventListener("appinstalled", () => {
    installPrompt = null;
    sync();
  });
  document.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-install]")) install();
  });

  window.FelixApp = { isApp, canInstall, install, sync };

  if ("serviceWorker" in navigator) {
    addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch((error) => console.warn("Felix: the service worker didn't register.", error));
    });
  }
})();
