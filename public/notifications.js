'use strict';
/* Olutech PMS in-app notification centre. No third-party service or permissions required.
   The server remains the source of truth; notifications are scoped by logged-in user ID. */
(function () {
  const trigger = document.getElementById('notificationTrigger');
  const panel = document.getElementById('notificationPanel');
  const badge = document.getElementById('notificationBadge');
  const items = document.getElementById('notificationItems');
  const markAll = document.getElementById('notificationReadAll');
  if (!trigger || !panel || !badge || !items) return;
  const toastRoot = document.createElement('div');
  toastRoot.className = 'notification-toasts';
  toastRoot.setAttribute('aria-live', 'polite');
  toastRoot.setAttribute('aria-atomic', 'false');
  document.body.appendChild(toastRoot);
  const seen = new Set();
  const sessionKey = 'olutech-task-notifications-shown';
  try { JSON.parse(sessionStorage.getItem(sessionKey) || '[]').forEach(x => seen.add(x)); } catch (_) {}
  const persistSeen = () => { try { sessionStorage.setItem(sessionKey, JSON.stringify([...seen].slice(-400))); } catch (_) {} };
  let busy = false, firstLoad = true;

  function textNode(tag, value, klass) {
    const el = document.createElement(tag);
    if (klass) el.className = klass;
    el.textContent = String(value || '');
    return el;
  }
  async function markRead(ids, all) {
    const body = new URLSearchParams(all ? {all:'yes'} : {id:ids});
    const r = await fetch('/notifications/read', {method:'POST', body, credentials:'same-origin',headers:{'Content-Type':'application/x-www-form-urlencoded'}});
    if (r.ok) await refresh();
  }
  function linkFor(n) {
    const value = String(n.link || '/tasks');
    // Never follow a server or stored external URL from a notification.
    return value.startsWith('/tasks') && !value.startsWith('//') ? value : '/tasks';
  }
  function displayDate(timestamp) {
    const d = new Date(timestamp);
    return Number.isFinite(d.getTime()) ? d.toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}) : '';
  }
  function dismissToast(toast) { if (toast && toast.parentNode) toast.remove(); }
  function showToast(n) {
    const toast = document.createElement('section');
    toast.className = 'notification-toast';
    toast.appendChild(textNode('strong', n.title, 'notification-toast-title'));
    toast.appendChild(textNode('p', n.message, 'notification-toast-message'));
    const row = document.createElement('div');
    row.className = 'notification-toast-actions';
    const open = textNode('a', 'Open task', 'notification-toast-open');
    open.href = linkFor(n);
    open.addEventListener('click', () => markRead(n.id, false).catch(() => {}));
    const close = textNode('button', 'Dismiss', 'notification-toast-dismiss');
    close.type = 'button';
    close.addEventListener('click', () => { dismissToast(toast); markRead(n.id, false).catch(() => {}); });
    row.append(open, close);
    toast.append(row);
    toastRoot.prepend(toast);
    while (toastRoot.children.length > 3) toastRoot.lastChild.remove();
    // Toast stays visible until dismissal: useful to staff who are away from a tab.
  }
  function draw(feed) {
    const notices = Array.isArray(feed.notifications) ? feed.notifications : [];
    const count = Number(feed.unread || 0);
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
    trigger.setAttribute('aria-label', count ? count + ' unread notifications' : 'Notifications');
    items.replaceChildren();
    if (!notices.length) {
      items.appendChild(textNode('p', 'No notifications yet.', 'notification-empty'));
    }
    for (const n of notices) {
      const card = document.createElement('div');
      card.className = 'notification-item' + (n.readAt ? '' : ' unread');
      const a = textNode('a', n.title, 'notification-item-title');
      a.href = linkFor(n);
      a.addEventListener('click', () => { if (!n.readAt) markRead(n.id, false).catch(() => {}); });
      card.appendChild(a);
      card.appendChild(textNode('p', n.message, 'notification-item-body'));
      const meta = document.createElement('div'); meta.className = 'notification-item-meta';
      meta.appendChild(textNode('small', displayDate(n.createdAt)));
      if (!n.readAt) {
        const read = textNode('button', 'Mark read', 'notification-item-read');
        read.type = 'button';
        read.addEventListener('click', () => markRead(n.id, false).catch(() => {}));
        meta.appendChild(read);
      }
      card.appendChild(meta);
      items.appendChild(card);
    }
    const pending = notices.filter(n => !n.readAt && !seen.has(n.id));
    // First load also shows missed unread alerts (from when the app was closed).
    pending.slice(-3).reverse().forEach(n => { seen.add(n.id); showToast(n); });
    if (pending.length) persistSeen();
    firstLoad = false;
  }
  async function refresh() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const r = await fetch('/notifications', {credentials:'same-origin',cache:'no-store'});
      if (r.status === 401 || r.redirected) return;
      if (!r.ok) return;
      draw(await r.json());
    } catch (_) { /* Offline: retain current notifications until next poll. */ }
    finally { busy = false; }
  }
  trigger.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    trigger.setAttribute('aria-expanded', String(!panel.hidden));
    if (!panel.hidden) refresh();
  });
  markAll.addEventListener('click', () => markRead('', true).catch(() => {}));
  document.addEventListener('click', e => {
    if (!panel.hidden && !document.getElementById('notificationCenter').contains(e.target)) {
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !panel.hidden) {
      panel.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('focus', refresh);
  refresh();
  setInterval(refresh, 20000);
})();
