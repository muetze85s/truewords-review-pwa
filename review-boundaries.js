(() => {
  'use strict';

  const app = document.getElementById('review-app');
  if (!app) return;

  let scheduled = false;

  function numericMessageId(element) {
    const value = Number(element?.dataset?.messageId || 0);
    return Number.isInteger(value) && value > 0 ? value : null;
  }

  function gapNotice(leftElement, rightElement) {
    const left = numericMessageId(leftElement);
    const right = numericMessageId(rightElement);
    if (left === null || right === null || right <= left + 1) return null;

    const distance = right - left;
    const notice = document.createElement('div');
    notice.className = 'export-gap-notice';
    notice.setAttribute('role', 'note');
    notice.innerHTML = `
      <strong>Telegram-ID-Sprung von ${left} auf ${right}</strong>
      <span>Der numerische Abstand beträgt ${distance}. Telegram-IDs sind nicht lückenlos und beweisen daher keine ${distance - 1} fehlenden Nachrichten. Im aktuell geladenen Prüfdatensatz ist zwischen diesen beiden Datensätzen kein weiteres Ereignis gespeichert.</span>`;
    return notice;
  }

  function moveBoundaryControls(messageList) {
    const boundaryBox = app.querySelector('.boundary-box');
    const situationZone = messageList.querySelector('.situation-zone');
    if (!boundaryBox || !situationZone) return;

    const rows = [...boundaryBox.querySelectorAll('.boundary-row')];
    const startBoundary = situationZone.querySelector('.situation-boundary.start');
    const endBoundary = situationZone.querySelector('.situation-boundary.end');

    if (rows[0] && startBoundary) {
      rows[0].classList.add('boundary-control', 'start-control');
      rows[0].setAttribute('aria-label', 'Anfang der Situation verschieben');
      startBoundary.before(rows[0]);
    }

    if (rows[1] && endBoundary) {
      rows[1].classList.add('boundary-control', 'end-control');
      rows[1].setAttribute('aria-label', 'Ende der Situation verschieben');
      endBoundary.after(rows[1]);
    }

    boundaryBox.remove();
  }

  function addGapNotices(messageList) {
    messageList.querySelectorAll('.export-gap-notice').forEach((element) => element.remove());

    const beforeZone = messageList.querySelector('.context-zone.before');
    const beforeMessage = beforeZone?.querySelector('[data-message-id]') || null;
    const situationZone = messageList.querySelector('.situation-zone');
    const assignedMessages = [...messageList.querySelectorAll('.situation-messages [data-message-id]')];
    const afterZone = messageList.querySelector('.context-zone.after');
    const afterMessage = afterZone?.querySelector('[data-message-id]') || null;

    if (beforeMessage && assignedMessages[0] && situationZone) {
      const notice = gapNotice(beforeMessage, assignedMessages[0]);
      if (notice) situationZone.prepend(notice);
    }

    for (let index = 1; index < assignedMessages.length; index += 1) {
      const notice = gapNotice(assignedMessages[index - 1], assignedMessages[index]);
      if (notice) assignedMessages[index].before(notice);
    }

    if (assignedMessages.length && afterMessage && afterZone) {
      const notice = gapNotice(assignedMessages[assignedMessages.length - 1], afterMessage);
      if (notice) afterZone.before(notice);
    }
  }

  function enhance() {
    const messageList = app.querySelector('#message-list');
    if (!messageList) return;

    const messageIds = [...messageList.querySelectorAll('[data-message-id]')]
      .map((element) => element.dataset.messageId)
      .join('|');
    const selected = app.querySelector('.chat-head .eyebrow')?.textContent || '';
    const signature = `${selected}|${messageIds}`;

    if (messageList.dataset.boundaryEnhancement === signature) return;

    moveBoundaryControls(messageList);
    addGapNotices(messageList);
    messageList.dataset.boundaryEnhancement = signature;
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      enhance();
    });
  }

  new MutationObserver(schedule).observe(app, {
    childList: true,
    subtree: true,
  });

  schedule();
})();
