// SecPass mobile — synchronisation avec le dépôt GitHub privé (API « contents »).
// Seul vault.json (déjà chiffré) transite : le mot de passe maître ne quitte jamais le téléphone.

import { b64decode, b64encode } from "./crypto.js";

const API = "https://api.github.com";
const enc = new TextEncoder();
const dec = new TextDecoder();

export class SyncError extends Error {}
export class ConflictError extends SyncError {}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function fileUrl(cfg) {
  const path = cfg.path.split("/").map(encodeURIComponent).join("/");
  return `${API}/repos/${encodeURIComponent(cfg.owner)}/${encodeURIComponent(cfg.repo)}/contents/${path}`;
}

async function request(url, options) {
  let res;
  try {
    res = await fetch(url, { cache: "no-store", ...options });
  } catch {
    throw new SyncError("Pas de connexion à GitHub (hors ligne ?).");
  }
  if (res.status === 401) throw new SyncError("Jeton GitHub refusé : il est invalide ou a expiré.");
  if (res.status === 403) throw new SyncError("Le jeton GitHub n'a pas les droits nécessaires (Contents : lecture et écriture).");
  if (res.status === 404) throw new SyncError("Dépôt ou fichier introuvable : vérifie le propriétaire, le dépôt, la branche et le chemin.");
  if (res.status === 409 || res.status === 422) throw new ConflictError("Le coffre a changé sur GitHub pendant l'envoi.");
  if (!res.ok) throw new SyncError(`GitHub a répondu ${res.status}.`);
  return res.json();
}

// Télécharge vault.json : { vault, sha }
export async function fetchRemote(cfg, token) {
  const data = await request(`${fileUrl(cfg)}?ref=${encodeURIComponent(cfg.branch)}`, { headers: headers(token) });
  if (data.type !== "file" || typeof data.content !== "string") throw new SyncError("Le chemin indiqué n'est pas un fichier.");
  let vault;
  try {
    vault = JSON.parse(dec.decode(b64decode(data.content.replace(/\s/g, ""))));
  } catch {
    throw new SyncError("Le fichier sur GitHub n'est pas un coffre SecPass valide.");
  }
  return { vault, sha: data.sha };
}

// Envoie vault.json (commit dans le dépôt). Renvoie le nouveau sha.
export async function pushRemote(cfg, token, vault, sha) {
  const body = {
    message: "Mise à jour du coffre (SecPass mobile)",
    content: b64encode(enc.encode(JSON.stringify(vault, null, 2) + "\n")),
    branch: cfg.branch,
    ...(sha ? { sha } : {}),
  };
  const data = await request(fileUrl(cfg), {
    method: "PUT",
    headers: { ...headers(token), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return data.content.sha;
}

// Fusion quand le téléphone ET GitHub ont changé : tout compte présent d'un seul côté est gardé,
// et pour un compte modifié des deux côtés, la version la plus récente gagne.
export function mergeEntries(local, remote) {
  const out = { ...remote };
  for (const [name, entry] of Object.entries(local)) {
    const other = remote[name];
    if (!other || (entry.updated || "") >= (other.updated || "")) out[name] = entry;
  }
  return out;
}

// ---- jeton GitHub chiffré avec la clé du coffre (illisible sans le mot de passe maître)
const TOKEN_AAD = enc.encode("secpass-github-token");

async function aes(keyBytes, usage) {
  return crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, [usage]);
}

export async function encryptSecret(keyBytes, text) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: TOKEN_AAD }, await aes(keyBytes, "encrypt"), enc.encode(text));
  return { nonce: b64encode(nonce), ct: b64encode(new Uint8Array(ct)) };
}

export async function decryptSecret(keyBytes, box) {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64decode(box.nonce), additionalData: TOKEN_AAD }, await aes(keyBytes, "decrypt"), b64decode(box.ct));
  return dec.decode(pt);
}
