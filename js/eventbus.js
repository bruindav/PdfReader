// fix-1
// Eenvoudige eventbus tussen modules (document-loaded, zoom-changed, page-rendered, ...).
// Maakt latere uitbreidingen (bijv. annotaties) mogelijk zonder de viewer te wijzigen.
const target = new EventTarget();

export const bus = {
  on(type, fn) {
    const h = (e) => fn(e.detail);
    target.addEventListener(type, h);
    return () => target.removeEventListener(type, h);
  },
  emit(type, detail) {
    target.dispatchEvent(new CustomEvent(type, { detail }));
  },
};
