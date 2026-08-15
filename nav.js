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
    { href: '/review.html', label: 'Prüfstand' },
    { href: '/doppelpruefung.html', label: 'Doppelprüfung', match: '/doppelpruefung.html' },
    { href: '/upload.html', label: 'Upload', admin: true },
    { href: '/push-settings.html', label: 'Settings', admin: true },
  ];

  function build(user) {
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
    const search = location.search || '';
    LINKS.forEach((item) => {
      if (item.admin && !canUpload) return;
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.label;
      const pathMatch = (item.match || item.href) === here || (item.match || item.href) === location.pathname;
      if (item.href.includes('?tab=overview')) {
        if (pathMatch && search.includes('tab=overview')) a.classList.add('active');
      } else if (item.label === 'Doppelprüfung') {
        if (pathMatch && !search.includes('tab=overview')) a.classList.add('active');
      } else {
        if (pathMatch) a.classList.add('active');
      }
      links.appendChild(a);
    });
    nav.appendChild(links);

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
    build(user);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
