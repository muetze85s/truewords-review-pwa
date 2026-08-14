(() => {
  'use strict';

  const app = document.getElementById('app');
  if (!app) return;

  // Basis-URL der Schwester-Werkzeuge (Prüfen/Auswertung liegen in einem
  // eigenen Pages-Projekt). Auf github.io wird sie aus dem Host abgeleitet,
  // lokal relativ aufgelöst. Sollte das Pages-Projekt anders heißen, hier anpassen.
  const TOOLS_BASE = location.hostname.endsWith('github.io')
    ? `${location.origin}/truewords-tools/`
    : '../truewords-tools/';

  // Reihenfolge der Navigation. In-App-Routen schalten die vorhandenen
  // Prüf-Ansichten (data-tw-view greift der Bestehende Klick-Handler ab),
  // externe Werkzeuge öffnen in einem neuen Tab.
  const ROUTES = [
    { kind: 'view', view: 'chat', label: 'Chat' },
    { kind: 'view', view: 'situations', label: 'Situationen' },
    { kind: 'view', view: 'review', label: 'Bestätigen' },
    { kind: 'link', href: `${TOOLS_BASE}pruefen.html`, label: 'Prüfen' },
    { kind: 'link', href: `${TOOLS_BASE}auswertung.html`, label: 'Auswertung' },
  ];

  function buildNav() {
    const nav = document.createElement('nav');
    nav.className = 'tw-nav';
    nav.setAttribute('aria-label', 'Hauptnavigation');

    const home = document.createElement('a');
    home.className = 'tw-nav-home';
    home.href = './';
    home.textContent = 'TrueWords Review';
    nav.appendChild(home);

    const links = document.createElement('div');
    links.className = 'tw-nav-links';

    ROUTES.forEach(route => {
      if (route.kind === 'view') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'tw-nav-link';
        button.dataset.twView = route.view;
        button.textContent = route.label;
        links.appendChild(button);
      } else {
        const link = document.createElement('a');
        link.className = 'tw-nav-link tw-nav-external';
        link.href = route.href;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = route.label;
        links.appendChild(link);
      }
    });

    nav.appendChild(links);
    return nav;
  }

  function ensureNav() {
    const header = app.querySelector('header');
    if (!header) return;
    if (app.querySelector('.tw-nav')) return;
    header.after(buildNav());
  }

  // Der Kern rendert #app bei jeder Änderung neu; die Navigation wird danach
  // erneut eingesetzt. Ein Guard verhindert Endlosschleifen des Observers.
  new MutationObserver(() => ensureNav()).observe(app, {
    childList: true,
    subtree: true,
  });

  ensureNav();
})();
