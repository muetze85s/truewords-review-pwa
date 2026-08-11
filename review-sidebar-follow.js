(() => {
  'use strict';

  const MOBILE_BREAKPOINT = 840;
  let centerFrame = 0;

  function centerActiveSituation({ smooth = true } = {}) {
    if (window.innerWidth <= MOBILE_BREAKPOINT) return;
    const list = document.querySelector('[data-situation-list]');
    const card = list?.querySelector('[data-situation-card].is-active');
    if (!list || !card || list.clientHeight <= 0) return;

    // Extra scroll range above/below lets even the first and last situation sit
    // in the visual center of the list, like a synchronized timeline picker.
    const spacer = Math.max(24, Math.round(list.clientHeight * 0.5));
    const spacerPx = `${spacer}px`;
    if (list.style.paddingTop !== spacerPx) list.style.paddingTop = spacerPx;
    if (list.style.paddingBottom !== spacerPx) list.style.paddingBottom = spacerPx;

    const target = card.offsetTop - (list.clientHeight - card.offsetHeight) / 2;
    const maxTop = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTo({
      top: Math.min(maxTop, Math.max(0, target)),
      behavior: smooth ? 'smooth' : 'auto',
    });
  }

  function scheduleCenter(smooth = true) {
    if (centerFrame) cancelAnimationFrame(centerFrame);
    centerFrame = requestAnimationFrame(() => {
      centerFrame = requestAnimationFrame(() => {
        centerFrame = 0;
        centerActiveSituation({ smooth });
      });
    });
  }

  const app = document.getElementById('review-app');
  if (app) {
    const observer = new MutationObserver((mutations) => {
      if (window.innerWidth <= MOBILE_BREAKPOINT) return;
      const relevant = mutations.some((mutation) => (
        mutation.type === 'childList'
        || (mutation.type === 'attributes' && mutation.attributeName === 'class')
      ));
      if (relevant) scheduleCenter(true);
    });
    observer.observe(app, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['class'],
    });
  }

  window.addEventListener('resize', () => scheduleCenter(false), { passive: true });
  document.addEventListener('DOMContentLoaded', () => scheduleCenter(false), { once: true });
})();
