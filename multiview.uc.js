// ==UserScript==
// @name           Multiview
// @description    Right-click a video, page or tab -> "Add to Multiview": grids up to four
//                 YouTube / Twitch / Kick / Vimeo / Dailymotion videos or live streams in one tab.
// @include        main
// ==/UserScript==
//
// Standalone port of src/js/17-multiview.js from z1n-k/zia (MIT).
// https://github.com/z1n-k/zia
//
// The videos live in the Multiview page's address (#~colour,kind:id@seconds;title,...),
// so the grid survives restarts. The page itself is a small static site (YouTube and
// Twitch only play embeds on a real web address); its URL is set in the mod's
// preferences and defaults to Zia's hosted copy.

(() => {
  "use strict";

  // ---------- Config & prefs

  const PREF_ENABLED = "mod.multiview.enabled";
  const PREF_COLOR = "mod.multiview.icon-color"; // "blue" | "space"
  const PREF_URL = "mod.multiview.url";
  const DEFAULT_URL = "https://z1n-k.github.io/zia/multiview/";

  const MULTIVIEW_MAX = 4;
  const DEFAULT_BLUE = "5ab9f5";

  const TWITCH_RESERVED = new Set([
    "directory", "videos", "settings", "search", "p", "downloads", "jobs", "turbo",
    "subscriptions", "inventory", "wallet", "drops", "friends", "messages", "login", "signup",
  ]);
  const KICK_RESERVED = new Set([
    "categories", "browse", "following", "search", "dashboard", "settings", "category",
  ]);

  const NS_ERROR_NOT_AVAILABLE = Components.results.NS_ERROR_NOT_AVAILABLE;

  // ---------- Small helpers (these came from other files in the Zia bundle)

  function noteError(where, err) {
    console.error(`[Multiview] ${where}`, err);
  }

  function watchPrefs(pref, callback) {
    const observer = { observe: () => callback() };
    Services.prefs.addObserver(pref, observer);
    window.addEventListener("unload", () => Services.prefs.removeObserver(pref, observer), { once: true });
  }

  const enabled = () => Services.prefs.getBoolPref(PREF_ENABLED, true);

  function baseURL() {
    let url = DEFAULT_URL;
    try {
      url = Services.prefs.getStringPref(PREF_URL, DEFAULT_URL).trim() || DEFAULT_URL;
    } catch (err) {
      noteError("baseURL", err);
    }
    return url;
  }

  const systemPrincipal = () => Services.scriptSecurityManager.getSystemPrincipal();

  // ---------- Parsing a page address into a Multiview entry

  // A video (the page it's on, its own file, where it's up to) as an entry:
  // [kind, id, seconds or 0].
  function multiviewEntry(pageSpec, mediaSpec, seconds) {
    let url;
    try {
      url = new URL(pageSpec);
    } catch (err) {
      return null;
    }
    const host = url.hostname.replace(/^(www|m|music)\./, "");
    const parts = url.pathname.split("/").filter(Boolean);
    const at = Math.max(0, Math.floor(seconds || 0));

    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const id =
        url.searchParams.get("v") ||
        (["shorts", "live", "embed"].includes(parts[0]) ? parts[1] : null);
      return id && /^[\w-]{6,}$/.test(id) ? ["yt", id, at] : null;
    }
    if (host === "youtu.be") {
      return parts[0] ? ["yt", parts[0], at] : null;
    }
    if (host === "clips.twitch.tv" && parts[0]) {
      const clip = parts[0] === "embed" ? url.searchParams.get("clip") : parts[0];
      return clip ? ["twc", clip, 0] : null;
    }
    if (host === "player.twitch.tv") {
      const channel = url.searchParams.get("channel");
      const video = url.searchParams.get("video");
      return channel ? ["tw", channel, 0] : video ? ["twv", video.replace(/^v/, ""), at] : null;
    }
    if (host === "twitch.tv") {
      if (parts[0] === "videos" && /^\d+$/.test(parts[1] || "")) {
        return ["twv", parts[1], at];
      }
      if (parts[1] === "clip" && parts[2]) {
        return ["twc", parts[2], 0];
      }
      if (parts[0] && !TWITCH_RESERVED.has(parts[0].toLowerCase())) {
        return ["tw", parts[0].toLowerCase(), 0];
      }
      return null;
    }
    if (host === "kick.com" || host === "player.kick.com") {
      return parts[0] && !KICK_RESERVED.has(parts[0].toLowerCase()) ? ["kick", parts[0].toLowerCase(), 0] : null;
    }
    if (host === "vimeo.com" || host === "player.vimeo.com") {
      const id = parts.find((part) => /^\d+$/.test(part));
      return id ? ["vm", id, at] : null;
    }
    if (host === "dailymotion.com" || host === "dai.ly") {
      const id = host === "dai.ly" ? parts[0] : parts.includes("video") ? parts[parts.indexOf("video") + 1] : null;
      return id ? ["dm", id.split("_")[0], at] : null;
    }

    // Anything else: the video's own file, if it's a whole video file (not one
    // chunk of a stream, which is all many sites' players load at once).
    if (/^https?:\/\/[^?#]+\.(mp4|m4v|webm|ogv|ogg|mov)([?#]|$)/i.test(mediaSpec || "")) {
      return ["file", mediaSpec, at];
    }
    return null;
  }

  // Where the tab's playing video is up to (0 for live streams).
  function multiviewPosition(browser) {
    try {
      const state = browser?.browsingContext?.mediaController?.getPositionState();
      if (state && Number.isFinite(state.duration) && state.duration > 0 && state.duration < 1e7) {
        return state.position;
      }
    } catch (err) {
      // No media playing: Firefox says so by throwing; nothing's wrong.
      if (err?.result !== NS_ERROR_NOT_AVAILABLE) {
        noteError("multiviewPosition", err);
      }
    }
    return 0;
  }

  // ---------- The Multiview page's address

  const multiviewKey = (entry) => `${entry[0]}:${entry[1]}`;

  // Entries are [kind, id, seconds, title]. In the address:
  //   #~colour,kind:id@seconds;title,...
  function multiviewEntries(spec) {
    const hash = (spec.split("#")[1] || "").trim();
    return hash
      .split(",")
      .filter((item) => item && !item.startsWith("~"))
      .map((item) => {
        const [body, title] = item.split(";");
        const [head, at] = body.split("@");
        const [kind, id] = head.split(":");
        return kind && id
          ? [kind, decodeURIComponent(id), Number(at) || 0, title ? decodeURIComponent(title) : ""]
          : null;
      })
      .filter(Boolean);
  }

  // The colour the Multiview tab fills its grid icon with: blue, or the space's own colour.
  function multiviewColor() {
    let choice = "blue";
    try {
      choice = Services.prefs.getStringPref(PREF_COLOR, "blue");
    } catch (err) {
      noteError("multiviewColor", err);
    }
    const root = document.documentElement;
    if (choice === "space" && root.getAttribute("zen-default-theme") !== "true") {
      const m = getComputedStyle(root).getPropertyValue("--zen-primary-color").match(/\d+(\.\d+)?/g);
      if (m && m.length >= 3) {
        return m
          .slice(0, 3)
          .map((n) => Math.round(Math.min(255, Number(n))).toString(16).padStart(2, "0"))
          .join("");
      }
    }
    return DEFAULT_BLUE;
  }

  function multiviewSpec(entries) {
    const items = entries.map(
      ([kind, id, at, title]) =>
        `${kind}:${encodeURIComponent(id)}${at ? `@${Math.floor(at)}` : ""}${title ? `;${encodeURIComponent(title)}` : ""}`
    );
    return `${baseURL()}#${[`~${multiviewColor()}`, ...items].join(",")}`;
  }

  // Only the address's # part changes, so the page updates without reloading its players.
  function setMultiviewSpec(tab, spec) {
    if (tab.linkedBrowser.currentURI.spec !== spec) {
      tab.linkedBrowser.fixupAndLoadURIString(spec, { triggeringPrincipal: systemPrincipal() });
    }
  }

  function isMultiviewTab(tab) {
    return !!tab?.linkedBrowser?.currentURI?.spec?.startsWith(baseURL());
  }

  const findMultiviewTab = () => gBrowser.visibleTabs.find(isMultiviewTab);

  function currentMultiview() {
    const tab = findMultiviewTab();
    return tab ? multiviewEntries(tab.linkedBrowser.currentURI.spec) : [];
  }

  function recolorMultiview(tab) {
    // Not unloaded tabs: changing their address would load them.
    if (isMultiviewTab(tab) && !tab.hasAttribute("pending")) {
      setMultiviewSpec(tab, multiviewSpec(multiviewEntries(tab.linkedBrowser.currentURI.spec)));
    }
  }

  // Adds a video, or with `replace` puts it in that video's place; the other tiles keep playing.
  function addToMultiview(entry, replace = -1) {
    const tab = findMultiviewTab();
    if (!tab) {
      gBrowser.selectedTab = gBrowser.addTrustedTab(multiviewSpec([entry]), {
        triggeringPrincipal: systemPrincipal(),
      });
      return;
    }
    const entries = multiviewEntries(tab.linkedBrowser.currentURI.spec);
    if (!entries.some((item) => multiviewKey(item) === multiviewKey(entry))) {
      if (replace >= 0 && replace < entries.length) {
        entries[replace] = entry;
      } else if (entries.length < MULTIVIEW_MAX) {
        entries.push(entry);
      }
    }
    setMultiviewSpec(tab, multiviewSpec(entries));
    gBrowser.selectedTab = tab;
  }

  // ---------- Labels

  // A tab's title without its site's name or unread count, for labels.
  function multiviewTitle(tab) {
    return (tab?.label || "")
      .replace(/^\(\d+\+?\)\s*/, "")
      .replace(/\s*[-–|•]\s*(YouTube|Twitch|Kick|Vimeo|Dailymotion)\s*$/i, "")
      .trim()
      .slice(0, 120);
  }

  // (a Map: the kind comes from the page's address, and "constructor" isn't a site)
  const MULTIVIEW_SITES = new Map([
    ["yt", "YouTube"], ["twv", "Twitch video"], ["twc", "Twitch clip"], ["vm", "Vimeo"], ["dm", "Dailymotion"],
  ]);

  function multiviewSite([kind, id]) {
    if (kind === "tw" || kind === "kick") {
      return `${kind === "tw" ? "twitch.tv" : "kick.com"}/${id}`;
    }
    if (MULTIVIEW_SITES.has(kind)) {
      return MULTIVIEW_SITES.get(kind);
    }
    try {
      return new URL(id).hostname.replace(/^www\./, "");
    } catch (err) {
      return "Video";
    }
  }

  function multiviewLabel(entry) {
    const site = multiviewSite(entry);
    const title = entry[3];
    if (!title || title.toLowerCase() === site.toLowerCase()) {
      return site;
    }
    return `${title.length > 60 ? `${title.slice(0, 59)}…` : title} — ${site}`;
  }

  function tabMultiviewEntry(tab) {
    const browser = tab?.linkedBrowser;
    if (!browser || isMultiviewTab(tab)) {
      return null;
    }
    const entry = multiviewEntry(browser.currentURI?.spec, null, multiviewPosition(browser));
    return entry && [...entry, multiviewTitle(tab)];
  }

  // ---------- Context menus

  // "Add to Multiview", or once it holds four, "Replace in Multiview" with the four to choose from.
  function attachMultiviewMenu(menu, anchor, idPrefix, readEntry) {
    let pending = null;

    const item = document.createXULElement("menuitem");
    item.id = `${idPrefix}-multiview`;
    item.setAttribute("label", "Add to Multiview");
    item.setAttribute("accesskey", "M");
    item.addEventListener("command", () => pending && addToMultiview(pending));

    const replaceMenu = document.createXULElement("menu");
    replaceMenu.id = `${idPrefix}-multiview-replace`;
    replaceMenu.setAttribute("label", "Replace in Multiview");
    replaceMenu.setAttribute("accesskey", "M");
    const replacePopup = document.createXULElement("menupopup");
    replaceMenu.appendChild(replacePopup);

    if (anchor) {
      anchor.after(item, replaceMenu);
    } else {
      menu.append(item, replaceMenu);
    }

    menu.addEventListener("popupshowing", (event) => {
      if (event.target !== menu) {
        return;
      }
      pending = readEntry();
      const current = currentMultiview();
      const already = !!pending && current.some((entry) => multiviewKey(entry) === multiviewKey(pending));
      const full = !!pending && !already && current.length >= MULTIVIEW_MAX;
      item.hidden = !pending || full;
      replaceMenu.hidden = !full;
      if (!full) {
        return;
      }
      replacePopup.replaceChildren(
        ...current.map((entry, index) => {
          const choice = document.createXULElement("menuitem");
          choice.setAttribute("label", multiviewLabel(entry));
          choice.addEventListener("command", () => addToMultiview(pending, index));
          return choice;
        })
      );
    });
  }

  function watchMultiview() {
    // Right-clicking a video, or the page of a video site. (YouTube shows its own
    // menu first; right-click again for this one.)
    const pageMenu = document.getElementById("contentAreaContextMenu");
    if (pageMenu) {
      attachMultiviewMenu(pageMenu, document.getElementById("context-video-pictureinpicture"), "multiview-context", () => {
        const context = window.gContextMenu;
        if (!enabled() || !context || context.isTextSelected || context.onLink || context.onImage) {
          return null;
        }
        const browser = context.browser;
        const framePage = context.contentData?.docLocation;
        const topPage = browser?.currentURI?.spec;
        if (!topPage || topPage.startsWith(baseURL())) {
          return null;
        }
        const at = multiviewPosition(browser);
        let entry;
        if (context.onVideo) {
          // The site first (the frame the video is in, then the page), and only
          // then the video's own file.
          entry =
            (framePage && multiviewEntry(framePage, null, at)) ||
            multiviewEntry(topPage, null, at) ||
            multiviewEntry(topPage, context.mediaURL, at);
        } else {
          entry = multiviewEntry(topPage, null, at);
          entry = entry && entry[0] !== "file" ? entry : null;
        }
        return entry && [...entry, multiviewTitle(gBrowser.getTabForBrowser(browser))];
      });
    }

    // Right-clicking a tab
    const tabMenu = document.getElementById("tabContextMenu");
    if (tabMenu) {
      const anchor = document.getElementById("context_duplicateTab") || document.getElementById("context_reloadTab");
      attachMultiviewMenu(tabMenu, anchor, "multiview-tab", () => {
        const entry = enabled() && tabMultiviewEntry(window.TabContextMenu?.contextTab);
        return entry && entry[0] !== "file" ? entry : null;
      });
    }

    // Keep the grid icon's colour current: when the Multiview tab is shown (the
    // space may have changed colour) and when the setting changes.
    gBrowser.tabContainer.addEventListener("TabSelect", (event) => recolorMultiview(event.target));
    watchPrefs(PREF_COLOR, () => gBrowser.tabs.forEach(recolorMultiview));
  }

  // ---------- Start once the browser window is ready

  function start() {
    try {
      watchMultiview();
    } catch (err) {
      noteError("watchMultiview", err);
    }
  }

  if (window.gBrowserInit?.delayedStartupFinished) {
    start();
  } else {
    const observer = {
      observe(subject, topic) {
        if (topic === "browser-delayed-startup-finished" && subject === window) {
          Services.obs.removeObserver(observer, topic);
          start();
        }
      },
    };
    Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  }
})();
