(() => {
  'use strict';

  const MOBILE_BREAKPOINT = 840;
  const nativeScrollIntoView = Element.prototype.scrollIntoView;

  function focusOffset() {
    if (window.innerWidth > MOBILE_BREAKPOINT) return 18;
    return document.querySelector('[data-app-shell]')?.classList.contains('is-header-hidden') ? 62 : 112;
  }

  function scrollElementIntoChatView(element) {
    const scroll = element?.closest?.('[data-chat-scroll]');
    if (!scroll) return false;
    const scrollRect = scroll.getBoundingClientRect();
    const targetRect = element.getBoundingClientRect();
    const top = Math.max(0, scroll.scrollTop + targetRect.top - scrollRect.top - focusOffset());
    scroll.scrollTo({ top, behavior: 'auto' });
    return true;
  }

  Element.prototype.scrollIntoView = function patchedScrollIntoView(options) {
    const block = options && typeof options === 'object' ? options.block : undefined;
    if (block === 'start' && this.closest?.('[data-chat-scroll]') && scrollElementIntoChatView(this)) return;
    return nativeScrollIntoView.call(this, options);
  };

  function focusSituation(id) {
    const target = document.querySelector(
      `[data-message-situation="${Number(id)}"][data-situation-first="true"]`,
    );
    if (!target) return;
    scrollElementIntoChatView(target);
  }

  // Die Situationsliste wird bei jedem Aktivwechsel neu aufgebaut. Deshalb darf
  // die Navigation nicht an einzelne Buttons gebunden sein. Dieser delegierte
  // Handler bleibt über alle Re-Renders hinweg erhalten.
  document.addEventListener('click', (event) => {
    const button = event.target.closest?.('[data-open-situation]');
    if (!button) return;

    const id = Number(button.dataset.openSituation);
    if (!Number.isInteger(id) || id <= 0) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    document.querySelector('[data-drawer]')?.classList.remove('is-open');

    const sliderButton = document.querySelector(`[data-slider-situation="${id}"]`);
    if (!sliderButton) return;
    sliderButton.click();

    requestAnimationFrame(() => {
      focusSituation(id);
      requestAnimationFrame(() => focusSituation(id));
    });
  }, true);
})();
