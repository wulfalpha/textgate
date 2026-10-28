// Only the app's own dialogs count as modal: document content in the preview
// must never be able to block menus and shortcuts.
export const appDialogOpen = (document) => Boolean(document.querySelector('body > dialog[open]'));

// Both the browser fallback and native menu invoke the same application actions.
export async function setupMenus({ document, desktop, native, onError }) {
  const bar = document.getElementById('menubar');
  const groups = [...bar.querySelectorAll('details')];
  const close = () => groups.forEach((group) => { group.open = false; });
  for (const group of groups) {
    group.addEventListener('toggle', () => {
      if (group.open) groups.filter((other) => other !== group).forEach((other) => { other.open = false; });
    });
  }
  bar.addEventListener('click', (event) => { if (event.target.closest('button')) close(); });
  document.addEventListener('pointerdown', (event) => { if (!bar.contains(event.target)) close(); });
  bar.addEventListener('keydown', (event) => {
    const group = event.target.closest('details');
    if (!group) return;
    const summary = group.querySelector('summary');
    const buttons = [...group.querySelectorAll('button:not(:disabled)')];
    if (event.key === 'Escape') { close(); summary.focus(); }
    else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const next = groups[(groups.indexOf(group) + (event.key === 'ArrowRight' ? 1 : groups.length - 1)) % groups.length];
      close(); next.open = true; next.querySelector('summary').focus();
    } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      group.open = true;
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
    } else return;
    event.preventDefault();
  });
  if (!desktop) return null;
  const { Menu, MenuItem, CheckMenuItem, Submenu } = native ?? await import('@tauri-apps/api/menu');
  const bindings = [];
  const handles = [];
  const mac = /Mac/.test(document.defaultView.navigator.platform);
  const appItems = [];
  let menu;
  try {
    const submenus = [];
    for (const group of groups) {
      const items = [];
      for (const element of group.querySelector('.menu-popup').children) {
        if (element.tagName === 'HR') { items.push({ item: 'Separator' }); continue; }
        const checked = element.hasAttribute('aria-pressed');
        const item = await (checked ? CheckMenuItem : MenuItem).new({
          id: element.id, text: element.textContent,
          enabled: !element.disabled, ...(checked ? { checked: element.getAttribute('aria-pressed') === 'true' } : {}),
          accelerator: element.dataset.shortcut,
          action: () => {
            if (!appDialogOpen(document)) element.click();
          },
        });
        handles.push(item);
        bindings.push({ element, item, checked });
        if (mac && ['about', 'quit'].includes(element.id)) appItems.push(item);
        else items.push(item);
      }
      if (group.querySelector('summary').textContent === 'Edit') {
        items.splice(2, 0, { item: 'Separator' }, { item: 'Cut' }, { item: 'Copy' }, { item: 'Paste' }, { item: 'SelectAll' });
      }
      const submenu = await Submenu.new({ text: group.querySelector('summary').textContent, items });
      handles.push(submenu);
      submenus.push(submenu);
    }
    if (mac) {
      const appMenu = await Submenu.new({ text: 'Textgate', items: [
        ...appItems.filter((item) => item.id === 'about'), { item: 'Separator' },
        { item: 'Services' }, { item: 'Hide' }, { item: 'HideOthers' }, { item: 'ShowAll' },
        { item: 'Separator' }, ...appItems.filter((item) => item.id === 'quit'),
      ] });
      handles.push(appMenu);
      submenus.unshift(appMenu);
    }
    menu = await Menu.new({ items: submenus });
    const previous = await menu.setAsAppMenu();
    await previous?.close();
    bar.hidden = true;
  } catch (error) {
    await Promise.allSettled(handles.map((item) => item.close()));
    await menu?.close();
    throw error;
  }
  let pending = Promise.resolve();
  const observer = new document.defaultView.MutationObserver(() => {
    pending = pending.then(async () => {
      const modal = appDialogOpen(document);
      for (const { element, item, checked } of bindings) {
        await item.setEnabled(!element.disabled && !modal);
        if (checked) await item.setChecked(element.getAttribute('aria-pressed') === 'true');
      }
    }).catch(onError);
  });
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['aria-pressed', 'disabled', 'open'] });
  return { menu, dispose: async () => {
    observer.disconnect();
    await pending;
    await Promise.allSettled(handles.map((item) => item.close()));
    await menu.close();
  } };
}
