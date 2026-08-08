(() => {
  'use strict';

  const MOBILE_BREAKPOINT = 840;
  let fadeFrame = 0;
  let centerFrame = 0;
  let dragStartY = null;

  function firstName(value) {
    const text = String(value || '').trim();
    if (!text) return text;
    return text.split(/\s+/u)[0];
  }

  function currentReviewer() {
    const select = document.getElementById('reviewer-select');
    if (select?.value) return firstName(select.value);
    const pill = [...document.querySelectorAll('.tw-pill span')]
      .map((node) => String(node.textContent || '').trim())
      .find((value) => /^(Philipp|Lena)\b/iu.test(value));
    return firstName(pill || 'Philipp');
  }

  function applyPerspective() {
    const reviewer = currentReviewer().toLocaleLowerCase('de-DE');
    if (reviewer === 'philipp' || reviewer === 'lena') {
      document.documentElement.dataset.reviewer = reviewer;
    }
  }

  function shortenDisplayedNames(root = document) {
    root.querySelectorAll('.tw-message-meta strong').forEach((node) => {
      const value = firstName(node.textContent);
      if (value && node.textContent !== value) node.textContent = value;
    });
    root.querySelectorAll('.tw-reply strong').forEach((node) => {
      const text = String(node.textContent || '');
      const parts = text.split('·');
      if (!parts.length) return;
      const name = firstName(parts[0]);
      if (!name) return;
      const next = [name, ...parts.slice(1).map((part) => part.trim())].join(' · ');
      if (next !== text) node.textContent = next;
    });
  }

  function statusForSituation(id) {
    return document.querySelector(`[data-situation-list] [data-situation-card="${CSS.escape(String(id))}"]`)?.dataset.status
      || document.querySelector(`[data-drawer-list] [data-situation-card="${CSS.escape(String(id))}"]`)?.dataset.status
      || 'open';
  }

  function syncSliderStatuses() {
    document.querySelectorAll('[data-slider-situation]').forEach((node) => {
      node.dataset.status = statusForSituation(node.dataset.sliderSituation);
    });
  }

  function moveConfirmationIntoEndLine() {
    document.querySelectorAll('[data-boundary-end]').forEach((boundary) => {
      const id = String(boundary.dataset.boundaryEnd || '');
      if (!id) return;
      const actions = boundary.querySelector('.tw-boundary-actions');
      if (!actions) return;

      let confirm = boundary.querySelector(`[data-confirm="${CSS.escape(id)}"]`);
      const endCard = document.querySelector(`[data-end-card="${CSS.escape(id)}"]`);
      if (!confirm) confirm = endCard?.querySelector(`[data-confirm="${CSS.escape(id)}"]`) || null;
      if (confirm && confirm.parentElement !== actions) {
        confirm.classList.add('tw-boundary-confirm');
        actions.append(confirm);
      }

      if (!confirm && !actions.querySelector('.tw-boundary-owner')) {
        const ownerLabel = endCard?.querySelector('.tw-sit-status')?.textContent?.trim();
        if (ownerLabel) {
          const label = document.createElement('span');
          label.className = 'tw-boundary-owner';
          label.textContent = ownerLabel;
          actions.append(label);
        }
      }
    });
  }

  function ensureMobileListButton() {
    const shell = document.querySelector('[data-app-shell]');
    if (!shell || shell.querySelector('.tw-mobile-list-fab')) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tw-mobile-list-fab';
    button.setAttribute('aria-label', 'Situationsliste öffnen');
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
    button.addEventListener('click', () => {
      const nativeButton = document.querySelector('[data-nav="situations"]');
      if (nativeButton) nativeButton.click();
      else document.querySelector('[data-drawer]')?.classList.add('is-open');
      scheduleCenter(false);
    });
    shell.append(button);
  }

  function activeIndex(nodes) {
    return Math.max(0, nodes.findIndex((node) => node.classList.contains('is-active')));
  }

  function fadeSituationList(list) {
    if (!list) return;
    const nodes = [...list.querySelectorAll('[data-situation-card]')];
    if (!nodes.length) return;
    const active = activeIndex(nodes);
    nodes.forEach((node, index) => {
      const distance = Math.abs(index - active);
      const opacity = distance === 0 ? 1 : distance === 1 ? .88 : distance === 2 ? .74 : .58;
      node.style.setProperty('--tw-list-opacity', String(opacity));
    });
  }

  function fadeSlider() {
    const nodes = [...document.querySelectorAll('[data-slider-situation]')];
    if (!nodes.length) return;
    const active = activeIndex(nodes);
    nodes.forEach((node, index) => {
      const distance = Math.abs(index - active);
      const opacity = distance === 0 ? 1 : distance === 1 ? .82 : distance === 2 ? .7 : .58;
      node.style.setProperty('--tw-slider-opacity', String(opacity));
    });
  }

  function flowOpacity(rect, viewport, selected = false) {
    if (selected) return 1;
    if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) return .02;
    const center = viewport.top + viewport.height * .5;
    const nodeCenter = rect.top + rect.height * .5;
    const normalized = Math.abs(nodeCenter - center) / Math.max(1, viewport.height * .58);
    return Math.max(.08, Math.min(1, 1 - normalized * .92));
  }

  function applyChatFades() {
    fadeFrame = 0;
    const scroll = document.querySelector('[data-chat-scroll]');
    if (!scroll) return;
    const viewport = scroll.getBoundingClientRect();
    const nodes = scroll.querySelectorAll('.tw-message-wrap,.tw-group-label,.tw-boundary,.tw-day');
    nodes.forEach((node) => {
      const opacity = flowOpacity(node.getBoundingClientRect(), viewport, node.classList.contains('is-selected'));
      node.style.setProperty('--tw-flow-opacity', opacity.toFixed(3));
    });
  }

  function scheduleFades() {
    if (fadeFrame) return;
    fadeFrame = requestAnimationFrame(applyChatFades);
  }

  function centerVerticalList(list, smooth = true) {
    if (!list || list.clientHeight <= 0) return;
    const card = list.querySelector('[data-situation-card].is-active');
    if (!card) return;
    const spacer = Math.max(24, Math.round(list.clientHeight * .5));
    const px = `${spacer}px`;
    if (list.style.paddingTop !== px) list.style.paddingTop = px;
    if (list.style.paddingBottom !== px) list.style.paddingBottom = px;
    const target = card.offsetTop - (list.clientHeight - card.offsetHeight) / 2;
    const max = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTo({ top: Math.min(max, Math.max(0, target)), behavior: smooth ? 'smooth' : 'auto' });
  }

  function centerHorizontalSlider(smooth = true) {
    const slider = document.querySelector('[data-situation-slider]');
    const item = slider?.querySelector('[data-slider-situation].is-active');
    if (!slider || !item || slider.clientWidth <= 0) return;
    const target = item.offsetLeft - (slider.clientWidth - item.offsetWidth) / 2;
    const max = Math.max(0, slider.scrollWidth - slider.clientWidth);
    slider.scrollTo({ left: Math.min(max, Math.max(0, target)), behavior: smooth ? 'smooth' : 'auto' });
  }

  function centerAll(smooth = true) {
    centerFrame = 0;
    if (window.innerWidth > MOBILE_BREAKPOINT) {
      centerVerticalList(document.querySelector('[data-situation-list]'), smooth);
    }
    const drawer = document.querySelector('[data-drawer]');
    if (drawer?.classList.contains('is-open')) {
      centerVerticalList(document.querySelector('[data-drawer-list]'), smooth);
    }
    centerHorizontalSlider(smooth);
    fadeSituationList(document.querySelector('[data-situation-list]'));
    fadeSituationList(document.querySelector('[data-drawer-list]'));
    fadeSlider();
  }

  function scheduleCenter(smooth = true) {
    if (centerFrame) cancelAnimationFrame(centerFrame);
    centerFrame = requestAnimationFrame(() => requestAnimationFrame(() => centerAll(smooth)));
  }

  function enhance(root = document) {
    applyPerspective();
    shortenDisplayedNames(root);
    syncSliderStatuses();
    moveConfirmationIntoEndLine();
    ensureMobileListButton();
    scheduleFades();
    scheduleCenter(true);
  }

  function bindCurrentChatScroll() {
    const scroll = document.querySelector('[data-chat-scroll]');
    if (!scroll || scroll.dataset.twFadeBound === '1') return;
    scroll.dataset.twFadeBound = '1';
    scroll.addEventListener('scroll', scheduleFades, { passive: true });
  }

  function bindBottomSheetGestures() {
    const panel = document.querySelector('.tw-drawer-panel');
    if (!panel || panel.dataset.twSheetBound === '1') return;
    panel.dataset.twSheetBound = '1';
    panel.addEventListener('touchstart', (event) => {
      dragStartY = event.touches?.[0]?.clientY ?? null;
    }, { passive: true });
    panel.addEventListener('touchend', (event) => {
      const endY = event.changedTouches?.[0]?.clientY;
      if (dragStartY !== null && Number.isFinite(endY) && endY - dragStartY > 85) {
        document.querySelector('[data-close-drawer]')?.click();
      }
      dragStartY = null;
    }, { passive: true });
  }

  const app = document.getElementById('review-app');
  if (app) {
    const observer = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) => mutation.type === 'childList' || mutation.attributeName === 'class' || mutation.attributeName === 'data-status');
      if (!relevant) return;
      bindCurrentChatScroll();
      bindBottomSheetGestures();
      enhance(app);
    });
    observer.observe(app, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class', 'data-status'],
    });
  }

  document.addEventListener('change', (event) => {
    if (event.target?.id === 'reviewer-select') {
      requestAnimationFrame(() => enhance(document));
    }
  }, true);

  window.addEventListener('truewords:active-situation-change', () => {
    scheduleCenter(true);
    scheduleFades();
  });
  window.addEventListener('resize', () => {
    scheduleCenter(false);
    scheduleFades();
  }, { passive: true });

  document.addEventListener('DOMContentLoaded', () => {
    bindCurrentChatScroll();
    bindBottomSheetGestures();
    enhance(document);
  }, { once: true });
})();
