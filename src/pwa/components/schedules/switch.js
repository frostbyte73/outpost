// Accessible on/off switch (role="switch") — not a native checkbox, matching
// the mockup's pill-toggle look. Shared by the list card's enable toggle and
// the routing card's github-approval / channel-enable toggles. Tracks its own
// state so repeated clicks toggle correctly even when the caller never
// repaints (routing-card edit mode); `.set(value)` lets callers reconcile
// after a failed network update.
export function createSwitch(checked, onToggle, ariaLabel) {
  let state = !!checked;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'sched-switch';
  btn.setAttribute('role', 'switch');
  if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
  const apply = () => {
    btn.setAttribute('aria-checked', String(state));
    btn.classList.toggle('is-on', state);
  };
  apply();
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    state = !state;
    apply();
    onToggle(state);
  });
  btn.set = (value) => { state = !!value; apply(); };
  return btn;
}
