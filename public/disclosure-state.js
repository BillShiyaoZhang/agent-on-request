// Replacing a view should not close the evidence a person is inspecting.
const saved = new Map();
const idFor = (scope, node) => scope + ':' + node.dataset.disclosureId;
export function rememberDisclosures(root, scope) {
  root?.querySelectorAll('details[data-disclosure-id]').forEach(node => saved.set(idFor(scope, node), node.open));
}
export function restoreDisclosures(root, scope) {
  root?.querySelectorAll('details[data-disclosure-id]').forEach(node => {
    const id = idFor(scope, node);
    if (saved.has(id)) node.open = saved.get(id);
  });
}
export function observeDisclosures(root, getScope) {
  root.addEventListener('toggle', event => {
    const node = event.target;
    if (root.contains(node) && node.matches('details[data-disclosure-id]')) saved.set(idFor(getScope(), node), node.open);
  }, true);
}
