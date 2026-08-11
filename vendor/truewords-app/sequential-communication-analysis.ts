export const SITUATION_DEFAULTS = {
  inactivityMs: 15 * 60_000,
  maxMessages: 40,
  maxOpenMs: 6 * 60 * 60_000,
  maxCharacters: 24_000,
} as const;

export const SIGNAL_SOURCES = [
  "chat_import", "telegram_live", "truewords_inline", "sender_source_declaration",
  "recipient_feedback", "sender_feedback", "shared_clarification", "behavior_follow_up",
] as const;

export type SignalSource = typeof SIGNAL_SOURCES[number];
export type ResolutionState = "resolved" | "partially_resolved" | "postponed" | "unresolved" | "abandoned" | "topic_shifted" | "unknown";
export type Trend = "increasing" | "stable" | "decreasing" | "improving" | "worsening" | "unclear";
export type ActualSource = "truewords_inline" | "sender_written" | "sender_declared_ai_assisted" | "sender_declared_external_help" | "external_assistance_confirmed" | "unknown";

export type NormalizedMessageEvent = {
  id: string;
  source: SignalSource;
  senderUserId: string;
  recipientUserId: string;
  text: string;
  sentAt: Date;
  replyToId?: string | null;
  actualSource?: ActualSource;
};

export type CommunicationSituation = {
  id: string;
  source: SignalSource;
  messages: NormalizedMessageEvent[];
  startedAt: Date;
  endedAt: Date;
  status: "open" | "closed";
  closeReason: "inactivity" | "max_messages" | "max_characters" | "max_duration" | "explicit_candidate" | "end_of_import" | "open";
  previousSituationId?: string;
};

export type SituationObservation = {
  patternType: string;
  actorUserId: string;
  recipientUserId: string;
  statement: string;
  evidenceStrength: "weak" | "medium" | "strong" | "very_strong";
  positive: boolean;
};

const normalize = (value: string) => value.trim().replace(/\s+/g, " ");
const lower = (value: string) => normalize(value).toLocaleLowerCase("de");
const words = (value: string) => new Set(lower(value).match(/[\p{L}\p{N}]{3,}/gu) ?? []);
const overlap = (left: string, right: string) => {
  const a = words(left); const b = words(right);
  if (!a.size || !b.size) return 0;
  return [...a].filter((word) => b.has(word)).length / Math.min(a.size, b.size);
};

export function isExplicitClosureCandidate(text: string) {
  return /(?:okay,? dann machen wir das so|danke,? geklärt|gute nacht|lass uns später weiterreden)/iu.test(text);
}

export function segmentCommunicationSituations(
  input: NormalizedMessageEvent[],
  config: Partial<typeof SITUATION_DEFAULTS> = {},
): CommunicationSituation[] {
  const limits = { ...SITUATION_DEFAULTS, ...config };
  const messages = [...input].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  const situations: CommunicationSituation[] = [];
  let current: NormalizedMessageEvent[] = [];
  let characters = 0;
  const close = (reason: CommunicationSituation["closeReason"]) => {
    if (!current.length) return;
    const first = current[0]; const last = current[current.length - 1];
    situations.push({ id: `situation:${first.source}:${first.id}`, source: first.source, messages: current,
      startedAt: first.sentAt, endedAt: last.sentAt, status: "closed", closeReason: reason });
    current = []; characters = 0;
  };
  for (const message of messages) {
    const previous = current[current.length - 1];
    if (previous && message.sentAt.getTime() - previous.sentAt.getTime() >= limits.inactivityMs) close("inactivity");
    if (current.length >= limits.maxMessages) close("max_messages");
    if (current.length && characters + message.text.length > limits.maxCharacters) close("max_characters");
    if (current.length && message.sentAt.getTime() - current[0].sentAt.getTime() > limits.maxOpenMs) close("max_duration");
    current.push(message); characters += message.text.length;
    if (isExplicitClosureCandidate(message.text) && current.length >= 2) close("explicit_candidate");
  }
  if (current.length) {
    const first = current[0]; const last = current[current.length - 1];
    situations.push({ id: `situation:${first.source}:${first.id}`, source: first.source, messages: current,
      startedAt: first.sentAt, endedAt: last.sentAt, status: first.source === "chat_import" ? "closed" : "open",
      closeReason: first.source === "chat_import" ? "end_of_import" : "open" });
  }
  for (let index = 1; index < situations.length; index++) {
    const previous = situations[index - 1]; const currentSituation = situations[index];
    if (overlap(previous.messages.map((m) => m.text).join(" "), currentSituation.messages.map((m) => m.text).join(" ")) >= .25
      || currentSituation.messages.some((message) => previous.messages.some((old) => message.replyToId === old.id))) {
      currentSituation.previousSituationId = previous.id;
    }
  }
  return situations;
}

export function extractSequenceFeatures(situation: CommunicationSituation) {
  const messages = situation.messages;
  const initiator = messages[0]?.senderUserId ?? "";
  const recipient = messages[0]?.recipientUserId ?? "";
  const first = messages[0]?.text ?? "";
  const later = messages.slice(1);
  const directAnswer = later.find((m) => m.senderUserId === recipient);
  const returnToConcern = later.slice(1).some((m) => overlap(first, m.text) >= .28);
  const responsibility = later.some((m) => /\b(?:ich habe|ich war|mein anteil|dafür übernehme ich|das war von mir)\b/iu.test(m.text));
  const repair = later.some((m) => /\b(?:wie kann ich|ich ändere|wiedergutmachen|lass uns|vereinbaren|ich kümmere mich)\b/iu.test(m.text));
  const counterCriticism = Boolean(directAnswer && /\b(?:aber du|du machst doch|was ist mit dir|selber|genauso)\b/iu.test(directAnswer.text));
  const topicShift = Boolean(directAnswer && overlap(first, directAnswer.text) < .12 && counterCriticism && !returnToConcern);
  return { initiator, recipient, first, later, directAnswer, returnToConcern, responsibility, repair, counterCriticism, topicShift };
}

export function analyzeApology(text: string) {
  const value = lower(text);
  const apology = /(?:tut mir leid|entschuldig\w*|verzeih\w*)/u.test(value);
  const conditionalLanguage = /\b(?:falls|wenn ich dich)\b/u.test(value);
  const recipientReaction = /(?:dass du dich|wenn du dich).*?(?:fühl|verletzt)/u.test(value);
  const justificationAdded = /\b(?:aber|weil du|provoziert)\b/u.test(value);
  const counterCriticismAdded = /\b(?:aber du|du machst.*(?:auch|genauso)|jetzt bist du dran)\b/u.test(value);
  const responsibilityShifted = /\b(?:wegen dir|weil du|du hast mich dazu)\b/u.test(value);
  const repairOffered = /\b(?:wiedergutmachen|reparieren|ich kümmere mich|wie kann ich)\b/u.test(value);
  const changePromised = /\b(?:kommt nicht wieder vor|ich werde|ich ändere)\b/u.test(value);
  const apologyUsedToCloseDiscussion = /(?:ich habe mich doch entschuldigt|jetzt muss.*gut sein)/u.test(value);
  const forgivenessDemanded = /(?:musst du mir.*verzeihen|jetzt bist du dran)/u.test(value);
  const specificBehaviorNamed = apology && /\b(?:dass ich|mein verhalten|meine worte)\b/u.test(value);
  const impactAcknowledged = /\b(?:verletzt|belastet|enttäuscht|wirkung)\b/u.test(value);
  const responsibilityAccepted = specificBehaviorNamed && !responsibilityShifted;
  const category = !apology ? "unclear" : apologyUsedToCloseDiscussion ? "apology_used_as_discussion_closure"
    : forgivenessDemanded ? "apology_used_as_exchange" : counterCriticismAdded ? "apology_with_countercriticism"
      : responsibilityShifted ? "apology_with_responsibility_shift" : justificationAdded ? "apology_with_justification"
        : conditionalLanguage ? "conditional_apology" : recipientReaction && !specificBehaviorNamed ? "recipient_reaction_apology"
          : responsibilityAccepted ? "full_responsibility_expression" : "partial_responsibility_expression";
  return { apology, category, specificBehaviorNamed, impactAcknowledged, responsibilityAccepted, conditionalLanguage,
    justificationAdded, counterCriticismAdded, responsibilityShifted, repairOffered, changePromised,
    followThroughObserved: false, apologyUsedToCloseDiscussion, forgivenessDemanded };
}

export function analyzeCommunicationSituation(situation: CommunicationSituation) {
  const f = extractSequenceFeatures(situation);
  const observations: SituationObservation[] = [];
  const response = f.directAnswer?.text ?? "";
  const add = (patternType: string, statement: string, actor = f.recipient, recipient = f.initiator, positive = false, strength: SituationObservation["evidenceStrength"] = "medium") =>
    observations.push({ patternType, actorUserId: actor, recipientUserId: recipient, statement, evidenceStrength: strength, positive });
  if (f.counterCriticism && !f.returnToConcern) add("countercriticism_before_addressing_concern", "Das Ausgangsanliegen wurde zunächst mit einem Gegenpunkt beantwortet und später nicht wieder aufgegriffen.");
  if (/\b(?:aber du|was ist mit|und damals)\b/iu.test(response) && !f.returnToConcern) add("whataboutism_candidate", "Ein anderes Verhalten wurde eingeführt; das Ausgangsanliegen blieb offen.");
  if (/\b(?:damals|früher|letztes mal)\b/iu.test(response) && /\b(?:also|deshalb|selber|auch)\b/iu.test(response) && !f.returnToConcern) add("previous_issue_used_to_displace_current_issue", "Ein früheres Problem wurde vor der Bearbeitung des aktuellen Anliegens eingeführt.");
  if (f.topicShift) add("topic_shift", "Das Ausgangsthema wurde durch ein anderes Thema ersetzt und blieb offen.");
  if ((response.match(/\b(?:außerdem|und noch|damals|immer|nie)\b/giu) ?? []).length >= 2) add("problem_mixing", "Mehrere möglicherweise unabhängige Probleme wurden zusammengeführt.");
  if (/\b(?:weil du|wegen dir|du hast mich dazu)\b/iu.test(response) && !/\b(?:mein anteil|ich habe|ich war)\b/iu.test(response)) add("responsibility_shift", "Das eigene Verhalten wurde ausschließlich mit dem Verhalten des anderen erklärt.");
  if (/(?:übertreibst|nicht so schlimm|so schlimm.*nicht|nur spaß|andere würden)/iu.test(response)) add("impact_relativized", "Anliegen oder wahrgenommene Wirkung wurde relativiert.");
  if (/\bdu (?:willst|sagst|machst) das (?:nur|absichtlich)/iu.test(response)) add("intent_attribution", "Ein vermutetes Motiv wurde als Tatsache formuliert.", f.recipient, f.initiator, false, "weak");
  if (/\b(?:immer|nie|jedes mal|typisch du|grundsätzlich|ständig)\b/iu.test(response)) add("generalization_candidate", "Eine pauschale Formulierung wurde im Situationskontext beobachtet.", f.recipient, f.initiator, false, "weak");
  const turns = situation.messages.map((m) => m.text);
  if (turns.length >= 4 && /\b(?:immer|nie|warum|du)\b/iu.test(turns[0]) && turns.slice(1).filter((t) => /\b(?:weil|aber|ich musste|so war das nicht)\b/iu.test(t)).length >= 2) add("criticism_justification_loop", "Kritik und Rechtfertigung verstärkten sich über mehrere Schritte ohne Klärung.");
  if (f.repair) add("repair_or_clarification", "Eine Reparatur, Klärung oder Vereinbarung wurde angeboten.", f.recipient, f.initiator, true, "strong");
  if (f.responsibility) add("responsibility_taken", "Verantwortung wurde im späteren Verlauf ausdrücklich übernommen.", f.recipient, f.initiator, true, "strong");
  for (const message of situation.messages) {
    const apology = analyzeApology(message.text);
    if (apology.apology) add(apology.category, "Beobachtbare Entschuldigungsbestandteile wurden strukturiert erfasst.", message.senderUserId, message.recipientUserId, apology.responsibilityAccepted, "strong");
  }
  const resolutionState: ResolutionState = f.repair && f.responsibility ? "resolved" : f.repair ? "partially_resolved"
    : /\b(?:später|morgen|pause)\b/iu.test(response) ? "postponed" : f.topicShift ? "topic_shifted"
      : situation.messages.length === 1 ? "unknown" : "unresolved";
  return {
    concern: { initiator: f.initiator, recipient: f.recipient, topic: normalize(f.first).slice(0, 240),
      addressedBehavior: normalize(f.first).slice(0, 300), expressedNeed: /\b(?:brauche|wünsche|möchte|vermisse)\b/iu.test(f.first) ? normalize(f.first).slice(0, 300) : "",
      requestedAction: /\b(?:bitte|kannst du|ich möchte,? dass)\b/iu.test(f.first) ? normalize(f.first).slice(0, 300) : "",
      firstResponseType: f.counterCriticism ? "counterpoint" : f.directAnswer ? "direct_or_contextual_response" : "none",
      wasEventuallyAddressed: f.returnToConcern || f.responsibility || f.repair, resolutionState },
    observations,
  };
}

export function classifyTextSource(input: { viaTrueWords?: boolean; declaration?: string | null; externalConfirmed?: boolean }) {
  const declaration = lower(input.declaration ?? "");
  const sourceDeclaration = /selbst formuliert/u.test(declaration) ? "sender_written"
    : /(?:andere ki|ki formuliert)/u.test(declaration) ? "sender_declared_ai_assisted"
      : /(?:jemandem überarbeitet|externe hilfe|fremd)/u.test(declaration) ? "sender_declared_external_help" : "unknown";
  const actualSource: ActualSource = input.viaTrueWords ? "truewords_inline" : input.externalConfirmed ? "external_assistance_confirmed" : sourceDeclaration === "sender_written" ? "sender_written" : "unknown";
  return { actualSource, sourceDeclaration, public: false, insightEvidence: "none" as const };
}

export function detectStyleDeviation(current: string, baseline: { averageLength: number; formalRatio: number } | null) {
  if (!baseline) return { deviates: false, confidence: 0, source: "unknown" as const };
  const formal = /\b(?:hinsichtlich|dementsprechend|gleichwohl|kommunikationsmuster|bedürfnisorientiert)\b/iu.test(current) ? 1 : 0;
  const lengthDelta = Math.abs(current.length - baseline.averageLength) / Math.max(1, baseline.averageLength);
  return { deviates: lengthDelta > 1.5 || formal > baseline.formalRatio + .5, confidence: 20, source: "style_context_only" as const };
}

export function recipientEffect(input: { explicit?: string | null; response?: string | null; silence?: boolean; baselineDeviation?: boolean }) {
  if (input.explicit && input.explicit !== "skip" && input.explicit !== "unknown") return { category: input.explicit, strength: "strong", source: "explicit_recipient_feedback" };
  if (input.silence || !input.response?.trim()) return { category: "effect_unknown", strength: "none", source: "response_sequence" };
  if (/^(?:ok(?:ay)?|[👍👌🙂])\W*$/iu.test(input.response.trim())) return { category: "effect_unknown", strength: "weak", source: "response_sequence" };
  return { category: "effect_unknown", strength: input.baselineDeviation ? "weak" : "weak", source: input.baselineDeviation ? "recipient_baseline_deviation" : "response_sequence" };
}

export function inlineEvidence(input: { shown?: boolean; selected?: boolean; sent?: boolean; edited?: boolean; laterBehavior?: boolean }) {
  if (input.laterBehavior) return { weight: 5, senderPreference: "strong", behaviorChangeEvidence: "very_strong" };
  if (!input.sent) return { weight: 0, senderPreference: "none", behaviorChangeEvidence: "none" };
  return input.edited ? { weight: 4, senderPreference: "strong", behaviorChangeEvidence: "none" }
    : { weight: 2, senderPreference: "medium", behaviorChangeEvidence: "none" };
}

export function updateTrend(input: { confidence: number; supporting: number; contradicting: number; positiveChange: number; status: string }) {
  const confidence = Math.max(0, Math.min(100, input.confidence + input.supporting * 5 - input.contradicting * 8 - input.positiveChange * 7));
  const trend: Trend = input.positiveChange >= 2 ? "improving" : input.contradicting > input.supporting ? "decreasing"
    : input.supporting > input.contradicting + 1 ? "increasing" : "stable";
  return { confidence, trend, status: confidence < 20 ? "inactive" : input.status };
}

export function sufficientlyComparable(left: { topic: string; contextKey: string }, right: { topic: string; contextKey: string }) {
  return left.contextKey === right.contextKey && overlap(left.topic, right.topic) >= .35;
}

export function detectDoubleStandard(situations: Array<{ actor: string; behavior: string; evaluation: string; contextKey: string }>) {
  if (situations.length < 3) return false;
  for (let i = 0; i < situations.length; i++) for (let j = i + 1; j < situations.length; j++) {
    const a = situations[i]; const b = situations[j];
    if (a.actor !== b.actor && a.contextKey === b.contextKey && overlap(a.behavior, b.behavior) >= .5 && a.evaluation !== b.evaluation) return true;
  }
  return false;
}
