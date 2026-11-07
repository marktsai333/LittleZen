// ==UserScript==
// @name        Little Zen
// @description Runtime backport of zen-browser/desktop#13450 for Twilight builds
// @include     main
// ==/UserScript==

(function () {
  "use strict";

  const LITTLE_WINDOW_ATTR = "zen-little-window";
  const COMMAND_ID = "cmd_zenNewLittleWindow";
  const URLBAR_HEIGHT = 340;
  const URLBAR_WIDTH = 520;
  const SEARCH_HEIGHT_PREF = "extensions.littleZen.search.lastHeight";
  function initialSearchHeight() {
    try {
      return Math.max(80, Math.min(800, Services.prefs.getIntPref(SEARCH_HEIGHT_PREF, URLBAR_HEIGHT)));
    } catch (error) {
      return URLBAR_HEIGHT;
    }
  }
  const NORMAL_WINDOW_WIDTH = 1000;
  const NORMAL_WINDOW_HEIGHT = 600;
  const OPEN_FEATURES =
    "titlebar,close,toolbar,location,personalbar=no,status,menubar=no," +
    `resizable,minimizable,scrollbars,width=${URLBAR_WIDTH}`;
  function cursorScreenBounds() {
    if (AppConstants.platform !== "macosx") return null;
    let library = null;
    let coreFoundation = null;
    let release = null;
    let event = null;
    try {
      const { ctypes } = ChromeUtils.importESModule("resource://gre/modules/ctypes.sys.mjs");
      library = ctypes.open("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics");
      const point = ctypes.StructType("LittleZenCGPoint", [{ x: ctypes.double }, { y: ctypes.double }]);
      const create = library.declare("CGEventCreate", ctypes.default_abi, ctypes.voidptr_t, ctypes.voidptr_t);
      const location = library.declare("CGEventGetLocation", ctypes.default_abi, point, ctypes.voidptr_t);
      coreFoundation = ctypes.open("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation");
      release = coreFoundation.declare("CFRelease", ctypes.default_abi, ctypes.void_t, ctypes.voidptr_t);
      event = create(null);
      if (event.isNull()) return null;
      const p = location(event);
      const manager = Cc["@mozilla.org/gfx/screenmanager;1"].getService(Ci.nsIScreenManager);
      const screen = manager.screenForRect(Math.floor(Number(p.x)), Math.floor(Number(p.y)), 1, 1);
      const left = {}, top = {}, width = {}, height = {};
      screen.GetAvailRectDisplayPix(left, top, width, height);
      release(event);
      event = null;
      if (!(width.value > 0 && height.value > 0)) return null;
      return { availLeft: left.value, availTop: top.value, availWidth: width.value, availHeight: height.value };
    } catch (error) {
      log("Could not determine cursor screen; using opener screen", error);
      return null;
    } finally {
      if (event && !event.isNull() && release) {
        try { release(event); } catch (_) {}
      }
      if (coreFoundation) coreFoundation.close();
      if (library) library.close();
    }
  }
  function searchWindowFeatures(opener, selectedScreen = null) {
    const screen = selectedScreen || opener?.screen;
    const height = Math.min(initialSearchHeight(), Math.floor((screen?.availHeight || 900) * 0.7));
    if (!screen?.availWidth) return `${OPEN_FEATURES},height=${height}`;
    const left = Math.round((screen.availLeft ?? 0) + screen.availWidth - URLBAR_WIDTH - 20);
    const top = Math.round((screen.availTop ?? 0) + 20);
    return `${OPEN_FEATURES},height=${height},left=${left},top=${top}`;
  }
  function pageWindowFeatures(opener) {
    const screen = opener?.screen;
    const prefix = "titlebar,close,toolbar,location,personalbar=no,status,menubar=no,resizable,minimizable,scrollbars";
    if (!(screen?.availWidth > 0 && screen?.availHeight > 0)) {
      return `${prefix},width=${NORMAL_WINDOW_WIDTH},height=${NORMAL_WINDOW_HEIGHT},centerscreen`;
    }
    const width = Math.round(screen.availWidth * 0.9);
    const height = Math.round(screen.availHeight * 0.9);
    const left = Math.round((screen.availLeft ?? 0) + (screen.availWidth - width) / 2);
    const top = Math.round((screen.availTop ?? 0) + (screen.availHeight - height) / 2);
    return `${prefix},width=${width},height=${height},left=${left},top=${top}`;
  }
  const LITTLE_ZEN_THEME_CACHE_LIMIT = 200;
  const LITTLE_ZEN_THEME_MESSAGE_NAME = "little-zen:theme-response";
  const LITTLE_ZEN_THEME_BRIDGE_TIMEOUT_MS = 250;
  const LITTLE_ZEN_ROUTING_DEBUG_PREF = "extensions.littleZen.debugRouting";
  const LITTLE_ZEN_STALLED_LOAD_TIMEOUT_MS = 25000;

  const PATCH_FLAGS = {
    browserDOMWindow: "__littleZenBrowserDOMWindowPatched",
    openBrowserWindow: "__littleZenOpenBrowserWindowPatched",
    compactMode: "__littleZenCompactModePatched",
    verticalTabs: "__littleZenVerticalTabsPatched",
    zenUIManager: "__littleZenZenUIManagerPatched",
    urlbar: "__littleZenUrlbarPatched",
    urlbarDisableGuard: "__littleZenUrlbarDisableGuardAttached",
    extensionPlacement: "__littleZenExtensionPlacementAttached",
    emptyState: "__littleZenEmptyStatePatched",
    autoClose: "__littleZenAutoCloseAttached",
    doubleEscapeClose: "__littleZenDoubleEscapeCloseAttached",
    keyListener: "__littleZenKeyListenerAttached",
    tabClickListener: "__littleZenTabClickListenerAttached",
    contentLinkListener: "__littleZenContentLinkListenerAttached",
    window: "__littleZenBootstrapped",
  };
  const littleZenThemeCache = new Map();
  let littleZenThemeRequestSeq = 0;

  const { AppConstants } = ChromeUtils.importESModule(
    "resource://gre/modules/AppConstants.sys.mjs"
  );
  const { ClickHandlerParent } = ChromeUtils.importESModule(
    "resource:///actors/ClickHandlerParent.sys.mjs"
  );

  try {
    ChromeUtils.importESModule("resource:///modules/zen/ZenLittleWindow.sys.mjs");
    console.log("[LittleZen]", "Native Little Zen support detected; skipping backport.");
    return;
  } catch (error) {}

  // Zen's default 55% cutoff overflows pinned actions before the URL bar is full.
  const overflowThresholdPrefs = Services.prefs.getDefaultBranch("");
  if (overflowThresholdPrefs.getIntPref("zen.view.overflow-webext-toolbar-threshold", 55) < 100) {
    overflowThresholdPrefs.setIntPref("zen.view.overflow-webext-toolbar-threshold", 100);
  }

  function formatLogArg(arg) {
    if (arg === undefined) {
      return "undefined";
    }
    if (arg === null) {
      return "null";
    }
    if (typeof arg === "string") {
      return arg;
    }
    if (typeof arg === "number" || typeof arg === "boolean" || typeof arg === "bigint") {
      return String(arg);
    }
    if (arg instanceof Error) {
      return `${arg.name}: ${arg.message}`;
    }
    if (typeof arg?.message === "string") {
      return `${arg.name ?? "Error"}: ${arg.message}`;
    }
    if (typeof arg?.spec === "string") {
      return arg.spec;
    }
    try {
      return JSON.stringify(arg);
    } catch (error) {
      try {
        return String(arg);
      } catch (stringError) {
        return "[unserializable]";
      }
    }
  }

  function log(...args) {
    // Logging may contain URLs; opt in explicitly before writing diagnostics.
    try {
      if (!Services.prefs.getBoolPref("extensions.littleZen.enableDebugLog", false)) return;
    } catch (error) { return; }
    const message = `[LittleZen] ${args.map(formatLogArg).join(" ")}`;
    console.log("[LittleZen]", ...args);
    try {
      Services.console.logStringMessage(message);
    } catch (error) {}
    try {
      const file = Services.dirsvc.get("ProfD", Ci.nsIFile);
      file.append("little-zen-debug.log");
      const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(
        Ci.nsIFileOutputStream
      );
      stream.init(file, 0x1a, 0o600, 0);
      const converter = Cc[
        "@mozilla.org/intl/converter-output-stream;1"
      ].createInstance(Ci.nsIConverterOutputStream);
      converter.init(stream, "UTF-8");
      converter.writeString(`${new Date().toISOString()} ${message}\n`);
      converter.close();
    } catch (error) {}
  }

  // A short-lived token ties a global invocation to exactly one search window.
  function takeGlobalFocusRequest() {
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(`/private/tmp/littlezen-focus-${Services.appinfo.processID}.request`);
      if (!file.exists()) return null;
      const input = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(Ci.nsIFileInputStream);
      input.init(file, 0x01, 0, 0);
      const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(Ci.nsIScriptableInputStream);
      stream.init(input);
      const contents = stream.read(Math.min(stream.available(), 128));
      stream.close();
      file.remove(false);
      const [token, timestamp] = contents.split("\n");
      const age = Date.now() / 1000 - Number(timestamp);
      const valid = /^[0-9a-f]{1,32}$/.test(token) && age >= 0 && age < 60;
      if (!valid) return null;
      try {
        const claimed = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
        claimed.initWithPath(`/private/tmp/littlezen-focus-${Services.appinfo.processID}.claimed`);
        const output = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
        output.init(claimed, 0x02 | 0x08 | 0x20, 0o600, 0);
        output.write(`${token}\n`, token.length + 1);
        output.close();
      } catch (error) { log("Could not acknowledge global focus request", error); }
      return token;
    } catch (error) {
      log("Could not read global focus request", error);
      return null;
    }
  }

  function signalGlobalLittleWindowClosed(win) {
    const token = win.__littleZenGlobalFocusToken;
    if (!token) return;
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(`/private/tmp/littlezen-focus-${Services.appinfo.processID}.closed`);
      const stream = Cc["@mozilla.org/network/file-output-stream;1"].createInstance(Ci.nsIFileOutputStream);
      stream.init(file, 0x02 | 0x08 | 0x20, 0o600, 0);
      stream.write(`${token}\n`, token.length + 1);
      stream.close();
      delete win.__littleZenGlobalFocusToken;
    } catch (error) { log("Could not signal Little Zen close", error); }
  }

  function attachGlobalLittleWindowCloseSignal(win) {
    if (!win.__littleZenGlobalFocusToken || win.__littleZenGlobalCloseSignalAttached) return;
    win.__littleZenGlobalCloseSignalAttached = true;
    win.addEventListener("unload", () => signalGlobalLittleWindowClosed(win), { once: true });
  }

  function canPromoteStartupWindowToLittleZen(win) {
    const uri = win.gBrowser?.selectedBrowser?.currentURI?.spec || "";
    return ["about:blank", "about:newtab", "about:home", "about:welcome"].includes(uri);
  }

  function closeEmptyLittleWindow(win) {
    signalGlobalLittleWindowClosed(win);
    win.close();
  }

  function isRoutingDebugEnabled() {
    try {
      return Services.prefs.getBoolPref(LITTLE_ZEN_ROUTING_DEBUG_PREF, false);
    } catch (error) {
      return false;
    }
  }

  function routeLog(...args) {
    if (isRoutingDebugEnabled()) {
      log(...args);
    }
  }

  function isBrowserWindow(win) {
    return (
      !!win &&
      !win.closed &&
      win.location?.href === "chrome://browser/content/browser.xhtml"
    );
  }

  function isLittleWindow(win) {
    return (
      isBrowserWindow(win) &&
      (win._zenStartupLittleWindow ||
        win.document?.documentElement?.hasAttribute(LITTLE_WINDOW_ATTR))
    );
  }

  function isEmptyLittleWindow(win) {
    return isLittleWindow(win) && !!win.gBrowser?.selectedTab?.hasAttribute("zen-empty-tab");
  }

  function usesEmptyLittleWindowPresentation(win) {
    return isEmptyLittleWindow(win) && !win.__littleZenStartExpanded;
  }

  function isExternalOpenContext(context) {
    return (
      context === Ci.nsIBrowserDOMWindow.OPEN_EXTERNAL ||
      (typeof context === "number" &&
        !!(context & Ci.nsIWebNavigation.LOAD_FLAGS_FROM_EXTERNAL))
    );
  }

  function getLittleWindowState(win) {
    const root = win?.document?.documentElement;
    const tab = win?.gBrowser?.selectedTab;
    const urlbar = win?.gURLBar;

    return {
      littleWindow: isLittleWindow(win),
      startupReady: !!win?.__littleZenStartupReady,
      pendingUrl: win?.__littleZenPendingURL ?? null,
      rootEmpty: !!root?.hasAttribute("zen-has-empty-tab"),
      tabEmpty: !!tab?.hasAttribute("zen-empty-tab"),
      urlbarBreakout: !!urlbar?.hasAttribute("breakout-extend"),
      urlbarOpen: !!urlbar?.view?.isOpen,
      urlbarNewtab: !!urlbar?.hasAttribute("zen-newtab"),
      currentUrl: win?.gBrowser?.selectedBrowser?.currentURI?.spec ?? null,
      compactMode: root?.getAttribute("zen-compact-mode") ?? null,
      singleToolbar: !!root?.hasAttribute("zen-single-toolbar"),
      navbarParent: win?.document?.getElementById("nav-bar")?.parentElement?.id ?? null,
      backButtonParent:
        win?.document?.getElementById("back-button")?.parentElement?.id ?? null,
      urlbarParent:
        win?.document?.getElementById("urlbar-container")?.parentElement?.id ?? null,
    };
  }

  function getLittleWindowLayoutState(win) {
    const describe = element => {
      if (!element) {
        return null;
      }
      const rect = element.getBoundingClientRect();
      const style = win.getComputedStyle(element);
      return {
        id: element.id || null,
        className: typeof element.className === "string" ? element.className : null,
        x: Math.round(rect.x * 10) / 10,
        y: Math.round(rect.y * 10) / 10,
        width: Math.round(rect.width * 10) / 10,
        height: Math.round(rect.height * 10) / 10,
        computedWidth: style.width,
        minWidth: style.minWidth,
        maxWidth: style.maxWidth,
        position: style.position,
        translate: style.translate,
        left: style.left,
        right: style.right,
        insetInlineStart: style.insetInlineStart,
        insetInlineEnd: style.insetInlineEnd,
        transform: style.transform,
        marginInlineStart: style.marginInlineStart,
        positionAnchor: style.positionAnchor,
        zIndex: style.zIndex,
      };
    };

    const doc = win.document;
    const urlbar = doc.getElementById("urlbar");
    return {
      window: { width: win.innerWidth, height: win.innerHeight },
      navBar: describe(doc.getElementById("nav-bar")),
      urlbarContainer: describe(doc.getElementById("urlbar-container")),
      urlbar: describe(urlbar),
      urlbarInput: describe(urlbar?.querySelector(".urlbar-input-container")),
      urlbarView: describe(urlbar?.querySelector(".urlbarView")),
      searchCloseButton: describe(doc.getElementById("little-zen-search-close-button")),
    };
  }

  function isExternalStartupWindow(win) {
    try {
      const extraOptions = win.arguments?.[1];
      return (
        extraOptions instanceof Ci.nsIPropertyBag2 &&
        extraOptions.hasKey("fromExternal") &&
        extraOptions.getPropertyAsBool("fromExternal")
      );
    } catch (error) {
      return false;
    }
  }

  function getExternalStartupUrl(win) {
    const argument = win.arguments?.[0];
    if (typeof argument === "string") {
      return argument;
    }
    if (argument?.spec) {
      return argument.spec;
    }
    try {
      return argument?.queryElementAt?.(0, Ci.nsIURI)?.spec ?? null;
    } catch (error) {
      return null;
    }
  }

  function logLittleWindowState(win, label, extra = undefined) {
    log(label, {
      ...getLittleWindowState(win),
      ...(extra ?? {}),
    });
  }

  function centerWindow(win) {
    try {
      win.docShell?.treeOwner
        ?.QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIAppWindow)
        .center(null, true, true);
    } catch (error) {
      log("Could not center the Little Zen window.", error);
    }
  }

  function positionSearchWindow(win) {
    try {
      const screen = win.__littleZenSearchScreen || win.screen;
      const left = screen.availLeft ?? 0;
      const top = screen.availTop ?? 0;
      win.moveTo(Math.max(left, left + screen.availWidth - win.outerWidth - 20), top + 20);
    } catch (error) {
      log("Could not position the Little Zen search window.", error);
    }
  }

  function setWindowResizable(win, isResizable) {
    try {
      win.setResizable?.(isResizable);
    } catch (error) {
      log("Could not update the Little Zen resizable state.", error);
    }
  }

  function releaseLittleWindowPresentation(win, reason = "unknown") {
    if (!isBrowserWindow(win) || win.__littleZenPresentationReleased) {
      return;
    }

    if (win.document?.documentElement?.hasAttribute("zen-little-window-loading")) {
      win.__littleZenReleasePresentationAfterLoading = reason;
      logLittleWindowState(win, "Deferred Little Zen presentation release while loading", {
        reason,
      });
      return;
    }

    win.__littleZenPresentationReleased = true;
    logLittleWindowState(win, "Released Little Zen startup presentation", {
      reason,
    });
  }

  function cleanupLittleWindowLifecycle(win, reason = "unknown") {
    const cleanup = win.__littleZenLifecycleCleanup;
    if (typeof cleanup === "function") {
      cleanup(reason);
    }
  }

  function expandLittleWindow(win, reason = "unknown") {
    cleanupLittleWindowLifecycle(win, `expand:${reason}`);
    if (!isBrowserWindow(win) || win.closed) {
      return;
    }

    try {
      win.document.documentElement.removeAttribute("zen-no-padding");
      updateLittleZenBlendedTheme(win, `expand:${reason}`);
    } catch (error) {
      log("Could not prepare Little Zen blended frame while expanding", error);
    }

    setWindowResizable(win, true);
    try {
      // Keep the page window on the same display as the Little Zen search
      // window. The generic native centering API can choose the primary
      // display, even when the search started on an external monitor.
      const screen = win.screen?.availWidth > 0 && win.screen?.availHeight > 0
        ? win.screen
        : win.__littleZenSearchScreen;
      const availLeft = Number(screen?.availLeft ?? 0);
      const availTop = Number(screen?.availTop ?? 0);
      const availWidth = Number(screen?.availWidth ?? 0);
      const availHeight = Number(screen?.availHeight ?? 0);
      const width = Math.round(availWidth * 0.9) || NORMAL_WINDOW_WIDTH;
      const height = Math.round(availHeight * 0.9) || NORMAL_WINDOW_HEIGHT;
      win.resizeTo(width, height);
      if (availWidth > 0 && availHeight > 0) {
        win.moveTo(
          Math.round(availLeft + (availWidth - win.outerWidth) / 2),
          Math.round(availTop + (availHeight - win.outerHeight) / 2)
        );
      } else {
        centerWindow(win);
      }
      logLittleWindowState(win, "Expanded Little Zen window", {
        reason,
        targetScreen: { availLeft, availTop, availWidth, availHeight },
      });
    } catch (error) {
      log("Could not expand the Little Zen window.", error);
    }
  }

  function* browserWindows() {
    const windows = Services.wm.getEnumerator("navigator:browser");
    while (windows.hasMoreElements()) {
      const browserWindow = windows.getNext();
      if (isBrowserWindow(browserWindow)) {
        yield browserWindow;
      }
    }
  }

  function patchBrowserDOMWindow(win) {
    if (win[PATCH_FLAGS.browserDOMWindow]) {
      return;
    }

    const originalBrowserDOMWindow = win.browserDOMWindow;
    if (!originalBrowserDOMWindow) {
      log("Skipping browserDOMWindow patch; no browserDOMWindow on window yet");
      return;
    }

    const wrappedBrowserDOMWindow = {
      __proto__: originalBrowserDOMWindow,

      openURI(aURI, aOpener, aWhere, aContext, aTriggeringPrincipal, aCsp) {
        const url = aURI?.spec ?? null;
        const isExternal = isExternalOpenContext(aContext);
        log("browserDOMWindow.openURI", {
          url,
          where: aWhere,
          context: aContext,
          isExternal,
        });

        if (isExternal && url) {
          log("Intercepting external openURI into Little Zen", { url });
          try {
            const littleWindow = LittleZen.openLittleWindow(win, {
              url,
              source: "browserDOMWindow.openURI",
              triggeringPrincipal: aTriggeringPrincipal,
              expanded: true,
            });
            if (littleWindow) return null;
          } catch (error) {
            log("External openURI failed; using Zen's original handler", error);
          }
        }

        return originalBrowserDOMWindow.openURI.call(
          originalBrowserDOMWindow,
          aURI,
          aOpener,
          aWhere,
          aContext,
          aTriggeringPrincipal,
          aCsp
        );
      },

      openURIInFrame(aURI, aParams, aWhere, aContext, aName) {
        const url = aURI?.spec ?? null;
        const isExternal = isExternalOpenContext(aContext);
        log("browserDOMWindow.openURIInFrame", {
          url,
          where: aWhere,
          context: aContext,
          isExternal,
          name: aName,
        });

        if (isExternal && url) {
          log("Intercepting external openURIInFrame into Little Zen", { url });
          try {
            const littleWindow = LittleZen.openLittleWindow(win, {
              url,
              source: "browserDOMWindow.openURIInFrame",
              expanded: true,
            });
            if (littleWindow) return null;
          } catch (error) {
            log("External openURIInFrame failed; using Zen's original handler", error);
          }
        }

        return originalBrowserDOMWindow.openURIInFrame?.call(
          originalBrowserDOMWindow,
          aURI,
          aParams,
          aWhere,
          aContext,
          aName
        ) ?? null;
      },

      QueryInterface(iid) {
        if (
          iid.equals(Ci.nsIBrowserDOMWindow) ||
          iid.equals(Ci.nsISupports)
        ) {
          return this;
        }
        if (typeof originalBrowserDOMWindow.QueryInterface === "function") {
          return originalBrowserDOMWindow.QueryInterface(iid);
        }
        throw Components.Exception(
          "",
          Components.results.NS_ERROR_NO_INTERFACE
        );
      },
    };

    win._littleZenOriginalBrowserDOMWindow = originalBrowserDOMWindow;
    win.browserDOMWindow = wrappedBrowserDOMWindow;
    win[PATCH_FLAGS.browserDOMWindow] = true;
    log("Patched browserDOMWindow for external-link interception");
  }

  function patchOpenBrowserWindow(win) {
    if (win[PATCH_FLAGS.openBrowserWindow] || typeof win.OpenBrowserWindow !== "function") {
      return;
    }

    const originalOpenBrowserWindow = win.OpenBrowserWindow;

    win.OpenBrowserWindow = function (options = {}) {
      if (!options?.zenLittleWindow) {
        return originalOpenBrowserWindow.call(this, options);
      }

      const nextOptions = {
        ...options,
        all: options.all ?? false,
        features: options.features ?? searchWindowFeatures(win),
        zenSyncedWindow: false,
      };

      const littleWindow = originalOpenBrowserWindow.call(this, nextOptions);
      if (littleWindow) {
        littleWindow.__littleZenSearchScreen = options.littleZenSearchScreen || null;
        littleWindow._zenStartupLittleWindow = true;
        littleWindow._zenStartupSyncFlag = "unsynced";
        // Zen's Tabbrowser reads this when creating the initial browser. Set it
        // explicitly because its own startup flag depends on user preferences.
        if (Number.isSafeInteger(options.littleZenOriginContainerId) &&
            options.littleZenOriginContainerId >= 0) {
          littleWindow._zenStartupUnsyncedUserContextId = options.littleZenOriginContainerId;
        }
        littleWindow.__littleZenStartExpanded = !!options.expanded;
        littleWindow.__littleZenStartLoadingVeil = !!options.url;
        littleWindow.__littleZenFreshExternalStart = !!options.littleZenFreshExternalStart;
        littleWindow.__littleZenPresentationReleased = false;
        log("Opened Little Zen browser window", {
          startupSyncFlag: littleWindow._zenStartupSyncFlag,
          hasPendingUrl: !!littleWindow.__littleZenPendingURL,
        });
        try {
          littleWindow.document?.documentElement?.setAttribute(
            LITTLE_WINDOW_ATTR,
            "true"
          );
          if (littleWindow.__littleZenStartLoadingVeil) {
            littleWindow.document?.documentElement?.setAttribute(
              "zen-little-window-loading",
              "true"
            );
          }
        } catch (error) {
          log("Startup flag applied before DOM was ready.", error);
        }
      }
      return littleWindow;
    };

    win[PATCH_FLAGS.openBrowserWindow] = true;
    log("Patched OpenBrowserWindow for Little Zen windows");
  }

  function patchCompactModeManager(win) {
    if (!isLittleWindow(win) || !win.__littleZenStartupReady) {
      return;
    }

    const manager = win.gZenCompactModeManager;
    if (!manager || manager[PATCH_FLAGS.compactMode]) {
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(manager, "shouldBeCompact");
    if (!descriptor?.get) {
      return;
    }

    Object.defineProperty(manager, "shouldBeCompact", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        if (win.document.documentElement.hasAttribute(LITTLE_WINDOW_ATTR)) {
          return false;
        }
        return descriptor.get.call(this);
      },
    });

    if (manager.preference) {
      manager.preference = false;
      log("Disabled inherited compact mode in Little Zen window");
    }

    manager[PATCH_FLAGS.compactMode] = true;
  }

  function patchVerticalTabsManager(win) {
    if (!isLittleWindow(win) || !win.__littleZenStartupReady) {
      return;
    }

    const manager = win.gZenVerticalTabsManager;
    if (!manager || manager[PATCH_FLAGS.verticalTabs]) {
      return;
    }

    const descriptor = Object.getOwnPropertyDescriptor(manager, "hidesTabsToolbar");
    const originalGetter = descriptor?.get;
    const originalValue = originalGetter ? undefined : manager.hidesTabsToolbar;

    Object.defineProperty(manager, "hidesTabsToolbar", {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get() {
        if (
          win.document.documentElement.hasAttribute(LITTLE_WINDOW_ATTR) ||
          win._zenStartupLittleWindow
        ) {
          return true;
        }
        return originalGetter ? originalGetter.call(this) : originalValue;
      },
    });

    if (typeof manager._updateEvent === "function") {
      const originalUpdateEvent = manager._updateEvent;
      manager._updateEvent = function (...args) {
        const root = win.document.documentElement;
        if (root.hasAttribute("zen-single-toolbar")) {
          this._hasSetSingleToolbar = true;
          this._navbarParent ||= this._toolbarOriginalParent;
        }
        const result = originalUpdateEvent.apply(this, args);
        root.removeAttribute("zen-single-toolbar");
        positionLittleWindowNavbar(win);
        return result;
      };
    }

    manager[PATCH_FLAGS.verticalTabs] = true;
  }

  function patchZenUIManager(win) {
    const manager = win.gZenUIManager;
    if (!manager || manager[PATCH_FLAGS.zenUIManager]) {
      return;
    }

    // Guard against closeWatermark firing before gZenUIManager.init() sets motion.
    // In the Little Zen window the async init races with delayedStartupFinished,
    // so we install a stub that silently no-ops until the real motion library loads.
    if (!manager.motion) {
      const noopAnimation = { finished: Promise.resolve(), complete: () => {}, cancel: () => {} };
      const noopFn = () => noopAnimation;
      const motionStub = {
        animate: noopFn,
        stagger: () => 0,
      };
      Object.defineProperty(manager, "motion", {
        configurable: true,
        enumerable: true,
        get() { return this._motion ?? motionStub; },
        set(v) {
          // Once the real motion library is assigned, replace the stub
          Object.defineProperty(manager, "motion", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: v,
          });
        },
      });
      log("Installed gZenUIManager.motion stub for Little Zen window");
    }

    if (typeof manager.onFloatingURLBarOpen === "function") {
      const originalOnFloatingURLBarOpen = manager.onFloatingURLBarOpen;
      manager.onFloatingURLBarOpen = function (...args) {
        const result = originalOnFloatingURLBarOpen.apply(this, args);
        win.requestAnimationFrame(() => {
          if (!isLittleWindow(win) || win.closed) {
            return;
          }

          win.dispatchEvent(new win.CustomEvent("ZenFloatingURLBarOpened"));
          logLittleWindowState(
            win,
            "Dispatched Little Zen floating-urlbar opened event"
          );
        });
        return result;
      };
    }

    manager[PATCH_FLAGS.zenUIManager] = true;
    log("Patched gZenUIManager for Little Zen lifecycle events");
  }

  function patchUrlbar(win) {
    const urlbar = win.gURLBar;
    if (!urlbar || urlbar[PATCH_FLAGS.urlbar]) {
      return;
    }

    const prototype = Object.getPrototypeOf(urlbar);
    const behaviorDescriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "zenUrlbarBehavior"
    );

    if (behaviorDescriptor?.get) {
      Object.defineProperty(urlbar, "zenUrlbarBehavior", {
        configurable: true,
        enumerable: behaviorDescriptor.enumerable,
        get() {
          if (this.document.documentElement.hasAttribute(LITTLE_WINDOW_ATTR)) {
            return "default";
          }
          return behaviorDescriptor.get.call(this);
        },
      });
    }

    if (typeof urlbar._whereToOpen === "function") {
      const originalWhereToOpen = urlbar._whereToOpen;
      urlbar._whereToOpen = function (event) {
        if (this.document.documentElement.hasAttribute(LITTLE_WINDOW_ATTR)) {
          return "current";
        }
        return originalWhereToOpen.call(this, event);
      };
    }

    // A picked result can be a tab switch rather than a navigation. Record the
    // actual switch request, since ZenURLBarClosed marks both as picked.
    let parentController;
    try { parentController = urlbar.parentController; } catch (error) {
      log("Could not attach Little Zen tab-switch handling", error);
    }
    if (parentController && typeof parentController.switchToTab === "function") {
      const originalSwitchToTab = parentController.switchToTab;
      parentController.switchToTab = function (loadData) {
        if (isLittleWindow(win) && loadData?.url) {
          let priorSelections = [];
          try {
            priorSelections = [...browserWindows()].filter(w => w !== win && !isLittleWindow(w))
              .map(w => ({ window: w, tab: w.gBrowser?.selectedTab, workspace: getActiveWorkspaceId(w) }));
          } catch (error) {
            log("Could not snapshot tabs before Little Zen switch", error);
          }
          win.__littleZenSwitchToTab = {
            url: loadData?.url,
            userContextId: Number(loadData?.userContextId ?? 0),
            focusToken: win.__littleZenGlobalFocusToken,
            priorSelections,
          };
          delete win.__littleZenGlobalFocusToken;
        }
        try {
          return originalSwitchToTab.call(this, loadData);
        } catch (error) {
          win.__littleZenGlobalFocusToken = win.__littleZenSwitchToTab?.focusToken;
          delete win.__littleZenSwitchToTab;
          throw error;
        }
      };
    }

    urlbar._zenTrimURL = function (value) {
      return formatLittleZenUrlbarValue(value);
    };

    urlbar[PATCH_FLAGS.urlbar] = true;
  }

  // Candidate: route trusted address-bar/search navigations into the originating
  // Space container before any page request is made. Never touch other windows.
  function patchLittleZenContainerNavigation(win) {
    if (!isLittleWindow(win) || win.__littleZenContainerNavigationPatched ||
        typeof win.openTrustedLinkIn !== "function") {
      return;
    }
    const original = win.openTrustedLinkIn;
    const tabbrowser = win.gBrowser;
    if (!tabbrowser || typeof tabbrowser.addTab !== "function") return;
    const originalAddTab = tabbrowser.addTab;
    let trustedNavigationDepth = 0;
    tabbrowser.addTab = function (uri, options, ...rest) {
      if (!trustedNavigationDepth) {
        return originalAddTab.call(this, uri, options, ...rest);
      }
      // URILoadingHelper does not forward skipRoute, while Zen's site-routing
      // can otherwise replace even an explicitly supplied container ID.
      const targetId = win.__littleZenTargetContainerId;
      if (!Number.isSafeInteger(targetId) || targetId < 0) {
        throw new Error("Little Zen cannot determine the originating Space container");
      }
      return originalAddTab.call(this, uri, {
        ...options, userContextId: targetId, skipRoute: true,
      }, ...rest);
    };
    win.openTrustedLinkIn = function (url, where, params = {}) {
      if (!isLittleWindow(win) || where !== "current") {
        return original.call(this, url, where, params);
      }
      const targetId = win.__littleZenTargetContainerId;
      if (!Number.isSafeInteger(targetId) || targetId < 0) {
        throw new Error("Little Zen cannot determine the originating Space container");
      }
      const targetTab = params.targetBrowser
        ? win.gBrowser?.getTabForBrowser?.(params.targetBrowser)
        : win.gBrowser?.selectedTab;
      if (!targetTab) {
        throw new Error("Little Zen has no valid target tab for this navigation");
      }
      // Gecko itself opens a new tab when an explicit userContextId differs
      // from the target or when the target is Zen's special empty tab. Always
      // pass the ID, including on matches, so those implicit tabs inherit it.
      trustedNavigationDepth++;
      try {
        return original.call(this, url, where, { ...params, userContextId: targetId });
      } finally {
        trustedNavigationDepth--;
      }
    };
    win.__littleZenContainerNavigationPatched = true;
  }

  function attachUrlbarDisableGuard(win) {
    if (!isBrowserWindow(win) || win[PATCH_FLAGS.urlbarDisableGuard]) {
      return;
    }

    const doc = win.document;
    const urlbar = win.gURLBar;
    const blockedEvents = [
      "mousedown",
      "mouseup",
      "click",
      "dblclick",
      "focusin",
      "beforeinput",
      "input",
    ];
    const listeners = [];

    const addListener = (target, type, listener) => {
      if (!target?.addEventListener) {
        return;
      }
      target.addEventListener(type, listener, true);
      listeners.push([target, type, listener]);
    };

    const isUrlbarButtonTarget = target => {
      if (!target?.closest) {
        return false;
      }
      try {
        return !!target.closest(
          [
            "#identity-box",
            "#tracking-protection-icon-container",
            "#page-action-buttons",
            "#urlbar-go-button",
            "#urlbar-revert-button",
            "#reader-mode-button",
            "#picture-in-picture-button",
            ".urlbar-page-action",
            "toolbarbutton",
            "button",
          ].join(",")
        );
      } catch (error) {
        return false;
      }
    };

    const isUrlbarInputTarget = target => {
      if (!target) {
        return false;
      }
      if (target === urlbar) {
        return true;
      }
      if (isUrlbarButtonTarget(target)) {
        return false;
      }
      if (!target.closest) {
        return false;
      }
      try {
        return !!target.closest(
          [
            "#urlbar-input",
            ".urlbar-input-box",
            ".urlbar-input-container",
            ".urlbar-background",
            "#urlbar-search-mode-indicator",
          ].join(",")
        );
      } catch (error) {
        return false;
      }
    };

    const isBlockedUrlbarTarget = event => {
      if (!urlbar || !event?.target) {
        return false;
      }
      try {
        return urlbar.contains(event.target) && isUrlbarInputTarget(event.target);
      } catch (error) {
        return false;
      }
    };

    const blockUrlbarOpen = (event, reason) => {
      if (!isLittleWindow(win)) {
        return;
      }

      try {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        event?.stopImmediatePropagation?.();
      } catch (error) {}

      closeLittleWindowUrlbar(win, reason);
    };

    const blockUrlbarTarget = event => {
      if (isBlockedUrlbarTarget(event)) {
        blockUrlbarOpen(event, `blocked-${event.type}`);
      }
    };

    const blockOpenLocationCommand = event => {
      blockUrlbarOpen(event, "blocked-open-location-command");
    };

    const blockOpenLocationKeys = event => {
      if (!isLittleWindow(win) || event.defaultPrevented) {
        return;
      }

      const key = event.key?.toLowerCase?.();
      const usesAccel = AppConstants.platform === "macosx" ? event.metaKey : event.ctrlKey;
      if (
        (usesAccel && (key === "l" || key === "k" || key === "t")) ||
        (event.altKey && key === "d") ||
        event.key === "F6"
      ) {
        blockUrlbarOpen(event, `blocked-key-${event.key}`);
      }
    };

    for (const type of blockedEvents) {
      addListener(urlbar, type, blockUrlbarTarget);
    }
    addListener(doc.getElementById("Browser:OpenLocation"), "command", blockOpenLocationCommand);
    addListener(doc.getElementById("cmd_newNavigatorTab"), "command", event => {
      blockUrlbarOpen(event, "blocked-new-tab-command");
    });
    addListener(win, "keydown", blockOpenLocationKeys);

    try {
      urlbar?.setAttribute("zen-little-urlbar-disabled", "true");
    } catch (error) {}

    win.addEventListener(
      "unload",
      () => {
        for (const [target, type, listener] of listeners) {
          try {
            target.removeEventListener(type, listener, true);
          } catch (error) {}
        }
        try {
          urlbar?.removeAttribute("zen-little-urlbar-disabled");
        } catch (error) {}
      },
      { once: true }
    );

    win[PATCH_FLAGS.urlbarDisableGuard] = true;
    closeLittleWindowUrlbar(win, "urlbar-disable-guard-attached");
    log("Attached Little Zen urlbar disable guard");
  }

  function formatLittleZenUrlbarValue(value) {
    if (typeof value !== "string" || !value) {
      return value;
    }
    if (!Services.prefs.getBoolPref("browser.urlbar.trimURLs", false)) {
      return value;
    }

    let formatted = value;
    if (Services.prefs.getBoolPref("browser.urlbar.trimHttps", false)) {
      formatted = formatted.replace(/^https:\/\//i, "");
    }
    formatted = formatted.replace(/^http:\/\//i, "");

    try {
      const uri = new URL(value);
      if (
        formatted.endsWith("/") &&
        uri.pathname === "/" &&
        !uri.search &&
        !uri.hash
      ) {
        formatted = formatted.slice(0, -1);
      }
    } catch (error) {}

    return formatted;
  }

  function syncEmptyTabState(win, reason = "unknown") {
    if (!isBrowserWindow(win)) {
      return;
    }

    const root = win.document.documentElement;
    const tab = win.gBrowser?.selectedTab;

    if (win.__littleZenStartExpanded && tab?.hasAttribute("zen-empty-tab")) {
      tab.removeAttribute("zen-empty-tab");
    }

    const hasEmptyTab = usesEmptyLittleWindowPresentation(win);

    if (hasEmptyTab) {
      root.setAttribute("zen-has-empty-tab", "true");
    } else {
      root.removeAttribute("zen-has-empty-tab");
    }

    logLittleWindowState(win, "Synced Little Zen empty-tab state", { reason });
  }

  function leaveEmptyTabMode(win, reason = "unknown") {
    if (!isBrowserWindow(win)) {
      return;
    }

    const tab = win.gBrowser?.selectedTab;
    const urlbar = win.gURLBar;
    logLittleWindowState(win, "Leaving Little Zen empty-tab mode", { reason });

    if (tab?.hasAttribute("zen-empty-tab")) {
      tab.removeAttribute("zen-empty-tab");
    }

    try {
      urlbar?.removeAttribute("zen-newtab");
      urlbar?.removeAttribute("breakout-extend");
      urlbar?.removeAttribute("open");
      urlbar?.view?.close?.();
      urlbar?.inputField?.blur?.();
      urlbar?.blur?.();
    } catch (error) {
      log("Could not clear Little Zen zen-newtab attribute.", error);
    }

    syncEmptyTabState(win, `leave-empty-tab:${reason}`);
    refreshLittleWindowLayout(win);
  }

  function scheduleLeaveEmptyTabMode(win, reason = "unknown") {
    leaveEmptyTabMode(win, `${reason}:immediate`);
    win.requestAnimationFrame(() => {
      leaveEmptyTabMode(win, `${reason}:raf`);
    });
    win.setTimeout(() => {
      leaveEmptyTabMode(win, `${reason}:timeout`);
    }, 150);
  }

  function showPdfViewerWhileLoading(win, browser, url) {
    if (
      !isLittleWindow(win) ||
      browser !== win.gBrowser?.selectedBrowser ||
      !/\.pdf(?:[?#]|$)/i.test(url) ||
      win.__littleZenPendingURL ||
      !win.document.documentElement.hasAttribute("zen-little-window-loading")
    ) {
      return;
    }

    // The loading cover delays PDF.js rendering. Let the native viewer load normally.
    setLittleWindowLoading(win, false, "pdf-viewer");
  }

  function releaseLittleWindowOnCommittedLocation(win, browser, webProgress, locationURI) {
    if (!isLittleWindow(win) || !win.document?.documentElement?.hasAttribute("zen-little-window-loading") ||
        browser !== win.gBrowser?.selectedBrowser || webProgress?.isTopLevel === false ||
        win.__littleZenPendingURL) return false;
    const spec = locationURI?.spec ?? "";
    if (!spec || spec === "about:blank" || spec === "about:newtab") return false;
    setLittleWindowLoading(win, false, "location-committed");
    return true;
  }

  function syncLittleZenBackAvailability(win) {
    if (!isLittleWindow(win) || win.closed) return;
    const root = win.document?.documentElement;
    if (!root) return;
    if (win.gBrowser?.selectedBrowser?.canGoBack === true) {
      root.setAttribute("little-zen-can-go-back", "true");
    } else {
      root.removeAttribute("little-zen-can-go-back");
    }
  }

  function attachEmptyTabStateTracking(win) {
    if (win[PATCH_FLAGS.emptyState]) {
      return;
    }

    const scheduleThemeUpdate = (reason) => {
      if (win.document.documentElement.hasAttribute("zen-little-window-loading")) {
        return;
      }
      updateLittleZenBlendedTheme(win, reason);
      win.setTimeout(() => updateLittleZenBlendedTheme(win, `${reason}:settled`), 180);
      win.setTimeout(() => updateLittleZenBlendedTheme(win, `${reason}:late`), 700);
    };

    const sync = event => {
      if (!isLittleWindow(win)) {
        return;
      }

      syncEmptyTabState(win, event?.type ?? "manual");
      syncLittleZenBackAvailability(win);
      scheduleThemeUpdate(event?.type ?? "manual");
      const browser = win.gBrowser?.selectedBrowser;
      showPdfViewerWhileLoading(win, browser, browser?.currentURI?.spec ?? "");
      if (win.__littleZenPendingURL && win.__littleZenStartupReady) {
        flushPendingNavigation(win, `state-tracker:${event?.type ?? "manual"}`);
      }
    };

    const progressListener = {
      onLocationChange(browser, webProgress, _request, locationURI) {
        if (browser === win.gBrowser?.selectedBrowser) {
          syncLittleZenBackAvailability(win);
          win.setTimeout(() => syncLittleZenBackAvailability(win), 0);
          scheduleThemeUpdate("location-change");
          showPdfViewerWhileLoading(win, browser, locationURI?.spec ?? "");
          releaseLittleWindowOnCommittedLocation(win, browser, webProgress, locationURI);
        }
      },

      onStateChange(browser, webProgress, _request, stateFlags) {
        if (
          browser === win.gBrowser?.selectedBrowser &&
          (webProgress?.isTopLevel ?? true) &&
          stateFlags & Ci.nsIWebProgressListener.STATE_STOP
        ) {
          const currentSpec = browser.currentURI?.spec ?? "";
          if (
            stateFlags & Ci.nsIWebProgressListener.STATE_IS_NETWORK &&
            !win.__littleZenPendingURL &&
            !isEmptyLittleWindow(win) &&
            currentSpec !== "about:blank"
          ) {
            setLittleWindowLoading(win, false, "state-stop");
          }
          scheduleThemeUpdate("state-stop");
        }
      },
    };

    win.addEventListener("TabAttrModified", sync, true);
    win.addEventListener("TabSelect", sync, true);
    win.addEventListener("TabOpen", sync, true);
    win.addEventListener("TabClose", sync, true);
    try {
      win.gBrowser?.addTabsProgressListener?.(progressListener);
      win.addEventListener(
        "unload",
        () => {
          try {
            win.gBrowser?.removeTabsProgressListener?.(progressListener);
          } catch (error) {}
        },
        { once: true }
      );
    } catch (error) {
      log("Could not attach Little Zen theme progress listener", error);
    }
    syncLittleZenBackAvailability(win);
    win[PATCH_FLAGS.emptyState] = true;
    log("Attached Little Zen empty-tab state tracking");
  }

  function ensureLittleWindowLoadingPulse(win) {
    if (!isBrowserWindow(win)) {
      return null;
    }

    const doc = win.document;
    if (!doc.body) {
      return null;
    }

    let overlay = doc.getElementById("zen-little-window-loading-overlay");
    if (overlay) {
      return overlay;
    }

    overlay = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    overlay.id = "zen-little-window-loading-overlay";
    overlay.setAttribute("aria-hidden", "true");

    const pulse = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    pulse.id = "zen-little-window-loading-pulse";
    overlay.appendChild(pulse);

    const fallback = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    fallback.id = "zen-little-window-load-fallback";

    const fallbackTitle = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    fallbackTitle.id = "zen-little-window-load-fallback-title";
    fallbackTitle.textContent = "Still loading";
    fallback.appendChild(fallbackTitle);

    const fallbackActions = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    fallbackActions.id = "zen-little-window-load-fallback-actions";

    const makeButton = (id, label, action) => {
      const button = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
      button.id = id;
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        action();
      });
      fallbackActions.appendChild(button);
      return button;
    };

    makeButton("zen-little-window-load-retry", "Retry", () => {
      retryLittleWindowStalledLoad(win);
    });
    makeButton("zen-little-window-load-main", "Open in Main", () => {
      openLittleWindowStalledLoadInMain(win);
    });
    makeButton("zen-little-window-load-close", "Close", () => {
      win.close();
    });

    fallback.appendChild(fallbackActions);
    overlay.appendChild(fallback);

    (doc.body || doc.documentElement).appendChild(overlay);
    return overlay;
  }

  function clearLittleWindowLoadingFallback(win) {
    try {
      if (win.__littleZenStalledLoadTimer) {
        win.clearTimeout(win.__littleZenStalledLoadTimer);
      }
    } catch (error) {}
    delete win.__littleZenStalledLoadTimer;

    try {
      win.document.documentElement.removeAttribute("zen-little-window-load-stalled");
      win.document
        .getElementById("zen-little-window-loading-overlay")
        ?.setAttribute("aria-hidden", "true");
    } catch (error) {}
  }

  function showLittleWindowStalledLoadFallback(win, reason = "unknown") {
    if (!isLittleWindow(win) || win.closed) {
      return;
    }

    const root = win.document.documentElement;
    if (!root.hasAttribute("zen-little-window-loading")) {
      return;
    }

    ensureLittleWindowLoadingPulse(win);
    root.setAttribute("zen-little-window-load-stalled", "true");
    win.document
      .getElementById("zen-little-window-loading-overlay")
      ?.removeAttribute("aria-hidden");
    logLittleWindowState(win, "Little Zen stalled-load fallback shown", {
      reason,
      timeoutMs: LITTLE_ZEN_STALLED_LOAD_TIMEOUT_MS,
    });
  }

  function scheduleLittleWindowLoadingFallback(win, reason = "unknown") {
    clearLittleWindowLoadingFallback(win);
    if (!isLittleWindow(win)) {
      return;
    }

    win.__littleZenStalledLoadTimer = win.setTimeout(() => {
      delete win.__littleZenStalledLoadTimer;
      showLittleWindowStalledLoadFallback(win, reason);
    }, LITTLE_ZEN_STALLED_LOAD_TIMEOUT_MS);
  }

  function getLittleWindowFallbackUrl(win) {
    return (
      win?.__littleZenPendingURL ||
      win?.__littleZenRoutedURL ||
      getLittleWindowUrl(win)
    );
  }

  function retryLittleWindowStalledLoad(win) {
    if (!isLittleWindow(win) || win.closed) {
      return;
    }

    const url = getLittleWindowFallbackUrl(win);
    clearLittleWindowLoadingFallback(win);
    setLittleWindowLoading(win, true, "stalled-retry");

    if (win.__littleZenPendingURL) {
      schedulePendingNavigationFlush(win, "stalled-retry");
      return;
    }

    try {
      if (url && url !== "about:blank") {
        win.gBrowser?.selectedBrowser?.reload?.();
      }
    } catch (error) {
      log("Could not retry stalled Little Zen load", error);
    }
  }

  function openLittleWindowStalledLoadInMain(win) {
    const url = getLittleWindowFallbackUrl(win);
    const mainWin = getMainBrowserWindow(win);
    if (!url || url === "about:blank" || !mainWin) {
      win.close();
      return;
    }

    try {
      const principal = Services.scriptSecurityManager.getSystemPrincipal();
      if (typeof mainWin.openWebLinkIn === "function") {
        mainWin.openWebLinkIn(url, "tab", {
          triggeringPrincipal: principal,
          fromChrome: true,
        });
      } else {
        const tab = mainWin.gBrowser.addTab(url, {
          triggeringPrincipal: principal,
          skipAnimation: true,
        });
        if (tab) {
          mainWin.gBrowser.selectedTab = tab;
        }
      }
      mainWin.focus();
    } catch (error) {
      log("Could not open stalled Little Zen load in the main window", error);
    }

    win.close();
  }

  function setLittleWindowLoading(win, isLoading, reason = "unknown") {
    if (!isLittleWindow(win)) {
      return;
    }

    const root = win.document.documentElement;
    if (isLoading) {
      delete win.__littleZenBlankReady;
      root.setAttribute("zen-little-window-loading", "true");
      ensureLittleWindowLoadingPulse(win);
      scheduleLittleWindowLoadingFallback(win, reason);
    } else {
      root.removeAttribute("zen-little-window-loading");
      clearLittleWindowLoadingFallback(win);
      delete win.__littleZenStartLoadingVeil;
      delete win.__littleZenSuppressUrlbarFocus;
      if (win.__littleZenReleasePresentationAfterLoading) {
        const releaseReason = win.__littleZenReleasePresentationAfterLoading;
        delete win.__littleZenReleasePresentationAfterLoading;
        releaseLittleWindowPresentation(win, `loading-complete:${releaseReason}`);
      }
    }

    logLittleWindowState(win, isLoading ? "Entered Little Zen loading veil" : "Left Little Zen loading veil", {
      reason,
    });
  }

  function scheduleBlankLittleWindowReady(win, reason = "unknown") {
    if (!isLittleWindow(win) || win.closed) {
      return;
    }

    const finishIfStillBlank = phase => {
      if (win.closed || win.__littleZenPendingURL || win.__littleZenBlankReady) {
        return;
      }

      const currentSpec = win.gBrowser?.selectedBrowser?.currentURI?.spec ?? "";
      if (currentSpec !== "about:blank") {
        return;
      }

      win.__littleZenBlankReady = true;
      setLittleWindowLoading(win, false, `blank-document-ready:${reason}:${phase}`);
    };

    win.requestAnimationFrame(() => finishIfStillBlank("raf"));
    win.setTimeout(() => finishIfStillBlank("timeout"), 0);
  }

  function positionLittleWindowNavbar(win) {
    if (!isLittleWindow(win)) {
      return;
    }

    const navBar = win.document.getElementById("nav-bar");
    const navContainer = win.document.getElementById(
      "zen-appcontent-navbar-container"
    );
    if (navBar && navContainer && navBar.parentElement !== navContainer) {
      navContainer.appendChild(navBar);
      log("Moved Little Zen navbar above page content");
    }

    const target = win.document.getElementById("nav-bar-customization-target");
    const urlbar = win.document.getElementById("urlbar-container");
    if (target && urlbar?.parentElement === target) {
      for (const id of ["back-button", "forward-button", "stop-reload-button"]) {
        const item = win.document.getElementById(id);
        if (item) {
          target.insertBefore(item, urlbar);
        }
      }
    }
  }

  function attachLittleWindowExtensionPlacement(win) {
    if (!isLittleWindow(win) || win[PATCH_FLAGS.extensionPlacement]) {
      return;
    }

    const target = win.document.getElementById("nav-bar-customization-target");
    const actions = win.document.getElementById("page-action-buttons");
    if (!target || !actions) {
      return;
    }

    const place = node => {
      if (node.parentElement !== target || !node.hasAttribute("data-extensionid")) {
        return;
      }
      node.setAttribute("context", "toolbar-context-menu");
      actions.before(node);
      log("Placed Little Zen extension in URL bar");
    };
    const observer = new win.MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) {
            place(node);
          }
        }
      }
    });
    observer.observe(target, { childList: true });
    for (const node of Array.from(target.children)) {
      place(node);
    }
    win.addEventListener("unload", () => observer.disconnect(), { once: true });
    win[PATCH_FLAGS.extensionPlacement] = true;
  }

  function applyExpandedLittleWindow(win, reason) {
    if (!isBrowserWindow(win) || win.closed || win.__littleZenExpandedApplied) {
      return;
    }

    win.__littleZenExpandedApplied = true;
    win.__littleZenStartExpanded = true;
    closeLittleWindowUrlbar(win, "expanded-startup");
    leaveEmptyTabMode(win, reason);
    expandLittleWindow(win, reason);
  }

  function refreshLittleWindowLayout(win) {
    const root = win.document.documentElement;
    root.setAttribute(LITTLE_WINDOW_ATTR, "true");
    root.setAttribute("zen-compact-mode", "false");
    root.toggleAttribute("zen-no-padding", usesEmptyLittleWindowPresentation(win));

    try {
      win.ZenThemeModifier?.updateElementSeparation?.();
    } catch (error) {
      log("Could not refresh ZenThemeModifier.", error);
    }

    try {
      win.gZenVerticalTabsManager?._updateEvent?.();
    } catch (error) {
      log("Could not refresh vertical tabs layout.", error);
    }

    positionLittleWindowNavbar(win);
  }

  function verifyLittleWindowUrlbarPosition(win, reason = "unknown") {
    closeLittleWindowUrlbar(win, `urlbar-position-disabled:${reason}`);
  }

  function scheduleLittleWindowUrlbarPositionCheck(win, reason = "unknown") {
    closeLittleWindowUrlbar(win, `urlbar-position-check-disabled:${reason}`);
  }

  function openLittleWindowUrlbar(win) {
    closeLittleWindowUrlbar(win, "open-urlbar-disabled");
    logLittleWindowState(win, "Blocked Little Zen urlbar open");
    return false;
  }

  function closeLittleWindowUrlbar(win, reason = "unknown") {
    const urlbar = win?.gURLBar;
    if (!urlbar) {
      return;
    }

    try {
      urlbar.view?.close?.();
      urlbar.removeAttribute("zen-newtab");
      urlbar.removeAttribute("breakout-extend");
      urlbar.removeAttribute("open");
      urlbar.inputField?.blur?.();
      urlbar.blur?.();
      win.gBrowser?.selectedBrowser?.focus?.();
      logLittleWindowState(win, "Closed Little Zen urlbar for loaded navigation", {
        reason,
      });
    } catch (error) {
      log("Could not close Little Zen urlbar for loaded navigation.", error);
    }
  }

  function discardFreshExternalBlankTab(win, tab, replacementTab) {
    if (!win.__littleZenFreshExternalStart || !isLittleWindow(win) || !tab ||
        !replacementTab || win.gBrowser?.selectedTab !== replacementTab ||
        !tab.parentNode || tab.closing || tab.pinned || tab.isEmpty !== true ||
        tab.linkedBrowser?.currentURI?.spec !== "about:blank" ||
        !Array.from(win.gBrowser.tabs ?? []).includes(tab)) return false;
    win.gBrowser.removeTab(tab, { animate: false });
    log("Removed fresh external-link startup blank tab");
    return true;
  }

  function flushPendingNavigation(win, reason = "unknown") {
    if (!isBrowserWindow(win)) {
      return false;
    }

    const pendingUrl = win.__littleZenPendingURL;
    if (!pendingUrl) {
      return false;
    }

    if (!win.__littleZenStartupReady) {
      logLittleWindowState(win, "Little Zen pending URL waiting for delayed startup", {
        reason,
        url: pendingUrl,
      });
      return false;
    }

    if (!win.__littleZenWorkspacesInitialized && win.gZenWorkspaces?.promiseInitialized) {
      if (!win.__littleZenWorkspacesWaitAttached) {
        win.__littleZenWorkspacesWaitAttached = true;
        win.gZenWorkspaces.promiseInitialized.then(() => {
          if (win.closed) {
            return;
          }
          win.__littleZenWorkspacesInitialized = true;
          schedulePendingNavigationFlush(win, "workspaces-ready");
        }).catch(error => log("Little Zen workspace initialization failed", error));
      }
      return false;
    }

    let selectedBrowser = win.gBrowser?.selectedBrowser;
    if (!selectedBrowser) {
      logLittleWindowState(win, "Little Zen pending URL waiting for selected browser", {
        reason,
        url: pendingUrl,
      });
      return false;
    }

    const pendingMeta = win.__littleZenPendingURLMeta ?? {};
    win.__littleZenSuppressUrlbarFocus = true;
    setLittleWindowLoading(win, true, `flush:${reason}`);
    closeLittleWindowUrlbar(win, `flush:${reason}`);
    delete win.__littleZenPendingURL;
    delete win.__littleZenPendingURLMeta;

    routeLog("Loading queued Little Zen URL", {
      url: pendingUrl,
      source: pendingMeta.source ?? "unknown",
      reason,
    });

    try {
      scheduleLeaveEmptyTabMode(win, `flush:${reason}`);

      const principal =
        pendingMeta.triggeringPrincipal ||
        Services.scriptSecurityManager.getSystemPrincipal();
      const selectedTab = win.gBrowser?.selectedTab;
      if (!selectedTab) {
        throw new Error("Little Zen has no selected tab for the pending navigation");
      }
      const currentContainerId = getTabContainerId(selectedTab);
      const targetContainerId = win.__littleZenTargetContainerId;
      if (!Number.isSafeInteger(targetContainerId) || targetContainerId < 0) {
        throw new Error("Little Zen cannot determine the originating Space container");
      }

      routeLog("Little Zen navigation: using originating Space container", {
        reason, currentContainerId, targetContainerId,
      });

      let loadedByNewTab = false;
      if (selectedTab && currentContainerId !== targetContainerId) {
        const defaultTab = win.gBrowser.addTab(pendingUrl, {
          triggeringPrincipal: principal,
          skipAnimation: true,
          skipRoute: true,
          inBackground: false,
          userContextId: targetContainerId,
        });

        if (defaultTab?.linkedBrowser) {
          loadedByNewTab = true;
          syncLittleWindowTransparentBrowsers(win);
          win.gBrowser.selectedTab = defaultTab;
          selectedBrowser = defaultTab.linkedBrowser;
          try {
            discardFreshExternalBlankTab(win, selectedTab, defaultTab);
          } catch (error) {
            log("Could not discard fresh external-link blank tab", error);
          }
          routeLog("Little Zen navigation: opened URL in the originating Space container");
        } else {
          log("Little Zen target-container tab creation failed");
          win.__littleZenPendingURL = pendingUrl;
          win.__littleZenPendingURLMeta = pendingMeta;
          setLittleWindowLoading(win, true, `retry:${reason}`);
          return false;
        }
      } else if (selectedTab) {
        syncLittleWindowTransparentBrowsers(win);
      }

      const loadFlags =
        Ci.nsIWebNavigation.LOAD_FLAGS_ALLOW_THIRD_PARTY_FIXUP ??
        Ci.nsIWebNavigation.LOAD_FLAGS_NONE;

      if (!loadedByNewTab) {
        selectedBrowser.browsingContext.loadURI(Services.io.newURI(pendingUrl), {
          triggeringPrincipal: principal,
          loadFlags,
        });
      }
      delete win.__littleZenFreshExternalStart;

      if (pendingUrl === "about:blank") {
        scheduleBlankLittleWindowReady(win, reason);
      }

      try {
        win.__littleZenRefreshSpacePickerTarget?.();
      } catch (error) {
        log("Could not refresh Little Zen routed workspace after dispatch", error);
      }
      updateLittleZenBlendedTheme(win, `dispatch:${reason}`);

      win.setTimeout(() => {
        expandLittleWindow(win, `pending-navigation:${reason}`);
        try {
          win.__littleZenRefreshSpacePickerTarget?.();
        } catch (error) {
          log("Could not refresh Little Zen routed workspace after expand", error);
        }
      }, 0);

      logLittleWindowState(win, "Queued Little Zen URL dispatched", {
        url: pendingUrl,
        source: pendingMeta.source ?? "unknown",
        reason,
      });
      return true;
    } catch (error) {
      log("Failed to load queued Little Zen URL", pendingUrl, error);
      win.__littleZenPendingURL = pendingUrl;
      win.__littleZenPendingURLMeta = pendingMeta;
      setLittleWindowLoading(win, true, `error:${reason}`);
      return false;
    }
  }

  function schedulePendingNavigationFlush(win, reason = "unknown") {
    if (!win?.__littleZenPendingURL || win.closed) {
      return;
    }

    logLittleWindowState(win, "Scheduling Little Zen pending navigation flush", {
      reason,
      url: win.__littleZenPendingURL,
    });

    const attemptFlush = phase => {
      if (win.closed || !win.__littleZenPendingURL) {
        return;
      }
      flushPendingNavigation(win, `${reason}:${phase}`);
    };

    attemptFlush("immediate");
    win.requestAnimationFrame(() => {
      attemptFlush("raf");
    });
    win.setTimeout(() => {
      attemptFlush("timeout-150");
    }, 150);
    win.setTimeout(() => {
      attemptFlush("timeout-500");
    }, 500);
  }

  function focusUrlbar(win) {
    try {
      win.focus();
      win.gURLBar?.focus();
      win.gURLBar?.select();
      win.gURLBar?.inputField?.focus();
    } catch (error) {
      log("Could not focus the Little Zen urlbar.", error);
    }
  }

  // ── Workspace Picker ────────────────────────────────────────────────────────

  const PICKER_ID = "zen-little-window-space-picker";
  const PICKER_MENU_ID = "zen-little-window-space-menu";

  function getMainBrowserWindow(win) {
    for (const bw of browserWindows()) {
      if (!isLittleWindow(bw) && bw !== win && !bw.closed) {
        return bw;
      }
    }
    return null;
  }

  function getWorkspaces(mainWin) {
    try {
      return mainWin?.gZenWorkspaces?.getWorkspaces?.() ?? [];
    } catch (e) {
      return [];
    }
  }

  function getActiveWorkspaceId(mainWin) {
    try {
      return mainWin?.gZenWorkspaces?.getActiveWorkspace?.()?.uuid ?? null;
    } catch (e) {
      return null;
    }
  }

  function getWorkspaceById(mainWin, id) {
    try {
      return mainWin?.gZenWorkspaces?.getWorkspaceFromId?.(id) ?? null;
    } catch (e) {
      return null;
    }
  }

  function getTabContainerId(tab) {
    const containerId = Number.parseInt(tab?.getAttribute("usercontextid") ?? 0, 10);
    return Number.isFinite(containerId) ? containerId : 0;
  }

  function getOpenShortcutDisplay() {
    return AppConstants.platform === "macosx" ? "⌘O" : "Ctrl+O";
  }

  function getWorkspaceDisplayIcon(workspace) {
    if (workspace?.icon) {
      return workspace.icon;
    }

    const name = String(workspace?.name ?? "Space");
    try {
      return new Intl.Segmenter().segment(name).containing(0).segment.toUpperCase();
    } catch (error) {
      return Array.from(name)[0]?.toUpperCase() ?? "S";
    }
  }

  function isTransparentBrowserAllowed() {
    try {
      return Services.prefs.getBoolPref(
        "browser.tabs.allow_transparent_browser",
        false
      );
    } catch (error) {
      return false;
    }
  }

  function syncLittleWindowTransparentBrowsers(win) {
    if (!isLittleWindow(win)) {
      return;
    }

    const enabled = isTransparentBrowserAllowed();
    win.document.documentElement.toggleAttribute(
      "zen-little-window-transparent-browser",
      enabled
    );

    try {
      for (const browser of win.gBrowser?.browsers ?? []) {
        if (enabled) {
          browser.setAttribute("transparent", "true");
        } else {
          browser.removeAttribute("transparent");
        }
      }
    } catch (error) {
      log("Could not sync Little Zen transparent browser attribute", error);
    }
  }

  function attachTransparentBrowserPrefSync(win) {
    if (win.__littleZenTransparentPrefSyncAttached) {
      return;
    }
    win.__littleZenTransparentPrefSyncAttached = true;

    const observer = () => syncLittleWindowTransparentBrowsers(win);
    try {
      Services.prefs.addObserver(
        "browser.tabs.allow_transparent_browser",
        observer
      );
      win.addEventListener(
        "unload",
        () => {
          try {
            Services.prefs.removeObserver(
              "browser.tabs.allow_transparent_browser",
              observer
            );
          } catch (error) {}
        },
        { once: true }
      );
    } catch (error) {
      log("Could not attach Little Zen transparent browser pref observer", error);
    }
  }

  function attachLittleWindowCloseButtonGuard(win) {
    if (win.__littleZenCloseButtonGuardAttached) {
      return;
    }
    win.__littleZenCloseButtonGuardAttached = true;

    const isCloseButtonTarget = (target) =>
      !!(
        target?.classList?.contains("titlebar-close") ||
        target?.closest?.(".titlebar-close")
      );

    const closeFromTitlebar = (event) => {
      const closeButton =
        event.composedPath?.().some(isCloseButtonTarget) ||
        isCloseButtonTarget(event.target);
      if (!closeButton || !isLittleWindow(win)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      try {
        closeEmptyLittleWindow(win);
      } catch (error) {
        log("Little Zen titlebar close guard failed", error);
      }
    };

    win.addEventListener("mousedown", closeFromTitlebar, true);
    win.addEventListener("click", closeFromTitlebar, true);
    win.addEventListener("command", closeFromTitlebar, true);
    win.addEventListener(
      "unload",
      () => {
        try {
          win.removeEventListener("mousedown", closeFromTitlebar, true);
          win.removeEventListener("click", closeFromTitlebar, true);
          win.removeEventListener("command", closeFromTitlebar, true);
        } catch (error) {}
      },
      { once: true }
    );
  }

  function rgbaToCss(color) {
    return `rgba(${color.r}, ${color.g}, ${color.b}, ${color.a.toFixed(3)})`;
  }

  function rgbToCss(color) {
    return `rgb(${color.r}, ${color.g}, ${color.b})`;
  }

  function parseCssRgb(input) {
    if (!input) {
      return null;
    }
    const raw = String(input).trim();
    const perceptual = raw.match(/^ok(?:lab|lch)\(\s*(\d+(?:\.\d+)?%?)/i);
    if (perceptual) {
      const channel = perceptual[1];
      const lightness = channel.endsWith("%")
        ? parseFloat(channel) / 100
        : parseFloat(channel);
      if (Number.isFinite(lightness)) {
        const value = Math.max(0, Math.min(255, Math.round(lightness * 255)));
        return { r: value, g: value, b: value };
      }
    }

    const hex = raw.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
      const value = hex[1];
      const expand = (part) => part.length === 1 ? `${part}${part}` : part;
      const r = parseInt(expand(value.length <= 4 ? value[0] : value.slice(0, 2)), 16);
      const g = parseInt(expand(value.length <= 4 ? value[1] : value.slice(2, 4)), 16);
      const b = parseInt(expand(value.length <= 4 ? value[2] : value.slice(4, 6)), 16);
      return { r, g, b };
    }

    const rgb = raw.match(/^rgba?\(([^)]+)\)$/i);
    if (!rgb) {
      return null;
    }
    const parts = rgb[1].replace(/\s*\/\s*[\d.]+%?$/, "").split(/[,\s]+/).filter(Boolean);
    if (parts.length < 3) {
      return null;
    }
    const readChannel = (part) => {
      const value = parseFloat(part);
      const scaled = String(part).trim().endsWith("%") ? value * 2.55 : value;
      return Math.max(0, Math.min(255, Math.round(scaled)));
    };
    return {
      r: readChannel(parts[0]),
      g: readChannel(parts[1]),
      b: readChannel(parts[2]),
    };
  }

  function getCssColorAlpha(value) {
    const match = String(value || "").trim().match(/^[a-z-]+\(([^)]+)\)$/i);
    if (!match) {
      return null;
    }

    const body = match[1].trim();
    let alpha = null;
    if (body.includes("/")) {
      alpha = body.slice(body.lastIndexOf("/") + 1).trim();
    } else {
      const parts = body.split(",");
      if (parts.length === 4) {
        alpha = parts[3].trim();
      }
    }
    if (alpha === null) {
      return null;
    }

    const amount = parseFloat(alpha);
    if (!Number.isFinite(amount)) {
      return null;
    }
    return alpha.endsWith("%") ? amount / 100 : amount;
  }

  function hasVisibleColor(input) {
    if (!input) {
      return false;
    }
    const value = String(input).trim().toLowerCase();
    if (!value || value === "transparent") {
      return false;
    }
    const alpha = getCssColorAlpha(value);
    return alpha === null || alpha >= 0.08;
  }

  function extractCssColor(input) {
    const value = String(input || "").trim();
    if (!value || value === "none") {
      return null;
    }
    const candidates = value.match(/[a-z-]+\([^)]*\)|#[0-9a-f]{3,8}\b/gi) || [];
    return candidates.find(hasVisibleColor) || null;
  }

  function getStyleBackground(style) {
    if (!style) {
      return null;
    }
    if (hasVisibleColor(style.backgroundColor)) {
      return style.backgroundColor;
    }
    return extractCssColor(style.backgroundImage);
  }

  function getRelativeLuminance(color) {
    const toLinear = (channel) => {
      const value = channel / 255;
      return value <= 0.03928
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    return (
      0.2126 * toLinear(color.r) +
      0.7152 * toLinear(color.g) +
      0.0722 * toLinear(color.b)
    );
  }

  function getContrastRatio(a, b) {
    const light = Math.max(getRelativeLuminance(a), getRelativeLuminance(b));
    const dark = Math.min(getRelativeLuminance(a), getRelativeLuminance(b));
    return (light + 0.05) / (dark + 0.05);
  }

  function getBlendedControlOutline(background) {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };
    const tint = getContrastRatio(background, black) >= getContrastRatio(background, white)
      ? black
      : white;
    const blend = amount => ({
      r: background.r + (tint.r - background.r) * amount,
      g: background.g + (tint.g - background.g) * amount,
      b: background.b + (tint.b - background.b) * amount,
    });
    let low = 0;
    let high = 1;
    // Keep the same subtle contrast on neutral and colored headers.
    for (let i = 0; i < 12; i++) {
      const amount = (low + high) / 2;
      if (getContrastRatio(background, blend(amount)) < 1.4) {
        low = amount;
      } else {
        high = amount;
      }
    }
    const outline = blend(high);
    return rgbToCss({
      r: Math.round(outline.r),
      g: Math.round(outline.g),
      b: Math.round(outline.b),
    });
  }

  function chooseForeground(color) {
    return getRelativeLuminance(color) > 0.6
      ? "rgba(11, 13, 16, 0.92)"
      : "rgba(245, 247, 251, 0.96)";
  }

  function getReadableForeground(bg, candidates = []) {
    const bgRgb = parseCssRgb(bg);
    if (!bgRgb) {
      return candidates.find(hasVisibleColor) || "currentColor";
    }
    return candidates.find((candidate) => {
      const fgRgb = parseCssRgb(candidate);
      if (!fgRgb) {
        return false;
      }
      return getContrastRatio(bgRgb, fgRgb) >= 4.5;
    }) || chooseForeground(bgRgb);
  }

  function getStableHeaderForeground(bgRgb, foreground) {
    const fgRgb = parseCssRgb(foreground);
    if (fgRgb && getContrastRatio(bgRgb, fgRgb) >= 4.5) {
      return foreground;
    }
    return chooseForeground(bgRgb);
  }

  function getCurrentThemeColorScheme(win) {
    const themeWin = isLittleWindow(win) ? getMainBrowserWindow(win) || win : win;
    const root = themeWin.document.documentElement;
    if (
      root.hasAttribute("zen-should-be-dark-mode") ||
      themeWin.matchMedia("(prefers-color-scheme: dark)").matches
    ) {
      return "dark";
    }
    const rootStyle = themeWin.getComputedStyle(root);
    const colorScheme =
      rootStyle.getPropertyValue("--toolbar-color-scheme") ||
      rootStyle.colorScheme;
    const normalizedScheme = String(colorScheme || "").trim().toLowerCase();
    return normalizedScheme === "dark" ? "dark" : "light";
  }

  function getNeutralHeaderShade(win, source = "unknown-page") {
    const isLight = getCurrentThemeColorScheme(win) === "light";
    return {
      bg: isLight ? "rgb(245, 247, 251)" : "rgb(16, 18, 24)",
      fg: isLight ? "rgba(11, 13, 16, 0.92)" : "rgba(245, 247, 251, 0.96)",
      source,
    };
  }

  function getThemeColorTheme(browser) {
    const doc = browser?.contentDocument;
    const view = doc?.defaultView;
    if (!doc || !view) {
      return null;
    }

    const metas = doc.querySelectorAll?.('meta[name="theme-color" i]') || [];
    for (const meta of metas) {
      const media = meta.getAttribute?.("media") || "";
      if (media) {
        try {
          if (!view.matchMedia(media).matches) {
            continue;
          }
        } catch (error) {}
      }

      const bg = meta.getAttribute?.("content") || "";
      if (!hasVisibleColor(bg)) {
        continue;
      }

      const rootStyle = doc.documentElement ? view.getComputedStyle(doc.documentElement) : null;
      const bodyStyle = doc.body ? view.getComputedStyle(doc.body) : null;
      const bgRgb = parseCssRgb(bg);
      return {
        bg,
        fg: getReadableForeground(bg, [
          bodyStyle?.color || null,
          rootStyle?.color || null,
          bgRgb ? chooseForeground(bgRgb) : null,
        ]),
        source: "theme-color",
      };
    }

    return null;
  }

  function getDocumentCanvasTheme(browser) {
    const doc = browser?.contentDocument;
    const view = doc?.defaultView;
    const root = doc?.documentElement;
    if (!doc || !view || !root) {
      return null;
    }

    const rootStyle = view.getComputedStyle(root);
    const bodyStyle = doc.body ? view.getComputedStyle(doc.body) : null;
    let canvasFg = "";
    let probe = null;
    try {
      probe = doc.createElement("div");
      probe.style.cssText =
        "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;pointer-events:none;background-color:Canvas;color:CanvasText;";
      root.appendChild(probe);
      canvasFg = view.getComputedStyle(probe).color;
    } catch (error) {
    } finally {
      try {
        probe?.remove?.();
      } catch (error) {}
    }

    const bg = [
      bodyStyle ? getStyleBackground(bodyStyle) : null,
      getStyleBackground(rootStyle),
    ].find(hasVisibleColor);
    if (!bg) {
      return null;
    }

    return {
      bg,
      fg: getReadableForeground(bg, [
        bodyStyle?.color || null,
        rootStyle?.color || null,
        canvasFg || null,
      ]),
      source: "document-canvas",
    };
  }

  function getThemeFromElement(view, element, source = "element", allowPageFallback = true) {
    if (!view || !element) {
      return null;
    }

    let fg = null;
    let bg = null;
    let current = element;
    const doc = element.ownerDocument || null;

    while (current) {
      if (!allowPageFallback && (current === doc?.body || current === doc?.documentElement)) {
        break;
      }
      const style = view.getComputedStyle(current);
      if (!fg && hasVisibleColor(style.color)) {
        fg = style.color;
      }
      const background = getStyleBackground(style);
      if (!bg && hasVisibleColor(background)) {
        bg = background;
      }
      if (bg && fg) {
        break;
      }
      current = current.parentElement;
    }

    if (!hasVisibleColor(bg)) {
      return null;
    }

    return {
      bg,
      fg: getReadableForeground(bg, [fg]),
      source,
    };
  }

  function getTopVisibleTheme(browser) {
    const doc = browser?.contentDocument;
    const view = doc?.defaultView;
    if (!doc || !view) {
      return null;
    }

    const width = view.innerWidth || doc.documentElement?.clientWidth || 0;
    const height = view.innerHeight || doc.documentElement?.clientHeight || 0;
    const xMid = Math.max(1, Math.floor((width || 2) / 2));
    const xEnd = Math.max(1, (width || 2) - 2);
    const yTop = Math.min(3, Math.max(0, (height || 4) - 1));
    const yBand = Math.min(30, Math.max(0, (height || 31) - 1));
    const points = [
      [1, yTop],
      [xMid, yTop],
      [xEnd, yTop],
      [1, yBand],
      [xMid, yBand],
    ];
    let firstRendered = null;

    const isRenderedElement = (candidate) => {
      if (!candidate) {
        return false;
      }
      const rect = candidate.getBoundingClientRect?.();
      const style = view.getComputedStyle(candidate);
      return (
        rect?.width > 0 &&
        rect?.height > 0 &&
        style.visibility !== "hidden" &&
        style.visibility !== "collapse" &&
        style.display !== "none" &&
        Number(style.opacity || 1) > 0.05
      );
    };

    for (const [x, y] of points) {
      const elements = doc.elementsFromPoint?.(x, y) || [];
      for (const element of elements) {
        if (!isRenderedElement(element)) {
          continue;
        }
        firstRendered ||= element;
        const background = getStyleBackground(view.getComputedStyle(element));
        if (hasVisibleColor(background)) {
          return getThemeFromElement(view, element, "top-visible", false);
        }
      }
    }

    return getThemeFromElement(
      view,
      firstRendered || doc.elementFromPoint?.(1, 3),
      "top-visible",
      false
    );
  }

  function getChromeToolbarFallbackTheme(win) {
    const doc = win.document;
    const probe = doc.createElement("div");
    probe.style.position = "fixed";
    probe.style.pointerEvents = "none";
    probe.style.opacity = "0";
    probe.style.backgroundColor = "var(--zen-main-browser-background-toolbar)";
    probe.style.color = "var(--toolbox-textcolor)";
    doc.documentElement.appendChild(probe);
    const probeStyle = win.getComputedStyle(probe);
    const toolbarBg = probeStyle.backgroundColor;
    const toolbarFg = probeStyle.color;
    probe.remove();

    const rootStyle = win.getComputedStyle(doc.documentElement);
    const rootBg = rootStyle.backgroundColor;
    const bg = [toolbarBg, rootBg].find((color) =>
      parseCssRgb(color) && (getCssColorAlpha(color) ?? 1) >= 0.98
    );
    if (!bg) {
      return getNeutralHeaderShade(win, "toolbar-fallback");
    }
    return {
      bg,
      fg: getReadableForeground(bg, [toolbarFg]),
      source: "toolbar-fallback",
    };
  }

  async function getContentTaskPageTheme(browser) {
    if (!browser || typeof ContentTask === "undefined" || !ContentTask?.spawn) {
      return null;
    }

    try {
      return await ContentTask.spawn(browser, null, () => {
        const parseCssRgb = (input) => {
          if (!input) return null;
          const raw = String(input).trim();
          const hex = raw.match(/^#([0-9a-f]{3,8})$/i);
          if (hex) {
            const value = hex[1];
            const expand = (part) => part.length === 1 ? `${part}${part}` : part;
            return {
              r: parseInt(expand(value.length <= 4 ? value[0] : value.slice(0, 2)), 16),
              g: parseInt(expand(value.length <= 4 ? value[1] : value.slice(2, 4)), 16),
              b: parseInt(expand(value.length <= 4 ? value[2] : value.slice(4, 6)), 16),
            };
          }
          const rgb = raw.match(/^rgba?\(([^)]+)\)$/i);
          if (!rgb) return null;
          const parts = rgb[1].replace(/\s*\/\s*[\d.]+%?$/, "").split(/[,\s]+/).filter(Boolean);
          if (parts.length < 3) return null;
          const read = (part) => {
            const value = parseFloat(part);
            return Math.max(0, Math.min(255, Math.round(String(part).trim().endsWith("%") ? value * 2.55 : value)));
          };
          return { r: read(parts[0]), g: read(parts[1]), b: read(parts[2]) };
        };
        const luminance = (color) => {
          const toLinear = (channel) => {
            const value = channel / 255;
            return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
          };
          return 0.2126 * toLinear(color.r) + 0.7152 * toLinear(color.g) + 0.0722 * toLinear(color.b);
        };
        const alpha = (value) => {
          const match = String(value || "").trim().match(/^[a-z-]+\(([^)]+)\)$/i);
          if (!match) return null;
          const body = match[1].trim();
          const raw = body.includes("/") ? body.slice(body.lastIndexOf("/") + 1).trim() : body.split(",")[3]?.trim();
          if (!raw) return null;
          const amount = parseFloat(raw);
          return Number.isFinite(amount) ? (raw.endsWith("%") ? amount / 100 : amount) : null;
        };
        const visible = (input) => {
          const value = String(input || "").trim().toLowerCase();
          if (!value || value === "transparent") return false;
          const a = alpha(value);
          return a === null || a >= 0.08;
        };
        const extractColor = (input) =>
          (String(input || "").match(/[a-z-]+\([^)]*\)|#[0-9a-f]{3,8}\b/gi) || []).find(visible) || null;
        const styleBackground = (style) => visible(style?.backgroundColor) ? style.backgroundColor : extractColor(style?.backgroundImage);
        const chooseFg = (bg) => {
          const rgb = parseCssRgb(bg);
          return rgb && luminance(rgb) > 0.6 ? "rgba(11, 13, 16, 0.92)" : "rgba(245, 247, 251, 0.96)";
        };
        const readableFg = (bg, candidates = []) =>
          candidates.find((candidate) => {
            if (!visible(candidate)) return false;
            const bgRgb = parseCssRgb(bg);
            const fgRgb = parseCssRgb(candidate);
            if (!bgRgb || !fgRgb) return false;
            const light = Math.max(luminance(bgRgb), luminance(fgRgb));
            const dark = Math.min(luminance(bgRgb), luminance(fgRgb));
            return (light + 0.05) / (dark + 0.05) >= 3;
          }) || chooseFg(bg);
        const themeFromElement = (view, element, source, allowPageFallback = true) => {
          if (!view || !element) return null;
          let fg = null;
          let bg = null;
          let current = element;
          const doc = element.ownerDocument;
          while (current) {
            if (!allowPageFallback && (current === doc.body || current === doc.documentElement)) break;
            const style = view.getComputedStyle(current);
            if (!fg && visible(style.color)) fg = style.color;
            const background = styleBackground(style);
            if (!bg && visible(background)) bg = background;
            if (bg && fg) break;
            current = current.parentElement;
          }
          return visible(bg) ? { bg, fg: readableFg(bg, [fg]), source } : null;
        };
        const themeColorTheme = (doc, view) => {
          for (const meta of doc.querySelectorAll?.('meta[name="theme-color" i]') || []) {
            const media = meta.getAttribute?.("media") || "";
            try {
              if (media && !view.matchMedia(media).matches) continue;
            } catch {}
            const bg = meta.getAttribute?.("content") || "";
            if (!visible(bg)) continue;
            const rootStyle = doc.documentElement ? view.getComputedStyle(doc.documentElement) : null;
            const bodyStyle = doc.body ? view.getComputedStyle(doc.body) : null;
            return {
              bg,
              fg: readableFg(bg, [bodyStyle?.color || null, rootStyle?.color || null]),
              source: "theme-color",
            };
          }
          return null;
        };
        const topVisibleTheme = (doc, view) => {
          const width = view.innerWidth || doc.documentElement?.clientWidth || 0;
          const height = view.innerHeight || doc.documentElement?.clientHeight || 0;
          const xMid = Math.max(1, Math.floor((width || 2) / 2));
          const xEnd = Math.max(1, (width || 2) - 2);
          const yTop = Math.min(3, Math.max(0, (height || 4) - 1));
          const yBand = Math.min(30, Math.max(0, (height || 31) - 1));
          const points = [[1, yTop], [xMid, yTop], [xEnd, yTop], [1, yBand], [xMid, yBand]];
          let firstRendered = null;
          const isRendered = (candidate) => {
            if (!candidate) return false;
            const rect = candidate.getBoundingClientRect?.();
            const style = view.getComputedStyle(candidate);
            return rect?.width > 0 && rect?.height > 0 && style.visibility !== "hidden" && style.visibility !== "collapse" && style.display !== "none" && Number(style.opacity || 1) > 0.05;
          };
          for (const [x, y] of points) {
            for (const element of doc.elementsFromPoint?.(x, y) || []) {
              if (!isRendered(element)) continue;
              firstRendered ||= element;
              const background = styleBackground(view.getComputedStyle(element));
              if (visible(background)) return themeFromElement(view, element, "top-visible", false);
            }
          }
          return themeFromElement(view, firstRendered || doc.elementFromPoint?.(1, 3), "top-visible", false);
        };
        const canvasTheme = (doc, view) => {
          const root = doc.documentElement;
          const rootStyle = view.getComputedStyle(root);
          const bodyStyle = doc.body ? view.getComputedStyle(doc.body) : null;
          const bg = [bodyStyle ? styleBackground(bodyStyle) : null, styleBackground(rootStyle)].find(visible);
          return visible(bg)
            ? { bg, fg: readableFg(bg, [bodyStyle?.color || null, rootStyle?.color || null]), source: "document-canvas" }
            : null;
        };

        try {
          const doc = content.document;
          const view = doc?.defaultView;
          if (!doc || !view || !doc.documentElement) return null;
          const href = content.location.href;
          const theme =
            topVisibleTheme(doc, view) ||
            themeColorTheme(doc, view) ||
            themeFromElement(view, doc.body, "body") ||
            themeFromElement(view, doc.documentElement, "html") ||
            canvasTheme(doc, view);
          return theme ? { ...theme, href, bridge: "content" } : null;
        } catch {
          return null;
        }
      });
    } catch (error) {
      log("Little Zen ContentTask theme lookup failed", error);
      return null;
    }
  }

  function getLittleZenBrowserMessageManager(browser) {
    return browser?.messageManager || browser?.frameLoader?.messageManager || null;
  }

  function getLittleZenThemeFrameScript(requestId) {
    return `
      (() => {
        const requestId = ${JSON.stringify(requestId)};
        const messageName = ${JSON.stringify(LITTLE_ZEN_THEME_MESSAGE_NAME)};
        const send = (payload) => sendAsyncMessage(messageName, { requestId, ...payload });
        const alpha = value => {
          const match = String(value || "").trim().match(/^[a-z-]+\\(([^)]+)\\)$/i);
          if (!match) return null;
          const body = match[1].trim();
          const raw = body.includes("/") ? body.slice(body.lastIndexOf("/") + 1).trim() : body.split(",")[3]?.trim();
          if (!raw) return null;
          const amount = parseFloat(raw);
          return Number.isFinite(amount) ? (raw.endsWith("%") ? amount / 100 : amount) : null;
        };
        const visible = input => {
          const value = String(input || "").trim().toLowerCase();
          if (!value || value === "transparent") return false;
          const a = alpha(value);
          return a === null || a >= 0.08;
        };
        const extractColor = input =>
          (String(input || "").match(/[a-z-]+\\([^)]*\\)|#[0-9a-f]{3,8}\\b/gi) || []).find(visible) || null;
        const styleBackground = style => visible(style?.backgroundColor) ? style.backgroundColor : extractColor(style?.backgroundImage);
        const parseRgb = input => {
          const raw = String(input || "").trim();
          const rgb = raw.match(/^rgba?\\(([^)]+)\\)$/i);
          if (!rgb) return null;
          const parts = rgb[1].replace(/\\s*\\/\\s*[\\d.]+%?$/, "").split(/[,\\s]+/).filter(Boolean);
          if (parts.length < 3) return null;
          const read = part => {
            const value = parseFloat(part);
            return Math.max(0, Math.min(255, Math.round(String(part).trim().endsWith("%") ? value * 2.55 : value)));
          };
          return { r: read(parts[0]), g: read(parts[1]), b: read(parts[2]) };
        };
        const luminance = color => {
          const lin = channel => {
            const value = channel / 255;
            return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
          };
          return 0.2126 * lin(color.r) + 0.7152 * lin(color.g) + 0.0722 * lin(color.b);
        };
        const chooseFg = bg => {
          const rgb = parseRgb(bg);
          return rgb && luminance(rgb) > 0.6 ? "rgba(11, 13, 16, 0.92)" : "rgba(245, 247, 251, 0.96)";
        };
        const themeFromElement = (view, element, source, allowPageFallback = true) => {
          if (!view || !element) return null;
          let bg = null;
          let fg = null;
          let current = element;
          const doc = element.ownerDocument;
          while (current) {
            if (!allowPageFallback && (current === doc.body || current === doc.documentElement)) break;
            const style = view.getComputedStyle(current);
            if (!fg && visible(style.color)) fg = style.color;
            const background = styleBackground(style);
            if (!bg && visible(background)) bg = background;
            if (bg && fg) break;
            current = current.parentElement;
          }
          return visible(bg) ? { bg, fg: fg || chooseFg(bg), source } : null;
        };
        const topVisibleTheme = (doc, view) => {
          const width = view.innerWidth || doc.documentElement?.clientWidth || 0;
          const height = view.innerHeight || doc.documentElement?.clientHeight || 0;
          const xMid = Math.max(1, Math.floor((width || 2) / 2));
          const xEnd = Math.max(1, (width || 2) - 2);
          const yTop = Math.min(3, Math.max(0, (height || 4) - 1));
          const yBand = Math.min(30, Math.max(0, (height || 31) - 1));
          const points = [[1, yTop], [xMid, yTop], [xEnd, yTop], [1, yBand], [xMid, yBand]];
          let firstRendered = null;
          for (const [x, y] of points) {
            for (const element of doc.elementsFromPoint?.(x, y) || []) {
              if (!element) continue;
              const rect = element.getBoundingClientRect?.();
              const style = view.getComputedStyle(element);
              if (!(rect?.width > 0 && rect?.height > 0) || style.visibility === "hidden" || style.visibility === "collapse" || style.display === "none" || Number(style.opacity || 1) <= 0.05) continue;
              firstRendered ||= element;
              if (visible(styleBackground(style))) return themeFromElement(view, element, "top-visible", false);
            }
          }
          return themeFromElement(view, firstRendered || doc.elementFromPoint?.(1, 3), "top-visible", false);
        };
        const themeColorTheme = (doc, view) => {
          for (const meta of doc.querySelectorAll?.('meta[name="theme-color" i]') || []) {
            const media = meta.getAttribute?.("media") || "";
            try { if (media && !view.matchMedia(media).matches) continue; } catch {}
            const bg = meta.getAttribute?.("content") || "";
            if (visible(bg)) return { bg, fg: chooseFg(bg), source: "theme-color" };
          }
          return null;
        };
        try {
          if (content.top !== content) return;
          const doc = content.document;
          const view = doc?.defaultView;
          if (!doc || !view || !doc.documentElement) return send({ ok: false });
          const theme =
            topVisibleTheme(doc, view) ||
            themeColorTheme(doc, view) ||
            themeFromElement(view, doc.body, "body") ||
            themeFromElement(view, doc.documentElement, "html");
          send({ ok: true, theme: theme ? { ...theme, href: content.location.href, bridge: "message-manager" } : null });
        } catch (error) {
          send({ ok: false, error: error?.message || String(error) });
        }
      })();
    `;
  }

  async function getMessageManagerPageTheme(browser) {
    const messageManager = getLittleZenBrowserMessageManager(browser);
    if (!browser || !messageManager?.loadFrameScript || !messageManager?.addMessageListener) {
      return null;
    }

    const requestId = `little-zen-theme-${Date.now()}-${++littleZenThemeRequestSeq}`;
    return await new Promise((resolve) => {
      let settled = false;
      let timeoutId = 0;
      const finish = (theme) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        try {
          messageManager.removeMessageListener(LITTLE_ZEN_THEME_MESSAGE_NAME, listener);
        } catch (error) {}
        resolve(theme || null);
      };
      const listener = {
        receiveMessage(message) {
          const data = message?.data;
          if (!data || data.requestId !== requestId) {
            return;
          }
          finish(data.theme || null);
        },
      };

      const ownerWindow = browser.ownerGlobal || window;
      timeoutId = ownerWindow.setTimeout(
        () => finish(null),
        LITTLE_ZEN_THEME_BRIDGE_TIMEOUT_MS
      );
      try {
        messageManager.addMessageListener(LITTLE_ZEN_THEME_MESSAGE_NAME, listener);
        const scriptUrl = `data:application/javascript;charset=utf-8,${encodeURIComponent(
          getLittleZenThemeFrameScript(requestId)
        )}`;
        messageManager.loadFrameScript(scriptUrl, false);
      } catch (error) {
        finish(null);
      }
    });
  }

  async function getLittleZenAsyncPageTheme(browser) {
    const lookups = [
      getContentTaskPageTheme(browser),
      getMessageManagerPageTheme(browser),
    ];

    return await new Promise((resolve) => {
      let pending = lookups.length;
      const finishEmpty = () => {
        pending--;
        if (pending === 0) {
          resolve(null);
        }
      };

      for (const lookup of lookups) {
        Promise.resolve(lookup)
          .then((theme) => {
            if (theme?.bg) {
              resolve(theme);
            } else {
              finishEmpty();
            }
          })
          .catch(() => finishEmpty());
      }
    });
  }

  function getLittleZenChromePageTheme(win) {
    const browser = win.gBrowser?.selectedBrowser;
    const href = getLittleZenThemeUrl(win)?.href || "";
    const browserHref = browser?.currentURI?.spec || "";
    let docHref = "";
    let theme = null;
    try {
      docHref = browser?.contentDocument?.location?.href || "";
      const chromeThemeAllowed = !docHref || !browserHref || docHref === browserHref;
      theme =
        (chromeThemeAllowed ? getTopVisibleTheme(browser) : null) ||
        (chromeThemeAllowed ? getThemeColorTheme(browser) : null) ||
        (chromeThemeAllowed ? getThemeFromElement(browser?.contentDocument?.defaultView, browser?.contentDocument?.body, "body") : null) ||
        (chromeThemeAllowed ? getThemeFromElement(browser?.contentDocument?.defaultView, browser?.contentDocument?.documentElement, "html") : null) ||
        (chromeThemeAllowed ? getDocumentCanvasTheme(browser) : null);
    } catch (error) {
      log("Little Zen page theme probe failed", error);
    }
    theme =
      theme ||
      (href ? null : getNeutralHeaderShade(win)) ||
      getChromeToolbarFallbackTheme(win);
    return {
      ...theme,
      href,
    };
  }

  function getLittleZenThemeUrl(win) {
    try {
      const spec =
        win.gBrowser?.selectedBrowser?.currentURI?.spec ||
        win.__littleZenRoutedURL ||
        win.__littleZenPendingURL;
      if (spec && !spec.startsWith("about:")) {
        return new URL(spec);
      }
    } catch (error) {}
    return null;
  }

  function getLittleZenThemeCacheKeys(href) {
    const keys = [];
    const raw = String(href || "");
    if (!raw) {
      return keys;
    }
    keys.push(`page:${raw}`);
    try {
      const url = new URL(raw);
      if (/^https?:$/i.test(url.protocol) && url.hostname) {
        keys.push(`host:${url.hostname.toLowerCase()}`);
      }
    } catch (error) {}
    return keys;
  }

  function rememberLittleZenTheme(theme, href) {
    if (!theme?.bg || !href || theme.source === "toolbar-fallback" || theme.source === "unknown-page") {
      return;
    }
    for (const key of getLittleZenThemeCacheKeys(href)) {
      littleZenThemeCache.set(key, theme);
    }
    while (littleZenThemeCache.size > LITTLE_ZEN_THEME_CACHE_LIMIT) {
      littleZenThemeCache.delete(littleZenThemeCache.keys().next().value);
    }
  }

  function getRememberedLittleZenTheme(href) {
    for (const key of getLittleZenThemeCacheKeys(href)) {
      const theme = littleZenThemeCache.get(key);
      if (theme?.bg) {
        return {
          ...theme,
          source: theme.source === "host-cache" ? "host-cache" : theme.source || "target-cache",
        };
      }
    }
    return null;
  }

  function applyLittleZenResolvedTheme(win, theme, reason = "unknown") {
    if (!isLittleWindow(win) || !theme) {
      return;
    }

    const root = win.document.documentElement;
    const url = getLittleZenThemeUrl(win);
    const themeColor = theme?.bg || (
      root.hasAttribute("zen-should-be-dark-mode")
        ? "rgb(16, 18, 24)"
        : "rgb(245, 247, 251)"
    );
    const themeRgb = parseCssRgb(themeColor) || (
      root.hasAttribute("zen-should-be-dark-mode")
        ? { r: 16, g: 18, b: 24 }
        : { r: 245, g: 247, b: 251 }
    );
    const header = themeColor;
    const foreground = getStableHeaderForeground(themeRgb, theme?.fg);
    root.setAttribute(
      "zen-little-header-text",
      getRelativeLuminance(parseCssRgb(foreground)) > 0.5 ? "light" : "dark"
    );
    const windowBackground = themeColor;
    const isLightTheme = getRelativeLuminance(themeRgb) > 0.56;
    const controlOutline = getBlendedControlOutline(themeRgb);
    const pageOutline = isLightTheme
      ? "rgba(0, 0, 0, 0.34)"
      : "rgba(255, 255, 255, 0.20)";
    const tintBackground = windowBackground;

    setCssVar(root, "--little-zen-page-header-background", header);
    setCssVar(root, "--little-zen-page-header-foreground", foreground);
    setCssVar(root, "--little-zen-window-theme-background", windowBackground);
    setCssVar(root, "--little-zen-theme-outline", controlOutline);
    setCssVar(root, "--little-zen-page-outline", pageOutline);
    setCssVar(root, "--blended-addressbar-frame-background", windowBackground);
    setCssVar(root, "--blended-addressbar-window-tint-background", tintBackground);
    setCssVar(
      win.document.getElementById("zen-browser-background"),
      "--blended-addressbar-window-tint-background",
      tintBackground
    );
    rememberLittleZenTheme(theme, theme.href || url?.href || "");

    log("Little Zen blended theme updated", {
      reason,
      href: url?.href ?? null,
      source: theme?.source ?? null,
      header,
      foreground,
      windowBackground,
      controlOutline,
      pageOutline,
      tintBackground,
    });
  }

  async function updateLittleZenBlendedTheme(win, reason = "unknown") {
    if (
      !isLittleWindow(win) ||
      win.document.documentElement.hasAttribute("zen-little-window-loading")
    ) {
      return;
    }

    const browser = win.gBrowser?.selectedBrowser;
    const expectedHref = getLittleZenThemeUrl(win)?.href || "";
    const chromeTheme = getLittleZenChromePageTheme(win);
    const rememberedTheme = getRememberedLittleZenTheme(expectedHref);
    if (rememberedTheme?.bg && chromeTheme?.source === "toolbar-fallback") {
      applyLittleZenResolvedTheme(win, rememberedTheme, `${reason}:retained`);
    } else {
      applyLittleZenResolvedTheme(win, chromeTheme, reason);
    }

    const contentTheme = await getLittleZenAsyncPageTheme(browser);
    if (!contentTheme?.bg || !isLittleWindow(win)) {
      return;
    }
    const currentHref = getLittleZenThemeUrl(win)?.href || "";
    if (expectedHref && currentHref && expectedHref !== currentHref) {
      return;
    }
    applyLittleZenResolvedTheme(win, contentTheme, `${reason}:content`);
  }

  function getLittleWindowUrl(win) {
    try {
      const browser = win.gBrowser?.selectedBrowser;
      const spec = browser?.currentURI?.spec;
      if (spec && spec !== "about:blank" && spec !== "about:newtab") {
        return spec;
      }
    } catch (e) {}
    return null;
  }

  function getInitialTargetWorkspaceId(mainWin) {
    return getActiveWorkspaceId(mainWin);
  }

  function setCssVar(element, name, value) {
    if (!element?.style) {
      return;
    }
    if (value) {
      element.style.setProperty(name, value);
    } else {
      element.style.removeProperty(name);
    }
  }

  async function transferTabToWorkspace(win, workspaceId) {
    const mainWin = getMainBrowserWindow(win) || (win.__littleZenHostlessStartup ? win : null);
    if (!mainWin) {
      log("transferTabToWorkspace: no main window found");
      return;
    }

    const workspace = getWorkspaceById(mainWin, workspaceId);
    if (!workspace) {
      log("transferTabToWorkspace: workspace not found", workspaceId);
      return;
    }

    const url = getLittleWindowUrl(win);
    log("Transferring tab to workspace", { url, workspace: workspace.name });

    try {
      if (typeof mainWin.gZenWorkspaces?.changeWorkspaceWithID === "function") {
        await mainWin.gZenWorkspaces.changeWorkspaceWithID(workspaceId);
      } else {
        await mainWin.gZenWorkspaces?.changeWorkspace?.(workspace);
      }
      if (url) {
        const newTab = mainWin.gBrowser.addTab(url, {
          triggeringPrincipal:
            Services.scriptSecurityManager.getSystemPrincipal(),
          skipRoute: true,
        });
        mainWin.gBrowser.selectedTab = newTab;
      }
      mainWin.focus();
    } catch (error) {
      log("transferTabToWorkspace failed", error);
    } finally {
      win.close();
    }
  }

  function buildSpacePicker(win) {
    const doc = win.document;
    if (doc.getElementById(PICKER_ID)) {
      return;
    }

    const mainWin = getMainBrowserWindow(win) || (win.__littleZenHostlessStartup ? win : null);
    if (!mainWin) {
      return;
    }

    // Split workspace control, mirroring Zen's toolbarbutton/menuitem shape.
    const picker = doc.createXULElement("toolbaritem");
    picker.id = PICKER_ID;
    picker.setAttribute("align", "center");
    picker.classList.add("chromeclass-toolbar-additional");

    // The source browser profile is distinct from the target Space.
    const spaceBadge = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    spaceBadge.id = PICKER_ID + "-badge";
    spaceBadge.classList.add("zen-little-window-space-badge");
    spaceBadge.setAttribute("role", "note");
    spaceBadge.setAttribute("aria-label", "Current profile");
    const spaceBadgeIcon = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    spaceBadgeIcon.id = PICKER_ID + "-badge-icon";
    spaceBadge.appendChild(spaceBadgeIcon);
    const spaceBadgeName = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
    spaceBadgeName.id = PICKER_ID + "-badge-name";
    spaceBadge.appendChild(spaceBadgeName);

    const openButton = doc.createXULElement("toolbarbutton");
    openButton.id = PICKER_ID + "-open";
    openButton.classList.add(
      "toolbarbutton-1",
      "chromeclass-toolbar-additional",
      "zen-little-window-space-button"
    );
    openButton.setAttribute("crop", "end");
    openButton.setAttribute("flex", "1");
    openButton.setAttribute("orient", "horizontal");
    openButton.setAttribute("tooltip", "dynamic-shortcut-tooltip");

    const openButtonLabel = doc.createXULElement("label");
    openButtonLabel.id = PICKER_ID + "-label";
    openButtonLabel.setAttribute("crop", "end");
    openButtonLabel.setAttribute("flex", "1");
    openButton.appendChild(openButtonLabel);

    const shortcutHint = doc.createXULElement("label");
    shortcutHint.id = PICKER_ID + "-shortcut";
    shortcutHint.setAttribute("value", getOpenShortcutDisplay());
    shortcutHint.setAttribute("tooltiptext", "Open in main window");
    openButton.appendChild(shortcutHint);

    const arrow = doc.createXULElement("toolbarbutton");
    arrow.id = PICKER_ID + "-arrow";
    arrow.classList.add(
      "toolbarbutton-1",
      "chromeclass-toolbar-additional",
      "zen-little-window-space-arrow"
    );
    arrow.setAttribute("type", "menu");
    arrow.setAttribute("label", "▾");
    arrow.setAttribute("orient", "horizontal");

    const arrowLabel = doc.createXULElement("label");
    arrowLabel.id = PICKER_ID + "-arrow-label";
    arrowLabel.setAttribute("value", "▾");
    arrow.appendChild(arrowLabel);

    // Popup menu
    const popup = doc.createXULElement("menupopup");
    popup.id = PICKER_MENU_ID;
    popup.setAttribute("ignorekeys", "true");

    picker.appendChild(openButton);
    picker.appendChild(arrow);
    arrow.appendChild(popup);

    // State: which workspace is targeted
    let targetWorkspaceId = getInitialTargetWorkspaceId(mainWin);

    const applyWorkspaceTheme = (wsId) => {
      try {
        const root = doc.documentElement;
        setCssVar(root, "--little-zen-window-background", "");
        setCssVar(root, "--little-zen-window-toolbar-background", "");
        picker.setAttribute("zen-workspace-id", wsId ?? "");
      } catch (e) {}
    };

    const updateLabel = () => {
      const ws = getWorkspaceById(mainWin, targetWorkspaceId);
      const name = ws?.name ?? "Space";
      const label = `Open in ${name}`;
      openButton.setAttribute("label", label);
      openButton.setAttribute("shortcut", getOpenShortcutDisplay());
      openButtonLabel.setAttribute("value", label);
      openButton.setAttribute("tooltiptext", `Open in ${name}`);
      arrow.setAttribute("tooltiptext", name);
      applyWorkspaceTheme(targetWorkspaceId);
    };

    const refreshRouteTarget = () => {
      const activeWorkspaceId = getInitialTargetWorkspaceId(mainWin);
      if (activeWorkspaceId && activeWorkspaceId !== targetWorkspaceId) {
        targetWorkspaceId = activeWorkspaceId;
        updateLabel();
      }
    };

    const openMenu = () => {
      const workspaces = getWorkspaces(mainWin);
      while (popup.firstChild) popup.removeChild(popup.firstChild);
      popup.classList.add("zen-little-window-space-menu");

      const searchRow = doc.createXULElement("hbox");
      searchRow.className = "zen-little-window-space-menu-search-row";
      searchRow.setAttribute("align", "center");

      const searchInput = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "input"
      );
      searchInput.id = PICKER_MENU_ID + "-search";
      searchInput.className = "zen-little-window-space-menu-search";
      searchInput.setAttribute("type", "search");
      searchInput.setAttribute("placeholder", "Search spaces");
      searchInput.setAttribute("autocomplete", "off");
      searchInput.setAttribute("aria-label", "Search spaces");
      searchInput.setAttribute("dir", "ltr");
      searchRow.appendChild(searchInput);
      popup.appendChild(searchRow);

      const noResults = doc.createXULElement("label");
      noResults.className = "zen-little-window-space-menu-no-results";
      noResults.setAttribute("value", "No spaces found");
      noResults.hidden = true;
      popup.appendChild(noResults);

      const selectWorkspace = (ws) => {
        targetWorkspaceId = ws.uuid;
        updateLabel();
        try {
          popup.hidePopup();
        } catch (error) {}
      };

      const rows = [];
      workspaces.forEach(ws => {
        const item = doc.createXULElement("menuitem");
        item.className = "zen-workspace-context-menu-item zen-little-window-space-menu-item";
        item.__littleZenWorkspace = ws;
        item.setAttribute("zen-workspace-id", ws.uuid);
        const icon = getWorkspaceDisplayIcon(ws);
        const iconIsSvg = !!icon && icon.endsWith(".svg");
        if (iconIsSvg) {
          item.setAttribute("image", icon);
          item.classList.add("menuitem-iconic", "zen-workspace-context-icon");
          item.setAttribute("label", ws.name);
        } else {
          item.setAttribute("label", `${icon}  ${ws.name}`);
        }
        item.setAttribute("data-label", `${ws.name ?? ""} ${icon ?? ""}`.toLowerCase());
        if (ws.uuid === targetWorkspaceId) {
          item.setAttribute("selected", "true");
        }
        item.addEventListener("command", () => {
          selectWorkspace(ws);
        });
        item.addEventListener("DOMMenuItemActive", () => {
          setSelectedRow(item);
        });
        item.addEventListener("DOMMenuItemInactive", () => {
          item.removeAttribute("selected");
        });
        rows.push(item);
        popup.appendChild(item);
      });

      const visibleRows = () => rows.filter(item => !item.hidden);
      const setSelectedRow = (row) => {
        rows.forEach(item => item.removeAttribute("selected"));
        row?.setAttribute("selected", "true");
        row?.scrollIntoView?.({ block: "nearest" });
      };
      const filterRows = () => {
        const query = searchInput.value.toLowerCase().trim();
        let shown = 0;
        for (const item of rows) {
          const matches = !query || item.getAttribute("data-label").includes(query);
          item.hidden = !matches;
          if (matches) {
            shown++;
          }
        }
        noResults.hidden = shown > 0;
        if (!visibleRows().some(item => item.hasAttribute("selected"))) {
          setSelectedRow(visibleRows()[0]);
        }
      };
      const moveSelection = (direction) => {
        const visible = visibleRows();
        if (!visible.length) {
          return;
        }
        const currentIndex = Math.max(
          0,
          visible.findIndex(item => item.hasAttribute("selected"))
        );
        setSelectedRow(visible[(currentIndex + direction + visible.length) % visible.length]);
      };
      const acceptSelection = () => {
        const selected = visibleRows().find(item => item.hasAttribute("selected"));
        if (selected?.__littleZenWorkspace) {
          selectWorkspace(selected.__littleZenWorkspace);
        }
      };
      const stopSearchEvent = (event) => {
        if (event.target === searchInput || searchRow.contains(event.target)) {
          if (event.type === "keydown") {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              popup.hidePopup();
              return;
            }
            if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) {
              event.preventDefault();
              event.stopPropagation();
              moveSelection(1);
              return;
            }
            if (event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey)) {
              event.preventDefault();
              event.stopPropagation();
              moveSelection(-1);
              return;
            }
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              acceptSelection();
              return;
            }
          }
          event.stopPropagation();
        }
      };

      for (const eventName of [
        "keydown",
        "keypress",
        "keyup",
        "mousedown",
        "mouseup",
        "click",
      ]) {
        popup.addEventListener(eventName, stopSearchEvent, true);
      }
      searchInput.addEventListener("input", filterRows);
      popup.addEventListener(
        "popupshown",
        () => {
          searchInput.focus();
          searchInput.select();
        },
        { once: true }
      );
      popup.openPopup(picker, "after_start", 0, 0, false, false);
    };

    const openSelectedWorkspace = () => {
      transferTabToWorkspace(win, targetWorkspaceId);
    };

    openButton.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      openSelectedWorkspace();
    });

    openButton.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    arrow.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu();
    });

    arrow.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });

    // Ctrl/Cmd+O opens in the current target; Alt opens the Space picker.
    win.addEventListener("keydown", (e) => {
      if (
        !e.defaultPrevented &&
        !e.repeat &&
        (AppConstants.platform === "macosx" ? e.metaKey : e.ctrlKey) &&
        e.key?.toLowerCase() === "o"
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (e.altKey) {
          openMenu();
        } else {
          openSelectedWorkspace();
        }
      }
    }, true);

    // Keep label in sync when main window changes workspace
    try {
      mainWin.addEventListener("ZenWorkspaceChanged", () => {
        const activeWorkspaceId = getInitialTargetWorkspaceId(mainWin);
        if (activeWorkspaceId) {
          log("Little Zen picker target refreshed after workspace change", {
            activeWorkspaceId,
          });
          targetWorkspaceId = activeWorkspaceId;
          updateLabel();
        }
      });
    } catch (e) {}

    updateLabel();
    win.__littleZenRefreshSpacePickerTarget = refreshRouteTarget;
    win.setTimeout(refreshRouteTarget, 150);
    win.setTimeout(refreshRouteTarget, 750);

    // Arc profiles most closely correspond to Zen container identities. Read
    // the selected tab's actual identity, independently of the destination Space.
    const refreshIdentityBadge = () => {
      const tab = win.gBrowser?.selectedTab;
      const attributeId = tab?.getAttribute("usercontextid");
      const rawId = attributeId !== null && attributeId !== undefined && attributeId !== ""
        ? attributeId : (tab?.userContextId ?? win.__littleZenTargetContainerId ?? 0);
      const id = Number(rawId);
      let name = "Default";
      try {
        const { ContextualIdentityService } = ChromeUtils.importESModule(
          "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
        );
        const identity = id > 0 ? ContextualIdentityService.getPublicIdentityFromId(id) : null;
        if (identity) name = ContextualIdentityService.getUserContextLabel(id) || identity.name || name;
      } catch (error) {
        name = "Identity unavailable";
        log("Could not resolve Little Zen container identity", error);
      }
      spaceBadgeIcon.textContent = name.charAt(0).toUpperCase();
      spaceBadgeName.textContent = name;
      spaceBadge.setAttribute("aria-label", `Container: ${name}`);
      spaceBadge.setAttribute("title", `Container: ${name}`);
    };
    refreshIdentityBadge();
    win.gBrowser?.tabContainer?.addEventListener("TabSelect", refreshIdentityBadge);
    win.setTimeout(refreshIdentityBadge, 150);
    win.setTimeout(refreshIdentityBadge, 750);
    const inputContainer = doc.querySelector("#urlbar .urlbar-input-container");
    if (inputContainer) inputContainer.insertBefore(spaceBadge, inputContainer.firstChild);
    const navBar = doc.getElementById("nav-bar");
    const nativeWindowControls = doc.querySelector(".titlebar-buttonbox-container");
    const nativeControlsHost = doc.getElementById("zen-sidebar-top-buttons");
    const nativeButtonBox = doc.querySelector(".titlebar-buttonbox");
    log("Inspected native titlebar controls", {
      containerFound: !!nativeWindowControls,
      buttonBoxFound: !!nativeButtonBox,
      hostFound: !!nativeControlsHost,
      containerParent: nativeWindowControls?.parentElement?.id ?? null,
      buttonCount: nativeWindowControls?.querySelectorAll(".titlebar-button").length ?? 0,
    });
    if (navBar && nativeWindowControls && nativeControlsHost?.contains(nativeWindowControls)) {
      // On macOS Gecko uses the themed box's paint geometry to position the
      // real NSWindow buttons. Keep that box outside the collapsed toolbox and
      // its clipped navigation wrapper. The toolbarbutton children stay hidden
      // on macOS, as in Zen's own browser.css.
      if (AppConstants.platform === "macosx" && nativeButtonBox) {
        nativeButtonBox.id = "little-zen-native-button-box";
        doc.documentElement.appendChild(nativeButtonBox);
        log("Placed native macOS button geometry at window root");
      } else {
      // Reuse Zen/macOS's real titlebar controls rather than drawing lookalikes.
      navBar.insertBefore(nativeControlsHost, navBar.firstChild);
      nativeControlsHost.classList.remove("customization-target");
      const exposeNativeElement = (element, display) => {
        if (!element) return;
        try {
          if ("collapsed" in element) element.collapsed = false;
          if ("hidden" in element) element.hidden = false;
        } catch (error) {}
        element.removeAttribute("hidden");
        element.removeAttribute("collapsed");
        element.style.setProperty("display", display, "important");
        element.style.setProperty("visibility", "visible", "important");
      };
      exposeNativeElement(nativeControlsHost, "flex");
      exposeNativeElement(nativeWindowControls, "flex");
      exposeNativeElement(nativeButtonBox, "flex");
      const isMaximized =
        doc.documentElement.getAttribute("sizemode") === "maximized" ||
        win.windowState === win.STATE_MAXIMIZED;
      nativeWindowControls.querySelectorAll(".titlebar-button").forEach(button => {
        const isRestore = button.classList.contains("titlebar-restore");
        const isMaximize = button.classList.contains("titlebar-max");
        const shouldShow = isRestore ? isMaximized : !(isMaximize && isMaximized);
        if (shouldShow) {
          exposeNativeElement(button, "flex");
        } else {
          button.style.setProperty("display", "none", "important");
        }
      });
      win.requestAnimationFrame(() => {
        const describe = element => {
          if (!element) return null;
          const style = win.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return {
            id: element.id || null,
            className: String(element.className?.baseVal ?? element.className ?? ""),
            display: style.display,
            visibility: style.visibility,
            color: style.color,
            appearance: style.getPropertyValue("-moz-appearance") || style.appearance,
            hidden: "hidden" in element ? element.hidden : null,
            collapsed: "collapsed" in element ? element.collapsed : null,
            hasHiddenAttribute: element.hasAttribute("hidden"),
            hasCollapsedAttribute: element.hasAttribute("collapsed"),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            inlineStyle: element.getAttribute("style"),
          };
        };
        let displayRules = [];
        try {
          const inspector = win.InspectorUtils ?? globalThis.InspectorUtils;
          const rules = inspector?.getCSSStyleRules(nativeControlsHost);
          if (rules) {
            for (let index = 0; index < rules.length; index++) {
              const rule = rules.item(index);
              const display = rule?.style?.getPropertyValue("display");
              const visibility = rule?.style?.getPropertyValue("visibility");
              if (display || visibility) {
                displayRules.push({
                  selector: rule.selectorText,
                  display,
                  displayPriority: rule.style.getPropertyPriority("display"),
                  visibility,
                  visibilityPriority: rule.style.getPropertyPriority("visibility"),
                });
              }
            }
          }
        } catch (error) {
          displayRules = [{ error: formatLogArg(error) }];
        }
        log("Native titlebar control layout", {
          host: describe(nativeControlsHost),
          hostParent: describe(nativeControlsHost.parentElement),
          container: describe(nativeWindowControls),
          buttonBox: describe(nativeButtonBox),
          buttons: [...nativeWindowControls.querySelectorAll(".titlebar-button")].map(describe),
          displayRules,
        });
      });
      }
    } else {
      log("Could not locate Zen's native titlebar control host for Little Zen.");
    }

    // Insert destination action into .customizableui-special-spring2 (right side).
    const spring2 = doc.querySelector(".customizableui-special-spring2");
    if (spring2) {
      spring2.appendChild(picker);
      log("Injected space picker into .customizableui-special-spring2");
    } else {
      // Fallback: right end of nav-bar
      const navBar = doc.getElementById("nav-bar") || doc.getElementById("urlbar-container");
      if (navBar) {
        navBar.appendChild(picker);
        log("Injected space picker into nav-bar (fallback)");
      }
    }

    // Popup stays inside picker — moving it to popupSet breaks single-click command events
  }

  function ensureSpacePicker(win) {
    if (!isLittleWindow(win) || win.document.getElementById(PICKER_ID)) {
      return;
    }
    const mainWin = getMainBrowserWindow(win) || (win.__littleZenHostlessStartup ? win : null);
    if (!mainWin?.gZenWorkspaces) {
      // Retry until workspaces are ready
      win.setTimeout(() => ensureSpacePicker(win), 500);
      return;
    }
    buildSpacePicker(win);
  }

  // ── End Workspace Picker ─────────────────────────────────────────────────────

  function attachDoubleEscapeClose(win) {
    if (win[PATCH_FLAGS.doubleEscapeClose]) {
      return;
    }

    let lastEscapeAt = 0;
    const onKeyDown = event => {
      if (!isLittleWindow(win) || event.defaultPrevented || event.key !== "Escape") {
        return;
      }

      const now = win.performance?.now?.() ?? Date.now();
      if (now - lastEscapeAt <= 520) {
        event.preventDefault();
        event.stopPropagation();
        logLittleWindowState(win, "Closing Little Zen window after double Escape");
        closeEmptyLittleWindow(win);
        return;
      }

      lastEscapeAt = now;
      win.setTimeout(() => {
        if ((win.performance?.now?.() ?? Date.now()) - lastEscapeAt >= 520) {
          lastEscapeAt = 0;
        }
      }, 560);
    };

    win.addEventListener("keydown", onKeyDown, true);
    win.addEventListener(
      "unload",
      () => {
        try {
          win.removeEventListener("keydown", onKeyDown, true);
        } catch (error) {}
      },
      { once: true }
    );
    win[PATCH_FLAGS.doubleEscapeClose] = true;
    log("Attached Little Zen double Escape close listener");
  }

  function finishLittleZenTabSwitch(win, request) {
    let attempts = 0;
    const check = async () => {
      if (win.closed) return;
      let privateBrowsing;
      try {
        ({ PrivateBrowsingUtils: privateBrowsing } = ChromeUtils.importESModule(
          "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
        ));
      } catch (error) {
        win.__littleZenGlobalFocusToken = request.focusToken;
        closeEmptyLittleWindow(win);
        return;
      }
      const matches = [];
      for (const targetWin of browserWindows()) {
        if (targetWin === win || targetWin.closed || isLittleWindow(targetWin)) continue;
        if (privateBrowsing.isWindowPrivate(targetWin) !== privateBrowsing.isWindowPrivate(win)) continue;
        for (const tab of targetWin.gBrowser?.tabs ?? []) {
          if (!tab.closing && tab.linkedBrowser?.currentURI?.spec === request.url &&
              getTabContainerId(tab) === request.userContextId) matches.push({ targetWin, tab });
        }
      }
      const changed = matches.filter(({ targetWin, tab }) => {
        const before = request.priorSelections?.find(item => item.window === targetWin);
        return before && targetWin.gBrowser.selectedTab === tab &&
          (before.tab !== tab || before.workspace !== getActiveWorkspaceId(targetWin));
      });
      // URL and container do not identify which of several duplicate tabs the
      // user meant. Only resolve an ambiguous result after Zen selects one.
      const match = matches.length === 1 ? matches[0] : changed.length === 1 ? changed[0] : null;
      if (match) {
        const { targetWin, tab } = match;
        try {
          const workspaceId = tab.getAttribute("zen-workspace-id");
          if (workspaceId && getActiveWorkspaceId(targetWin) !== workspaceId) {
            if (typeof targetWin.gZenWorkspaces?.changeWorkspaceWithID !== "function") throw new Error("Space switch unavailable");
            await targetWin.gZenWorkspaces.changeWorkspaceWithID(workspaceId);
          }
          if (win.closed) return;
          if (tab.closing) throw new Error("Target tab closed during switch");
          targetWin.gBrowser.selectedTab = tab;
          win.close();
          targetWin.focus();
          log("Completed Little Zen switch to existing tab");
          return;
        } catch (error) {
          log("Could not finish Little Zen tab switch", error);
        }
      }
      if (++attempts < 30) {
        win.setTimeout(check, 100);
      } else {
        win.__littleZenGlobalFocusToken = request.focusToken;
        log("Little Zen tab switch not confirmed; closing empty search window");
        closeEmptyLittleWindow(win);
      }
    };
    win.setTimeout(check, 100);
  }

  function attachAutoClose(win) {
    if (win[PATCH_FLAGS.autoClose]) {
      return;
    }

    const urlbar = win.gURLBar;
    let resizeObserver = null;

    if (win.__littleZenStartExpanded) {
      win.document.documentElement.setAttribute(LITTLE_WINDOW_ATTR, "true");
      applyExpandedLittleWindow(win, "expanded-startup");
      win[PATCH_FLAGS.autoClose] = true;
      logLittleWindowState(win, "Opened expanded Little Zen window");
      return;
    }

    const onOpened = () => {
      releaseLittleWindowPresentation(win, "floating-urlbar-opened");
      positionSearchWindow(win);

      try {
        win.focus();
        urlbar?.focus();
        urlbar?.select();
        urlbar?.inputField?.focus();
      } catch (error) {
        log("Could not focus the Little Zen urlbar.", error);
      }

      logLittleWindowState(win, "Opened Little Zen floating urlbar", {
        layout: getLittleWindowLayoutState(win),
      });
    };

    const onUnload = () => {
      cleanupLittleWindowLifecycle(win, "unload");
    };

    const cleanup = reason => {
      if (win.__littleZenLifecycleCleanup !== cleanup) {
        return;
      }

      delete win.__littleZenLifecycleCleanup;
      try {
        resizeObserver?.disconnect();
      } catch (error) {}
      resizeObserver = null;
      clearLittleWindowLoadingFallback(win);
      try {
        win.removeEventListener("ZenFloatingURLBarOpened", onOpened);
        win.removeEventListener("ZenURLBarClosed", onClosed);
        win.removeEventListener("unload", onUnload);
      } catch (error) {}
      releaseLittleWindowPresentation(win, `cleanup:${reason}`);
      logLittleWindowState(win, "Cleaned up Little Zen lifecycle", { reason });
    };

    const onClosed = event => {
      cleanup("urlbar-closed");

      if (win.closed) {
        return;
      }

      const switchRequest = win.__littleZenSwitchToTab;
      if (switchRequest?.url) {
        delete win.__littleZenSwitchToTab;
        finishLittleZenTabSwitch(win, switchRequest);
        return;
      }

      if (!event.detail?.onElementPicked && !win.__littleZenPendingURL) {
        logLittleWindowState(win, "Closing empty Little Zen window after urlbar close");
        closeEmptyLittleWindow(win);
        return;
      }

      expandLittleWindow(
        win,
        event.detail?.onElementPicked ? "urlbar-picked" : "urlbar-closed"
      );
    };

    const urlbarElement = win.document.getElementById("urlbar");
    const resultsElement = urlbarElement?.querySelector(".urlbarView");
    const maxSearchHeight = Math.max(URLBAR_HEIGHT, Math.floor((win.screen?.availHeight || 900) * 0.7));
    win.document.documentElement.style.setProperty(
      "--little-zen-results-max-height", `${Math.max(100, maxSearchHeight - 80)}px`
    );
    if (urlbarElement && typeof win.ResizeObserver === "function") {
      resizeObserver = new win.ResizeObserver(entries => {
        if (win.closed || !isEmptyLittleWindow(win) || !urlbarElement.hasAttribute("breakout-extend")) {
          return;
        }

        for (const entry of entries) {
          if (entry.target !== urlbarElement && entry.target !== resultsElement) {
            continue;
          }

          const inputRect = urlbarElement.getBoundingClientRect();
          const resultsRect = resultsElement?.getBoundingClientRect();
          const height = Math.max(inputRect.bottom, resultsRect?.bottom || 0);
          if (!height) {
            continue;
          }

          const windowHeight = Math.min(
            maxSearchHeight,
            Math.max(Math.ceil(height + Math.max(0, win.outerHeight - win.innerHeight)), 80)
          );
          try {
            if (Math.abs(win.outerHeight - windowHeight) > 1 || Math.abs(win.outerWidth - URLBAR_WIDTH) > 1) {
              win.resizeTo(URLBAR_WIDTH, windowHeight);
            }
            if (Services.prefs.getIntPref(SEARCH_HEIGHT_PREF, 0) !== windowHeight) {
              Services.prefs.setIntPref(SEARCH_HEIGHT_PREF, windowHeight);
            }
            logLittleWindowState(win, "Resized Little Zen window to urlbar bounds", {
              width: URLBAR_WIDTH,
              height: windowHeight,
              actualOuterHeight: win.outerHeight,
              actualInnerHeight: win.innerHeight,
            });
          } catch (error) {
            log("Could not resize the Little Zen window to match the urlbar.", error);
          }
        }
      });
      resizeObserver.observe(urlbarElement);
      if (resultsElement) resizeObserver.observe(resultsElement);
    }

    win.document.documentElement.setAttribute(LITTLE_WINDOW_ATTR, "true");
    win.document.documentElement.toggleAttribute("zen-no-padding", isEmptyLittleWindow(win));
    win.__littleZenLifecycleCleanup = cleanup;

    setWindowResizable(win, true);
    try {
      win.resizeTo(URLBAR_WIDTH, Math.min(initialSearchHeight(), maxSearchHeight));
      positionSearchWindow(win);
      win.focus();
      closeLittleWindowUrlbar(win, "attach-auto-close-disabled");
    } catch (error) {
      log("Could not size the little window.", error);
    }

    win.addEventListener("ZenFloatingURLBarOpened", onOpened, { once: true });
    win.addEventListener("ZenURLBarClosed", onClosed, { once: true });
    win.addEventListener("unload", onUnload, { once: true });
    win.gZenWorkspaces?.promiseInitialized?.finally?.(() => {
      releaseLittleWindowPresentation(win, "workspaces-ready");
    });
    win[PATCH_FLAGS.autoClose] = true;
    log("Attached Little Zen lifecycle listeners");
  }

  function applyLittleWindowMode(win) {
    if (!isBrowserWindow(win)) {
      return;
    }

    win.document.documentElement.setAttribute(LITTLE_WINDOW_ATTR, "true");
    patchCompactModeManager(win);
    patchVerticalTabsManager(win);
    patchZenUIManager(win);
    patchUrlbar(win);
    patchLittleZenContainerNavigation(win);
    attachEmptyTabStateTracking(win);
    attachTransparentBrowserPrefSync(win);
    attachLittleWindowCloseButtonGuard(win);
    attachDoubleEscapeClose(win);
    syncLittleWindowTransparentBrowsers(win);
    ensureLittleWindowLoadingPulse(win);
    if (win.__littleZenStartLoadingVeil || win.__littleZenPendingURL) {
      setLittleWindowLoading(win, true, "apply-mode-startup");
    }
    syncEmptyTabState(win, "apply-mode");
    updateLittleZenBlendedTheme(win, "apply-mode");
    refreshLittleWindowLayout(win);
    attachLittleWindowExtensionPlacement(win);
    attachAutoClose(win);
    if (win.__littleZenPendingURL) {
      schedulePendingNavigationFlush(win, "apply-mode");
    } else if (!win.__littleZenSuppressUrlbarFocus) {
      closeLittleWindowUrlbar(win, "apply-mode-urlbar-disabled");
    }
    ensureSpacePicker(win);
    // Independent close control for platforms where native titlebar controls are absent.
    const nav = win.document.getElementById("nav-bar");
    if (nav && !win.document.getElementById("little-zen-close-button")) {
      const button = win.document.createXULElement("toolbarbutton");
      button.id = "little-zen-close-button";
      button.setAttribute("label", "×");
      button.setAttribute("tooltiptext", "Close Little Zen");
      button.setAttribute("aria-label", "Close Little Zen");
      button.addEventListener("command", () => win.close());
      nav.appendChild(button);
    }
    const searchInput = win.document.querySelector("#urlbar .urlbar-input-container");
    if (searchInput && !win.document.getElementById("little-zen-search-close-button")) {
      const button = win.document.createElementNS("http://www.w3.org/1999/xhtml", "button");
      button.id = "little-zen-search-close-button";
      button.textContent = "×";
      button.setAttribute("type", "button");
      button.setAttribute("tooltiptext", "Close Little Zen");
      button.setAttribute("aria-label", "Close Little Zen");
      button.addEventListener("click", event => { event.stopPropagation(); closeEmptyLittleWindow(win); });
      searchInput.appendChild(button);
    }
    logLittleWindowState(win, "Applied Little Zen mode");
  }

  function whenStartupReady(win, callback) {
    if (win.gBrowserInit?.delayedStartupFinished) {
      win.__littleZenStartupReady = true;
      callback();
      return;
    }

    const observer = new win.MutationObserver(() => {
      if (!win.gBrowserInit?.delayedStartupFinished) {
        return;
      }
      observer.disconnect();
      win.__littleZenStartupReady = true;
      callback();
    });

    observer.observe(win.document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    win.addEventListener(
      "unload",
      () => {
        try {
          observer.disconnect();
        } catch (error) {}
      },
      { once: true }
    );
  }

  function ensureCommand(win) {
    if (win.document.getElementById(COMMAND_ID)) {
      return;
    }

    const commandSet =
      win.document.getElementById("zenCommandSet") ||
      win.document.getElementById("mainCommandSet");
    if (!commandSet) {
      return;
    }

    const command = win.document.createXULElement("command");
    command.id = COMMAND_ID;
    command.addEventListener("command", () => {
      LittleZen.openLittleWindow(win, { source: "command" });
    });
    commandSet.appendChild(command);
    log("Injected cmd_zenNewLittleWindow command");
  }

  function ensureFallbackShortcut(win) {
    if (win[PATCH_FLAGS.keyListener]) {
      return;
    }

    // F18 is reserved for the local macOS bridge and is distinct from its global shortcut.
    const bridgeSet = win.document.getElementById("mainKeyset");
    if (bridgeSet && !win.document.getElementById("little-zen-bridge-key")) {
      const bridgeKey = win.document.createXULElement("key");
      bridgeKey.id = "little-zen-bridge-key";
      bridgeKey.setAttribute("keycode", "VK_F18");
      bridgeKey.setAttribute("command", COMMAND_ID);
      bridgeSet.appendChild(bridgeKey);
    }

    const isAccelPressed = event =>
      AppConstants.platform === "macosx"
        ? event.metaKey || event.ctrlKey
        : event.ctrlKey;

    // Register the shortcut through Gecko's native keyset so it is handled
    // consistently by the browser chrome even when the focused content owns keys.
    const keyset = win.document.getElementById("mainKeyset");
    if (keyset && !win.document.getElementById("little-zen-shortcut-key")) {
      const key = win.document.createXULElement("key");
      key.id = "little-zen-shortcut-key";
      key.setAttribute("key", "n");
      key.setAttribute("modifiers", "accel,alt");
      key.setAttribute("command", COMMAND_ID);
      keyset.appendChild(key);
      log("Registered native Little Zen accel+alt+n key binding", {
        keyset: keyset.id,
      });
    } else if (!keyset) {
      log("Could not find mainKeyset for Little Zen shortcut");
    }

    const onKeyDown = event => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.shiftKey ||
        event.getModifierState("AltGraph") ||
        !event.altKey ||
        !isAccelPressed(event) ||
        event.code !== "KeyN" && event.key?.toLowerCase() !== "n"
      ) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      LittleZen.openLittleWindow(win, { source: "shortcut" });
    };

    win.addEventListener("keydown", onKeyDown, true);
    win[PATCH_FLAGS.keyListener] = true;
    log("Attached fallback Little Zen shortcut listener");
  }

  function patchContentLinkShortcut() {
    if (ClickHandlerParent[PATCH_FLAGS.contentLinkListener]) {
      return;
    }

    const originalContentAreaClick = ClickHandlerParent.prototype.contentAreaClick;
    ClickHandlerParent.prototype.contentAreaClick = function (event) {
      const usesAccel = AppConstants.platform === "macosx" ? event.metaKey : event.ctrlKey;
      if (
        event.button !== 0 ||
        event.shiftKey ||
        !event.altKey ||
        !usesAccel
      ) {
        return originalContentAreaClick.call(this, event);
      }

      const browser = this.manager.browsingContext.top.embedderElement;
      const opener = browser?.documentGlobal;
      if (!event.href || !isBrowserWindow(opener)) {
        return originalContentAreaClick.call(this, event);
      }

      try {
        if (LittleZen.openLittleWindow(opener, {
          url: event.href,
          source: "ctrl-alt-click",
          triggeringPrincipal: event.triggeringPrincipal,
        })) return undefined;
      } catch (error) {
        log("Little Zen link shortcut failed; using normal click handling", error);
      }
      return originalContentAreaClick.call(this, event);
    };

    ClickHandlerParent[PATCH_FLAGS.contentLinkListener] = true;
    log("Patched remote content Ctrl+Alt+click handling");
  }

  function attachMainTabShortcut(win) {
    if (isLittleWindow(win) || win[PATCH_FLAGS.tabClickListener]) {
      return;
    }

    const getShortcutTab = event => {
      const usesAccel =
        AppConstants.platform === "macosx" ? event.metaKey : event.ctrlKey;
      const tab = event.target?.closest?.(".tabbrowser-tab");
      if (
        event.button !== 0 ||
        event.shiftKey ||
        !event.altKey ||
        !usesAccel ||
        !tab
      ) {
        return null;
      }

      const url = tab.linkedBrowser?.currentURI?.spec;
      if (!url || url === "about:blank" || url === "about:newtab") {
        return null;
      }

      return { tab, url };
    };

    let handledTab = null;
    const onMouseDown = event => {
      handledTab = null;
      const target = getShortcutTab(event);
      if (!target) {
        return;
      }

      if (target.url.startsWith("file:")) {
        try {
          const file = Services.io.newURI(target.url).QueryInterface(Ci.nsIFileURL).file;
          if (!file.exists()) {
            Services.prompt.alert(win, "Little Zen", "This file no longer exists on disk.");
            return;
          }
        } catch (error) {
          log("Could not check Little Zen tab file", error);
        }
      }
      // This tab shortcut is browser chrome navigation, not a content click.
      try {
        if (!LittleZen.openLittleWindow(win, {
          url: target.url,
          source: "ctrl-alt-tab-click",
          triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
        })) return;
      } catch (error) {
        log("Little Zen tab shortcut failed; using normal tab handling", error);
        return;
      }
      handledTab = target.tab;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const onClick = event => {
      const target = getShortcutTab(event);
      if (!target || target.tab !== handledTab) {
        handledTab = null;
        return;
      }
      handledTab = null;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    win.gBrowser?.tabContainer?.addEventListener("mousedown", onMouseDown, true);
    win.gBrowser?.tabContainer?.addEventListener("click", onClick, true);
    win[PATCH_FLAGS.tabClickListener] = true;
    log("Attached main-window Ctrl+Alt+tab click handling");
  }

  // An external launch may create a transient window whose Space is not the
  // user's last active one. Resolve the most recently active normal window.
  function getLittleZenOriginSpace(opener) {
    try {
      if (isLittleWindow(opener) && opener.__littleZenHostlessStartup) {
        return opener.gZenWorkspaces?.getActiveWorkspace?.() ?? null;
      }
      let origin = opener;
      if (isLittleWindow(opener) || isExternalStartupWindow(opener)) {
        const { BrowserWindowTracker } = ChromeUtils.importESModule(
          "resource:///modules/BrowserWindowTracker.sys.mjs"
        );
        const { PrivateBrowsingUtils } = ChromeUtils.importESModule(
          "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
        );
        const privateMode = PrivateBrowsingUtils.isWindowPrivate(opener);
        origin = BrowserWindowTracker.orderedWindows.find(candidate =>
          candidate !== opener && isBrowserWindow(candidate) &&
          !isLittleWindow(candidate) && !candidate.closed &&
          PrivateBrowsingUtils.isWindowPrivate(candidate) === privateMode &&
          candidate.gZenWorkspaces?.getActiveWorkspace?.()
        );
        // On a cold external launch the first normal browser window is the
        // only possible source of the restored active Space.
        if (!origin && isExternalStartupWindow(opener) && !isLittleWindow(opener)) {
          origin = opener;
        }
      }
      return origin?.gZenWorkspaces?.getActiveWorkspace?.() ?? null;
    } catch (error) {
      log("Could not resolve the originating Space", error);
      return null;
    }
  }

  const LittleZen = {
    queueNavigation(win, url, meta = {}) {
      if (!url) {
        delete win.__littleZenSuppressUrlbarFocus;
        return;
      }

      win._zenStartupLittleWindow = true;
      try {
        win.document?.documentElement?.setAttribute(LITTLE_WINDOW_ATTR, "true");
        win.document?.documentElement?.setAttribute(
          "zen-little-window-loading",
          "true"
        );
      } catch (error) {
        log("Could not mark Little Zen window before queueing navigation", error);
      }

      win.__littleZenSuppressUrlbarFocus = true;
      win.__littleZenPendingURL = url;
      win.__littleZenRoutedURL = url;
      win.__littleZenPendingURLMeta = meta;
      setLittleWindowLoading(win, true, "queue-navigation");
      closeLittleWindowUrlbar(win, "queue-navigation");
      routeLog("Queued Little Zen navigation", {
        url,
        source: meta.source ?? "unknown",
      });
      try {
        win.__littleZenRefreshSpacePickerTarget?.();
      } catch (error) {
        log("Could not refresh Little Zen routed workspace target", error);
      }

      if (win.__littleZenStartupReady) {
        schedulePendingNavigationFlush(win, "queue-navigation-ready");
        return;
      }

      logLittleWindowState(win, "Little Zen navigation waiting for delayed startup", {
        url,
        source: meta.source ?? "unknown",
      });

      whenStartupReady(win, () => {
        logLittleWindowState(
          win,
          "Little Zen navigation callback reached delayed startup",
          {
            url,
            source: meta.source ?? "unknown",
          }
        );
        schedulePendingNavigationFlush(win, "queue-navigation-startup");
      });
    },

    openLittleWindow(opener = window, options = {}) {
      const {
        url = null,
        source = "manual",
        triggeringPrincipal = null,
        expanded = false,
      } = options;
      log("Little Zen open request", {
        source,
        url,
      });

      const originatingSpace = getLittleZenOriginSpace(opener);
      const rawContainerId = originatingSpace?.containerTabId;
      const targetContainerId = rawContainerId == null ? null : Number(rawContainerId);
      const validContainerId = Number.isSafeInteger(targetContainerId) && targetContainerId >= 0
        ? targetContainerId : null;
      if (validContainerId === null) {
        log("Cannot open Little Zen; originating Space container is unavailable");
        return null;
      }
      let privateBrowsing;
      try {
        ({ PrivateBrowsingUtils: privateBrowsing } = ChromeUtils.importESModule(
          "resource://gre/modules/PrivateBrowsingUtils.sys.mjs"
        ));
        // Until private window creation is independently verified, preserve the
        // browser's normal behavior rather than risk crossing privacy modes.
        if (privateBrowsing.isWindowPrivate(opener)) {
          log("Private Little Zen is unavailable until privacy isolation is verified");
          return null;
        }
      } catch (error) {
        log("Cannot establish privacy mode for Little Zen", error);
        return null;
      }
      const searchScreen = !url && !expanded ? cursorScreenBounds() : null;
      const focusToken = !url && !expanded && (source === "shortcut" || source === "command")
        ? takeGlobalFocusRequest() : null;
      for (const browserWindow of browserWindows()) {
        if (isEmptyLittleWindow(browserWindow) && !privateBrowsing.isWindowPrivate(browserWindow)) {
          browserWindow.__littleZenTargetContainerId = validContainerId;
          if (focusToken) {
            browserWindow.__littleZenGlobalFocusToken = focusToken;
            attachGlobalLittleWindowCloseSignal(browserWindow);
          }
          log("Reusing existing empty Little Zen window");
          if (!url && !expanded) {
            browserWindow.__littleZenSearchScreen = searchScreen;
            positionSearchWindow(browserWindow);
          }
          if (expanded) {
            applyExpandedLittleWindow(browserWindow, "expanded-reuse");
          }
          this.queueNavigation(browserWindow, url, { source, triggeringPrincipal });
          browserWindow.focus();
          if (!url && !expanded) {
            delete browserWindow.__littleZenSuppressUrlbarFocus;
            focusUrlbar(browserWindow);
          }
          return browserWindow;
        }
      }

      if (typeof opener?.OpenBrowserWindow !== "function") {
        log("Cannot open Little Zen; OpenBrowserWindow missing");
        return null;
      }

      const littleWindow = opener.OpenBrowserWindow({
        zenLittleWindow: true,
        all: false,
        features: expanded ? pageWindowFeatures(opener) : searchWindowFeatures(opener, searchScreen),
        littleZenSearchScreen: searchScreen,
        url,
        expanded,
        littleZenFreshExternalStart: source === "browserDOMWindow.openURI" ||
          source === "browserDOMWindow.openURIInFrame" || source === "external-startup-window",
        littleZenOriginContainerId: validContainerId,
      });

      if (littleWindow) {
        littleWindow.__littleZenTargetContainerId = validContainerId;
        if (focusToken) {
          littleWindow.__littleZenGlobalFocusToken = focusToken;
          attachGlobalLittleWindowCloseSignal(littleWindow);
        }
        this.queueNavigation(littleWindow, url, { source, triggeringPrincipal });
        if (expanded) {
          whenStartupReady(littleWindow, () => {
            applyExpandedLittleWindow(littleWindow, "expanded-request");
          });
        }
        littleWindow.focus();
      }

      return littleWindow;
    },
  };

  function bootstrapWindow(win) {
    if (!isBrowserWindow(win) || win[PATCH_FLAGS.window]) {
      return;
    }

    // If the user invoked the system-wide shortcut while Zen was running with
    // no browser windows, reuse its new blank startup window as Little Zen.
    // This avoids leaving a full Zen window behind after the search is opened.
    if (!isLittleWindow(win) && canPromoteStartupWindowToLittleZen(win)) {
      const token = takeGlobalFocusRequest();
      if (token) {
        const tab = win.gBrowser?.selectedTab;
        tab?.setAttribute("zen-empty-tab", "true");
        win._zenStartupLittleWindow = true;
        win.__littleZenHostlessStartup = true;
        win.__littleZenTargetContainerId = getTabContainerId(tab);
        win.__littleZenSearchScreen = cursorScreenBounds();
        win.__littleZenGlobalFocusToken = token;
        win.document.documentElement.setAttribute(LITTLE_WINDOW_ATTR, "true");
        attachGlobalLittleWindowCloseSignal(win);
        log("Converted blank startup window directly into Little Zen");
      }
    }

    const redirectExternalStartup =
      !isLittleWindow(win) && isExternalStartupWindow(win);
    // Wait for the origin Space to be available before handling external
    // startup. Keep the startup window: it may contain restored user tabs.
    if (redirectExternalStartup) {
      log("External startup will be handled after browser startup");
    }

    win[PATCH_FLAGS.window] = true;
    win.LittleZen = LittleZen;

    patchBrowserDOMWindow(win);
    patchOpenBrowserWindow(win);
    patchContentLinkShortcut();
    attachMainTabShortcut(win);
    ensureFallbackShortcut(win);
    ensureCommand(win);

    // Intercept window.gZenUIManager assignment so the motion stub is installed
    // the instant Zen sets it — regardless of when that happens relative to our
    // script. ZenStartup creates gZenUIManager inside a setTimeout(..., 0) after
    // MozBeforeInitialXULLayout, so polling/event listeners are too late.
    if (!win.gZenUIManager && !win.__littleZenUIManagerIntercepted) {
      win.__littleZenUIManagerIntercepted = true;
      let _uiManager = undefined;
      Object.defineProperty(win, "gZenUIManager", {
        configurable: true,
        enumerable: true,
        get() { return _uiManager; },
        set(v) {
          _uiManager = v;
          // Restore normal property so future reads/writes are direct
          Object.defineProperty(win, "gZenUIManager", {
            configurable: true,
            enumerable: true,
            writable: true,
            value: v,
          });
          // Install the motion stub immediately
          patchZenUIManager(win);
        },
      });
    } else if (win.gZenUIManager) {
      patchZenUIManager(win);
    }

    // Block mods that crash in the little window by intercepting gZenThemePicker.
    // BetterZenGradientPicker checks for this before initializing; keeping it
    // undefined in little windows prevents it from running where it has no panel.
    if (isLittleWindow(win) && !win.__littleZenThemePickerBlocked) {
      win.__littleZenThemePickerBlocked = true;
      if (!win.gZenThemePicker) {
        Object.defineProperty(win, "gZenThemePicker", {
          configurable: true,
          enumerable: true,
          get() { return undefined; },
          set(v) {
            // Silently swallow — theme picker has no panel in little windows
            Object.defineProperty(win, "gZenThemePicker", {
              configurable: true, enumerable: true, writable: true, value: undefined,
            });
          },
        });
      }
    }

    if (isLittleWindow(win)) {
      applyLittleWindowMode(win);
    }

    whenStartupReady(win, () => {
      log("Little Zen delayed startup reached");
      if (redirectExternalStartup) {
        let attempts = 0;
        const redirect = () => {
          if (win.closed) {
            return;
          }

          const url = getExternalStartupUrl(win) || getLittleWindowUrl(win);
          if (!url || !getLittleZenOriginSpace(win)) {
            if (++attempts < 100) {
              win.setTimeout(redirect, 50);
            } else {
              log("External startup URL did not become available; keeping normal window");
            }
            return;
          }

          const littleWindow = LittleZen.openLittleWindow(win, {
            url,
            source: "external-startup-window",
            expanded: true,
          });
          if (!littleWindow) {
            log("External startup could not open Little Zen; preserving original window");
          }
        };
        redirect();
        return;
      }

      patchBrowserDOMWindow(win);
      ensureCommand(win);
      patchOpenBrowserWindow(win);
      patchCompactModeManager(win);
      patchVerticalTabsManager(win);
      patchZenUIManager(win);
      patchUrlbar(win);
      if (isLittleWindow(win)) {
        if (win.__littleZenHostlessStartup) {
          const workspace = win.gZenWorkspaces?.getActiveWorkspace?.();
          const workspaceContainer = Number(workspace?.containerTabId);
          if (Number.isSafeInteger(workspaceContainer) && workspaceContainer >= 0) {
            win.__littleZenTargetContainerId = workspaceContainer;
            const tab = win.gBrowser?.selectedTab;
            if (tab && getTabContainerId(tab) !== workspaceContainer) {
              try {
                const blankTab = win.gBrowser.addTab("about:blank", {
                  userContextId: workspaceContainer,
                  skipAnimation: true,
                  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
                });
                blankTab.setAttribute("zen-empty-tab", "true");
                win.gBrowser.selectedTab = blankTab;
                win.gBrowser.removeTab(tab, { animate: false });
              } catch (error) {
                log("Could not match startup Little Zen to the active Space container", error);
              }
            }
          }
          // Zen may replace its first about:blank tab while completing startup.
          // Mark the final selected tab after that work, so its New Tab page is
          // hidden and the global invocation opens the regular Little Zen search.
          win.gBrowser?.selectedTab?.setAttribute("zen-empty-tab", "true");
          syncEmptyTabState(win, "hostless-startup-final-tab");
        }
        applyLittleWindowMode(win);
        if (win.__littleZenHostlessStartup) {
          const openStartupSearch = () => {
            if (win.closed || !isLittleWindow(win)) return;
            win.gBrowser?.selectedTab?.setAttribute("zen-empty-tab", "true");
            syncEmptyTabState(win, "hostless-startup-open-search");
            const searchWindow = LittleZen.openLittleWindow(win, { source: "shortcut" });
            if (!searchWindow) {
              focusUrlbar(win);
              log("Used direct URL bar focus for hostless Little Zen startup");
            }
          };
          const workspaceReady = win.gZenWorkspaces?.promiseInitialized;
          if (workspaceReady?.then) {
            workspaceReady.then(
              () => win.setTimeout(openStartupSearch, 0),
              error => {
                log("Workspace initialization failed before hostless search", error);
                win.setTimeout(openStartupSearch, 0);
              }
            );
          } else {
            win.setTimeout(openStartupSearch, 100);
          }
        }
        if (win.__littleZenPendingURL) {
          schedulePendingNavigationFlush(win, "bootstrap-delayed-startup");
        }
      }
    });
  }

  bootstrapWindow(window);
  log("Little Zen runtime backport loaded.");
})();
