(() => {
  'use strict';
  // Persistente Navigation: baut oben einen Balken mit Links zu allen Seiten der
  // Review-PWA. Rolle wird über /api/auth/me bestimmt; Upload-/Admin-/Push-Links
  // erscheinen nur für Personen mit canUpload (Philipp). Der ?dataset=-Schalter
  // lebt ausschließlich auf der Settings-Seite (Abschnitt „Datenbank") — hier im
  // Balken erscheint er nirgendwo, um Konsistenz über alle Seiten zu wahren.

  // Nur die tatsächlich funktionierenden Seiten. Dashboard steht vorn (zentrale
  // Startseite). `admin` = nur mit canUpload. Quiz/Situationen wurden entfernt;
  // Admin/Analyse waren reine Weiterleitungen auf Upload und sind zu „Upload"
  // zusammengeführt.
  const LINKS = [
    { href: '/doppelpruefung.html?tab=overview', label: 'Übersicht', match: '/doppelpruefung.html' },
    { href: '/doppelpruefung.html', label: 'Doppelprüfung', match: '/doppelpruefung.html' },
    // Klassifizierung: Philipp immer, Lena nur bei Freischaltung (classification-Flag).
    { href: '/klassifizierung.html', label: 'Klassifizierung', match: '/klassifizierung.html', classification: true },
    { href: '/upload.html', label: 'Upload', admin: true },
    { href: '/push-settings.html', label: 'Settings', admin: true },
  ];

  // Aufgabe 20: die Doppelprüfung wechselt intern per JS zwischen Runde und
  // Übersicht, ohne die Seite neu zu laden — der Balken wird aber nur einmal
  // gebaut. `window.TW_NAV.setActive(search)` lässt boundary-pairs.js die
  // aktive Markierung bei jedem Tab-Wechsel nachziehen, ohne den Balken neu
  // aufzubauen.
  function computeActive(item, here, search) {
    const pathMatch = (item.match || item.href) === here || (item.match || item.href) === location.pathname;
    if (item.href.includes('?tab=overview')) return pathMatch && search.includes('tab=overview');
    if (item.label === 'Doppelprüfung') return pathMatch && !search.includes('tab=overview');
    return pathMatch;
  }

  function build(user, classificationEnabled) {
    const canUpload = Boolean(user && user.canUpload);
    const here = location.pathname.replace(/\/index\.html$/, '/');

    const nav = document.createElement('nav');
    nav.className = 'tw-nav';
    nav.setAttribute('aria-label', 'Hauptnavigation');

    const brand = document.createElement('span');
    brand.className = 'tw-nav-brand';
    brand.textContent = 'TrueWords';
    nav.appendChild(brand);

    const links = document.createElement('div');
    links.className = 'tw-nav-links';
    const entries = [];
    LINKS.forEach((item) => {
      if (item.admin && !canUpload) return;
      // Klassifizierung: Philipp (canUpload) immer, Lena nur bei Freischaltung.
      if (item.classification && !canUpload && !classificationEnabled) return;
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.label;
      if (computeActive(item, here, location.search || '')) a.classList.add('active');
      entries.push({ a, item });
      links.appendChild(a);
    });
    nav.appendChild(links);

    window.TW_NAV = {
      setActive(search) {
        entries.forEach(({ a, item }) => {
          a.classList.toggle('active', computeActive(item, here, search || ''));
        });
      },
    };

    const right = document.createElement('div');
    right.className = 'tw-nav-right';

    if (user) {
      const logout = document.createElement('button');
      logout.type = 'button';
      logout.className = 'tw-nav-logout';
      logout.textContent = 'Abmelden';
      logout.addEventListener('click', () => {
        fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
          .catch(() => {})
          .then(() => { location.href = '/login.html'; });
      });
      right.appendChild(logout);
    }

    nav.appendChild(right);
    document.body.insertBefore(nav, document.body.firstChild);
  }

  async function init() {
    let user = null;
    try {
      const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      if (response.ok) {
        const data = await response.json();
        if (data && data.ok) user = data.user;
      }
    } catch (_) { /* nicht angemeldet → schlanker Balken ohne Abmelden */ }

    // Freischaltung der Klassifizierung für Lena — bestimmt, ob der Menüpunkt
    // bei ihr erscheint. Fehler/nicht angemeldet → aus.
    let classificationEnabled = false;
    if (user) {
      try {
        const access = await fetch('/api/classification/access', { credentials: 'same-origin', cache: 'no-store' });
        if (access.ok) {
          const data = await access.json();
          if (data && data.ok) classificationEnabled = Boolean(data.enabled);
        }
      } catch (_) { /* aus */ }
    }
    build(user, classificationEnabled);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
