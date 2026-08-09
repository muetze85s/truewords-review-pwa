(() => {
  'use strict';

  const MOBILE_BREAKPOINT = 840;
  const app = document.getElementById('review-app');
  const EMBLA_OPTIONS = {
    align: 'center',
    containScroll: false,
    loop: false,
    dragFree: false,
    skipSnaps: false,
    duration: 20,
  };
  let scheduled = 0;
  let lastActiveId = '';
  let mobileExpanded = false;
  let settleTimers = [];

  function normalizeEmblaViewport(viewport = window.__twReviewEmblaViewport) {
    if (!viewport) return;
    if (viewport.scrollLeft !== 0) viewport.scrollLeft = 0;
    if (viewport.scrollTop !== 0) viewport.scrollTop = 0;
  }

  function installEmblaViewportGuard(viewport) {
    if (!viewport || viewport.dataset.v31ViewportGuard === '1') return;
    viewport.dataset.v31ViewportGuard = '1';
    const normalize = () => normalizeEmblaViewport(viewport);
    viewport.addEventListener('scroll', normalize, { passive: true });
    viewport.addEventListener('focusin', () => requestAnimationFrame(normalize));
    viewport.addEventListener('pointerdown', normalize, { passive: true });
    normalize();
  }

  /*
   * Keep Embla standard. V31 previously wrapped the carousel in a Proxy and
   * inserted artificial edge slides. That made the logical and physical snap
   * indices diverge. The real remaining drift came from the hidden viewport
   * acquiring scrollLeft while Embla simultaneously moves the track by
   * transform. The viewport must therefore stay at scrollLeft=0 at all times.
   */
  if (typeof window.EmblaCarousel === 'function' && !window.__twV31EmblaWrapped) {
    const factory = window.EmblaCarousel;
    const wrapped = function (viewport, options = {}, plugins) {
      installEmblaViewportGuard(viewport);
      const api = factory(viewport, { ...options, ...EMBLA_OPTIONS }, plugins);
      window.__twReviewEmbla = api;
      window.__twReviewEmblaViewport = viewport;
      normalizeEmblaViewport(viewport);
      return api;
    };
    Object.assign(wrapped, factory);
    window.EmblaCarousel = wrapped;
    window.__twV31EmblaWrapped = true;
  }

  function activeCard(root = document) {
    return root.querySelector('[data-situation-card].is-active');
  }

  function activeId() {
    return String(activeCard(document.querySelector('[data-situation-list]') || document)?.dataset.situationCard || '');
  }

  function installListScrollGuard(list) {
    if (!list || list.dataset.v31ScrollGuard === '1') return;
    const nativeScrollTo = typeof list.scrollTo === 'function' ? list.scrollTo.bind(list) : null;
    if (nativeScrollTo) {
      list.scrollTo = (first, second) => {
        if (first && typeof first === 'object') {
          return nativeScrollTo({ ...first, behavior: 'auto' });
        }
        return nativeScrollTo(first, second);
      };
    }
    list.dataset.v31ScrollGuard = '1';
  }

  function prepareVerticalList(list, card) {
    installListScrollGuard(list);
    const usableCardHeight = Math.min(card.offsetHeight || 0, list.clientHeight || 0);
    const edge = Math.max(12, Math.floor((list.clientHeight - usableCardHeight) / 2));
    list.style.setProperty('padding-top', `${edge}px`, 'important');
    list.style.setProperty('padding-bottom', `${edge}px`, 'important');
  }

  function centerVerticalList(list) {
    if (!list || list.clientHeight <= 0) return;
    const id = activeId();
    if (!id) return;
    const card = list.querySelector(`[data-situation-card="${CSS.escape(id)}"]`);
    if (!card) return;

    prepareVerticalList(list, card);
    const listRect = list.getBoundingClientRect();
    const cardRect = card.getBoundingClientRect();
    const delta = (cardRect.top + cardRect.height / 2) - (listRect.top + listRect.height / 2);
    if (Math.abs(delta) > 0.5) list.scrollTop += delta;
  }

  function centerLists() {
    centerVerticalList(document.querySelector('[data-situation-list]'));
    const drawer = document.querySelector('[data-drawer]');
    if (drawer?.open || drawer?.classList.contains('is-open')) {
      centerVerticalList(document.querySelector('[data-drawer-list]'));
    }
  }

  function clearSettleTimers() {
    settleTimers.forEach((timer) => clearTimeout(timer));
    settleTimers = [];
  }

  function settleListCenters() {
    clearSettleTimers();
    centerLists();
    [40, 120, 260, 520].forEach((delay) => {
      settleTimers.push(setTimeout(centerLists, delay));
    });
  }

  function sliderIndexForId(id) {
    return [...document.querySelectorAll('[data-slider-situation]')]
      .findIndex((node) => String(node.dataset.sliderSituation) === String(id));
  }

  function centerSliderId(id, jump = true) {
    if (window.innerWidth > MOBILE_BREAKPOINT) return;
    const embla = window.__twReviewEmbla;
    const index = sliderIndexForId(id);
    if (!embla || index < 0) return;
    normalizeEmblaViewport();
    try {
      embla.scrollTo(index, jump);
    } catch (_) {
      return;
    }
    requestAnimationFrame(() => normalizeEmblaViewport());
  }

  function settleSlider(id = activeId()) {
    if (!id) return;
    requestAnimationFrame(() => {
      centerSliderId(id, true);
      requestAnimationFrame(() => centerSliderId(id, true));
    });
    setTimeout(() => centerSliderId(id, true), 80);
    setTimeout(() => centerSliderId(id, true), 220);
  }

  function reflowSlider() {
    if (window.innerWidth > MOBILE_BREAKPOINT) return;
    const embla = window.__twReviewEmbla;
    if (!embla) return;
    normalizeEmblaViewport();
    try {
      embla.reInit({ ...EMBLA_OPTIONS });
    } catch (_) {
      return;
    }
    settleSlider();
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
    const source = activeCard(document.querySelector('[data-situation-list]') || document);
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
        requestAnimationFrame(() => requestAnimationFrame(settleListCenters));
      });
    }
  }

  function bindEmblaSettle() {
    const embla = window.__twReviewEmbla;
    if (!embla || embla.__twV31SettleBound) return;
    embla.__twV31SettleBound = true;
    embla.on?.('settle', () => {
      normalizeEmblaViewport();
      const id = activeId();
      if (id) centerSliderId(id, true);
    });
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
    bindEmblaSettle();
    normalizeEmblaViewport();
    if (changed || initial) {
      settleListCenters();
      settleSlider(nextId);
    } else {
      centerLists();
    }
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
      if (mutation.target.closest?.('[data-v31-mobile-active]')) return false;
      if (mutation.type === 'childList') return true;
      if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
        return mutation.target.matches?.('[data-situation-card],[data-slider-situation],[data-drawer]');
      }
      return false;
    });
    if (relevant) schedule(false);
  });

  observer.observe(app, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', () => {
    schedule(false);
    requestAnimationFrame(reflowSlider);
  }, { passive: true });
  window.visualViewport?.addEventListener('resize', () => {
    schedule(false);
    requestAnimationFrame(reflowSlider);
  }, { passive: true });
  schedule(true);
})();
