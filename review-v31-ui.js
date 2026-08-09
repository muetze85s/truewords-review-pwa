(() => {
  'use strict';

  const MOBILE_BREAKPOINT = 840;
  const app = document.getElementById('review-app');
  if (!app) return;

  let scheduled = 0;
  let mobileExpanded = false;
  let suppressVirtualClickUntil = 0;

  function sourceSituationList() {
    return document.querySelector('[data-situation-list]');
  }

  function sourceSituationCards() {
    return [...(sourceSituationList()?.querySelectorAll(':scope > [data-situation-card]') || [])];
  }

  function sourceSliderItems() {
    return [...document.querySelectorAll('[data-situation-slider] [data-slider-situation]')];
  }

  function activeSourceCard() {
    return sourceSituationList()?.querySelector(':scope > [data-situation-card].is-active') || null;
  }

  function activeId() {
    return String(activeSourceCard()?.dataset.situationCard || '');
  }

  function orderedIds() {
    return sourceSituationCards().map((card) => String(card.dataset.situationCard || '')).filter(Boolean);
  }

  function activeIndex() {
    const ids = orderedIds();
    return ids.indexOf(activeId());
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

  function removeDuplicateIds(root) {
    root?.querySelectorAll?.('[id]').forEach((node) => node.removeAttribute('id'));
  }

  function cloneSituationCard(source, slot) {
    if (!source) return null;
    const clone = source.cloneNode(true);
    removeDuplicateIds(clone);
    clone.classList.add('tw-v33-nav-card');
    clone.dataset.v33NavId = String(source.dataset.situationCard || '');
    clone.dataset.v33Slot = slot;
    return clone;
  }

  function cloneSliderItem(source, slot) {
    if (!source) return null;
    const clone = source.cloneNode(true);
    removeDuplicateIds(clone);
    const id = String(source.dataset.sliderSituation || '');
    clone.removeAttribute('data-slider-situation');
    clone.dataset.v33NavId = id;
    clone.dataset.v33Slot = slot;
    clone.classList.add('tw-v33-strip-item');
    return clone;
  }

  function sourceCardFor(id, selector = '[data-situation-list]') {
    return document.querySelector(`${selector} [data-situation-card="${CSS.escape(String(id))}"]`);
  }

  function alignBoundary(id) {
    const scroll = document.querySelector('[data-chat-scroll]');
    const boundary = document.querySelector(`[data-boundary-start="${CSS.escape(String(id))}"]`);
    if (!scroll || !boundary) return;
    const scrollRect = scroll.getBoundingClientRect();
    const boundaryRect = boundary.getBoundingClientRect();
    const desiredInset = 10;
    const delta = boundaryRect.top - scrollRect.top - desiredInset;
    if (Math.abs(delta) < 0.5) return;
    const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    scroll.scrollTop = Math.min(max, Math.max(0, scroll.scrollTop + delta));
  }

  function settleBoundary(id) {
    alignBoundary(id);
    requestAnimationFrame(() => {
      alignBoundary(id);
      requestAnimationFrame(() => alignBoundary(id));
    });
  }

  function navigateTo(id) {
    const value = String(id || '');
    if (!value) return;
    const source = document.querySelector(`[data-situation-list] [data-open-situation="${CSS.escape(value)}"]`);
    if (!source) return;
    source.click();
    settleBoundary(value);
  }

  function navigateRelative(delta) {
    const ids = orderedIds();
    const index = activeIndex();
    if (index < 0 || !ids.length) return;
    const nextIndex = Math.max(0, Math.min(ids.length - 1, index + delta));
    if (nextIndex === index) return;
    navigateTo(ids[nextIndex]);
  }

  function forwardCardAction(target, navRoot) {
    const card = target.closest('[data-v33-nav-id]');
    const id = String(card?.dataset.v33NavId || '');
    if (!id) return false;

    if (target.closest('[data-open-situation]')) {
      navigateTo(id);
      return true;
    }

    const source = sourceCardFor(id, navRoot?.dataset.v33FixedList === 'drawer' ? '[data-drawer-list]' : '[data-situation-list]')
      || sourceCardFor(id);
    if (!source) return false;

    const confirm = target.closest('[data-card-confirm]');
    if (confirm) {
      source.querySelector('[data-card-confirm]')?.click();
      return true;
    }

    const edit = target.closest('[data-edit-detail]');
    if (edit) {
      const key = String(edit.dataset.detailKey || '');
      const candidate = [...source.querySelectorAll('[data-edit-detail]')]
        .find((node) => String(node.dataset.detailKey || '') === key);
      candidate?.click();
      return true;
    }

    if (target.closest('[data-add-detail]')) {
      source.querySelector('[data-add-detail]')?.click();
      return true;
    }

    return false;
  }

  function detailsCanScroll(target, deltaY) {
    const scroller = target.closest('.tw-v33-list-center .tw-situation');
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight + 1) return false;
    if (deltaY < 0 && scroller.scrollTop > 0) return true;
    if (deltaY > 0 && scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1) return true;
    return false;
  }

  function bindFixedList(nav) {
    if (!nav || nav.dataset.v33Bound === '1') return;
    nav.dataset.v33Bound = '1';
    nav.tabIndex = 0;

    let wheelTotal = 0;
    let wheelTimer = 0;
    let pointer = null;

    nav.addEventListener('wheel', (event) => {
      if (detailsCanScroll(event.target, event.deltaY)) return;
      event.preventDefault();
      wheelTotal += event.deltaY;
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => { wheelTotal = 0; }, 140);
      if (Math.abs(wheelTotal) < 44) return;
      navigateRelative(wheelTotal > 0 ? 1 : -1);
      wheelTotal = 0;
    }, { passive: false });

    nav.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }, { passive: true });

    nav.addEventListener('pointerup', (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      pointer = null;
      if (Math.abs(dy) < 36 || Math.abs(dy) <= Math.abs(dx) * 1.15) return;
      suppressVirtualClickUntil = performance.now() + 280;
      navigateRelative(dy < 0 ? 1 : -1);
    }, { passive: true });

    nav.addEventListener('pointercancel', () => { pointer = null; }, { passive: true });

    nav.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      navigateRelative(event.key === 'ArrowDown' ? 1 : -1);
    });

    nav.addEventListener('click', (event) => {
      if (performance.now() < suppressVirtualClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (forwardCardAction(event.target, nav)) {
        event.preventDefault();
        event.stopPropagation();
      }
    });
  }

  function buildListGroup(cards, className, slotPrefix) {
    const group = document.createElement('div');
    group.className = className;
    cards.forEach((source, index) => {
      const clone = cloneSituationCard(source, `${slotPrefix}-${index}`);
      if (clone) group.append(clone);
    });
    return group;
  }

  function renderFixedList(nav) {
    if (!nav) return;
    const cards = sourceSituationCards();
    const index = cards.findIndex((card) => card.classList.contains('is-active'));
    if (index < 0) return;

    const topSources = cards.slice(Math.max(0, index - 2), index);
    const bottomSources = cards.slice(index + 1, index + 3);
    const top = buildListGroup(topSources, 'tw-v33-list-group tw-v33-list-top', 'before');
    const center = document.createElement('div');
    center.className = 'tw-v33-list-center';
    const activeClone = cloneSituationCard(cards[index], 'active');
    if (activeClone) center.append(activeClone);
    const bottom = buildListGroup(bottomSources, 'tw-v33-list-group tw-v33-list-bottom', 'after');
    nav.replaceChildren(top, center, bottom);
    nav.dataset.activeId = String(cards[index].dataset.situationCard || '');
  }

  function ensureFixedList(kind) {
    const isDrawer = kind === 'drawer';
    const host = isDrawer ? document.querySelector('.tw-drawer-body') : document.querySelector('.tw-sidebar');
    const source = isDrawer ? document.querySelector('[data-drawer-list]') : sourceSituationList();
    if (!host || !source) return null;

    let nav = host.querySelector(`:scope > [data-v33-fixed-list="${kind}"]`);
    if (!nav) {
      nav = document.createElement('div');
      nav.className = `tw-v33-fixed-list tw-v33-fixed-list-${kind}`;
      nav.dataset.v33FixedList = kind;
      nav.setAttribute('aria-label', isDrawer ? 'Situationen' : 'Situationen');
      if (isDrawer) host.insertBefore(nav, source);
      else host.insertBefore(nav, source);
      bindFixedList(nav);
    }
    source.setAttribute('aria-hidden', 'true');
    renderFixedList(nav);
    return nav;
  }

  function renderMobileActive() {
    const shell = document.querySelector('[data-app-shell]');
    const slider = document.querySelector('[data-situation-slider]');
    const source = activeSourceCard();
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
    if (panel.dataset.situationId !== id) mobileExpanded = false;
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

  function bindMobileStrip(strip) {
    if (!strip || strip.dataset.v33Bound === '1') return;
    strip.dataset.v33Bound = '1';

    let pointer = null;
    let wheelTotal = 0;
    let wheelTimer = 0;

    strip.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    }, { passive: true });

    strip.addEventListener('pointerup', (event) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      pointer = null;
      if (Math.abs(dx) < 32 || Math.abs(dx) <= Math.abs(dy) * 1.15) return;
      suppressVirtualClickUntil = performance.now() + 280;
      navigateRelative(dx < 0 ? 1 : -1);
    }, { passive: true });

    strip.addEventListener('pointercancel', () => { pointer = null; }, { passive: true });

    strip.addEventListener('wheel', (event) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      wheelTotal += event.deltaX;
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => { wheelTotal = 0; }, 140);
      if (Math.abs(wheelTotal) < 44) return;
      navigateRelative(wheelTotal > 0 ? 1 : -1);
      wheelTotal = 0;
    }, { passive: false });

    strip.addEventListener('click', (event) => {
      if (performance.now() < suppressVirtualClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const item = event.target.closest('[data-v33-nav-id]');
      if (!item) return;
      event.preventDefault();
      event.stopPropagation();
      navigateTo(item.dataset.v33NavId);
    });
  }

  function renderMobileStrip() {
    const shell = document.querySelector('[data-app-shell]');
    const original = document.querySelector('[data-situation-slider]');
    const items = sourceSliderItems();
    const id = activeId();
    const index = items.findIndex((item) => String(item.dataset.sliderSituation || '') === id);
    if (!shell || !original || index < 0) return;

    let strip = shell.querySelector('[data-v33-mobile-strip]');
    if (!strip) {
      strip = document.createElement('nav');
      strip.className = 'tw-v33-mobile-strip';
      strip.dataset.v33MobileStrip = '';
      strip.setAttribute('aria-label', 'Situationen');
      original.before(strip);
      bindMobileStrip(strip);
    }
    original.setAttribute('aria-hidden', 'true');

    const left = document.createElement('div');
    left.className = 'tw-v33-strip-side tw-v33-strip-left';
    items.slice(Math.max(0, index - 2), index).forEach((source, offset) => {
      const clone = cloneSliderItem(source, `before-${offset}`);
      if (clone) left.append(clone);
    });

    const center = document.createElement('div');
    center.className = 'tw-v33-strip-center';
    const active = cloneSliderItem(items[index], 'active');
    if (active) {
      active.classList.add('is-active');
      center.append(active);
    }

    const right = document.createElement('div');
    right.className = 'tw-v33-strip-side tw-v33-strip-right';
    items.slice(index + 1, index + 3).forEach((source, offset) => {
      const clone = cloneSliderItem(source, `after-${offset}`);
      if (clone) right.append(clone);
    });

    strip.replaceChildren(left, center, right);
    strip.dataset.activeId = id;
  }

  function renderAll() {
    if (!document.querySelector('[data-app-shell]')) return;
    const previousActive = document.querySelector('[data-v31-mobile-active]')?.dataset.situationId || '';
    const nextActive = activeId();
    if (previousActive && nextActive && previousActive !== nextActive) mobileExpanded = false;

    ensureFixedList('sidebar');
    ensureFixedList('drawer');
    renderMobileActive();
    renderMobileStrip();
    document.documentElement.classList.add('tw-v33-ready');
  }

  function schedule() {
    if (scheduled) return;
    scheduled = requestAnimationFrame(() => {
      scheduled = 0;
      renderAll();
    });
  }

  const observer = new MutationObserver((mutations) => {
    const relevant = mutations.some((mutation) => {
      if (mutation.target.closest?.('[data-v33-fixed-list],[data-v33-mobile-strip],[data-v31-mobile-active]')) return false;
      if (mutation.type === 'childList') return true;
      if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
        return mutation.target.matches?.('[data-situation-card],[data-slider-situation],[data-drawer]');
      }
      return false;
    });
    if (relevant) schedule();
  });

  observer.observe(app, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', schedule, { passive: true });
  window.visualViewport?.addEventListener('resize', schedule, { passive: true });
  schedule();
})();
