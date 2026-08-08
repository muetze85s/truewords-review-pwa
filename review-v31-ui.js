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
    duration: 22,
  };
  let scheduled = 0;
  let lastActiveId = '';
  let mobileExpanded = false;
  let settleTimers = [];

  function installSliderEdges(viewport) {
    const container = viewport?.querySelector('[data-situation-slider-container]') || viewport?.firstElementChild;
    if (!container) return { count: 0 };
    const realSlides = [...container.children].filter((node) => !node.classList.contains('tw-v31-slider-edge'));
    if (!realSlides.length) return { count: 0 };

    let before = container.querySelector(':scope > .tw-v31-slider-edge[data-edge="before"]');
    let after = container.querySelector(':scope > .tw-v31-slider-edge[data-edge="after"]');
    if (!before) {
      before = document.createElement('div');
      before.className = 'tw-embla-slide tw-v31-slider-edge';
      before.dataset.edge = 'before';
      before.setAttribute('aria-hidden', 'true');
      container.prepend(before);
    }
    if (!after) {
      after = document.createElement('div');
      after.className = 'tw-embla-slide tw-v31-slider-edge';
      after.dataset.edge = 'after';
      after.setAttribute('aria-hidden', 'true');
      container.append(after);
    }

    const sampleWidth = realSlides[0].getBoundingClientRect().width || 120;
    const edgeSize = Math.max(0, viewport.clientWidth / 2 - sampleWidth / 2);
    before.style.setProperty('--tw-v31-edge-size', `${edgeSize}px`);
    after.style.setProperty('--tw-v31-edge-size', `${edgeSize}px`);
    return { count: realSlides.length };
  }

  /* V30 owns Embla's interaction model. V31 adds two inert edge slides and
     maps logical situation indices to physical Embla snaps. This lets every
     real situation – including the first and last – sit exactly at center. */
  if (typeof window.EmblaCarousel === 'function' && !window.__twV31EmblaWrapped) {
    const factory = window.EmblaCarousel;
    const wrapped = function (viewport, options, plugins) {
      let edgeState = installSliderEdges(viewport);
      const raw = factory(viewport, options, plugins);
      const api = new Proxy(raw, {
        get(target, property) {
          if (property === 'scrollTo') {
            return (logicalIndex, jump) => {
              const index = Math.max(0, Math.min(Math.max(0, edgeState.count - 1), Number(logicalIndex) || 0));
              return target.scrollTo(index + 1, jump);
            };
          }
          if (property === 'selectedScrollSnap') {
            return () => {
              const physical = Number(target.selectedScrollSnap()) || 0;
              return Math.max(0, Math.min(Math.max(0, edgeState.count - 1), physical - 1));
            };
          }
          if (property === 'scrollSnapList') {
            return () => target.scrollSnapList().slice(1, -1);
          }
          if (property === 'reInit') {
            return (nextOptions, nextPlugins) => {
              edgeState = installSliderEdges(viewport);
              return target.reInit(nextOptions, nextPlugins);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      window.__twReviewEmbla = api;
      return api;
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

  function ensureSpacers(list, card) {
    let before = list.querySelector(':scope > .tw-v31-list-spacer[data-edge="before"]');
    let after = list.querySelector(':scope > .tw-v31-list-spacer[data-edge="after"]');
    if (!before) {
      before = document.createElement('div');
      before.className = 'tw-v31-list-spacer';
      before.dataset.edge = 'before';
      list.prepend(before);
    }
    if (!after) {
      after = document.createElement('div');
      after.className = 'tw-v31-list-spacer';
      after.dataset.edge = 'after';
      list.append(after);
    }
    const height = Math.max(0, (list.clientHeight - Math.min(card.offsetHeight, list.clientHeight)) / 2 - 12);
    before.style.height = `${height}px`;
    after.style.height = `${height}px`;
  }

  function centerVerticalList(list) {
    if (!list || list.clientHeight <= 0) return;
    const id = activeId();
    if (!id) return;
    const card = list.querySelector(`[data-situation-card="${CSS.escape(id)}"]`);
    if (!card) return;

    ensureSpacers(list, card);
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
    [60, 180, 360].forEach((delay) => {
      settleTimers.push(setTimeout(centerLists, delay));
    });
  }

  function sliderIndexForId(id) {
    return [...document.querySelectorAll('[data-slider-situation]')]
      .findIndex((node) => String(node.dataset.sliderSituation) === String(id));
  }

  function centerSliderId(id, jump = false) {
    if (window.innerWidth > MOBILE_BREAKPOINT) return;
    const embla = window.__twReviewEmbla;
    const index = sliderIndexForId(id);
    if (!embla || index < 0) return;
    try {
      embla.scrollTo?.(index, jump);
    } catch (_) {
      /* V30 remains the functional owner of drag/navigation semantics. */
    }
  }

  function centerSlider(jump = false) {
    centerSliderId(activeId(), jump);
  }

  function settleSliderId(id) {
    requestAnimationFrame(() => {
      centerSliderId(id, true);
      requestAnimationFrame(() => centerSliderId(id, true));
    });
    setTimeout(() => centerSliderId(id, true), 90);
  }

  function reflowSlider() {
    if (window.innerWidth > MOBILE_BREAKPOINT) return;
    const embla = window.__twReviewEmbla;
    const id = activeId();
    const index = sliderIndexForId(id);
    if (!embla || index < 0) return;
    try {
      embla.reInit?.(EMBLA_OPTIONS);
      requestAnimationFrame(() => embla.scrollTo?.(index, true));
    } catch (_) {
      centerSliderId(id, true);
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
    if (changed || initial) settleListCenters();
    else centerLists();
    centerSlider(initial);
  }

  function schedule(initial = false) {
    if (scheduled) cancelAnimationFrame(scheduled);
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      stabilize({ initial });
    });
  }

  function internalSpacerMutation(mutation) {
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes].filter((node) => node.nodeType === Node.ELEMENT_NODE);
    return nodes.length > 0 && nodes.every((node) => node.classList?.contains('tw-v31-list-spacer') || node.classList?.contains('tw-v31-slider-edge'));
  }

  app.addEventListener('click', (event) => {
    const sliderItem = event.target.closest?.('[data-slider-situation]');
    if (!sliderItem) return;
    settleSliderId(sliderItem.dataset.sliderSituation);
  });

  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((mutation) => {
      if (mutation.target.closest?.('[data-v31-mobile-active]')) return false;
      if (mutation.type === 'childList') return !internalSpacerMutation(mutation);
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
