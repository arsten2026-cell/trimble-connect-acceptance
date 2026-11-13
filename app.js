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
  let lang = (() => { try { return localStorage.getItem("arsten.acceptance.lang") || "bg"; } catch { return "bg"; } })();
  const L2 = (b, e) => (lang === "bg" ? b : e);
  const state = { api: null, client: null, project: null, user: "", access: null, lib: null, acc: [], photos: new Map(), tab: "open", filter: "", urls: new Map(), open: null, busy: false, coloured: false, colourStep: "all" };
  const setStatus = (t, bad) => { $("status").textContent = t || ""; $("status").className = "status" + (bad ? " bad" : ""); };
  const errText = (e) => (e && (e.message || e.toString())) || String(e);
  const guarded = (fn) => Promise.resolve().then(fn).catch((e) => { console.error(e); setStatus(errText(e), true); });

  // ---------- access token ----------
  let token = null, waiters = [];
  function onToken(tk) { token = tk; const w = waiters; waiters = []; w.forEach((f) => f(tk)); }
  async function getToken(refresh) {
    if (token && !refresh) return token;
    const p = new Promise((resolve, reject) => { waiters.push(resolve); setTimeout(() => reject(new Error("No access token from Trimble Connect")), 60000); });
    const r = await state.api.extension.requestPermission("accesstoken");
    if (r === "denied") throw new Error("Access to Trimble Connect data was denied for this extension.");
    if (r && r !== "pending" && r !== "granted") { token = r; return r; }
    return p;
  }
  const core = () => window.ARSTEN_PHOTOS_CORE || PH.coreClient(ArstenAccess.coreBase(state.project.location), getToken);
  const canApprove = () => ArstenAccess.can(state.access, "approve");

  // ---------- data ----------
  async function load() {
    setStatus(L2("Зареждане…", "Loading…"));
    const found = await state.client.findLibrary(state.project.id, LIB_NAMES);
    if (!found.lib) return setStatus(L2("Няма библиотека CIP/Монолитно в проекта.", "No library CIP/Монолитно in the project."), true);
    state.lib = found.lib;
    const a = await state.client.listAll(state.lib.id, ACC.DEF_ID, ACC.prefix(state.project.id));
    state.acc = [...a].map(([link, p]) => Object.assign({ link }, p)).filter(ACC.valid);
    try {
      const ph = await state.client.listAll(state.lib.id, PH.DEF_ID, PH.photoPrefix(state.project.id));
      state.photos = new Map([...ph].map(([, p]) => [p.file_id, p]));
    } catch (e) { console.error(e); }
    $("main").hidden = false;
    const open = state.acc.filter((r) => r.status === "open").length;
    setStatus(L2(`${state.acc.length} заявки · ${open} чакат`, `${state.acc.length} requests · ${open} waiting`));
    render();
    if (state.coloured) await applyColours();
  }

  async function urlOf(fileId) {
    if (!state.urls.has(fileId)) state.urls.set(fileId, core().req(`files/fs/${encodeURIComponent(fileId)}/downloadurl`).then((d) => (d && (d.url || d.downloadUrl || d.href)) || "").catch(() => ""));
    return state.urls.get(fileId);
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

  let busy = false;
  async function decide(r, decision) {
    if (busy) return;
    if (!canApprove()) return setStatus(L2("Само групата 4.1-STRUCTURAL DESIGNER може да приема.", "Only the group 4.1-STRUCTURAL DESIGNER can decide."), true);
    const comment = (($("c_" + r.link) || {}).value || "").trim();
    try { ACC.decide(r, { decision, comment, by: state.user }); }
    catch (e) { if (e.code === "comment") return setStatus(L2("Напишете коментар (забележки / причина).", "Write a comment (remarks / reason)."), true); throw e; }
    busy = true;
    let props;
    try {
      // decide on the FRESH server copy; if photos or status changed since it was shown, show it again first
      const got = await state.client.readMany(state.lib.id, ACC.DEF_ID, [r.link]);
      const fresh = got.get(r.link);
      if (!fresh || fresh.status !== r.status || (fresh.photos || "") !== (r.photos || "")) {
        await load();
        return setStatus(L2("Заявката е променена междувременно (нови снимки или решение) – прегледайте я отново.", "The request changed meanwhile (new photos or a decision) – please look again."), true);
      }
      props = ACC.decide(Object.assign({ link: r.link }, fresh), { decision, comment, by: state.user });
      const rec = Object.assign({}, props); delete rec.link;
      await state.client.replace(state.lib.id, ACC.DEF_ID, r.link, rec);
    } finally { busy = false; }
    Object.assign(r, props);
    setStatus(`${r.pour} · ${ACC.STEPS[r.step][lang]}: ${ACC.STATUS[decision][lang]}`);
    render();
    if (state.coloured) await applyColours();
  }

  // ---------- colours in the model ----------
  // За приемане orange, Приети green, Приети със забележки light green, Не се приемат red; everything else grey, see-through.
  const LEGEND = [["open", "За приемане", "Awaiting acceptance"], ["approved", "Приети", "Accepted"], ["remarks", "Приети със забележки", "Accepted with remarks"], ["rejected", "Не се приемат", "Rejected"]];
  const OTHER = { color: "#BDBDBD", opacity: 0.18 };
  async function applyColours() {
    const v = state.api.viewer;
    const all = [];
    for (const m of (await v.getObjects()) || []) if ((m.objects || []).length) all.push({ modelId: m.modelId, objectRuntimeIds: m.objects.map((o) => o.id) });
    if (!state.coloured) { if (all.length) await v.setObjectState({ modelObjectIds: all }, { color: "reset", opacity: 1 }); return; }
    if (all.length) await v.setObjectState({ modelObjectIds: all }, OTHER);
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
      if (sel.length) { await v.setObjectState({ modelObjectIds: sel }, { color: ACC.STATUS[status].colour, opacity: 1 }); shown += sel.reduce((n, s) => n + s.objectRuntimeIds.length, 0); }
    }
    if (missing && !shown) setStatus(L2("Обектите на заявките не са в заредените модели (заредете модела с тактовете).", "The requests' objects are not in the loaded models (load the pour model)."), true);
  }

  // ---------- UI ----------
  const TABS = [["open", "Чакащи", "Waiting"], ["done", "Решени", "Decided"], ["all", "Всички", "All"]];
  function visible() {
    const f = state.filter.trim().toUpperCase();
    return state.acc.filter((r) => (state.tab === "all" || (state.tab === "open" ? r.status === "open" : r.status !== "open"))
      && (!f || String(r.pour).toUpperCase().includes(f)))
      .sort((a, b) => (state.tab === "open" ? (a.requested < b.requested ? -1 : 1) : (String(a.decided || a.requested) < String(b.decided || b.requested) ? 1 : -1)));
  }
  function card(r) {
    const s = ACC.STATUS[r.status] || ACC.STATUS.open;
    const photos = ACC.ids(r.photos).filter((id) => { const p = state.photos.get(id); return !p || !p.deleted; });
    const decideBox = r.status === "open" && canApprove()
      ? `<textarea id="c_${esc(r.link)}" placeholder="${esc(L2("Коментар (задължителен за забележки / отказ)", "Comment (required for remarks / rejection)"))}"></textarea>
         <div class="bar"><button class="small ok" data-d="approved" data-l="${esc(r.link)}">${L2("Одобрено", "Approve")}</button>
           <button class="small rem" data-d="remarks" data-l="${esc(r.link)}">${L2("Одобрено със забележки", "Approve with remarks")}</button>
           <button class="small no" data-d="rejected" data-l="${esc(r.link)}">${L2("Не се приема", "Reject")}</button></div>` : "";
    return `<div class="card" style="--c:${s.colour}">
      <div class="hd"><b>${esc(r.pour)}</b><span>${esc(ACC.STEPS[r.step] ? ACC.STEPS[r.step][lang] : r.step)}</span><span class="st">${esc(s[lang])}</span></div>
      <div class="sub">${L2("Заявено", "Requested")}: ${esc(r.requested)} · ${esc(r.requested_by)}${r.sent ? ` · ${L2("изпратено", "sent")} ${esc(r.sent)}` : ` · ${L2("неизпратено", "not sent")}`}</div>
      ${r.decided ? `<div class="sub">${esc(s[lang])}: ${esc(r.decided)} · ${esc(r.decided_by)}${r.comment ? ` – „${esc(r.comment)}“` : ""}</div>` : ""}
      <div class="grid">${photos.map((id) => `<button class="th" data-ph="${esc(id)}" data-l="${esc(r.link)}"><img alt="" data-src="${esc(id)}"></button>`).join("") || `<span class="sub">${L2("Няма снимки.", "No photos.")}</span>`}</div>
      <div class="bar"><button class="small secondary" data-show="${esc(r.link)}">${L2("Покажи в модела", "Show in model")}</button>
        <button class="small secondary" data-log="${esc(r.link)}">${L2("История", "History")}</button></div>
      <div class="log" id="log_${esc(r.link)}" hidden>${esc(r.log)}</div>
      ${decideBox}</div>`;
  }
  function render() {
    $("title").textContent = L2("Приемане", "Acceptance");
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
    document.querySelectorAll("img[data-src]").forEach((img) => urlOf(img.dataset.src).then((u) => { if (u) img.src = u; }));
    renderBox();
  }
  function renderBox() {
    const b = $("lightbox");
    if (!state.open) { b.innerHTML = ""; return; }
    const p = state.photos.get(state.open) || {};
    b.innerHTML = `<div class="box"><div class="zview" title="${esc(L2("Щракнете за увеличение", "Click to zoom"))}"><img alt="" data-src="${esc(state.open)}"></div><div class="meta">${esc(p.labels || "")}${p.caption ? " – " + esc(p.caption) : ""}<br>${esc(String(p.taken || "").replace("T", " ").slice(0, 16))} · ${esc(p.by || "")}</div>
      <div class="bar"><button class="small" id="boxClose">${L2("Затвори", "Close")}</button><a class="open" id="boxOpen" target="_blank" rel="noopener" href="#">${L2("Отвори в нов прозорец", "Open in new window")}</a></div></div>`;
    urlOf(state.open).then((u) => { const i = b.querySelector("img"); if (i && u) { i.src = u; const a = $("boxOpen"); if (a) a.href = u; } });
    PH.wireZoom(b.querySelector(".zview"));
    $("boxClose").onclick = () => { state.open = null; renderBox(); };
  }
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.tab) { state.tab = t.dataset.tab; render(); }
    else if (t.dataset.ph) { state.open = t.dataset.ph; renderBox(); }
    else if (t.dataset.show) guarded(() => showInModel(state.acc.find((r) => r.link === t.dataset.show)));
    else if (t.dataset.log) { const l = $("log_" + t.dataset.log); if (l) l.hidden = !l.hidden; }
    else if (t.dataset.d) guarded(() => decide(state.acc.find((r) => r.link === t.dataset.l), t.dataset.d));
  });
  $("filter").oninput = (e) => { state.filter = e.target.value; const pos = e.target.selectionStart; render(); $("filter").focus(); $("filter").setSelectionRange(pos, pos); };
  // "Обнови": reload the requests and re-check the access (cached 10 min), e.g. after joining 4.1-STRUCTURAL DESIGNER
  $("btnReload").onclick = () => guarded(async () => {
    if (!window.ARSTEN_DEMO) {
      try { for (const k of Object.keys(sessionStorage)) if (k.startsWith("arsten.access.")) sessionStorage.removeItem(k); } catch {}
      if (ArstenAccess._memo && ArstenAccess._memo.clear) ArstenAccess._memo.clear();
      const access = await ArstenAccess.check({ api: state.api, getToken, app: "acceptance" });
      if (!access.allowed) { ArstenAccess.renderDenied(document.body, lang, access); return; }
      state.access = access;
    }
    await load();
  });
  $("chkColour").onchange = (e) => guarded(async () => { state.coloured = e.target.checked; await applyColours(); });
  $("selStep").onchange = (e) => guarded(async () => { state.colourStep = e.target.value; if (state.coloured) await applyColours(); });
  $("selLang").onchange = (e) => { lang = e.target.value; try { localStorage.setItem("arsten.acceptance.lang", lang); } catch {} render(); };

  async function start(api, client) {
    state.api = api;
    const access = window.ARSTEN_DEMO ? (window.ARSTEN_DEMO_ACCESS || { allowed: true, role: "designer", caps: ["approve"] }) : await ArstenAccess.check({ api, getToken, app: "acceptance" });
    if (!access.allowed) { state.api = null; ArstenAccess.renderDenied(document.body, lang, access); return; }
    state.access = access;
    state.project = (await api.project.getProject()) || {};
    try { const u = await api.user.getUser(); state.user = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email || ""; } catch {}
    state.client = client || new A.PsetClient({ region: state.project.location || "europe", getToken });
    await guarded(load);
  }
  window.AcceptanceApp = { start, state };

  let reloadTimer = null;
  function onEvent(event, data) {
    if (event === "extension.accessToken") onToken(data);
    if (event === "viewer.onModelReset") { state.coloured = false; $("chkColour").checked = false; }
    if (event === "viewer.onModelStateChanged" && state.client && state.coloured) { clearTimeout(reloadTimer); reloadTimer = setTimeout(() => guarded(applyColours), 1500); }
  }
  if (window.parent === window) {
    if (/[?&]demo\b/.test(location.search)) { const s = document.createElement("script"); s.src = "demo.js?t=" + Date.now(); document.body.appendChild(s); }
    else setStatus("Not inside Trimble Connect. Add this extension to a project and open it from the 3D viewer side panel.", true);
    return;
  }
  TrimbleConnectWorkspace.connect(window.parent, onEvent, 30000)
    .then((api) => start(api))
    .catch((e) => setStatus("Could not connect to Trimble Connect: " + errText(e), true));
})();
