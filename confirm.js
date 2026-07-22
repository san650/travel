// Diálogo de confirmación compartido (#dlg-confirm). Vive en su propio
// módulo para que app.js y share.js lo usen sin dependencia circular.

let els = null;
let resolver = null;

const settle = (value) => {
  if (resolver) { resolver(value); resolver = null; }
  if (els.dlg.open) els.dlg.close();
};

const ensure = () => {
  if (els) return;
  els = {
    dlg: document.getElementById('dlg-confirm'),
    title: document.getElementById('confirm-title'),
    body: document.getElementById('confirm-body'),
    accept: document.querySelector('[data-confirm-accept]'),
    cancel: document.querySelector('[data-confirm-cancel]'),
  };
  els.accept.onclick = () => settle(true);
  els.cancel.onclick = () => settle(false);
  els.dlg.addEventListener('close', () => { if (resolver) settle(false); });
  // onclick (propiedad) y no addEventListener: iOS solo dispara click en
  // elementos no interactivos si tienen la propiedad onclick o cursor:pointer.
  els.dlg.onclick = (ev) => { if (ev.target === els.dlg) settle(false); };
};

export const askConfirm = ({ title, body, acceptLabel = 'Borrar' }) => {
  ensure();
  return new Promise((resolve) => {
    els.title.textContent = title;
    els.body.textContent = body || '';
    els.body.hidden = !body;
    els.accept.textContent = acceptLabel;
    resolver = resolve;
    els.dlg.showModal();
  });
};
