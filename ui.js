// SecPass — petits utilitaires d'interface partagés (popup + paramètres).

import { estimateStrength } from "./crypto.js";

// Icônes (traits 24×24). Contenu statique uniquement : jamais de donnée utilisateur ici.
export const ICONS = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  key: '<path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4"/><path d="m21 2-9.6 9.6"/><circle cx="7.5" cy="15.5" r="5.5"/>',
  login: '<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="m10 17 5-5-5-5"/><path d="M15 12H3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
};

export function icon(name) {
  const t = document.createElement("template");
  t.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  return t.content.firstElementChild;
}

// Barre de force : <div class="strength"><div class="strength-bar"><i></i>×4</div><span class="strength-label"></span></div>
export function renderStrength(el, password) {
  const s = estimateStrength(password);
  el.hidden = !password;
  el.dataset.level = String(s.level);
  el.querySelector(".strength-label").textContent = password ? `${s.label} · ${s.bits} bits` : "";
}

// Boutons « œil » : <button data-toggle="id-du-champ">
export function bindPasswordToggles(root = document) {
  for (const b of root.querySelectorAll("[data-toggle]")) {
    b.addEventListener("click", () => {
      const input = document.getElementById(b.dataset.toggle);
      setRevealed(input, b, input.type === "password");
    });
  }
}

export function setRevealed(input, button, revealed) {
  input.type = revealed ? "text" : "password";
  button.classList.toggle("on", revealed);
  button.title = revealed ? "Masquer" : "Afficher";
}
