// Cross-cutting interaction helpers.
//
// Keep timing policy here rather than scattered across event handlers.

let clickLockUntil = 0;
let reloadTimer = 0;

export const interactionLock = {
  lockClicksFor(ms) {
    clickLockUntil = Math.max(clickLockUntil, Date.now() + ms);
  },
  clicksLocked() {
    return Date.now() < clickLockUntil;
  },
  clear() {
    clickLockUntil = 0;
  },
};

// Reload the page after a server mutation. Centralised so the delay can be
// tuned in one place. Some flows want a longer delay so warning toasts can be
// read; pass { delay: 1600 } for that case.
export function reloadAfterMutation({ delay = 220 } = {}) {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => window.location.reload(), delay);
}
