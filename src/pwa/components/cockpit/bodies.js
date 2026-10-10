export function mountBody(el) {
  el.textContent = '';
  return { update() {}, unmount() { el.textContent = ''; } };
}
