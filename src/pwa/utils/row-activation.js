// Keyboard activation for `.o-row` primitives rendered as non-`<button>`
// elements (div-based rows with role="button" tabindex="0"). Delegated on
// the row's container so it survives innerHTML re-renders without rebinding.
// Enter/Space re-fires as a real `.click()`, so a single existing click
// listener (delegated or per-row) handles both mouse and keyboard the same way.
export function bindRowActivation(containerEl, selector = '[role="button"][tabindex]') {
  containerEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const rowEl = e.target.closest(selector);
    if (!rowEl || !containerEl.contains(rowEl)) return;
    e.preventDefault();
    rowEl.click();
  });
}
