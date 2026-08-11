(() => {
  'use strict';

  const MOBILE_BREAKPOINT = 760;

  function escapeHtml(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function idValue(value) {
    return String(value ?? '').trim();
  }

  function messageSituationId(message) {
    return idValue(message?.situationId ?? message?.situation_id ?? '');
  }

  function messageId(message) {
    return idValue(message?.id);
  }

  function baseSituationNumber(id) {
    return idValue(id).match(/^\d+/u)?.[0] || idValue(id) || '1';
  }

  function nextTemporarySituationId(currentId, existingIds) {
    const base = baseSituationNumber(currentId);
    const used = new Set([...existingIds].map(idValue));
    for (let index = 0; index < 26; index += 1) {
      const candidate = `${base}${String.fromCharCode(65 + index)}`;
      if (!used.has(candidate)) return candidate;
    }
    let counter = 1;
    while (used.has(`${base}A${counter}`)) counter += 1;
    return `${base}A${counter}`;
  }

  function orderedSituationIds(messages) {
    const result = [];
    const seen = new Set();
    messages.forEach((message) => {
      const id = messageSituationId(message);
      if (!id || seen.has(id)) return;
      seen.add(id);
      result.push(id);
    });
    return result;
  }

  function situationRange(messages, situationId) {
    const id = idValue(situationId);
    const indexes = [];
    messages.forEach((message, index) => {
      if (messageSituationId(message) === id) indexes.push(index);
    });
    if (!indexes.length) return null;
    return { first: indexes[0], last: indexes[indexes.length - 1], count: indexes.length };
  }

  function isContiguousSituation(messages, situationId) {
    const range = situationRange(messages, situationId);
    if (!range) return true;
    for (let index = range.first; index <= range.last; index += 1) {
      const id = messageSituationId(messages[index]);
      if (id && id !== idValue(situationId)) return false;
    }
    return true;
  }

  function assertContiguousSituations(messages) {
    const ids = orderedSituationIds(messages);
    const broken = ids.filter((id) => !isContiguousSituation(messages, id));
    if (broken.length) throw new Error(`Gestückelte Situationen sind nicht erlaubt: ${broken.join(', ')}`);
    return true;
  }

  function splitSituationAtMessage(model, selectedMessageId) {
    const messages = model.messages.map((message) => ({ ...message }));
    const situations = model.situations.map((item) => ({ ...item }));
    const selectedIndex = messages.findIndex((message) => messageId(message) === idValue(selectedMessageId));
    if (selectedIndex < 0) throw new Error('Nachricht nicht gefunden.');
    const sourceId = messageSituationId(messages[selectedIndex]);
    if (!sourceId) throw new Error('Die Nachricht gehört keiner Situation an.');
    const range = situationRange(messages, sourceId);
    if (!range || selectedIndex <= range.first) {
      throw new Error('Die erste Nachricht ist bereits der Anfang dieser Situation.');
    }

    const existingIds = situations.map((item) => item.id);
    const newId = nextTemporarySituationId(sourceId, existingIds);
    for (let index = selectedIndex; index <= range.last; index += 1) {
      if (messageSituationId(messages[index]) === sourceId) messages[index].situationId = newId;
    }

    const sourceIndex = situations.findIndex((item) => idValue(item.id) === sourceId);
    const source = sourceIndex >= 0 ? situations[sourceIndex] : { id: sourceId, status: 'open' };
    const clone = {
      ...source,
      id: newId,
      status: 'open',
      details: {},
      analysis: {},
      temporary: true,
      splitFrom: sourceId,
    };
    situations.splice(Math.max(0, sourceIndex + 1), 0, clone);
    assertContiguousSituations(messages);
    return { situations, messages, newSituationId: newId, sourceSituationId: sourceId };
  }

  function toggleConfirmedStatus(status) {
    return ['confirmed', 'corrected'].includes(String(status || '').toLowerCase()) ? 'open' : 'confirmed';
  }

  function messageText(message) {
    const value = message?.text;
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      return value.map((part) => typeof part === 'string' ? part : String(part?.text || '')).join('');
    }
    return String(value || '[Nachricht ohne Text]');
  }

  function speaker(message) {
    return String(message?.speaker || message?.from || message?.actor || 'Unbekannt');
  }

  function renderMessage(message, boundary, selected) {
    const situationId = messageSituationId(message);
    const actions = selected && situationId && !boundary.first
      ? `<div class="rv2-message-actions"><button type="button" data-split-here="${escapeHtml(messageId(message))}">Neue Situation ab hier</button></div>`
      : '';
    return `
      <article class="rv2-message ${selected ? 'is-selected-message' : ''}"
        data-message-id="${escapeHtml(messageId(message))}"
        data-message-situation="${escapeHtml(situationId)}"
        ${boundary.first ? 'data-situation-first="true"' : ''}
        ${boundary.last ? 'data-situation-last="true"' : ''}>
        <div class="rv2-message-meta"><strong>${escapeHtml(speaker(message))}</strong><span>${escapeHtml(message.time || message.dateLabel || '')}</span></div>
        <div class="rv2-message-text">${escapeHtml(messageText(message))}</div>
        ${actions}
      </article>`;
  }

  class ReviewV2Timeline {
    constructor(root, model, options = {}) {
      if (!root) throw new Error('Review-V2-Root fehlt.');
      this.root = root;
      this.model = {
        situations: (model?.situations || []).map((item) => ({ ...item, id: idValue(item.id) })),
        messages: (model?.messages || []).map((message) => ({ ...message, situationId: messageSituationId(message) })),
      };
      assertContiguousSituations(this.model.messages);
      this.options = options;
      this.activeId = idValue(options.activeId) || orderedSituationIds(this.model.messages)[0] || '';
      this.selectedMessageId = '';
      this.lastScrollTop = 0;
      this.headerHidden = false;
      this.scrollFrame = 0;
      this.sliderTimer = 0;
      this.suppressSliderUntil = 0;
      this.render();
      this.bind();
      this.activate(this.activeId, { scrollList: false, centerSlider: false });
    }

    situation(id) {
      return this.model.situations.find((item) => idValue(item.id) === idValue(id)) || null;
    }

    orderedIds() {
      return orderedSituationIds(this.model.messages);
    }

    enrichedSituation(item) {
      const id = idValue(item.id);
      const messages = this.model.messages.filter((message) => messageSituationId(message) === id);
      const first = messages[0] || {};
      const last = messages.at(-1) || {};
      return {
        ...item,
        id,
        messageCount: messages.length,
        startDate: item.startDate || first.dateLabel || first.date || '',
        startTime: item.startTime || first.time || '',
        endTime: item.endTime || last.time || '',
      };
    }

    render() {
      this.root.innerHTML = `
        <div class="rv2-shell ${this.headerHidden ? 'is-header-hidden' : ''}">
          <header class="rv2-context-header" data-context-header></header>
          <nav class="rv2-mobile-slider" data-mobile-slider aria-label="Situationen"></nav>
          <div class="rv2-layout">
            <aside class="rv2-sidebar" aria-label="Situationsliste"><div class="rv2-list" data-situation-list></div></aside>
            <main class="rv2-chat" data-chat-scroll><div class="rv2-chat-stream" data-chat-stream></div></main>
          </div>
        </div>`;
      this.renderList();
      this.renderHeader();
      this.renderSlider();
      this.renderChat();
    }

    renderList() {
      const list = this.root.querySelector('[data-situation-list]');
      if (!list) return;
      const ids = this.orderedIds();
      list.innerHTML = ids.map((id) => {
        const item = this.situation(id) || { id, status: 'open' };
        return window.TRUEWORDS_REVIEW_V2.renderSituationCard(this.enrichedSituation(item), {
          active: id === this.activeId,
          editable: id === this.activeId,
        });
      }).join('');
    }

    renderHeader() {
      const header = this.root.querySelector('[data-context-header]');
      if (!header) return;
      const item = this.situation(this.activeId);
      if (!item) {
        header.innerHTML = '';
        return;
      }
      const data = this.enrichedSituation(item);
      header.innerHTML = `
        <div class="rv2-context-primary"><strong>Situation ${escapeHtml(data.id)}</strong><span>${escapeHtml(data.owner || '')}</span><span>${data.messageCount} Nachr.</span></div>
        <div class="rv2-context-secondary"><span>${escapeHtml(data.startDate || '')}</span><span>${escapeHtml(data.startTime || '')}${data.startTime && data.endTime ? ' – ' : ''}${escapeHtml(data.endTime || '')}</span><span>${escapeHtml(window.TRUEWORDS_REVIEW_V2.statusLabels[data.status] || data.status || '')}</span></div>`;
    }

    renderSlider() {
      const slider = this.root.querySelector('[data-mobile-slider]');
      if (!slider) return;
      slider.innerHTML = this.orderedIds().map((id) => {
        const item = this.enrichedSituation(this.situation(id) || { id, status: 'open' });
        return `<button type="button" class="rv2-slider-item ${id === this.activeId ? 'is-active' : ''}" data-slider-situation="${escapeHtml(id)}"><strong>${escapeHtml(id)}</strong><span>${escapeHtml(item.startDate || '')}</span></button>`;
      }).join('');
    }

    renderChat() {
      const stream = this.root.querySelector('[data-chat-stream]');
      if (!stream) return;
      const ids = this.orderedIds();
      const ranges = Object.fromEntries(ids.map((id) => [id, situationRange(this.model.messages, id)]));
      const html = [];
      this.model.messages.forEach((message, index) => {
        const id = messageSituationId(message);
        const range = ranges[id];
        html.push(renderMessage(message, {
          first: Boolean(range && index === range.first),
          last: Boolean(range && index === range.last),
        }, messageId(message) === this.selectedMessageId));
        if (range && index === range.last) {
          const item = this.situation(id) || { id, status: 'open' };
          const done = ['confirmed', 'corrected'].includes(String(item.status || '').toLowerCase());
          html.push(`
            <div class="rv2-situation-end" data-situation-end="${escapeHtml(id)}">
              <span>Ende Situation ${escapeHtml(id)}</span>
              <button type="button" data-confirm-end="${escapeHtml(id)}">${done ? 'Bestätigung zurücknehmen' : 'Situation bestätigen'}</button>
            </div>`);
        }
      });
      stream.innerHTML = html.join('');
      this.applyActiveChatState();
    }

    bind() {
      this.root.addEventListener('click', (event) => {
        const toggle = event.target.closest('[data-toggle-status]');
        if (toggle) {
          event.stopPropagation();
          this.toggleStatus(toggle.dataset.toggleStatus);
          return;
        }
        const endConfirm = event.target.closest('[data-confirm-end]');
        if (endConfirm) {
          this.toggleStatus(endConfirm.dataset.confirmEnd);
          return;
        }
        const split = event.target.closest('[data-split-here]');
        if (split) {
          this.splitHere(split.dataset.splitHere);
          return;
        }
        const sliderItem = event.target.closest('[data-slider-situation]');
        if (sliderItem) {
          this.scrollToSituation(sliderItem.dataset.sliderSituation);
          return;
        }
        const card = event.target.closest('[data-open-situation]');
        if (card) {
          this.scrollToSituation(card.dataset.openSituation);
          return;
        }
        const message = event.target.closest('[data-message-id]');
        if (message) this.selectMessage(message.dataset.messageId);
      });

      this.root.addEventListener('keydown', (event) => {
        const card = event.target.closest('[data-open-situation]');
        if (card && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          this.scrollToSituation(card.dataset.openSituation);
        }
      });

      const chat = this.root.querySelector('[data-chat-scroll]');
      chat?.addEventListener('scroll', () => {
        if (this.scrollFrame) return;
        this.scrollFrame = requestAnimationFrame(() => {
          this.scrollFrame = 0;
          this.handleChatScroll();
        });
      }, { passive: true });

      const slider = this.root.querySelector('[data-mobile-slider]');
      slider?.addEventListener('scroll', () => {
        clearTimeout(this.sliderTimer);
        this.sliderTimer = setTimeout(() => this.snapSliderSelection(), 130);
      }, { passive: true });
    }

    selectMessage(id) {
      this.selectedMessageId = this.selectedMessageId === idValue(id) ? '' : idValue(id);
      const chat = this.root.querySelector('[data-chat-scroll]');
      const previousTop = chat?.scrollTop || 0;
      this.renderChat();
      if (chat) chat.scrollTop = previousTop;
      const selected = this.root.querySelector(`[data-message-id="${CSS.escape(this.selectedMessageId)}"]`);
      selected?.scrollIntoView({ block: 'nearest' });
    }

    splitHere(messageIdValue) {
      const result = splitSituationAtMessage(this.model, messageIdValue);
      this.model.situations = result.situations;
      this.model.messages = result.messages;
      this.activeId = result.newSituationId;
      this.selectedMessageId = '';
      this.renderList();
      this.renderHeader();
      this.renderSlider();
      this.renderChat();
      this.scrollToSituation(result.newSituationId, { block: 'start' });
      this.emitChange('situation_split', {
        sourceSituationId: result.sourceSituationId,
        newSituationId: result.newSituationId,
        startMessageId: idValue(messageIdValue),
      });
    }

    toggleStatus(id) {
      const item = this.situation(id);
      if (!item) return;
      item.status = toggleConfirmedStatus(item.status);
      this.renderList();
      this.renderHeader();
      this.renderChat();
      this.emitChange('situation_status_changed', { situationId: idValue(id), status: item.status });
    }

    scrollToSituation(id, options = {}) {
      const situationId = idValue(id);
      const target = this.root.querySelector(`[data-message-situation="${CSS.escape(situationId)}"][data-situation-first="true"]`);
      if (!target) return;
      this.activate(situationId);
      target.scrollIntoView({ behavior: options.behavior || 'auto', block: options.block || 'start' });
    }

    activate(id, options = {}) {
      const nextId = idValue(id);
      if (!nextId || !this.orderedIds().includes(nextId)) return;
      const changed = nextId !== this.activeId;
      this.activeId = nextId;
      this.renderList();
      this.renderHeader();
      this.renderSlider();
      this.applyActiveChatState();
      if (options.scrollList !== false) {
        this.root.querySelector(`[data-situation-id="${CSS.escape(nextId)}"]`)?.scrollIntoView({ block: 'nearest' });
      }
      if (options.centerSlider !== false) this.centerActiveSlider();
      if (changed) this.options.onActiveChange?.(nextId);
    }

    applyActiveChatState() {
      this.root.querySelectorAll('[data-message-situation]').forEach((node) => {
        node.classList.toggle('is-active-situation', node.dataset.messageSituation === this.activeId);
      });
      this.root.querySelectorAll('[data-situation-end]').forEach((node) => {
        node.classList.toggle('is-active-situation', node.dataset.situationEnd === this.activeId);
      });
    }

    handleChatScroll() {
      const chat = this.root.querySelector('[data-chat-scroll]');
      if (!chat) return;
      const currentTop = chat.scrollTop;
      const direction = currentTop >= this.lastScrollTop ? 'down' : 'up';
      const delta = currentTop - this.lastScrollTop;
      this.lastScrollTop = currentTop;
      this.updateHeaderVisibility(direction, delta, currentTop);
      this.syncActiveFromScroll(direction);
    }

    activationY() {
      const chat = this.root.querySelector('[data-chat-scroll]');
      if (!chat) return 0;
      const rect = chat.getBoundingClientRect();
      const stickyOffset = window.innerWidth <= MOBILE_BREAKPOINT ? (this.headerHidden ? 54 : 92) : 20;
      return rect.top + stickyOffset;
    }

    syncActiveFromScroll(direction) {
      const ids = this.orderedIds();
      let index = Math.max(0, ids.indexOf(this.activeId));
      const anchorY = this.activationY();
      if (direction === 'down') {
        while (index < ids.length - 1) {
          const nextId = ids[index + 1];
          const first = this.root.querySelector(`[data-message-situation="${CSS.escape(nextId)}"][data-situation-first="true"]`);
          if (!first || first.getBoundingClientRect().top > anchorY) break;
          index += 1;
        }
      } else {
        while (index > 0) {
          const previousId = ids[index - 1];
          const last = this.root.querySelector(`[data-message-situation="${CSS.escape(previousId)}"][data-situation-last="true"]`);
          if (!last || last.getBoundingClientRect().bottom < anchorY) break;
          index -= 1;
        }
      }
      if (ids[index] !== this.activeId) this.activate(ids[index]);
    }

    updateHeaderVisibility(direction, delta, scrollTop) {
      if (window.innerWidth > MOBILE_BREAKPOINT) return;
      const shouldHide = direction === 'down' && delta > 2 && scrollTop > 70;
      const shouldShow = direction === 'up' && delta < -2;
      if (!shouldHide && !shouldShow) return;
      const nextHidden = shouldHide ? true : shouldShow ? false : this.headerHidden;
      if (nextHidden === this.headerHidden) return;
      this.headerHidden = nextHidden;
      this.root.querySelector('.rv2-shell')?.classList.toggle('is-header-hidden', this.headerHidden);
    }

    centerActiveSlider() {
      const item = this.root.querySelector(`[data-slider-situation="${CSS.escape(this.activeId)}"]`);
      if (!item) return;
      this.suppressSliderUntil = performance.now() + 350;
      item.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
    }

    snapSliderSelection() {
      if (window.innerWidth > MOBILE_BREAKPOINT || performance.now() < this.suppressSliderUntil) return;
      const slider = this.root.querySelector('[data-mobile-slider]');
      if (!slider) return;
      const sliderRect = slider.getBoundingClientRect();
      const center = sliderRect.left + sliderRect.width / 2;
      let best = null;
      let distance = Infinity;
      slider.querySelectorAll('[data-slider-situation]').forEach((item) => {
        const rect = item.getBoundingClientRect();
        const itemCenter = rect.left + rect.width / 2;
        const currentDistance = Math.abs(itemCenter - center);
        if (currentDistance < distance) {
          distance = currentDistance;
          best = item;
        }
      });
      const id = best?.dataset?.sliderSituation;
      if (id && id !== this.activeId) this.scrollToSituation(id, { behavior: 'smooth' });
    }

    emitChange(type, payload) {
      this.options.onChange?.({ type, payload, model: this.snapshot() });
    }

    snapshot() {
      return {
        situations: this.model.situations.map((item) => ({ ...item })),
        messages: this.model.messages.map((message) => ({ ...message })),
        activeSituationId: this.activeId,
      };
    }
  }

  window.TRUEWORDS_REVIEW_V2_TIMELINE = Object.freeze({
    ReviewV2Timeline,
    nextTemporarySituationId,
    splitSituationAtMessage,
    assertContiguousSituations,
    isContiguousSituation,
    orderedSituationIds,
    toggleConfirmedStatus,
  });
})();
