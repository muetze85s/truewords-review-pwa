(() => {
  'use strict';

  const MOBILE_BREAKPOINT = 840;
  const app = document.getElementById('review-app');
  let scheduled = 0;
  let lastActiveId = '';
  let mobileExpanded = false;
  let resizeObserver = null;

  /* Capture the single Embla instance created by V30 so V31 can reliably
     re-center it after active-situation changes and split-view resizes. */
  if (typeof window.EmblaCarousel === 'function' && !window.__twV31EmblaWrapped) {
    const factory = window.EmblaCarousel;
    const wrapped = function (...args) {
      const instance = factory(...args);
      window.__twReviewEmbla = instance;
      return instance;
    };
    Object.assign(wrapped, factory);
    window.EmblaCarousel = wrapped;
    window.__twV31EmblaWrapped = true;
  }

  function activeCard() {
    return document.querySelector('[data-situation-list] [data-situation-card].is-active');
  }

  function activeId() {
    return String(activeCard()?.dataset.situationCard || '');
  }

  function removeListSpacers(list) {
    list?.querySelectorAll(':scope > .tw-v31-list-spacer').forEach((node) => node.remove());
  }

  function centerVerticalList(list, behavior = 'smooth') {
    if (!list || list.clientHeight <= 0) return;
    removeListSpacers(list);
    const card = list.querySelector(`[data-situation-card="${CSS.escape(activeId())}"]`);
    if (!card) return;

    const spacerHeight = Math.max(0, (list.clientHeight - card.offsetHeight) / 2 - 12);
    const before = document.createElement('div');
    const after = document.createElement('div');
    before.className = 'tw-v31-list-spacer';
    after.className = 'tw-v31-list-spacer';
    before.style.height = `${spacerHeight}px`;
    after.style.height = `${spacerHeight}px`;
    list.prepend(before);
    list.append(after);

    const target = card.offsetTop + card.offsetHeight / 2 - list.clientHeight / 2;
    const max = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTo({ top: Math.max(0, Math.min(max, target)), behavior });
  }

  function centerLists(behavior = 'smooth') {
    centerVerticalList(document.querySelector('[data-situation-list]'), behavior);
    const drawer = document.querySelector('[data-drawer]');
    if (drawer?.open || drawer?.classList.contains('is-open')) {
      centerVerticalList(document.querySelector('[data-drawer-list]'), behavior);
    }
  }

  function centerSlider(jump = false) {
    if (window.innerWidth > MOBILE_BREAKPOINT) return;
    const embla = window.__twReviewEmbla;
    if (!embla) return;
    const items = [...document.querySelectorAll('[data-slider-situation]')];
    const index = items.findIndex((node) => String(node.dataset.sliderSituation) === activeId());
    if (index < 0) return;
    try {
      embla.reInit?.();
      requestAnimationFrame(() => embla.scrollTo?.(index, jump));
    } catch (_) {
      /* V30 keeps the slider functional even if a browser rejects reInit. */
    }
  }

  function textOf(root, selector) {
    return root?.querySelector(selector)?.textContent?.trim() || '';
  }

  function analysisDetails(source) {
    return [...(source?.querySelectorAll('.tw-detail') || [])].map((row) => ({
      label: textOf(row, 'dt'),
      value: textOf(row, 'dd'),
    })).filter((item) => item.label || item.value);
  }

  function renderMobileActive() {
    const shell = document.querySelector('[data-app-shell]');
    const slider = document.querySelector('[data-situation-slider]');
    const source = activeCard();
    if (!shell || !slider || !source) return;

    let panel = shell.querySelector('[data-v31-mobile-active]');
    if (!panel) {
      panel = document.createElement('section');
      panel.className = 'tw-v31-mobile-active';
      panel.dataset.v31MobileActive = '';
      slider.before(panel);
      panel.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-v31-active-toggle]');
        if (!toggle) return;
        mobileExpanded = !mobileExpanded;
        panel.classList.toggle('is-expanded', mobileExpanded);
        toggle.setAttribute('aria-expanded', String(mobileExpanded));
        schedule(false);
      });
    }

    const id = String(source.dataset.situationCard || '');
    if (panel.dataset.situationId !== id) {
      mobileExpanded = false;
      panel.classList.remove('is-expanded');
    }
    panel.dataset.situationId = id;
    panel.dataset.status = source.dataset.status || 'open';

    const number = textOf(source, '.tw-sit-number');
    const status = textOf(source, '.tw-sit-status');
    const count = textOf(source, '.tw-sit-count');
    const owner = textOf(source, '.tw-sit-sub strong');
    const date = source.querySelector('.tw-sit-sub span')?.textContent?.trim() || '';
    const details = analysisDetails(source);
    const preview = details.slice(0, 2).map((item) => item.value).filter(Boolean).join(' · ')
      || `${owner}${date ? ` · ${date}` : ''}`;

    panel.replaceChildren();
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'tw-v31-active-toggle';
    toggle.dataset.v31ActiveToggle = '';
    toggle.setAttribute('aria-expanded', String(mobileExpanded));
    toggle.setAttribute('aria-label', `Analyse von Situation ${number || id} ${mobileExpanded ? 'einklappen' : 'anzeigen'}`);

    const numberNode = document.createElement('span');
    numberNode.className = 'tw-v31-active-number';
    numberNode.textContent = number || id;
    const copy = document.createElement('span');
    copy.className = 'tw-v31-active-copy';
    const title = document.createElement('strong');
    title.textContent = `${status}${count ? ` · ${count}` : ''}`;
    const sub = document.createElement('span');
    sub.textContent = preview;
    copy.append(title, sub);
    const chevron = document.createElement('span');
    chevron.className = 'tw-v31-active-chevron';
    chevron.textContent = '⌄';
    toggle.append(numberNode, copy, chevron);

    const detailWrap = document.createElement('dl');
    detailWrap.className = 'tw-v31-active-details';
    if (details.length) {
      details.forEach((detail) => {
        const row = document.createElement('div');
        row.className = 'tw-v31-active-detail';
        const dt = document.createElement('dt');
        const dd = document.createElement('dd');
        dt.textContent = detail.label;
        dd.textContent = detail.value;
        row.append(dt, dd);
        detailWrap.append(row);
      });
    } else {
      const empty = document.createElement('div');
      empty.className = 'tw-v31-active-empty';
      empty.textContent = 'Noch keine Analysefelder.';
      detailWrap.append(empty);
    }
    panel.append(toggle, detailWrap);
    panel.classList.toggle('is-expanded', mobileExpanded);
  }

  function bindDrawerFollow() {
    const opener = document.querySelector('[data-open-drawer]');
    if (opener && !opener.dataset.v31Bound) {
      opener.dataset.v31Bound = '1';
      opener.addEventListener('click', () => {
        requestAnimationFrame(() => requestAnimationFrame(() => centerVerticalList(document.querySelector('[data-drawer-list]'), 'auto')));
      });
    }
  }

  function observeSizes() {
    resizeObserver?.disconnect?.();
    if (!('ResizeObserver' in window)) return;
    resizeObserver = new ResizeObserver(() => schedule(false));
    const list = document.querySelector('[data-situation-list]');
    const drawerList = document.querySelector('[data-drawer-list]');
    const card = activeCard();
    if (list) resizeObserver.observe(list);
    if (drawerList) resizeObserver.observe(drawerList);
    if (card) resizeObserver.observe(card);
  }

  function stabilize({ initial = false } = {}) {
    if (!document.querySelector('[data-app-shell]')) return;
    const nextId = activeId();
    const changed = nextId && nextId !== lastActiveId;
    if (changed) {
      lastActiveId = nextId;
      mobileExpanded = false;
    }
    renderMobileActive();
    bindDrawerFollow();
    centerLists(initial ? 'auto' : 'smooth');
    centerSlider(initial);
    observeSizes();
  }

  function schedule(initial = false) {
    if (scheduled) cancelAnimationFrame(scheduled);
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      stabilize({ initial });
    });
  }

  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((mutation) => {
      if (mutation.type === 'childList') return true;
      if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
        return mutation.target.matches?.('[data-situation-card],[data-slider-situation],[data-drawer]');
      }
      return false;
    });
    if (relevant) schedule(false);
  });

  observer.observe(app, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', () => schedule(false), { passive: true });
  window.visualViewport?.addEventListener('resize', () => schedule(false), { passive: true });
  schedule(true);
})();
