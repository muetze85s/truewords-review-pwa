import baseWorker, {
  activeDatasetRow,
  reviewerSubmissionTimes,
  openDisputeTotal,
} from './worker-boundary-pairs';
import { sendPush } from '../push-send.mjs';
import { localYmd, dueReminderSlots, disputeAlertDue, parseHhmm } from '../push-schedule-logic.mjs';

/**
 * Oberste Worker-Schicht: Web-Push. Fängt ausschließlich /api/push/* und die
 * Einstellungsseite ab, beobachtet Runden-Abgaben für den Sofort-Hinweis und
 * trägt den Cron-`scheduled`-Handler. Alles andere geht unverändert an die
 * Doppelprüfung (baseWorker) und die Kette darunter. Die Basisdaten bleiben
 * unberührt — diese Schicht liest nur und schreibt ausschließlich in die
 * push_*-Tabellen.
 */

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ACTIVE_DATASET_ID: string;
  PHILIPP_REVIEW_TOKEN?: string;
  LENA_REVIEW_TOKEN?: string;
  ADMIN_REVIEW_TOKEN?: string;
  VAPID_PUBLIC?: string;
  VAPID_PRIVATE?: string;
  VAPID_SUBJECT?: string;
}

type Role = 'Philipp' | 'Lena';

const SESSION_COOKIE = 'tw_review_session_v2';
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'x-content-type-options': 'nosniff',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}
function error(message: string, status = 400): Response {
  return json({ ok: false, error: message }, status);
}

function cookieValue(request: Request, name: string): string {
  const cookie = request.headers.get('cookie') || '';
  for (const part of cookie.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return '';
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sessionReviewer(request: Request, env: Env): Promise<Role | null> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!/^[a-f0-9]{64}$/iu.test(token)) return null;
  const row = await env.DB.prepare(`
    SELECT u.role FROM review_sessions s
    JOIN review_users u ON u.id = s.user_id
    WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.is_active = 1
    LIMIT 1
  `).bind(await sha256Hex(token), new Date().toISOString()).first<{ role: Role }>();
  return row?.role ?? null;
}

// ------------------------------------------------------------- Einstellungen

type Settings = {
  reminders_lena_enabled: number;
  reminders_philipp_enabled: number;
  lena_time_1: string;
  lena_time_2: string;
  philipp_time_1: string;
  philipp_time_2: string;
  lena_tz: string;
  philipp_tz: string;
  notify_philipp_on_lena_submit: number;
  dispute_alert_enabled: number;
  dispute_threshold: number;
};

async function loadSettings(env: Env): Promise<Settings> {
  const row = await env.DB.prepare('SELECT * FROM push_settings WHERE id = 1').first<Settings>();
  // Die Migration legt die Zeile an; als Sicherheitsnetz Defaults, falls nicht.
  return row ?? {
    reminders_lena_enabled: 1,
    reminders_philipp_enabled: 1,
    lena_time_1: '09:00',
    lena_time_2: '18:00',
    philipp_time_1: '09:00',
    philipp_time_2: '18:00',
    lena_tz: 'Europe/Berlin',
    philipp_tz: 'Asia/Bangkok',
    notify_philipp_on_lena_submit: 1,
    dispute_alert_enabled: 1,
    dispute_threshold: 5,
  };
}

async function hasSubscription(env: Env, reviewer: Role): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 FROM push_subscriptions WHERE reviewer = ?1 LIMIT 1')
    .bind(reviewer).first();
  return Boolean(row);
}

// ------------------------------------------------------------- Endpunkte

async function pushConfig(request: Request, env: Env, reviewer: Role): Promise<Response> {
  return json({
    ok: true,
    reviewer,
    publicKey: env.VAPID_PUBLIC || '',
    subscribed: await hasSubscription(env, reviewer),
  });
}

async function subscribe(request: Request, env: Env, reviewer: Role): Promise<Response> {
  let body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  try {
    body = await request.json();
  } catch {
    return error('Ungültige Anfrage.');
  }
  const endpoint = String(body.endpoint || '');
  const p256dh = String(body.keys?.p256dh || '');
  const auth = String(body.keys?.auth || '');
  if (!/^https:\/\//u.test(endpoint) || !p256dh || !auth) return error('Abo-Daten unvollständig.', 422);

  await env.DB.prepare(`
    INSERT INTO push_subscriptions (endpoint, reviewer, p256dh, auth)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(endpoint) DO UPDATE SET
      reviewer = excluded.reviewer, p256dh = excluded.p256dh, auth = excluded.auth
  `).bind(endpoint, reviewer, p256dh, auth).run();
  return json({ ok: true });
}

async function unsubscribe(request: Request, env: Env, reviewer: Role): Promise<Response> {
  let body: { endpoint?: unknown };
  try {
    body = await request.json();
  } catch {
    return error('Ungültige Anfrage.');
  }
  const endpoint = String(body.endpoint || '');
  if (!endpoint) return error('Endpunkt fehlt.');
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1 AND reviewer = ?2')
    .bind(endpoint, reviewer).run();
  return json({ ok: true });
}

async function getSettings(env: Env): Promise<Response> {
  const settings = await loadSettings(env);
  return json({
    ok: true,
    publicKey: env.VAPID_PUBLIC || '',
    settings,
    devices: {
      lenaSubscribed: await hasSubscription(env, 'Lena'),
      philippSubscribed: await hasSubscription(env, 'Philipp'),
    },
  });
}

async function saveSettings(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return error('Ungültige Anfrage.');
  }
  const bool = (value: unknown): number => (value ? 1 : 0);
  // Leerer String = diese Zeit ist abgeschaltet (der Cron überspringt sie, weil
  // parseHhmm(null) → null). Nur bei nicht-leerem Unfug wird der alte Wert gehalten.
  const time = (value: unknown, fallback: string): string => {
    const text = String(value ?? '').trim();
    if (text === '') return '';
    return parseHhmm(text) === null ? fallback : text;
  };
  const current = await loadSettings(env);
  const threshold = Number(body.dispute_threshold);
  const next: Settings = {
    reminders_lena_enabled: bool(body.reminders_lena_enabled),
    reminders_philipp_enabled: bool(body.reminders_philipp_enabled),
    lena_time_1: time(body.lena_time_1, current.lena_time_1),
    lena_time_2: time(body.lena_time_2, current.lena_time_2),
    philipp_time_1: time(body.philipp_time_1, current.philipp_time_1),
    philipp_time_2: time(body.philipp_time_2, current.philipp_time_2),
    lena_tz: current.lena_tz,
    philipp_tz: current.philipp_tz,
    notify_philipp_on_lena_submit: bool(body.notify_philipp_on_lena_submit),
    dispute_alert_enabled: bool(body.dispute_alert_enabled),
    dispute_threshold: Number.isInteger(threshold) && threshold >= 1 && threshold <= 999 ? threshold : current.dispute_threshold,
  };
  await env.DB.prepare(`
    UPDATE push_settings SET
      reminders_lena_enabled = ?1, reminders_philipp_enabled = ?2,
      lena_time_1 = ?3, lena_time_2 = ?4, philipp_time_1 = ?5, philipp_time_2 = ?6,
      notify_philipp_on_lena_submit = ?7, dispute_alert_enabled = ?8, dispute_threshold = ?9,
      updated_at = ?10
    WHERE id = 1
  `).bind(
    next.reminders_lena_enabled, next.reminders_philipp_enabled,
    next.lena_time_1, next.lena_time_2, next.philipp_time_1, next.philipp_time_2,
    next.notify_philipp_on_lena_submit, next.dispute_alert_enabled, next.dispute_threshold,
    new Date().toISOString(),
  ).run();
  return json({ ok: true, settings: next });
}

async function handlePushApi(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const reviewer = await sessionReviewer(request, env);
  if (!reviewer) return error('Nicht angemeldet.', 401);

  if (url.pathname === '/api/push/config' && request.method === 'GET') {
    return pushConfig(request, env, reviewer);
  }
  if (url.pathname === '/api/push/subscribe' && request.method === 'POST') {
    return subscribe(request, env, reviewer);
  }
  if (url.pathname === '/api/push/subscribe' && request.method === 'DELETE') {
    return unsubscribe(request, env, reviewer);
  }
  // Einstellungen strikt nur für Philipp — Lena kommt hier nicht durch.
  if (url.pathname === '/api/push/settings') {
    if (reviewer !== 'Philipp') return error('Nur Philipp darf die Benachrichtigungen steuern.', 403);
    if (request.method === 'GET') return getSettings(env);
    if (request.method === 'POST') return saveSettings(request, env);
  }
  if (url.pathname === '/api/push/test' && request.method === 'POST') {
    if (reviewer !== 'Philipp') return error('Nur Philipp darf testen.', 403);
    await notifyReviewer(env, reviewer, 'TrueWords Test', 'Push funktioniert!');
    return json({ ok: true, sent: true });
  }
  return error('Endpunkt nicht gefunden.', 404);
}

// ------------------------------------------------------------- Versand

type VapidConfig = { publicKey: string; privateKey: string; subject: string };

function vapidFrom(env: Env): VapidConfig | null {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE || !env.VAPID_SUBJECT) return null;
  return { publicKey: env.VAPID_PUBLIC, privateKey: env.VAPID_PRIVATE, subject: env.VAPID_SUBJECT };
}

/** Schickt eine Nachricht an alle Geräte einer Person; räumt tote Abos ab. */
async function notifyReviewer(env: Env, reviewer: Role, title: string, bodyText: string): Promise<void> {
  const vapid = vapidFrom(env);
  if (!vapid) return;
  const rows = await env.DB.prepare(`
    SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE reviewer = ?1
  `).bind(reviewer).all<{ endpoint: string; p256dh: string; auth: string }>();
  const payload = JSON.stringify({ title, body: bodyText, url: '/doppelpruefung.html' });
  for (const subscription of rows.results || []) {
    try {
      const status = await sendPush(subscription, payload, vapid);
      if (status === 404 || status === 410) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(subscription.endpoint).run();
      }
    } catch (caught) {
      console.error('Push send failed', caught);
    }
  }
}

async function alreadySent(env: Env, reviewer: Role, kind: string, ymd: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 FROM push_state WHERE reviewer = ?1 AND kind = ?2 AND ymd = ?3 LIMIT 1')
    .bind(reviewer, kind, ymd).first();
  return Boolean(row);
}
async function markSent(env: Env, reviewer: Role, kind: string, ymd: string): Promise<void> {
  await env.DB.prepare('INSERT OR IGNORE INTO push_state (reviewer, kind, ymd) VALUES (?1, ?2, ?3)')
    .bind(reviewer, kind, ymd).run();
}
async function sentReminderSlots(env: Env, reviewer: Role, ymd: string): Promise<number[]> {
  const rows = await env.DB.prepare(`
    SELECT kind FROM push_state WHERE reviewer = ?1 AND ymd = ?2 AND kind LIKE 'reminder:%'
  `).bind(reviewer, ymd).all<{ kind: string }>();
  return (rows.results || []).map((row) => Number(row.kind.split(':')[1])).filter((slot) => Number.isInteger(slot));
}

/** Sofort-Hinweis: hat Lena eine Runde neu abgegeben, geht das an Philipp. */
async function maybeNotifyOnSubmit(env: Env, round: number, request: Request, response: Response): Promise<void> {
  try {
    const reviewer = await sessionReviewer(request, env);
    if (reviewer !== 'Lena') return;
    // `response` ist bereits ein dedizierter Klon (siehe fetch) — direkt lesen.
    const data = await response.json().catch(() => null) as { ok?: boolean; submitted?: boolean } | null;
    if (!data?.ok || !data?.submitted) return;
    const settings = await loadSettings(env);
    if (!settings.notify_philipp_on_lena_submit) return;
    // Dedup je Runde (ymd fix '-'), damit ein erneutes Abgeben nicht doppelt meldet.
    if (await alreadySent(env, 'Philipp', `lena_submit:${round}`, '-')) return;
    await markSent(env, 'Philipp', `lena_submit:${round}`, '-');
    await notifyReviewer(env, 'Philipp', 'TrueWords', `Lena hat Runde ${round} abgegeben.`);
  } catch (caught) {
    console.error('Submit notify failed', caught);
  }
}

// ------------------------------------------------------------- Cron

async function runScheduled(env: Env): Promise<void> {
  const vapid = vapidFrom(env);
  if (!vapid) return; // ohne Schlüssel nichts zu tun
  const dataset = await activeDatasetRow(env);
  if (!dataset) return;
  const settings = await loadSettings(env);
  const now = new Date();

  // Offene Streitfälle einmal berechnen (gleiche Zählung wie die Übersicht).
  let openDisputes = 0;
  try {
    openDisputes = await openDisputeTotal(env, dataset, 1, 'skip');
  } catch (caught) {
    console.error('openDisputeTotal failed', caught);
  }

  const roleConfig: Array<{ reviewer: Role; tz: string; times: string[]; enabled: boolean }> = [
    {
      reviewer: 'Lena',
      tz: settings.lena_tz,
      times: [settings.lena_time_1, settings.lena_time_2],
      enabled: Boolean(settings.reminders_lena_enabled),
    },
    {
      reviewer: 'Philipp',
      tz: settings.philipp_tz,
      times: [settings.philipp_time_1, settings.philipp_time_2],
      enabled: Boolean(settings.reminders_philipp_enabled),
    },
  ];

  for (const config of roleConfig) {
    const ymd = localYmd(now, config.tz);

    // Erinnerungen — nur wenn an dem Ortstag noch keine Runde abgegeben.
    const submissionTimes = await reviewerSubmissionTimes(env, dataset.id, config.reviewer);
    const submittedToday = submissionTimes.some((iso) => localYmd(new Date(iso), config.tz) === ymd);
    const sentSlotsToday = await sentReminderSlots(env, config.reviewer, ymd);
    const dueSlots = dueReminderSlots({
      now,
      timeZone: config.tz,
      times: config.times,
      enabled: config.enabled,
      submittedToday,
      sentSlotsToday,
    });
    for (const slot of dueSlots) {
      const kind = `reminder:${slot}`;
      if (await alreadySent(env, config.reviewer, kind, ymd)) continue;
      await markSent(env, config.reviewer, kind, ymd);
      await notifyReviewer(env, config.reviewer, 'TrueWords', 'Erinnerung: Deine Runde wartet.');
    }

    // Streitfall-Warnung — an beide, einmal je Ortstag pro Person.
    const disputeSent = await alreadySent(env, config.reviewer, 'dispute', ymd);
    if (disputeAlertDue({
      enabled: Boolean(settings.dispute_alert_enabled),
      openCount: openDisputes,
      threshold: settings.dispute_threshold,
      sentToday: disputeSent,
    })) {
      await markSent(env, config.reviewer, 'dispute', ymd);
      await notifyReviewer(env, config.reviewer, 'TrueWords', `${openDisputes} offene Streitfälle warten auf euch.`);
    }
  }
}

// ------------------------------------------------------------- Verdrahtung

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname.startsWith('/api/push/')) {
        return await handlePushApi(request, env);
      }

      // Einstellungsseite strikt auf Philipp beschränkt — Lena bekommt sie auch
      // per Direkt-URL nicht.
      if (url.pathname === '/push-settings.html' && (request.method === 'GET' || request.method === 'HEAD')) {
        const reviewer = await sessionReviewer(request, env);
        if (reviewer !== 'Philipp') {
          return new Response(null, { status: 302, headers: { location: '/doppelpruefung.html', 'cache-control': 'no-store' } });
        }
        const assetUrl = new URL(request.url);
        assetUrl.search = '';
        return env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET', headers: request.headers }));
      }

      // Sofort-Hinweis: Runden-Abgabe beobachten, ohne sie zu verändern.
      const submitMatch = url.pathname.match(/^\/api\/rounds\/(\d+)\/submit$/u);
      if (submitMatch && request.method === 'POST') {
        const response = await baseWorker.fetch(request, env);
        // Klon SYNCHRON ziehen, bevor der Originalkörper an den Client streamt —
        // sonst ist er im waitUntil schon verbraucht/gesperrt.
        const forNotify = response.clone();
        ctx.waitUntil(maybeNotifyOnSubmit(env, Number(submitMatch[1]), request, forNotify));
        return response;
      }

      return baseWorker.fetch(request, env);
    } catch (caught) {
      console.error('Push worker failed', caught);
      return baseWorker.fetch(request, env);
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScheduled(env));
  },
};
