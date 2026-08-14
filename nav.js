(() => {
  'use strict';
  // Persistente Navigation: baut oben einen Balken mit Links zu allen Seiten der
  // Review-PWA. Rolle wird über /api/auth/me bestimmt; Upload-/Admin-/Push-Links
  // erscheinen nur für Personen mit canUpload (Philipp). Enthält zugleich den
  // ?dataset=-Schalter (Aufgabe 1): Wahl wird pro Gerät gemerkt und beim Wechsel
  // neu geladen, ganz ohne Redeploy.

  const DATASETS = [
    { value: '', label: 'Aktiv (Server-Standard)' },
    { value: 'philena-4y', label: 'philena-4y (4 Jahre)' },
    { value: 'philena-2026-pilot-v4-unseen', label: 'philena-2026 (Pilot, eingefroren)' },
  ];

  // Alle für Prüfer sinnvollen Seiten/Routen. `admin` = nur mit canUpload.
  const LINKS = [
    { href: '/review.html', label: 'Prüfstand' },
    { href: '/doppelpruefung.html', label: 'Doppelprüfung' },
    { href: '/situation-info.html', label: 'Situationen' },
    { href: '/situation-quiz.html', label: 'Quiz' },
    { href: '/upload.html', label: 'Upload', admin: true },
    { href: '/admin.html', label: 'Admin', admin: true },
    { href: '/analysis-import.html', label: 'Analyse', admin: true },
    { href: '/push-settings.html', label: 'Benachrichtigungen', admin: true },
  ];

  function currentDataset() {
    try { return localStorage.getItem('tw_dataset') || ''; } catch (_) { return ''; }
  }

  function setDataset(value) {
    try {
      if (value) localStorage.setItem('tw_dataset', value);
      else localStorage.removeItem('tw_dataset');
    } catch (_) { /* egal */ }
  }

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
    LINKS.forEach((item) => {
      if (item.admin && !canUpload) return;
      const a = document.createElement('a');
      a.href = item.href;
      a.textContent = item.label;
      if (here === item.href || location.pathname === item.href) a.classList.add('active');
      links.appendChild(a);
    });
    nav.appendChild(links);

    const right = document.createElement('div');
    right.className = 'tw-nav-right';

    const ds = document.createElement('select');
    ds.className = 'tw-nav-ds';
    ds.setAttribute('aria-label', 'Datensatz wählen');
    const active = currentDataset();
    DATASETS.forEach((entry) => {
      const option = document.createElement('option');
      option.value = entry.value;
      option.textContent = entry.label;
      if (entry.value === active) option.selected = true;
      ds.appendChild(option);
    });
    ds.addEventListener('change', () => {
      setDataset(ds.value);
      // Query-Param mitschreiben, damit auch serverseitig geroutete Seiten den
      // gewählten Datensatz sofort sehen; ansonsten reicht der localStorage-Wert.
      const url = new URL(location.href);
      if (ds.value) url.searchParams.set('dataset', ds.value);
      else url.searchParams.delete('dataset');
      location.href = url.toString();
    });
    right.appendChild(ds);

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
