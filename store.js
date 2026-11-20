// SecPass mobile — stockage local du téléphone (localStorage).
// Le coffre y est stocké CHIFFRÉ (même JSON que vault.json). La clé déverrouillée n'est jamais
// écrite : elle ne vit qu'en mémoire tant que l'appli est ouverte et déverrouillée.

const KEYS = {
  vault: "secpass.vault",   // coffre chiffré
  meta: "secpass.meta",     // { syncedSha, dirty, syncedAt } : état de la synchro
  sync: "secpass.sync",     // { owner, repo, branch, path, token } (jeton chiffré avec la clé du coffre)
  prefs: "secpass.prefs",   // préférences du générateur
};

function read(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export const getVault = () => read(KEYS.vault);
export const setVault = (vault) => write(KEYS.vault, vault);

export const getMeta = () => ({ syncedSha: null, dirty: false, syncedAt: null, ...read(KEYS.meta) });
export const setMeta = (meta) => write(KEYS.meta, meta);
export const updateMeta = (patch) => setMeta({ ...getMeta(), ...patch });

export const getSync = () => read(KEYS.sync);
export const setSync = (sync) => write(KEYS.sync, sync);
export const removeSync = () => localStorage.removeItem(KEYS.sync);

export const getPrefs = () => ({ length: 20, symbols: true, ...read(KEYS.prefs) });
export const setPrefs = (prefs) => write(KEYS.prefs, prefs);

export function wipe() {
  for (const key of Object.values(KEYS)) localStorage.removeItem(key);
}
