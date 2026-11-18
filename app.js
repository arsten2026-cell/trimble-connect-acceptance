// "Приемане" (Acceptance): the structural designer reviews formwork / rebar acceptance requests made from site photos
// in Pour status, sees the photos and the pours in the model, and approves / approves with remarks / rejects.
// Opens for admins, the general contractor and designers (ArstenAccess app "acceptance"); only members of the group
// "4.1-STRUCTURAL DESIGNER" (capability "approve") get the decision buttons. Data: the pour library (CIP/Монолитно),
// definitions "acceptance" and "photo" (shared/arsten-acceptance.js, shared/arsten-photos.js).
(function () {
  "use strict";
  const A = window.ArstenPsetApi || window.PsetApi, ACC = window.ArstenAcceptance, PH = window.ArstenPhotos;
  const LIB_NAMES = ["CIP/Монолитно", "Arsten Pour Status"];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // one language for all tools (A10): shared key "arsten.lang" (shared/arsten-i18n.js), the old key read once
  const I18N = window.ArstenI18n, OLD_LANG = ["arsten.acceptance.lang"];
  let lang = I18N ? I18N.getLang(OLD_LANG) : "bg";
  // one date format (round 14 M4): stored "2026-11-13 08:00" shown as 13.11.2026 08:00; history lines in Bulgarian (stored text unchanged)
  const fmtWhen = (d) => (I18N ? I18N.fmtDate(d, lang, { time: true }) : String(d || ""));
  const logShown = (text) => String(text || "").split("\n").map((l) => (I18N ? I18N.logText(l, lang) : l)).join("\n");
  /** A card's history, translated. Round 17 L7: built only for a history that is open ("История"), not for every card on
   *  every render and filter keystroke. */
  const logOf = (r) => logShown([r.log, r.declog].filter(Boolean).join("\n"));
  const L2 = (b, e) => (lang === "bg" ? b : e);
  // counted forms (round 19 L6): countWord(1, "запис", "записа", "record", "records") = "1 запис"
  const countWord = (n, one, many, en1, enN) => `${n} ${lang === "bg" ? (Math.abs(Number(n)) === 1 ? one : many) : (Math.abs(Number(n)) === 1 ? en1 : enN)}`;
  const state = { api: null, client: null, project: null, user: "", access: null, lib: null, acc: [], photos: new Map(), tab: "open", filter: "", urls: new Map(), open: null, busy: false, coloured: true, colourStep: "all", logOpen: new Set(),   // logOpen: links whose "История" is open (round 17 L7); colouring on by default (owner, 17.11.2026)
    // sweep 18.11.2026: photosReady - the photo records and the folder scan run after the requests are shown;
    // arm {link, d} - the decision button tapped once (a second tap saves); saving - link whose decision is being written;
    // drafts - typed comments, kept across re-renders (arming, filter, background photo load)
    // commentErr - link whose decision needs a comment first (the message is shown under its comment box)
    photosReady: false, arm: null, saving: null, drafts: new Map(), commentErr: null,
    // fix 18.11.2026: urlAt - when each download URL was fetched (Connect's links are presigned and expire);
    // lost - link -> {props, decision}: a decision whose old record was deleted but whose re-create failed (kept to rewrite)
    urlAt: new Map(), lost: new Map() };
  // t may be a function: then it is built again in the new language after a language switch (round 19 L4)
  let statusAgain = null;
  const setStatus = (t, bad) => { statusAgain = typeof t === "function" ? { t, bad } : null; if (typeof t === "function") t = t(); $("status").textContent = t || ""; $("status").className = "status" + (bad ? " bad" : ""); };
  const relabelStatus = () => { if (statusAgain) setStatus(statusAgain.t, statusAgain.bad); if (window.ArstenDiag && ArstenDiag.relabel) ArstenDiag.relabel(); };
  const errText = (e) => (e && (e.message || e.toString())) || String(e);
  // sweep 18.11.2026: results and errors also show in a toast at the bottom of the panel, near the card the designer
  // tapped (the status line is at the top, out of view in a long list), as in Монолитен бетон / Дейности. The element
  // stays in the DOM (visually hidden when idle) so screen readers announce it; errors use role="alert".
  let toastTimer = null;
  function toast(text, bad) {
    const el = $("toast");
    if (!el || !text) return;
    if (el.setAttribute) el.setAttribute("role", bad ? "alert" : "status");
    el.textContent = text;
    el.className = "toast show " + (bad ? "bad" : "ok");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = "toast"; el.textContent = ""; }, bad ? 8000 : 4000);
  }
  const report = (t, bad) => { setStatus(t, bad); toast(typeof t === "function" ? t() : t, bad); };
  const guarded = (fn) => Promise.resolve().then(fn).catch((e) => { console.error(e); report(I18N ? I18N.err(errText(e), lang) : errText(e), true); });

  // ---------- access token ----------
  let token = null, waiters = [];
  function onToken(tk) { token = tk; const w = waiters; waiters = []; w.forEach((f) => f(tk)); }
  // Round 17 L3 (the round 12 L6 fix of Монолитен бетон / Стомана): the waiter is registered before asking (the token
  // event may come while requestPermission runs). When Connect returns the token directly, refuses or throws, the waiter
  // and its 60 s timer are dropped, so no stray "No access token" rejection is logged a minute later.
  async function getToken(refresh) {
    if (token && !refresh) return token;
    let timer = 0, done = null;
    const p = new Promise((resolve, reject) => {
      done = (tk) => { clearTimeout(timer); resolve(tk); };
      waiters.push(done);
      timer = setTimeout(() => { waiters = waiters.filter((f) => f !== done); reject(new Error(L2("Trimble Connect не даде ключ за достъп", "No access token from Trimble Connect"))); }, 60000);
    });
    const drop = () => { clearTimeout(timer); waiters = waiters.filter((f) => f !== done); p.catch(() => {}); };
    let r;
    try { r = await state.api.extension.requestPermission("accesstoken"); } catch (e) { drop(); throw e; }
    if (r === "denied") { drop(); throw new Error(L2("Достъпът до данните в Trimble Connect е отказан за това разширение.", "Access to Trimble Connect data was denied for this extension.")); }
    if (r && r !== "pending" && r !== "granted") { drop(); token = r; return r; }
    return p;
  }
  const core = () => window.ARSTEN_PHOTOS_CORE || PH.coreClient(ArstenAccess.coreBase(state.project.location), getToken);
  const canApprove = () => ArstenAccess.can(state.access, "approve");

  // ---------- data ----------
  // sweep 18.11.2026: a set-up or rights problem says who fixes it and in which panel (the names users see)
  // fix 18.11.2026: the names of the real tab and button (the setup check runs by itself; there is no "Провери")
  const NOT_SET_UP = () => L2("Проектът още не е настроен. Помолете администратора: Администрация → Настройка на проекта → Създай липсващите.", "This project is not set up yet. Ask the admin: Administration → Project setup → Create missing.");
  let loadGen = 0;   // a newer load() makes an older one's background photo scan drop its result
  /** opts.fullSweep: "Обнови" checks every decided ToDo, the open of the panel only recent ones (see sweepTodos). */
  async function load(opts) {
    const gen = ++loadGen;
    setStatus(L2("Зареждане…", "Loading…"));
    const found = await state.client.findLibrary(state.project.id, LIB_NAMES);
    if (!found.lib && found.denied) console.warn("library not readable", LIB_NAMES[0], JSON.stringify({ denied: found.denied }));   // round 19 M1: into the diagnostics
    if (!found.lib) { console.warn("library not found", LIB_NAMES[0]); return setStatus(NOT_SET_UP, true); }
    state.lib = found.lib;
    // sweep 18.11.2026: the three lists are read at once; the requests are shown as soon as requests and decisions are in,
    // and the photo records + the folder scan (1 Core listing per photo day) follow in the background
    const pre = ACC.prefix(state.project.id);
    // fix 18.11.2026: photo URLs older than URL_DROP_MS are dropped, so "Обнови" also brings fresh (unexpired) links
    const now = Date.now();
    for (const [id, at] of [...state.urlAt]) if (now - at > URL_DROP_MS) forgetUrl(id);
    const [a, dec] = await Promise.all([
      state.client.listAll(state.lib.id, ACC.DEF_ID, pre),
      state.client.listAll(state.lib.id, ACC.DEC_ID, pre).catch((e) => { if (e.status !== 404) throw e; return new Map(); }),
    ]);
    if (gen !== loadGen) return;
    state.acc = ACC.merge([...a].map(([link, p]) => Object.assign({ link }, p)), dec).filter(ACC.valid);
    state.photosReady = false;
    if (state.arm && !state.acc.some((r) => r.link === state.arm.link && r.status === "open")) state.arm = null;
    $("main").hidden = false;
    const open = state.acc.filter((r) => r.status === "open").length;
    setStatus(() => `${countWord(state.acc.length, "заявка", "заявки", "request", "requests")} · ${open} ${L2(open === 1 ? "чака" : "чакат", "waiting")}`);
    render();
    const photosDone = loadPhotos(gen);
    if (state.coloured) await applyColours();
    sweepTodos(!!(opts && opts.fullSweep)).catch((e) => console.error(e));
    await photosDone;
  }
  /** Background step of load(): photo records (cards drawn with them at once), then which of the photos the cards name
   *  still exist; the cards are drawn again only if one turned out to be gone. */
  async function loadPhotos(gen) {
    const named = new Set();
    for (const r of state.acc) for (const id of ACC.ids(r.photos)) named.add(id);
    // fix 18.11.2026: only the photo records the requests name are read, by link (batch-get, 100 per call, 4 at a time).
    // Before, every photo record of the project was listed (500 per page, page after page: 5-10 serial pages on a long
    // project) before a card could show a photo. The full listing stays only as the fallback when the batch read fails.
    const byFile = (ph) => new Map([...ph].map(([, p]) => [p.file_id, p]));
    let photos = new Map();
    try {
      const ids = [...named];
      if (ids.length) photos = byFile(await state.client.readMany(state.lib.id, PH.DEF_ID, ids.map((id) => PH.photoLink(state.project.id, id))));
    } catch (e) {
      console.error(e);
      try { photos = byFile(await state.client.listAll(state.lib.id, PH.DEF_ID, PH.photoPrefix(state.project.id))); } catch (e2) { console.error(e2); }
    }
    if (gen !== loadGen) return;
    state.photos = photos;
    state.photosReady = true;
    render();
    // sweep 18.11.2026: only the photos the requests name are checked (1 Core listing per photo day), and after the cards
    // already show them. Before, every photo day the project ever had was listed on each open (200 days = 15-30 s on a
    // phone, and 429 risk on Core) while every card said "проверка…". A file gone in between also falls back to img onerror.
    const recs = [...photos.values()].filter((p) => named.has(p.file_id));
    if (!recs.length) return;
    try {
      // photos deleted directly in Connect: their file is gone, so they are treated as deleted here
      const exist = await PH.existingIds(core(), state.project.id, recs);
      if (!exist || gen !== loadGen) return;
      let gone = 0;
      for (const p of recs) if (!p.deleted && p.file_id && !exist.has(p.file_id)) { p.deleted = true; p.gone = true; gone++; }
      if (gone) render();
    } catch (e) { console.error(e); }
  }

  // fix 18.11.2026: Connect's download links are presigned and expire. Each URL keeps the time it was fetched (urlAt); an
  // image that fails with a URL older than URL_RETRY_MS asks for a fresh one (as Дейности, RETRY_MS), and load() drops
  // URLs older than URL_DROP_MS. Before, a panel left open (or hidden in the combined panel) kept the expired links for
  // the whole session: the thumbnail and its full-photo fallback both stayed blank, and "Обнови" did not help.
  const URL_RETRY_MS = 10 * 60000, URL_DROP_MS = 30 * 60000;
  const forgetUrl = (id) => { state.urls.delete(id); state.urlAt.delete(id); };
  const urlOld = (id, ms) => { const t = state.urlAt.get(id); return t != null && Date.now() - t > ms; };
  async function urlOf(fileId) {
    if (!state.urls.has(fileId)) {
      const p = core().req(`files/fs/${encodeURIComponent(fileId)}/downloadurl`).then((d) => (d && (d.url || d.downloadUrl || d.href)) || "").catch(() => "");
      state.urls.set(fileId, p);
      state.urlAt.set(fileId, Date.now());
      // sweep 18.11.2026: a failed (or empty) answer is not kept, so the next render asks again (e.g. after a network blip)
      p.then((u) => { if (!u && state.urls.get(fileId) === p) forgetUrl(fileId); });
    }
    return state.urls.get(fileId);
  }
  /** The URL of a file, asked again first when the kept one is older than URL_RETRY_MS (it may have expired). */
  const freshUrl = (id) => { if (urlOld(id, URL_RETRY_MS)) forgetUrl(id); return urlOf(id); };
  /** img.src = u, and when it does not load: a fresh URL once if the one used is old (expired link); then a thumbnail
   *  falls back to the photo itself (once, with the same fresh-URL rule); then the image is left as it is. */
  function showImg(img, u) {
    const id = img.dataset.src, full = img.dataset.full;
    let refreshed = false, toFull = false;
    img.onerror = () => {
      const cur = toFull ? full : id;
      if (!refreshed && urlOld(cur, URL_RETRY_MS)) {
        refreshed = true; forgetUrl(cur);
        urlOf(cur).then((f) => { if (f && f !== img.src) img.src = f; else if (img.onerror) img.onerror(); });
        return;
      }
      if (!toFull && full && full !== id) { toFull = true; refreshed = false; freshUrl(full).then((f) => { if (f) img.src = f; }); return; }
      img.onerror = null;
    };
    img.src = u;
  }
  // sweep 18.11.2026: thumbnail URLs through a pool of 4 (shared urlLoader), only for cards in view (+300 px), so a long
  // list does not fire one downloadurl per photo at once. Without IntersectionObserver every image is queued.
  const loader = PH.urlLoader(urlOf, showImg, 4);
  let io = null;
  function wantImages(root) {
    if (io) io.disconnect();
    io = typeof IntersectionObserver === "function"
      ? new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); loader.want(e.target); } }, { rootMargin: "300px" }) : null;
    (root || document).querySelectorAll("img[data-src]").forEach((img) => (io ? io.observe(img) : loader.want(img)));
  }

  async function showInModel(r) {
    const byModel = new Map();
    for (const o of ACC.parseObjects(r.objects)) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.guid); }
    const sel = [];
    for (const [modelId, guids] of byModel) {
      try { const ids = ((await state.api.viewer.convertToObjectRuntimeIds(modelId, guids)) || []).filter((x) => x != null); if (ids.length) sel.push({ modelId, objectRuntimeIds: ids }); } catch {}
    }
    if (!sel.length) return setStatus(L2("Обектите не са в заредените модели (заредете модела с тактовете).", "The objects are not in the loaded models (load the pour model)."), true);
    await state.api.viewer.setSelection({ modelObjectIds: sel }, "set");
    try { await state.api.viewer.setCamera({ modelObjectIds: sel }, { animationTime: 400 }); } catch {}
  }

  // sweep 18.11.2026: the comment rule is said under the card's own comment box (focused and scrolled into view), and in
  // the toast; before, it went only to the status line at the top and the tap seemed to do nothing
  const COMMENT_NEEDED = () => L2("Напишете коментар – задължителен е за забележки и отказ.", "Write a comment – it is required for remarks and rejection.");
  function needComment(r) {
    state.commentErr = r.link;
    report(COMMENT_NEEDED, true);
    render();
    const ta = $("c_" + r.link);
    if (ta && ta.focus) { try { ta.focus({ preventScroll: true }); } catch { ta.focus(); } }
    if (ta && ta.scrollIntoView) ta.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  const NOT_APPROVER = () => L2("Само групата 4.1-STRUCTURAL DESIGNER може да приема. Помолете администратора да ви добави в нея.", "Only the group 4.1-STRUCTURAL DESIGNER can decide. Ask the admin to add you to it.");
  const commentOf = (r) => ((($("c_" + r.link) || {}).value || state.drafts.get(r.link) || "") + "").trim();
  /** sweep 18.11.2026: a decision is final (never undone) and may close the Connect ToDo, so a tap only arms the button
   *  ("Потвърди: одобри" + "Откажи", the other two hidden); the second tap on it saves. The comment rule is checked on
   *  the first tap, so the user is not asked to confirm something that cannot be saved. */
  function arm(r, decision) {
    if (!r || busy) return;
    if (!canApprove()) return report(NOT_APPROVER, true);
    if (state.lost.has(r.link)) return report(() => lostText(r, state.lost.get(r.link).decision), true);   // fix 18.11.2026: "Опитай пак" first
    if (state.arm && state.arm.link === r.link && state.arm.d === decision) return guarded(() => decide(r, decision));
    const comment = commentOf(r);
    try { ACC.decide(r, { decision, comment, by: state.user }); }
    catch (e) { if (e.code === "comment") return needComment(r); throw e; }
    state.arm = { link: r.link, d: decision }; state.commentErr = null;
    report(L2(`Натиснете „Потвърди: ${DEC_BG[decision].toLowerCase()}“, за да запишете решението, или „Откажи“.`, `Press "Confirm: ${DEC_EN[decision].toLowerCase()}" to save the decision, or "Cancel".`));
    render();
  }
  let busy = false;
  async function decide(r, decision) {
    if (busy) return;
    if (!canApprove()) return report(NOT_APPROVER, true);
    const comment = commentOf(r);
    try { ACC.decide(r, { decision, comment, by: state.user }); }
    catch (e) { if (e.code === "comment") return needComment(r); throw e; }
    busy = true; state.commentErr = null;
    // sweep 18.11.2026: while the decision is written the card's buttons are disabled and say so
    state.arm = null; state.saving = r.link;
    setStatus(L2("Записване на решението…", "Saving the decision…"));
    render();
    let props;
    try {
      // decide on the FRESH server copy; if photos or status changed since it was shown, show it again first
      // sweep 18.11.2026: request and decision are read side by side (one pset-api round trip less while "Записване…")
      // fix 18.11.2026: the decision is read with its version (readManyV), for the versioned write below
      const C = state.client, V = typeof C.readManyV === "function" && typeof C.writeIfUnchanged === "function";
      const [got, decV] = await Promise.all([
        C.readMany(state.lib.id, ACC.DEF_ID, [r.link]),
        (V ? C.readManyV(state.lib.id, ACC.DEC_ID, [r.link]) : C.readMany(state.lib.id, ACC.DEC_ID, [r.link]).then((m) => new Map([...m].map(([l, p]) => [l, { props: p }]))))
          .catch((e) => { if (e.status !== 404) throw e; return new Map(); }),
      ]);
      const dec = new Map([...decV].map(([l, x]) => [l, x.props]));
      const fresh = got.has(r.link) ? ACC.merge([Object.assign({ link: r.link }, got.get(r.link))], dec)[0] : null;
      if (!fresh || fresh.status !== r.status || fresh.round !== r.round || (fresh.photos || "") !== (r.photos || "")) throw changedError();
      // the decision goes to its own definition, where only the 4.1 group has Edit (server-side lock)
      props = ACC.decide(fresh, { decision, comment, by: state.user });
      await saveDecision(r.link, props, V ? decV.get(r.link) || null : undefined);
    } catch (e) {
      busy = false; state.saving = null; render();   // nothing saved: the buttons come back (the comment is kept in drafts)
      if (e && e.changed) { await load(); return report(CHANGED_TEXT, true); }
      // fix 18.11.2026: the old record was deleted but the new one not created (weak signal): the full record (with the
      // earlier rounds' log) is kept and the card offers "Опитай пак", which writes exactly it. A new decision built from
      // the reloaded (now empty) copy would lose the history of every earlier round.
      if (e && e.lost) {
        state.lost.set(r.link, { props: e.props || props, decision });
        render();
        return report(() => lostText(r, decision), true);
      }
      if (e && e.status === 403) throw new Error(L2("Нямате права за запис тук. Помолете администратора да ви добави в групата 4.1-STRUCTURAL DESIGNER.", "You cannot save here. Ask the admin to add you to the group 4.1-STRUCTURAL DESIGNER."));
      throw e;
    } finally { busy = false; state.saving = null; }
    await afterSaved(r, props, decision);
  }
  const CHANGED_TEXT = () => L2("Заявката е променена междувременно (нови снимки или решение) – прегледайте я отново.", "The request changed meanwhile (new photos or a decision) – please look again.");
  const changedError = () => Object.assign(new Error("changed"), { changed: true });
  const lostText = (r, decision) => L2(`${r.pour}: решението „${ACC.STATUS[decision].bg}“ не е записано – връзката прекъсна. Натиснете „Опитай пак“ (историята е запазена).`,
    `${r.pour}: the decision "${ACC.STATUS[decision].en}" was not saved – the connection failed. Press "Try again" (the history is kept).`);
  /** fix 18.11.2026: a decision is written with ONE PATCH carrying the version read just before (writeIfUnchanged), so a
   *  failed write never deletes anything, and a decision another designer saved in between is refused (412/409) instead
   *  of overwritten. Only when a field must be cleared (the comment of an earlier "remarks", now a plain approval: PATCH
   *  merges and pset-api refuses "") is replace() (delete + re-create) used; its err.lost is handled by decide().
   *  cur: {props, v} of the live decision, null when there is none, undefined when the client cannot write by version. */
  async function saveDecision(link, props, cur) {
    const C = state.client, lib = state.lib.id;
    const mustClear = cur && cur.props && Object.keys(cur.props).some((k) => cur.props[k] !== "" && cur.props[k] != null && (props[k] === "" || props[k] == null));
    if (cur === undefined || mustClear) return C.replace(lib, ACC.DEC_ID, link, props);
    try { return await C.writeIfUnchanged(lib, ACC.DEC_ID, link, props, cur ? cur.v : undefined); }
    catch (e) {
      if (e.status !== 412 && e.status !== 409) throw e;
      if (cur) throw changedError();   // someone wrote this decision after our read
      // no live decision, yet the create is refused: someone created one in between, or a deleted record of an earlier
      // round blocks it (replace re-creates on top of the deleted version)
      const now = await C.readManyV(lib, ACC.DEC_ID, [link]).catch(() => new Map());
      if (now.has(link)) throw changedError();
      return C.replace(lib, ACC.DEC_ID, link, props);
    }
  }
  /** "Опитай пак" on a lost decision: writes exactly the kept record (old log included), never one rebuilt from the
   *  reloaded copy. A live record found first is either our timed-out write (same status and time: saved) or another
   *  designer's decision (then the card is shown again). */
  async function retryLost(link) {
    const k = state.lost.get(link);
    if (!k || busy) return;
    if (!canApprove()) return report(NOT_APPROVER, true);
    busy = true; state.saving = link;
    setStatus(L2("Записване на решението…", "Saving the decision…"));
    render();
    const C = state.client, lib = state.lib.id;
    try {
      if (typeof C.readOne === "function" && typeof C.writeIfUnchanged === "function") {
        const cur = await C.readOne(lib, ACC.DEC_ID, link);
        if (cur && cur.props) { if (cur.props.status !== k.props.status || cur.props.decided !== k.props.decided) throw changedError(); }
        else await C.writeIfUnchanged(lib, ACC.DEC_ID, link, k.props, cur ? cur.v : undefined);
      } else await C.replace(lib, ACC.DEC_ID, link, k.props);
    } catch (e) {
      busy = false; state.saving = null; render();
      if (e && e.changed) { state.lost.delete(link); await load(); return report(CHANGED_TEXT, true); }
      if (e && (e.status === 412 || e.status === 409)) { state.lost.delete(link); await load(); return report(CHANGED_TEXT, true); }
      throw e;   // still no connection: the box stays for another try
    } finally { busy = false; state.saving = null; }
    state.lost.delete(link);
    const r = state.acc.find((x) => x.link === link);
    if (r) await afterSaved(r, k.props, k.decision);
    else await load();
  }
  /** After a decision is saved: the card, the toast, the Connect ToDo and the colours. */
  async function afterSaved(r, props, decision) {
    state.drafts.delete(r.link);
    Object.assign(r, { status: props.status, decided: props.decided, decided_by: props.decided_by, comment: props.comment, declog: props.log });
    // sweep 18.11.2026: "✓" and where the card went (it leaves "Чакащи"), said at once in the toast near the finger;
    // the ToDo outcome follows a moment later
    let msg = `${r.pour} · ${ACC.STEPS[r.step][lang]}: ${ACC.STATUS[decision][lang]} ✓${state.tab === "open" ? L2(" (вижте „Решени“)", ' (see "Decided")') : ""}`, bad = false;
    render();
    report(msg);
    let todoSaid = false;
    // the last decision of a ToDo closes that ToDo in Connect (user 16.11.2026); the decision itself is already saved
    try {
      const done = await closeTodo(r.todo_id);
      if (done === NO_COMMENT) { bad = true; todoSaid = true; msg += " · " + NO_COMMENT_TEXT[lang === "bg" ? "bg" : "en"]; }
      else if (done) { todoSaid = true; msg += L2(" · задачата в Connect е затворена", " · the Connect ToDo is closed"); }
    } catch (e) {
      console.error(e); bad = true; todoSaid = true;
      msg += e.refused ? " · " + REFUSED_TEXT[lang === "bg" ? "bg" : "en"]   // L7: 403, said once, never retried this session
        : L2(` · задачата в Connect НЕ е затворена (${errText(e)}) – затворете я ръчно`, ` · the Connect ToDo was NOT closed (${errText(e)}) – close it by hand`);
    }
    if (todoSaid) report(msg, bad);
    if (state.coloured) await applyColours();
  }

  // ---------- closing the Connect ToDo ----------
  // A ToDo closes once every request sent with it has a decision: a comment with the results, then status CLOSED
  // (legacy Core API 2.0: PATCH /todos/{id}, then POST /comments). A ToDo already closed (e.g. by hand) is left alone.
  // A stale list can only keep a ToDo open, never close it early: decisions are not undone, and a reopened request
  // has its todo_id cleared.
  const todoTried = new Set();
  // L7 (round 11): a close Connect refuses (403: e.g. the 4.1 assignee may not change the GC's ToDo) is remembered for the
  // browser session (sessionStorage, per project), so neither a decision, "Обнови" nor a model reload asks again; the user
  // is told once to close it by hand. Other errors are retried on the next load, as before.
  const REFUSED_TEXT = { bg: "нямате право да затворите задачата – затворете я ръчно", en: "you have no right to close the ToDo – close it by hand" };
  const refusedKey = () => `arsten.acceptance.todoRefused.${(state.project && state.project.id) || ""}`;
  function refusedIds() {
    try { const v = JSON.parse(sessionStorage.getItem(refusedKey()) || "[]"); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); }
  }
  const refusedMem = new Set();   // also kept here when sessionStorage is not available
  const isRefused = (id) => refusedMem.has(id) || refusedIds().has(id);
  function rememberRefused(id) {
    refusedMem.add(id);
    try { const s = refusedIds(); s.add(id); sessionStorage.setItem(refusedKey(), JSON.stringify([...s])); } catch {}
  }
  // sweep 18.11.2026: a ToDo found closed (by hand or by this panel) or deleted (404) never opens again for this panel, so
  // it is remembered per project in this browser (localStorage) and not asked again on the next open. Before, every
  // open of the panel re-checked every decided ToDo of the project, one GET after another (150 GETs after a few months).
  // (A "todo_closed" flag on the decision record would also cover other devices, but it needs a new field in the
  // decision definition, which pset-api refuses on libraries set up earlier; this stays local until that migration.)
  const closedKey = () => `arsten.acceptance.todoClosed.${(state.project && state.project.id) || ""}`;
  const CLOSED_KEEP = 2000;   // the newest ids are kept; an older one forgotten is only checked once more
  function closedIds() {
    try { const v = JSON.parse(localStorage.getItem(closedKey()) || "[]"); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); }
  }
  const closedMem = new Set();   // also kept here when localStorage is not available
  function rememberClosed(id) {
    closedMem.add(id);
    try { const s = closedIds(); s.delete(id); s.add(id); localStorage.setItem(closedKey(), JSON.stringify([...s].slice(-CLOSED_KEEP))); } catch {}
  }
  // sweep 18.11.2026: every Connect ToDo call goes through this one adapter, so the move from ToDos to Issues (Trimble's
  // direction) changes only this object. Errors keep their HTTP status (404 / 403 are handled by the callers).
  const todoApi = {
    isClosed: async (id) => { const t = await core().req(`todos/${encodeURIComponent(id)}`); return !!t && String(t.status || "").toUpperCase() === "CLOSED"; },
    close: (id) => core().req(`todos/${encodeURIComponent(id)}`, "PATCH", { status: "CLOSED" }),
    comment: (id, text) => core().req("comments", "POST", { objectId: id, objectType: "TODO", description: text }),
  };
  // sweep 18.11.2026: closed but the results comment failed - the approver is told (else the requester never sees the
  // reason), and the comment is kept here and tried once more on the next load ("Обнови").
  const NO_COMMENT = "nocomment";
  const NO_COMMENT_TEXT = { bg: "задачата в Connect е затворена, но коментарът не е записан – добавете го ръчно", en: "the Connect ToDo is closed, but the comment was not saved – add it by hand" };
  const commentRetry = new Map();   // todoId -> comment text, retried once
  /** @returns true (closed + comment), NO_COMMENT (closed, comment failed), false (nothing to do / already closed / deleted) */
  async function closeTodo(todoId) {
    const o = ACC.todoOutcome(state.acc, todoId, lang);
    if (!o || todoTried.has(todoId) || isRefused(todoId) || closedMem.has(todoId)) return false;
    todoTried.add(todoId);
    try {
      if (await todoApi.isClosed(todoId)) { rememberClosed(todoId); return false; }
      await todoApi.close(todoId);
      rememberClosed(todoId);
    } catch (e) {
      if (e.status === 404) { rememberClosed(todoId); return false; }   // 404: the ToDo was deleted
      if (e.status === 403) { rememberRefused(todoId); e.refused = true; throw e; }   // stays in todoTried: never asked again
      todoTried.delete(todoId); throw e;
    }
    // the comment comes after the close, so a failed close retried later never posts it twice
    try { await todoApi.comment(todoId, o.comment); return true; }
    catch (e) { console.error("ToDo comment " + todoId, e); commentRetry.set(todoId, o.comment); return NO_COMMENT; }
  }
  // sweep 18.11.2026: on open only ToDos with a decision from the last SWEEP_DAYS days are checked ("Обнови" checks all),
  // through a pool of SWEEP_POOL calls, so the sweep does not hold the connection while the photo thumbnails load
  const SWEEP_DAYS = 60, SWEEP_POOL = 3;
  const whenMs = (s) => { const t = Date.parse(String(s || "").trim().replace(" ", "T")); return isNaN(t) ? NaN : t; };
  const today = () => (window.ARSTEN_DEMO_TODAY ? whenMs(window.ARSTEN_DEMO_TODAY) : Date.now());   // demo: fixed date (demo.js)
  /** Newest decision time of a ToDo's requests; Infinity when one has no readable date (then it is checked). */
  function decidedAt(id) {
    let m = -Infinity;
    for (const r of state.acc) if (r.todo_id === id) { const t = whenMs(r.decided); m = Math.max(m, isNaN(t) ? Infinity : t); }
    return m;
  }
  /** On load (approvers only): close ToDos whose requests were all decided before auto-close existed, or whose closing
   *  failed; post once more the comments that failed last time. full: every decided ToDo, not only recent ones. */
  async function sweepTodos(full) {
    if (!canApprove()) return;
    let n = 0, refused = 0, noComment = 0, posted = 0;
    for (const [id, text] of [...commentRetry]) {   // the one retry: after it the comment is the user's to add
      commentRetry.delete(id);
      try { await todoApi.comment(id, text); posted++; } catch (e) { noComment++; console.error("ToDo comment " + id, e); }
    }
    const closed = closedIds(), since = today() - SWEEP_DAYS * 86400000;
    const ids = [...new Set(state.acc.map((r) => r.todo_id).filter(Boolean))].filter((id) => !todoTried.has(id) && !isRefused(id)
      && !closed.has(id) && !closedMem.has(id) && (full || decidedAt(id) >= since) && ACC.todoOutcome(state.acc, id, lang));
    // each call settles to its own outcome, so one failure does not stop the pool (mapLimit stops on the first error)
    const one = (id) => closeTodo(id).then((done) => ({ done }), (e) => { console.error("ToDo " + id, e); return { e }; });
    const outs = A && A.mapLimit ? await A.mapLimit(ids, SWEEP_POOL, one, { retries: 0 }) : await Promise.all(ids.map(one));
    for (const o of outs) {
      if (o.e) { if (o.e.refused) refused++; continue; }
      if (o.done) n++;
      if (o.done === NO_COMMENT) noComment++;
    }
    if (!n && !refused && !noComment && !posted) return;
    // round 19 L4: appended to the load's line so that it still follows a language switch
    const base = statusAgain ? statusAgain.t : null, was = $("status").textContent;
    const head = () => (base ? base() : was);
    const times = (k) => (k > 1 ? `${k} × ` : ""), key = () => (lang === "bg" ? "bg" : "en");
    setStatus(() => head()
      + (n ? L2(` · затворени задачи в Connect: ${n}`, ` · Connect ToDos closed: ${n}`) : "")
      + (posted ? L2(` · добавени коментари към задачи в Connect: ${posted}`, ` · comments added to Connect ToDos: ${posted}`) : "")
      + (noComment ? " · " + times(noComment) + NO_COMMENT_TEXT[key()] : "")
      + (refused ? " · " + times(refused) + REFUSED_TEXT[key()] : ""), refused > 0 || noComment > 0);
  }

  // ---------- colours in the model ----------
  // Чака приемане orange, Одобрено green, Одобрено със забележки light green, Не се приема red; everything else grey, see-through.
  // The legend uses the same words as the cards (ACC.STATUS, round 14 L6).
  const LEGEND = ["open", "approved", "remarks", "rejected"].map((s) => [s, ACC.STATUS[s].bg, ACC.STATUS[s].en]);
  const OTHER = { color: "#BDBDBD", opacity: 0.18 };
  // sweep 18.11.2026: every setObjectState fires onModelStateChanged again, so the panel used to re-colour the whole model
  // ~1.5 s after each of its own passes, for as long as colouring was on. Now a model event re-colours only when the
  // loaded models changed (id + version) or when it comes more than OWN_MS after the panel's own last setObjectState
  // (then it is someone else's change, e.g. Connect's own reset or another panel).
  const OWN_MS = 5000;
  let ownStateAt = 0, lastModelsKey = null;
  async function modelsKey() {
    try {
      const ms = (await state.api.viewer.getModels("loaded")) || [];
      return ms.map((m) => `${m && m.id}@${m && m.versionId}`).sort().join("|");
    } catch { return null; }   // not available: only the time guard applies
  }
  async function setState(sel, st) { try { await state.api.viewer.setObjectState(sel, st); } finally { ownStateAt = Date.now(); } }
  /** The debounced model event: at = the time of the last event. */
  async function recolourIfNeeded(at) {
    if (!state.client || !state.coloured) return false;
    const key = await modelsKey();
    const changed = key != null && key !== lastModelsKey;
    if (!changed && at - ownStateAt <= OWN_MS) return false;
    await applyColours();
    return true;
  }
  async function applyColours() {
    const v = state.api.viewer;
    if (typeof v.getModels === "function") lastModelsKey = await modelsKey();
    const all = [];
    for (const m of (await v.getObjects()) || []) if ((m.objects || []).length) all.push({ modelId: m.modelId, objectRuntimeIds: m.objects.map((o) => o.id) });
    if (!state.coloured) { if (all.length) await setState({ modelObjectIds: all }, { color: "reset", opacity: 1 }); return; }
    if (all.length) await setState({ modelObjectIds: all }, OTHER);
    let shown = 0, missing = 0;
    for (const [status] of LEGEND) {
      const byModel = new Map();
      for (const p of ACC.pourStates(state.acc, state.colourStep).filter((x) => x.status === status)) {
        for (const o of p.objects) { if (!byModel.has(o.modelId)) byModel.set(o.modelId, []); byModel.get(o.modelId).push(o.guid); }
      }
      const sel = [];
      for (const [modelId, guids] of byModel) {
        try {
          const ids = (await v.convertToObjectRuntimeIds(modelId, guids)) || [];
          const ok = ids.filter((x) => x != null); missing += guids.length - ok.length;
          if (ok.length) sel.push({ modelId, objectRuntimeIds: ok });
        } catch { missing += guids.length; }
      }
      if (sel.length) { await setState({ modelObjectIds: sel }, { color: ACC.STATUS[status].colour, opacity: 1 }); shown += sel.reduce((n, s) => n + s.objectRuntimeIds.length, 0); }
    }
    if (missing && !shown) setStatus(L2("Обектите на заявките не са в заредените модели (заредете модела с тактовете).", "The requests' objects are not in the loaded models (load the pour model)."), true);
  }

  // ---------- UI ----------
  const TABS = [["open", "Чакащи", "Waiting"], ["done", "Решени", "Decided"], ["all", "Всички", "All"]];
  const DEC_EN = { approved: "Approve", remarks: "Approve with remarks", rejected: "Reject" };
  const DEC_CLS = { approved: "ok", remarks: "rem", rejected: "no" };
  // sweep 18.11.2026: the buttons say what the tap does (Одобри / Отхвърли), not a state; the state words
  // ("Одобрено", "Не се приема") stay for the legend and the card's chip, so a green button no longer reads as already approved
  const DEC_BG = { approved: "Одобри", remarks: "Одобри със забележки", rejected: "Отхвърли" };
  const DEC_LABEL = (d) => L2(DEC_BG[d], DEC_EN[d]);
  const CONFIRM_LABEL = (d) => L2("Потвърди: " + DEC_BG[d].toLowerCase(), "Confirm: " + DEC_EN[d].toLowerCase());
  function visible() {
    const f = state.filter.trim().toUpperCase();
    return state.acc.filter((r) => (state.tab === "all" || (state.tab === "open" ? r.status === "open" : r.status !== "open"))
      && (!f || String(r.pour).toUpperCase().includes(f)))
      .sort((a, b) => (state.tab === "open" ? (a.requested < b.requested ? -1 : 1) : (String(a.decided || a.requested) < String(b.decided || b.requested) ? 1 : -1)));
  }
  function card(r) {
    const s = ACC.STATUS[r.status] || ACC.STATUS.open;
    const all = ACC.ids(r.photos);
    const photos = all.filter((id) => { const p = state.photos.get(id); return !p || !p.deleted; });
    const goneN = all.length - photos.length;
    // sweep 18.11.2026: two-tap decision (see arm()); while saving, the card's buttons are disabled
    const saving = state.saving === r.link, armed = !saving && state.arm && state.arm.link === r.link ? state.arm.d : null;
    const dis = saving || (state.saving && state.saving !== r.link) ? " disabled" : "";
    const decBtn = (d, cls) => `<button class="dec ${cls}${armed === d ? " armed" : ""}" data-d="${d}" data-l="${esc(r.link)}"${dis}>${armed === d ? esc(CONFIRM_LABEL(d)) : esc(DEC_LABEL(d))}</button>`;
    // fix 18.11.2026: a decision whose record was deleted but not re-created: only "Опитай пак" (no new decision, which
    // would start the history again from the empty reloaded copy)
    const lost = state.lost.get(r.link);
    const decideBox = lost
      ? `<div class="sub bad lost" role="alert">${esc(lostText(r, lost.decision))}</div>
         ${saving ? `<div class="sub saving" role="status">${esc(L2("Записване на решението…", "Saving the decision…"))}</div>` : ""}
         <div class="bar decide"><button class="dec ${DEC_CLS[lost.decision] || ""}" data-relost="${esc(r.link)}"${dis}>${esc(L2("Опитай пак", "Try again"))}</button></div>`
      : r.status === "open" && canApprove()
      ? `<textarea id="c_${esc(r.link)}" data-draft="${esc(r.link)}" placeholder="${esc(L2("Коментар (задължителен за забележки / отказ)", "Comment (required for remarks / rejection)"))}"${saving ? " disabled" : ""}${state.commentErr === r.link ? ' aria-invalid="true"' : ""}>${esc(state.drafts.get(r.link) || "")}</textarea>
         ${state.commentErr === r.link ? `<div class="sub bad cerr" role="alert">${esc(COMMENT_NEEDED())}</div>` : ""}
         ${saving ? `<div class="sub saving" role="status">${esc(L2("Записване на решението…", "Saving the decision…"))}</div>` : ""}
         <div class="bar decide">${armed
           ? `${decBtn(armed, DEC_CLS[armed])}<button class="dec secondary" data-cancel="${esc(r.link)}"${dis}>${esc(L2("Откажи", "Cancel"))}</button>`
           : ["approved", "remarks", "rejected"].map((d) => decBtn(d, DEC_CLS[d])).join("")}</div>` : "";
    return `<div class="card" style="--c:${s.colour}">
      <div class="hd"><b>${esc(r.pour)}</b><span>${esc(ACC.STEPS[r.step] ? ACC.STEPS[r.step][lang] : r.step)}</span><span class="st">${esc(s[lang])}</span></div>
      <div class="sub">${L2("Заявено", "Requested")}: ${esc(fmtWhen(r.requested))} · ${esc(r.requested_by)}${r.sent ? ` · ${L2("изпратено към проектанта", "sent to the designer")} ${esc(fmtWhen(r.sent))}` : ` · ${L2("не е изпратено към проектанта", "not sent to the designer yet")}`}</div>
      ${r.decided ? `<div class="sub">${esc(s[lang])}: ${esc(fmtWhen(r.decided))} · ${esc(r.decided_by)}${r.comment ? ` – „${esc(r.comment)}“` : ""}</div>` : ""}
      ${goneN ? `<div class="sub bad">${goneN} ${L2("снимки са изтрити", "photos were deleted")}</div>` : ""}
      ${!state.photosReady && all.length   // sweep 18.11.2026: photos are checked in the background after the list is shown
        ? `<div class="sub photos-wait">${esc(countWord(all.length, "снимка", "снимки", "photo", "photos"))} · ${L2("проверка…", "checking…")}</div>`
        : `<div class="grid">${photos.map((id) => { const p = state.photos.get(id); const th = (p && p.thumb_id) || id;   // the ~25 KB thumbnail when there is one
          return `<button class="th" data-ph="${esc(id)}" data-l="${esc(r.link)}"><img alt="" data-src="${esc(th)}" data-full="${esc(id)}"></button>`; }).join("") || `<span class="sub">${L2("Няма снимки.", "No photos.")}</span>`}</div>`}
      <div class="bar"><button class="small secondary" data-show="${esc(r.link)}">${L2("Покажи в модела", "Show in model")}</button>
        <button class="small secondary" data-log="${esc(r.link)}">${L2("История", "History")}</button></div>
      <div class="log" id="log_${esc(r.link)}"${state.logOpen.has(r.link) ? "" : " hidden"}>${state.logOpen.has(r.link) ? esc(logOf(r)) : ""}</div>
      ${decideBox}</div>`;
  }
  function render() {
    $("title").textContent = L2("Авторски надзор", "Design supervision");
    $("selLang").value = lang;
    $("filter").placeholder = L2("Филтър (такт)", "Filter (pour)");
    $("btnReload").textContent = L2("Обнови", "Refresh");
    $("lblColour").textContent = L2("Оцвети по приемане", "Colour by acceptance");
    $("chkColour").checked = state.coloured;
    $("selStep").innerHTML = [["all", "Всички етапи", "All steps"], ["formwork", "Кофраж", "Formwork"], ["rebar", "Армировка", "Rebar"]]
      .map(([id, bg, en]) => `<option value="${id}"${state.colourStep === id ? " selected" : ""}>${lang === "bg" ? bg : en}</option>`).join("");
    $("legend").innerHTML = LEGEND.map(([s, bg, en]) => `<span><span class="sw" style="background:${ACC.STATUS[s].colour}"></span>${lang === "bg" ? bg : en}</span>`).join("")
      + `<span><span class="sw" style="background:${OTHER.color};opacity:.5"></span>${L2("Без заявка (прозрачно)", "No request (see-through)")}</span>`;
    $("tabs").innerHTML = TABS.map(([id, bg, en]) => `<button class="small ${state.tab === id ? "on" : ""}" data-tab="${id}">${lang === "bg" ? bg : en}${id === "open" ? ` (${state.acc.filter((r) => r.status === "open").length})` : ""}</button>`).join("");
    $("who").textContent = canApprove() ? L2(`Приемате като ${state.user} (4.1-STRUCTURAL DESIGNER).`, `You decide as ${state.user} (4.1-STRUCTURAL DESIGNER).`)
      : L2("Само преглед: приема групата 4.1-STRUCTURAL DESIGNER.", "View only: the group 4.1-STRUCTURAL DESIGNER decides.");
    const list = visible();
    $("list").innerHTML = list.length ? list.map(card).join("") : `<div class="sub">${L2("Няма заявки.", "No requests.")}</div>`;
    if ($("list").querySelectorAll) wantImages($("list"));
    renderBox();
  }
  function renderBox() {
    const b = $("lightbox");
    if (!state.open) { b.innerHTML = ""; return; }
    const p = state.photos.get(state.open) || {};
    b.innerHTML = `<div class="box"><div class="zview" title="${esc(L2("Щракнете за увеличение", "Click to zoom"))}"><img alt="" data-src="${esc(state.open)}"></div><div class="meta">${esc(p.labels || "")}${p.caption ? " – " + esc(p.caption) : ""}<br>${esc(fmtWhen(String(p.taken || "").replace("T", " ").slice(0, 16)))} · ${esc(p.by || "")}</div>
      <div class="bar"><button class="small" id="boxClose">${L2("Затвори", "Close")}</button><a class="open" id="boxOpen" target="_blank" rel="noopener" href="#">${L2("Отвори в нов прозорец", "Open in new window")}</a></div></div>`;
    // fix 18.11.2026: an old (maybe expired) link is asked again before the zoom view uses it; a failure asks once more
    freshUrl(state.open).then((u) => { const i = b.querySelector("img"); if (i && u) { showImg(i, u); const a = $("boxOpen"); if (a) a.href = u; } });
    PH.wireZoom(b.querySelector(".zview"));
    $("boxClose").onclick = () => { state.open = null; renderBox(); };
  }
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.tab) { state.tab = t.dataset.tab; state.arm = null; state.commentErr = null; render(); }
    else if (t.dataset.cancel) { state.arm = null; report(L2("Отказано – нищо не е записано.", "Cancelled – nothing was saved.")); render(); }
    else if (t.dataset.ph) { state.open = t.dataset.ph; renderBox(); }
    else if (t.dataset.show) guarded(() => showInModel(state.acc.find((r) => r.link === t.dataset.show)));
    else if (t.dataset.log) {
      // round 17 L7: the history text is filled when it is opened (and kept open across re-renders), emptied when closed
      const link = t.dataset.log, l = $("log_" + link), r = state.acc.find((x) => x.link === link);
      const open = !state.logOpen.has(link);
      if (open) state.logOpen.add(link); else state.logOpen.delete(link);
      if (l) { l.textContent = open && r ? logOf(r) : ""; l.hidden = !open; }
    }
    else if (t.dataset.relost) guarded(() => retryLost(t.dataset.relost));
    else if (t.dataset.d) guarded(() => arm(state.acc.find((r) => r.link === t.dataset.l), t.dataset.d));
  });
  // typed comments survive a re-render (arming a button, the filter, the background photo check)
  document.addEventListener("input", (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.draft) return;
    state.drafts.set(t.dataset.draft, t.value);
    // the "write a comment" note under the box goes once something is typed (no re-render: the caret stays)
    if (state.commentErr === t.dataset.draft && t.value.trim()) {
      state.commentErr = null;
      const n = t.parentNode && t.parentNode.querySelector && t.parentNode.querySelector(".cerr");
      if (n && n.remove) n.remove();
      if (t.removeAttribute) t.removeAttribute("aria-invalid");
    }
  });
  // sweep 18.11.2026: the list is drawn again ~150 ms after the last keystroke, not on every key (the filter field itself is
  // not redrawn, so the caret stays where it is)
  let filterTimer = 0;
  $("filter").oninput = (e) => { state.filter = e.target.value; clearTimeout(filterTimer); filterTimer = setTimeout(render, 150); };
  // "Обнови": reload the requests and re-check the access (cached 10 min), e.g. after joining 4.1-STRUCTURAL DESIGNER
  $("btnReload").onclick = () => guarded(async () => {
    if (!window.ARSTEN_DEMO) {
      try { for (const k of Object.keys(sessionStorage)) if (k.startsWith("arsten.access.")) sessionStorage.removeItem(k); } catch {}
      if (ArstenAccess._memo && ArstenAccess._memo.clear) ArstenAccess._memo.clear();
      const access = await ArstenAccess.check({ api: state.api, getToken, app: "acceptance" });
      if (!access.allowed) { ArstenAccess.renderDenied(document.body, lang, access); return; }
      state.access = access;
    }
    await load({ fullSweep: true });
  });
  $("chkColour").onchange = (e) => guarded(async () => { state.coloured = e.target.checked; await applyColours(); });
  $("selStep").onchange = (e) => guarded(async () => { state.colourStep = e.target.value; if (state.coloured) await applyColours(); });
  $("selLang").onchange = (e) => { lang = I18N ? I18N.setLang(e.target.value) : e.target.value; render(); relabelStatus(); };

  async function start(api, client) {
    state.api = api;
    if (window.ArstenDiag) ArstenDiag.set({ panel: "Приемане (acceptance)", lang: () => lang });   // round 19 M1: before the access check, so a denied screen's diagnostics name the panel
    const access = window.ARSTEN_DEMO ? (window.ARSTEN_DEMO_ACCESS || { allowed: true, role: "designer", caps: ["approve"] }) : await ArstenAccess.check({ api, getToken, app: "acceptance" });
    if (I18N) { lang = await I18N.pickLang(api, access, OLD_LANG); $("selLang").value = lang; }   // stored choice, else the Connect user's language
    if (!access.allowed) { state.api = null; ArstenAccess.renderDenied(document.body, lang, access); return; }
    state.access = access;
    state.project = (await api.project.getProject()) || {};
    try { const u = await api.user.getUser(); state.user = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || ""; } catch {}
    state.client = client || new A.PsetClient({ region: state.project.location || "europe", getToken });
    if (window.ArstenDiag) ArstenDiag.set({ panel: "Приемане (acceptance)", projectId: state.project.id, redact: [state.user], lang: () => lang });   // A23
    await guarded(load);
  }
  // _token, _urlOf, _showImg, _freshUrl, _colour: tests (round 17 L3, sweep 18.11.2026)
  window.AcceptanceApp = { start, state, _token: { getToken, onToken, waiting: () => waiters.length }, _urlOf: urlOf, _showImg: showImg, _freshUrl: freshUrl,
    _colour: { recolourIfNeeded, ownStateAt: () => ownStateAt, onEvent: (e, d) => onEvent(e, d) } };

  let reloadTimer = null;
  function onEvent(event, data) {
    if (event === "extension.accessToken") onToken(data);
    if (event === "viewer.onModelReset") { state.coloured = false; $("chkColour").checked = false; }
    if (event === "viewer.onModelStateChanged" && state.client && state.coloured) {
      const at = Date.now();   // the event's own time: the 1.5 s wait must not make our own event look like someone else's
      clearTimeout(reloadTimer); reloadTimer = setTimeout(() => guarded(() => recolourIfNeeded(at)), 1500);
    }
  }
  if (window.parent === window) {
    if (/[?&]demo\b/.test(location.search)) { const s = document.createElement("script"); s.src = "demo.js?t=" + Date.now(); document.body.appendChild(s); }
    else setStatus(I18N ? I18N.word("notInside", lang) : "Not inside Trimble Connect.", true);
    return;
  }
  if (I18N) setStatus(I18N.word("connecting", lang));
  TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000)
    .then((api) => start(api))
    .catch((e) => setStatus((I18N ? I18N.word("connectFail", lang) : "Could not connect to Trimble Connect") + ": " + errText(e), true));
})();
