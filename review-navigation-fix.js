(() => {
  'use strict';

  const MOBILE_BREAKPOINT = 840;
  const nativeScrollIntoView = Element.prototype.scrollIntoView;
  const nativeAddEventListener = EventTarget.prototype.addEventListener;
  const messageClickHandlers = new Map();
  const guardedChatScrolls = new WeakSet();
  let manualScrollUntil = 0;

  function focusOffset() {
    if (window.innerWidth > MOBILE_BREAKPOINT) return 18;
    return document.querySelector('[data-app-shell]')?.classList.contains('is-header-hidden') ? 62 : 112;
  }

  function updateMobileHeader(scroll, previousTop) {
    if (window.innerWidth > MOBILE_BREAKPOINT || performance.now() < manualScrollUntil) return scroll.scrollTop;
    const current = scroll.scrollTop;
    const delta = current - previousTop;
    const shell = document.querySelector('[data-app-shell]');
    if (!shell) return current;
    if (delta > 2 && current > 80) shell.classList.add('is-header-hidden');
    if (delta < -2) shell.classList.remove('is-header-hidden');
    return current;
  }

  function installPassiveChatScroll(scroll) {
    if (guardedChatScrolls.has(scroll)) return;
    guardedChatScrolls.add(scroll);
    let previousTop = scroll.scrollTop;
    nativeAddEventListener.call(scroll, 'scroll', () => {
      previousTop = updateMobileHeader(scroll, previousTop);
    }, { passive: true });
  }

  // Die Kern-App bindet Klicks an einzelne Nachrichtenknoten. renderChat()
  // ersetzt diese Knoten nach der ersten Auswahl, wodurch die neuen Knoten
  // sonst keine Handler mehr hätten. Wir speichern die Kern-Handler je ID und
  // rufen sie delegiert auch für neu gerenderte Nachrichten auf.
  EventTarget.prototype.addEventListener = function patchedAddEventListener(type, listener, options) {
    if (
      type === 'click'
      && this instanceof Element
      && this.matches?.('[data-message-id]')
      && typeof listener === 'function'
    ) {
      const id = String(this.dataset.messageId || '');
      if (id) messageClickHandlers.set(id, { listener, source: this });
      return;
    }

    // Der Chat-Scroll darf die aktive Situation nicht mehr umschalten. Nur ein
    // expliziter Klick auf Situation/Slider ändert den aktiven Fokus.
    if (type === 'scroll' && this instanceof Element && this.matches?.('[data-chat-scroll]')) {
      installPassiveChatScroll(this);
      return;
    }

    return nativeAddEventListener.call(this, type, listener, options);
  };

  function scrollElementIntoChatView(element) {
    const scroll = element?.closest?.('[data-chat-scroll]');
    if (!scroll) return false;
    manualScrollUntil = performance.now() + 450;
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

  function toggleSituationConfirmation(check) {
    const opener = check.closest?.('[data-open-situation]');
    const id = Number(opener?.dataset.openSituation || 0);
    if (!id) return false;
    const confirm = document.querySelector(`[data-confirm="${id}"]`);
    if (!confirm) return false;
    confirm.click();
    return true;
  }

  document.addEventListener('click', (event) => {
    const check = event.target.closest?.('.tw-sit-check');
    if (check) {
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleSituationConfirmation(check);
      return;
    }

    const message = event.target.closest?.('[data-message-id]');
    if (message) {
      const id = String(message.dataset.messageId || '');
      const stored = messageClickHandlers.get(id);
      if (!stored) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      stored.listener.call(stored.source, event);
      return;
    }

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
