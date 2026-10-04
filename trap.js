// Anti-bot honeypot: adds an invisible field to every form. People never see or fill it; bots do.
// If it contains anything, every request carries a flag and the server blocks that visitor.
(function () {
  const style = document.createElement('style');
  style.textContent = '.hp-wrap{position:absolute!important;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden}';
  document.head.append(style);
  function addTrap(form) {
    if (form.querySelector('.hp-wrap')) return;
    const wrap = document.createElement('div'); wrap.className = 'hp-wrap'; wrap.setAttribute('aria-hidden', 'true');
    const label = document.createElement('label'); label.textContent = 'Leave this field empty';
    const input = document.createElement('input');
    input.type = 'text'; input.name = 'website_hp'; input.className = 'hp-trap'; input.tabIndex = -1; input.autocomplete = 'off';
    label.append(input); wrap.append(label); form.append(wrap);
  }
  const scan = root => root.querySelectorAll && root.querySelectorAll('form').forEach(addTrap);
  document.addEventListener('DOMContentLoaded', () => {
    scan(document);
    new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return; if (node.tagName === 'FORM') addTrap(node); scan(node);
    }))).observe(document.body, { childList: true, subtree: true });
  });
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const filled = [...document.querySelectorAll('.hp-trap')].find(el => el.value.trim());
    if (filled) {
      const base = init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers || {});
      init = { ...init, headers: { ...base, 'X-Workwise-Trap': filled.value.slice(0, 80) } };
    }
    return realFetch(input, init);
  };
})();
