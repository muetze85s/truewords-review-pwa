(() => {
  'use strict';

  const MOBILE_BREAKPOINT = 840;
  const nativeScrollIntoView = Element.prototype.scrollIntoView;
  const nativeScrollTo = Element.prototype.scrollTo;
  const nativeAddEventListener = EventTarget.prototype.addEventListener;
  const messageClickHandlers = new Map();
  const confirmationClickHandlers = new Map();
  const splitClickHandlers = new Map();
  const boundaryClickHandlers = new Map();
  const guardedChatScrolls = new WeakSet();

  let manualScrollUntil = 0;
  let scrollSyncFrame = 0;
  let suppressChatFocus = false;
  let stableAction = null;
  let lastViewportSnapshot = null;
  let releaseTimer = 0;

  function focusOffset() {
    return window.innerWidth > MOBILE_BREAKPOINT ? 18 : 162;
  }

  function currentActiveSituationId() {
    const slider = document.querySelector('[data-slider-situation].is-active');
    if (slider) return Number(slider.dataset.sliderSituation || 0);
    const card = document.querySelector('[data-situation-card].is-active');
    return Number(card?.dataset.situationCard || 0);
  }

  function readingAnchorY(scroll) {
    const rect = scroll.getBoundingClientRect();
    const topInset = window.innerWidth <= MOBILE_BREAKPOINT ? 154 : 18;
    const readable = Math.max(1, rect.height - topInset);
    return rect.top + topInset + readable * .38;
  }

  function situationAtScrollAnchor(scroll) {
    const firstMessages = [...scroll.querySelectorAll('[data-message-situation][data-situation-first="true"]')];
    if (!firstMessages.length) return 0;
    const anchor = readingAnchorY(scroll);
    let candidate = Number(firstMessages[0].dataset.messageSituation || 0);
    for (const node of firstMessages) {
      if (node.getBoundingClientRect().top > anchor + 1) break;
      const id = Number(node.dataset.messageSituation || 0);
      if (id) candidate = id;
    }
    return candidate;
  }

  function visibleViewportAnchor(scroll) {
    const rect = scroll.getBoundingClientRect();
    const anchorY = readingAnchorY(scroll);
    let best = null;
    let distance = Infinity;
    scroll.querySelectorAll('[data-message-wrap]').forEach((node) => {
      const nodeRect = node.getBoundingClientRect();
      if (nodeRect.bottom <= rect.top || nodeRect.top >= rect.bottom) return;
      const point = Math.min(Math.max(anchorY, nodeRect.top), nodeRect.bottom);
      const nextDistance = Math.abs(point - anchorY);
      if (nextDistance < distance) {
        best = node;
        distance = nextDistance;
      }
    });
    return best;
  }

  function captureViewportSnapshot(scroll) {
    if (!scroll) return null;
    const anchor = visibleViewportAnchor(scroll);
    const selected = document.querySelector('[data-message-wrap].is-selected');
    return {
      messageId: String(anchor?.dataset.messageWrap || ''),
      top: anchor?.getBoundingClientRect().top,
      scrollTop: scroll.scrollTop,
      selectedMessageId: String(selected?.dataset.messageWrap || ''),
      activeSituationId: currentActiveSituationId(),
      selectionRestored: false,
    };
  }

  function restoreViewportSnapshot(snapshot, { restoreSelection = true } = {}) {
    if (!snapshot) return;
    const scroll = document.querySelector('[data-chat-scroll]');
    if (!scroll) return;
    const anchor = snapshot.messageId
      ? document.querySelector(`[data-message-wrap="${CSS.escape(snapshot.messageId)}"]`)
      : null;
    if (anchor && Number.isFinite(snapshot.top)) {
      const delta = anchor.getBoundingClientRect().top - snapshot.top;
      if (Math.abs(delta) > .5) scroll.scrollTop += delta;
    } else if (Number.isFinite(snapshot.scrollTop)) {
      scroll.scrollTop = snapshot.scrollTop;
    }

    if (restoreSelection && snapshot.selectedMessageId && !snapshot.selectionRestored) {
      const selected = document.querySelector(`[data-message-wrap="${CSS.escape(snapshot.selectedMessageId)}"]`);
      if (selected && !selected.classList.contains('is-selected')) {
        const stored = messageClickHandlers.get(snapshot.selectedMessageId);
        if (stored) {
          snapshot.selectionRestored = true;
          stored.listener.call(stored.source, new MouseEvent('click', { bubbles: true }));
        }
      } else if (selected) {
        snapshot.selectionRestored = true;
      }
    }
  }

  function updateLastSnapshot(scroll) {
    const snapshot = captureViewportSnapshot(scroll);
    if (snapshot) lastViewportSnapshot = snapshot;
  }

  function releaseStableAction() {
    clearTimeout(releaseTimer);
    releaseTimer = 0;
    stableAction = null;
    suppressChatFocus = false;
    const scroll = document.querySelector('[data-chat-scroll]');
    if (scroll) {
      updateLastSnapshot(scroll);
      requestAnimationFrame(() => activateSituationFromScroll(scroll));
    }
  }

  function armStableAction() {
    const scroll = document.querySelector('[data-chat-scroll]');
    const snapshot = captureViewportSnapshot(scroll) || lastViewportSnapshot;
    stableAction = {
      snapshot,
      expiresAt: performance.now() + 10_000,
    };
    suppressChatFocus = true;
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(releaseStableAction, 10_000);
  }

  function scheduleStableRestore(snapshot) {
    if (!snapshot) return;
    requestAnimationFrame(() => {
      restoreViewportSnapshot(snapshot);
      requestAnimationFrame(() => {
        restoreViewportSnapshot(snapshot);
        manualScrollUntil = performance.now() + 220;
        clearTimeout(releaseTimer);
        releaseTimer = setTimeout(releaseStableAction, 260);
      });
    });
  }

  function activateSituationFromScroll(scroll) {
    if (suppressChatFocus || stableAction || performance.now() < manualScrollUntil) return;
    const id = situationAtScrollAnchor(scroll);
    if (!id || id === currentActiveSituationId()) return;
    const slider = document.querySelector(`[data-slider-situation="${id}"]`);
    if (!slider) return;

    const anchor = visibleViewportAnchor(scroll);
    const beforeTop = anchor?.getBoundingClientRect().top;
    suppressChatFocus = true;
    try {
      slider.click();
      if (anchor?.isConnected && Number.isFinite(beforeTop)) {
        const delta = anchor.getBoundingClientRect().top - beforeTop;
        if (Math.abs(delta) > .5) scroll.scrollTop += delta;
      }
      window.dispatchEvent(new CustomEvent('truewords:active-situation-change', { detail: { id, source: 'chat-scroll' } }));
    } finally {
      suppressChatFocus = false;
    }
    updateLastSnapshot(scroll);
  }

  function installPassiveChatScroll(scroll) {
    if (guardedChatScrolls.has(scroll)) return;
    guardedChatScrolls.add(scroll);
    scroll.style.overflowAnchor = 'none';
    document.querySelector('[data-app-shell]')?.classList.remove('is-header-hidden');
    updateLastSnapshot(scroll);
    nativeAddEventListener.call(scroll, 'scroll', () => {
      document.querySelector('[data-app-shell]')?.classList.remove('is-header-hidden');
      updateLastSnapshot(scroll);
      if (scrollSyncFrame) cancelAnimationFrame(scrollSyncFrame);
      scrollSyncFrame = requestAnimationFrame(() => {
        scrollSyncFrame = 0;
        activateSituationFromScroll(scroll);
      });
    }, { passive: true });
  }

  function handlerKey(element) {
    if (element.matches('[data-confirm]')) return `confirm:${element.dataset.confirm || ''}`;
    if (element.matches('[data-split-here]')) return `split:${element.dataset.splitHere || ''}`;
    if (element.matches('[data-boundary]')) return `boundary:${element.dataset.boundary || ''}`;
    return '';
  }

  EventTarget.prototype.addEventListener = function patchedAddEventListener(type, listener, options) {
    if (type === 'click' && this instanceof Element && typeof listener === 'function') {
      if (this.matches?.('[data-message-id]')) {
        const id = String(this.dataset.messageId || '');
        if (id) messageClickHandlers.set(id, { listener, source: this });
        return;
      }
      if (this.matches?.('[data-confirm]')) {
        const key = handlerKey(this);
        if (key) confirmationClickHandlers.set(key, { listener, source: this });
        return;
      }
      if (this.matches?.('[data-split-here]')) {
        const key = handlerKey(this);
        if (key) splitClickHandlers.set(key, { listener, source: this });
        return;
      }
      if (this.matches?.('[data-boundary]')) {
        const key = handlerKey(this);
        if (key) boundaryClickHandlers.set(key, { listener, source: this });
        return;
      }
    }

    if (type === 'scroll' && this instanceof Element && this.matches?.('[data-chat-scroll]')) {
      installPassiveChatScroll(this);
      return;
    }
    return nativeAddEventListener.call(this, type, listener, options);
  };

  Element.prototype.scrollIntoView = function patchedScrollIntoView(options) {
    const chat = this.closest?.('[data-chat-scroll]');
    if (chat) {
      if (suppressChatFocus || stableAction) return;
      const block = options && typeof options === 'object' ? options.block : undefined;
      if (block === 'nearest' && this.matches?.('[data-message-wrap]')) return;
      if (block === 'start') {
        manualScrollUntil = performance.now() + 450;
        const scrollRect = chat.getBoundingClientRect();
        const targetRect = this.getBoundingClientRect();
        const top = Math.max(0, chat.scrollTop + targetRect.top - scrollRect.top - focusOffset());
        nativeScrollTo.call(chat, { top, behavior: 'auto' });
        return;
      }
    }
    return nativeScrollIntoView.call(this, options);
  };

  Element.prototype.scrollTo = function patchedScrollTo(...args) {
    if (this.matches?.('[data-chat-scroll]') && (suppressChatFocus || stableAction)) return;
    return nativeScrollTo.apply(this, args);
  };

  function runStored(map, key, event, { stable = true } = {}) {
    const stored = map.get(key);
    if (!stored) return false;
    if (stable) armStableAction();
    stored.listener.call(stored.source, event);
    return true;
  }

  function focusSituation(id) {
    const target = document.querySelector(`[data-message-situation="${Number(id)}"][data-situation-first="true"]`);
    if (!target) return;
    const scroll = target.closest('[data-chat-scroll]');
    if (!scroll) return;
    manualScrollUntil = performance.now() + 450;
    const scrollRect = scroll.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = Math.max(0, scroll.scrollTop + targetRect.top - scrollRect.top - focusOffset());
    nativeScrollTo.call(scroll, { top, behavior: 'auto' });
    updateLastSnapshot(scroll);
  }

  document.addEventListener('click', (event) => {
    const check = event.target.closest?.('.tw-sit-check');
    if (check) {
      const opener = check.closest?.('[data-open-situation]');
      const id = String(opener?.dataset.openSituation || '');
      if (!id) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      runStored(confirmationClickHandlers, `confirm:${id}`, event);
      return;
    }

    const confirm = event.target.closest?.('[data-confirm]');
    if (confirm) {
      const id = String(confirm.dataset.confirm || '');
      if (!id) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      runStored(confirmationClickHandlers, `confirm:${id}`, event);
      return;
    }

    const split = event.target.closest?.('[data-split-here]');
    if (split) {
      const id = String(split.dataset.splitHere || '');
      if (!id) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      runStored(splitClickHandlers, `split:${id}`, event);
      return;
    }

    const boundary = event.target.closest?.('[data-boundary]');
    if (boundary) {
      const action = String(boundary.dataset.boundary || '');
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      runStored(boundaryClickHandlers, `boundary:${action}`, event);
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
      requestAnimationFrame(() => updateLastSnapshot(document.querySelector('[data-chat-scroll]')));
      return;
    }

    const button = event.target.closest?.('[data-open-situation]');
    if (!button) return;
    const id = Number(button.dataset.openSituation);
    if (!Number.isInteger(id) || id <= 0) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    stableAction = null;
    suppressChatFocus = false;
    document.querySelector('[data-drawer]')?.classList.remove('is-open');
    const slider = document.querySelector(`[data-slider-situation="${id}"]`);
    if (!slider) return;
    slider.click();
    requestAnimationFrame(() => focusSituation(id));
  }, true);

  document.addEventListener('submit', (event) => {
    if (event.target?.id === 'detail-form') armStableAction();
  }, true);

  document.addEventListener('change', (event) => {
    if (event.target?.id === 'reviewer-select') {
      stableAction = null;
      lastViewportSnapshot = null;
      suppressChatFocus = false;
    }
  }, true);

  const app = document.getElementById('review-app');
  if (app) {
    const observer = new MutationObserver((mutations) => {
      const workspaceReset = mutations.some((mutation) => {
        if (mutation.type !== 'childList') return false;
        return [...mutation.addedNodes].some((node) => node instanceof Element && (node.matches?.('.tw-app') || node.querySelector?.('[data-chat-scroll]')));
      });
      if (!workspaceReset) return;

      const snapshot = stableAction?.snapshot || lastViewportSnapshot;
      if (snapshot) scheduleStableRestore(snapshot);
      requestAnimationFrame(() => {
        const scroll = document.querySelector('[data-chat-scroll]');
        if (scroll) installPassiveChatScroll(scroll);
      });
    });
    observer.observe(app, { childList: true });
  }
})();
