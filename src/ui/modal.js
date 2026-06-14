export function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
}

export function initModal() {
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  Object.assign(window, { closeModal });
}
