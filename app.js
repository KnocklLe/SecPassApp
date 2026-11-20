// SecPass mobile — application web installable (Android), compatible vault.json / mdp.py / extension.

import { canonicalJson, decryptEntries, encryptEntries, generatePassword, unlockVault, validateVault, VaultError } from "./crypto.js";
import * as store from "./store.js";
import { ConflictError, SyncError, decryptSecret, encryptSecret, fetchRemote, mergeEntries, pushRemote } from "./sync.js";
import { bindPasswordToggles, icon, renderStrength, setRevealed } from "./ui.js";

const $ = (id) => document.getElementById(id);
const VIEWS = ["view-setup", "view-locked", "view-list", "view-edit", "view-gen", "view-settings"];
const LOCK_AFTER_BACKGROUND_MS = 60_000;   // appli en arrière-plan plus d'1 min -> verrouillée
const LOCK_AFTER_IDLE_MS = 5 * 60_000;     // 5 min sans toucher l'écran -> verrouillée
const CLIPBOARD_CLEAR_MS = 30_000;

let vault = null;          // coffre chiffré (copie locale)
let keyBytes = null;       // clé déverrouillée, en mémoire uniquement
let entries = {};          // comptes déchiffrés, en mémoire uniquement
let token = null;          // jeton GitHub déchiffré, en mémoire uniquement
let pendingToken = null;   // jeton saisi avant déverrouillage (sera chiffré au déverrouillage)
let editing = null;
let currentView = null;
let settingsReturn = "view-list";
let prefs = store.getPrefs();
let gen = { value: "", returnTo: "view-list", forEdit: false };

const SVG = {
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
};
function svg(name) {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${SVG[name]}</svg>`;
  return t.content.firstElementChild;
}

// ------------------------------------------------------------------ utilitaires

function show(view) {
  for (const v of VIEWS) $(v).hidden = v !== view;
  currentView = view;
  $("btn-lock").hidden = !keyBytes;
  window.scrollTo(0, 0);
}

function hostOf(url) {
  if (!url) return "";
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : "https://" + url);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function safeHref(url) {
  if (!url) return "";
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : "https://" + url);
    return /^https?:$/.test(u.protocol) ? u.href : "";
  } catch {
    return "";
  }
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
const nextPaint = () => new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 100); });

let toastTimer;
function toast(msg, kind = "ok") {
  const t = $("toast");
  const text = document.createElement("span");
  text.textContent = msg;
  t.replaceChildren(icon(kind === "error" ? "alert" : "check"), text);
  t.className = `show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function shake(el) {
  el.classList.remove("shake");
  void el.offsetWidth;
  el.classList.add("shake");
}

function ask(title, message, yesLabel) {
  return new Promise((resolve) => {
    $("confirm-title").textContent = title;
    $("confirm-text").textContent = message;
    $("confirm-yes").textContent = yesLabel;
    $("confirm").hidden = false;
    const done = (answer) => {
      $("confirm").hidden = true;
      $("confirm-yes").onclick = $("confirm-no").onclick = null;
      resolve(answer);
    };
    $("confirm-yes").onclick = () => done(true);
    $("confirm-no").onclick = () => done(false);
    $("confirm-no").focus();
  });
}

function avatar(name) {
  const a = document.createElement("span");
  a.className = "avatar";
  a.textContent = (name.match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
  let h = 0;
  for (const c of name.toLowerCase()) h = (h * 31 + c.codePointAt(0)) >>> 0;
  a.style.setProperty("--h", String(h % 360));
  return a;
}

function iconButton(node, title, onClick) {
  const b = document.createElement("button");
  b.className = "icon";
  b.title = title;
  b.setAttribute("aria-label", title);
  b.append(node);
  b.addEventListener("click", onClick);
  return b;
}

function busyButton(btn, on) {
  btn.disabled = on;
  const sp = btn.querySelector(".spinner");
  if (sp) sp.hidden = !on;
}

// ------------------------------------------------------------------ démarrage / verrou

function boot() {
  bindPasswordToggles();
  vault = store.getVault();
  updateSyncIndicator();
  if (!vault) return show("view-setup");
  showLocked();
}

function showLocked(message) {
  $("locked-text").textContent = message || "Entre ton mot de passe maître pour accéder à tes comptes.";
  show("view-locked");
}

function lock(message) {
  keyBytes = null;
  entries = {};
  token = null;
  $("search").value = "";
  if (vault) showLocked(message);
}

$("form-unlock").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("btn-unlock");
  $("unlock-error").hidden = true;
  btn.disabled = true;
  $("unlock-spinner").hidden = false;
  $("unlock-label").textContent = "Déverrouillage…";
  await nextPaint();
  try {
    const res = await unlockVault(vault, $("master").value);
    keyBytes = res.keyBytes;
    entries = res.entries;
    $("master").value = "";
    await loadToken();
    resetIdle();
    showList();
    sync();
  } catch (ex) {
    $("unlock-error").textContent = ex instanceof VaultError ? ex.message : `Erreur : ${ex.message}`;
    $("unlock-error").hidden = false;
    shake($("master"));
  } finally {
    btn.disabled = false;
    $("unlock-spinner").hidden = true;
    $("unlock-label").textContent = "Déverrouiller";
  }
});

$("btn-lock").addEventListener("click", () => lock());

// Verrouillage automatique : arrière-plan prolongé ou inactivité.
let hiddenAt = null;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    hiddenAt = Date.now();
    return;
  }
  if (keyBytes && hiddenAt && Date.now() - hiddenAt > LOCK_AFTER_BACKGROUND_MS) lock();
  else if (keyBytes) sync();
  hiddenAt = null;
});
let idleTimer;
function resetIdle() {
  clearTimeout(idleTimer);
  if (keyBytes) idleTimer = setTimeout(() => lock(), LOCK_AFTER_IDLE_MS);
}
document.addEventListener("pointerdown", resetIdle);
document.addEventListener("keydown", resetIdle);

// ------------------------------------------------------------------ liste

function showList() {
  show("view-list");
  renderList();
}

function renderList() {
  const q = $("search").value.trim().toLowerCase();
  const names = Object.keys(entries).sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
  const shown = names.filter((n) => !q || [n, entries[n].username, entries[n].url].some((s) => (s || "").toLowerCase().includes(q)));
  $("list").replaceChildren(...shown.map(entryItem));
  $("list-title").textContent = q ? "Résultats" : "Tous les comptes";
  $("list-count").textContent = String(shown.length);
  $("list-empty").hidden = shown.length > 0;
  $("list-empty-text").textContent = names.length ? `Aucun compte ne correspond à « ${q} ».` : "Ton coffre est vide pour l'instant.";
  $("btn-add-empty").hidden = names.length > 0;
}

function entryItem(name) {
  const e = entries[name];
  const li = document.createElement("li");
  li.className = "entry";
  const main = document.createElement("button");
  main.className = "entry-main";
  const text = document.createElement("span");
  text.className = "entry-text";
  const n = document.createElement("span");
  n.className = "entry-name";
  n.textContent = name;
  const sub = document.createElement("span");
  sub.className = "entry-sub";
  sub.textContent = e.username || hostOf(e.url) || "Pas d'identifiant";
  text.append(n, sub);
  main.append(avatar(name), text);
  main.addEventListener("click", () => openEdit(name));

  const actions = document.createElement("div");
  actions.className = "entry-actions";
  if (e.username) actions.append(iconButton(icon("user"), "Copier l'identifiant", () => copy(e.username, false)));
  actions.append(iconButton(icon("key"), "Copier le mot de passe", () => copy(e.password, true)));
  li.append(main, actions);
  return li;
}

$("search").addEventListener("input", renderList);

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

let clipTimer;
async function copy(text, isPassword) {
  if (!text) return toast(isPassword ? "Aucun mot de passe à copier" : "Aucun identifiant à copier", "error");
  if (!(await writeClipboard(text))) return toast("Copie impossible", "error");
  if (isPassword) {
    clearTimeout(clipTimer);
    // effacé après 30 s si l'appli est encore au premier plan (le navigateur l'interdit sinon)
    clipTimer = setTimeout(() => navigator.clipboard.writeText(" ").catch(() => {}), CLIPBOARD_CLEAR_MS);
    toast("Mot de passe copié");
  } else {
    toast("Identifiant copié");
  }
}

// ------------------------------------------------------------------ ajout / modification

function openEdit(name) {
  editing = name;
  const e = name ? entries[name] : {};
  $("edit-title").textContent = name ? "Modifier le compte" : "Nouveau compte";
  $("f-name").value = name ?? "";
  $("f-username").value = e.username || "";
  $("f-password").value = e.password || "";
  setRevealed($("f-password"), document.querySelector('[data-toggle="f-password"]'), false);
  $("f-url").value = e.url || "";
  $("f-notes").value = e.notes || "";
  $("btn-delete").hidden = !name;
  const href = safeHref(e.url);
  $("btn-open-site").hidden = !href;
  if (href) $("btn-open-site").href = href;
  $("edit-error").hidden = true;
  renderStrength($("f-strength"), $("f-password").value);
  show("view-edit");
  if (!name) $("f-name").focus();
}

function editError(msg, field) {
  $("edit-error").textContent = msg;
  $("edit-error").hidden = false;
  if (field) { shake(field); field.focus(); }
}

// Enregistre localement, puis envoie sur GitHub en arrière-plan.
async function persist(next) {
  const sealed = await encryptEntries(vault.header, keyBytes, next);
  store.setVault(sealed);
  vault = sealed;
  entries = next;
  localRev++;
  store.updateMeta({ dirty: true });
  updateSyncIndicator();
  sync();
}

$("btn-add").addEventListener("click", () => openEdit(null));
$("btn-add-empty").addEventListener("click", () => openEdit(null));
$("btn-cancel").addEventListener("click", showList);
$("btn-back").addEventListener("click", showList);
$("f-password").addEventListener("input", () => renderStrength($("f-strength"), $("f-password").value));
$("btn-copy-user").addEventListener("click", () => copy($("f-username").value, false));
$("btn-copy-pass").addEventListener("click", () => copy($("f-password").value, true));
$("btn-generate").addEventListener("click", () => openGenerator(true));

$("form-edit").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("f-name").value.trim();
  if (!name) return editError("Le nom est obligatoire.", $("f-name"));
  if (name !== editing && entries[name]) return editError(`« ${name} » existe déjà.`, $("f-name"));
  let password = $("f-password").value;
  const generated = !password;
  if (generated) password = generatePassword(prefs.length, prefs.symbols);
  const next = { ...entries };
  if (editing && editing !== name) delete next[editing];
  next[name] = {
    username: $("f-username").value.trim(),
    password,
    url: $("f-url").value.trim(),
    notes: $("f-notes").value.trim(),
    updated: nowIso(),
  };
  try {
    await persist(next);
  } catch (ex) {
    return editError(`Enregistrement impossible : ${ex.message}`);
  }
  showList();
  toast(generated ? `${name} enregistré · mot de passe généré` : `${name} enregistré`);
});

$("btn-delete").addEventListener("click", async () => {
  if (!(await ask("Supprimer ce compte ?", `« ${editing} » sera supprimé définitivement.`, "Supprimer"))) return;
  const next = { ...entries };
  delete next[editing];
  await persist(next);
  showList();
  toast("Compte supprimé");
});

// ------------------------------------------------------------------ générateur

function renderGenerated() {
  $("gen-value").replaceChildren(...[...gen.value].map((c) => {
    const s = document.createElement("span");
    s.textContent = c;
    if (/[0-9]/.test(c)) s.className = "d";
    else if (!/[a-zA-Z]/.test(c)) s.className = "s";
    return s;
  }));
  renderStrength($("gen-strength"), gen.value);
}

function regenerate() {
  gen.value = generatePassword(prefs.length, prefs.symbols);
  renderGenerated();
}

function openGenerator(forEdit) {
  gen.forEdit = forEdit;
  gen.returnTo = currentView === "view-gen" ? gen.returnTo : currentView;
  $("btn-gen-use").hidden = !forEdit;
  $("gen-length").value = String(prefs.length);
  $("gen-length-out").textContent = String(prefs.length);
  $("gen-symbols").checked = prefs.symbols;
  regenerate();
  show("view-gen");
}

$("btn-gen-open").addEventListener("click", () => openGenerator(false));
$("btn-gen-back").addEventListener("click", () => show(gen.returnTo));
$("btn-gen-refresh").addEventListener("click", regenerate);
$("btn-gen-copy").addEventListener("click", () => copy(gen.value, true));
$("gen-length").addEventListener("input", () => {
  prefs.length = Number($("gen-length").value);
  $("gen-length-out").textContent = String(prefs.length);
  regenerate();
});
$("gen-length").addEventListener("change", () => store.setPrefs(prefs));
$("gen-symbols").addEventListener("change", () => {
  prefs.symbols = $("gen-symbols").checked;
  store.setPrefs(prefs);
  regenerate();
});
$("btn-gen-use").addEventListener("click", () => {
  $("f-password").value = gen.value;
  setRevealed($("f-password"), document.querySelector('[data-toggle="f-password"]'), true);
  renderStrength($("f-strength"), gen.value);
  show("view-edit");
});

// ------------------------------------------------------------------ synchronisation GitHub

// Déchiffre le jeton enregistré (ou chiffre celui saisi avant le déverrouillage).
async function loadToken() {
  const cfg = store.getSync();
  if (!cfg) return;
  if (pendingToken) {
    token = pendingToken;
    pendingToken = null;
    store.setSync({ ...cfg, token: await encryptSecret(keyBytes, token) });
  } else if (cfg.token) {
    try {
      token = await decryptSecret(keyBytes, cfg.token);
    } catch {
      token = null; // mot de passe maître changé : il faut ressaisir le jeton
      store.setSync({ ...cfg, token: null });
      toast("Ressaisis ton jeton GitHub dans les paramètres", "error");
    }
  }
}

// Une seule synchro à la fois ; une modification faite pendant une synchro en relance une autre.
let syncing = null;
let syncAgain = false;
let localRev = 0; // augmente à chaque modification locale
function sync() {
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  syncing = runSync().finally(() => {
    syncing = null;
    if (syncAgain) {
      syncAgain = false;
      sync();
    }
  });
  return syncing;
}

async function runSync(attempt = 1) {
  const cfg = store.getSync();
  if (!cfg || !token || !keyBytes) return updateSyncIndicator();
  if (!navigator.onLine) return updateSyncIndicator("offline");
  updateSyncIndicator("busy");
  const rev = localRev;
  const changedMeanwhile = () => localRev !== rev;
  try {
    const meta = store.getMeta();
    const remote = await fetchRemote(cfg, token);
    validateVault(remote.vault);
    if (changedMeanwhile()) return runSync(attempt);

    if (remote.sha === meta.syncedSha) {
      // GitHub n'a pas bougé : on envoie nos modifications s'il y en a
      if (meta.dirty) {
        const sha = await pushRemote(cfg, token, vault, remote.sha);
        store.setMeta({ syncedSha: sha, dirty: changedMeanwhile(), syncedAt: Date.now() });
        if (changedMeanwhile()) syncAgain = true;
      } else {
        store.updateMeta({ syncedAt: Date.now() });
      }
      return updateSyncIndicator();
    }

    // GitHub a changé (depuis le PC, l'extension ou un autre téléphone)
    if (canonicalJson(remote.vault.header) !== canonicalJson(vault.header)) {
      if (meta.dirty) {
        throw new SyncError("Le mot de passe maître a été changé ailleurs alors que ce téléphone a des modifications non envoyées. Exporte le coffre du téléphone puis fusionne-le sur ton PC.");
      }
      // coffre re-chiffré avec un autre mot de passe maître : on l'adopte et on redemande le mot de passe
      store.setVault(remote.vault);
      store.setMeta({ syncedSha: remote.sha, dirty: false, syncedAt: Date.now() });
      vault = remote.vault;
      pendingToken = token;
      lock("Le mot de passe maître a changé sur un autre appareil : déverrouille avec le nouveau.");
      return updateSyncIndicator();
    }

    const remoteEntries = await decryptEntries(remote.vault, keyBytes);
    if (changedMeanwhile()) return runSync(attempt);
    if (!meta.dirty) {
      // pas de modification ici : le coffre de GitHub fait foi (suppressions comprises)
      store.setVault(remote.vault);
      store.setMeta({ syncedSha: remote.sha, dirty: false, syncedAt: Date.now() });
      vault = remote.vault;
      entries = remoteEntries;
    } else {
      // modifications des deux côtés : fusion, puis envoi
      const merged = mergeEntries(entries, remoteEntries);
      const sealed = await encryptEntries(vault.header, keyBytes, merged);
      const sha = await pushRemote(cfg, token, sealed, remote.sha);
      if (changedMeanwhile()) {
        // modifié pendant l'envoi : on garde la version locale (plus récente) et on resynchronise
        store.updateMeta({ syncedSha: sha });
        syncAgain = true;
      } else {
        store.setVault(sealed);
        store.setMeta({ syncedSha: sha, dirty: false, syncedAt: Date.now() });
        vault = sealed;
        entries = merged;
      }
    }
    if (currentView === "view-list") renderList();
    updateSyncIndicator();
  } catch (ex) {
    if (ex instanceof ConflictError && attempt < 3) return runSync(attempt + 1);
    updateSyncIndicator("error", ex instanceof SyncError || ex instanceof VaultError ? ex.message : `Erreur : ${ex.message}`);
  }
}

function updateSyncIndicator(state, message) {
  const cfg = store.getSync();
  const btn = $("btn-sync");
  const line = $("sync-line");
  btn.hidden = !cfg;
  line.hidden = !cfg;
  if (!cfg) return;
  const meta = store.getMeta();
  if (!state) {
    if (!token) state = keyBytes ? "notoken" : "locked";
    else state = meta.dirty ? "pending" : "ok";
  }
  const time = meta.syncedAt ? new Date(meta.syncedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }) : null;
  const texts = {
    ok: time ? `Synchronisé avec GitHub à ${time}` : "Synchronisé avec GitHub",
    pending: "Modifications à envoyer sur GitHub",
    busy: "Synchronisation…",
    offline: "Hors ligne : les modifications seront envoyées plus tard",
    notoken: "Jeton GitHub manquant : ajoute-le dans les paramètres",
    locked: "",
    error: message || "Erreur de synchronisation",
  };
  btn.className = `icon sync-btn ${{ ok: "ok", pending: "pending", offline: "pending", busy: "busy", error: "error", notoken: "error" }[state] || ""}`;
  btn.title = texts[state] || "Synchroniser avec GitHub";
  line.textContent = texts[state] || "";
  line.className = `sync-line ${state === "error" || state === "notoken" ? "error" : state === "pending" || state === "offline" ? "pending" : ""}`;
}

$("btn-sync").addEventListener("click", async () => {
  if (!keyBytes) return toast("Déverrouille d'abord le coffre", "error");
  if (!token) return openSettings();
  await sync();
  const line = $("sync-line");
  if (line.classList.contains("error")) toast(line.textContent, "error");
  else toast("Synchronisation terminée");
});
window.addEventListener("online", () => { if (keyBytes) sync(); });

// ------------------------------------------------------------------ paramètres

function openSettings() {
  settingsReturn = currentView === "view-settings" ? settingsReturn : currentView;
  const cfg = store.getSync();
  $("s-owner").value = cfg?.owner ?? "";
  $("s-repo").value = cfg?.repo ?? "";
  $("s-branch").value = cfg?.branch ?? "main";
  $("s-path").value = cfg?.path ?? "vault.json";
  $("s-token").value = "";
  $("s-token-hint").hidden = !(cfg?.token || token);
  $("btn-sync-remove").hidden = !cfg;
  $("sync-error").hidden = true;
  show("view-settings");
}

$("btn-settings").addEventListener("click", openSettings);
$("btn-setup-github").addEventListener("click", () => { openSettings(); $("s-owner").focus(); });
$("btn-settings-back").addEventListener("click", () => {
  if (!vault) return show("view-setup");
  if (!keyBytes) return showLocked();
  show(settingsReturn === "view-settings" || settingsReturn === "view-setup" || settingsReturn === "view-locked" ? "view-list" : settingsReturn);
  if (currentView === "view-list") renderList();
});

$("form-sync").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("btn-sync-save");
  const cfg = {
    owner: $("s-owner").value.trim(),
    repo: $("s-repo").value.trim(),
    branch: $("s-branch").value.trim() || "main",
    path: $("s-path").value.trim().replace(/^\/+/, "") || "vault.json",
  };
  const newToken = $("s-token").value.trim() || token || pendingToken;
  $("sync-error").hidden = true;
  const saved = store.getSync();
  if (!newToken && saved?.token && !keyBytes) {
    // verrouillé, jeton déjà enregistré (chiffré) : on garde le jeton, on testera après déverrouillage
    store.setSync({ ...cfg, token: saved.token });
    updateSyncIndicator();
    return showLocked("Paramètres enregistrés : déverrouille pour synchroniser.");
  }
  if (!newToken) {
    $("sync-error").textContent = "Colle ton jeton d'accès GitHub.";
    $("sync-error").hidden = false;
    return shake($("s-token"));
  }
  busyButton(btn, true);
  try {
    const remote = await fetchRemote(cfg, newToken); // vérifie le jeton et le chemin
    validateVault(remote.vault);
    const old = store.getSync();
    const sameRepo = old && old.owner === cfg.owner && old.repo === cfg.repo && old.branch === cfg.branch && old.path === cfg.path;
    if (keyBytes) {
      token = newToken;
      store.setSync({ ...cfg, token: await encryptSecret(keyBytes, token) });
    } else {
      pendingToken = newToken; // sera chiffré au déverrouillage
      store.setSync({ ...cfg, token: null });
    }
    if (!sameRepo) store.updateMeta({ syncedSha: null }); // nouveau dépôt : on repart de son contenu
    $("s-token").value = "";

    if (!vault) {
      // premier lancement : on récupère le coffre
      store.setVault(remote.vault);
      store.setMeta({ syncedSha: remote.sha, dirty: false, syncedAt: Date.now() });
      vault = remote.vault;
      updateSyncIndicator();
      return showLocked("Coffre récupéré depuis GitHub : déverrouille-le avec ton mot de passe maître.");
    }
    if (!keyBytes) {
      updateSyncIndicator();
      return showLocked("Connexion GitHub enregistrée : déverrouille pour synchroniser.");
    }
    await sync();
    if ($("sync-line").classList.contains("error")) throw new SyncError($("sync-line").textContent);
    toast("Synchronisé avec GitHub");
    showList();
  } catch (ex) {
    $("sync-error").textContent = ex instanceof SyncError || ex instanceof VaultError ? ex.message : `Erreur : ${ex.message}`;
    $("sync-error").hidden = false;
  } finally {
    busyButton(btn, false);
  }
});

$("btn-sync-remove").addEventListener("click", async () => {
  if (!(await ask("Déconnecter GitHub ?", "Le jeton est effacé de ce téléphone. Ton coffre reste sur le téléphone et sur GitHub.", "Déconnecter"))) return;
  store.removeSync();
  store.updateMeta({ syncedSha: null });
  token = pendingToken = null;
  updateSyncIndicator();
  openSettings();
  toast("GitHub déconnecté");
});

// ---- fichier vault.json
async function importFile(input) {
  const file = input.files[0];
  input.value = "";
  if (!file) return;
  try {
    const imported = validateVault(JSON.parse(await file.text()));
    if (vault && !(await ask("Remplacer le coffre ?", "Le coffre de ce téléphone sera remplacé par ce fichier.", "Remplacer"))) return;
    store.setVault(imported);
    // si GitHub est connecté, le fichier sera fusionné avec GitHub au prochain déverrouillage
    store.setMeta({ syncedSha: null, dirty: !!store.getSync(), syncedAt: null });
    vault = imported;
    if (token) pendingToken = token;
    lock();
    showLocked(`« ${file.name} » importé : déverrouille-le avec son mot de passe maître.`);
    updateSyncIndicator();
  } catch (ex) {
    toast(ex instanceof SyntaxError ? "Ce fichier n'est pas un JSON valide" : ex.message, "error");
  }
}
$("setup-file").addEventListener("change", (e) => importFile(e.target));
$("settings-file").addEventListener("change", (e) => importFile(e.target));

$("btn-export").addEventListener("click", () => {
  if (!vault) return toast("Aucun coffre à exporter", "error");
  const blob = new Blob([JSON.stringify(vault, null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "vault.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  toast("Coffre exporté (chiffré)");
});

$("btn-wipe").addEventListener("click", async () => {
  const meta = store.getMeta();
  const warning = meta.dirty ? " ATTENTION : des modifications n'ont pas encore été envoyées sur GitHub et seront perdues." : "";
  if (!(await ask("Effacer SecPass de ce téléphone ?", `Le coffre, le jeton GitHub et les réglages seront effacés de ce téléphone.${warning}`, "Effacer"))) return;
  store.wipe();
  location.reload();
});

// ------------------------------------------------------------------ hors ligne / installation

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
navigator.storage?.persist?.().catch(() => {});

boot();
