// Shared domain types for the AI Apprentice MVP.

export type QuestionType = "why" | "guardrail" | "exception" | "general";

export interface ScreenEvent {
  id: string;
  t: number; // ms since session start
  summary: string; // e.g. "Invoice 4471 cost center changed from 4711 to 0400"
  field?: string;
  from?: string;
  to?: string;
  frameThumbnail?: string; // small base64 jpeg, redacted
}

export interface QuestionLogEntry {
  id: string;
  t: number;
  type: QuestionType;
  question: string;
  answer?: string;
  relatedEventId?: string;
}

export interface TranscriptTurn {
  id: string;
  t: number;
  role: "agent" | "expert" | "new_hire";
  text: string;
}

export type SessionPhase =
  | "capture"
  | "debrief"
  | "mapped"
  | "teach"
  | "done";

export interface CaptureSession {
  id: string;
  title: string; // e.g. "Accounts Payable - Invoice Coding"
  expertName: string;
  createdAt: number;
  phase: SessionPhase;
  events: ScreenEvent[];
  questions: QuestionLogEntry[];
  transcript: TranscriptTurn[];
  debriefTranscript: TranscriptTurn[];
  offTheRecordRanges: { startT: number; endT: number | null }[];
  workMap?: WorkMap;
}

export interface WorkMapGuardrail {
  id: string;
  rule: string; // "No asset number, no capex booking."
  stopCondition?: string; // "Unknown supplier: stop and ask the controller."
}

export interface WorkMapStep {
  id: string;
  index: number;
  title: string; // "Code the invoice to a cost center"
  screenMoment: { t: number; label: string; eventId?: string };
  decision: string; // "Re-coded from opex (4711) to capex (0400)"
  reason: string; // quoted in the expert's words
  reasonQuote: boolean;
  guardrails: WorkMapGuardrail[];
}

export interface WorkMap {
  sessionId: string;
  title: string;
  generatedAt: number;
  steps: WorkMapStep[];
  judgmentCallCount: number;
  guardrailCount: number;
  teachBackSummary: string;
  teachBackConfirmed: boolean;
  openGaps: string[]; // unresolved items debrief surfaced
}

export type GuardrailSeverity = "info" | "warning" | "stop";

export interface TeachEvaluation {
  id: string;
  t: number;
  stepId?: string;
  correct: boolean;
  note: string;
}

export interface TeachSession {
  id: string;
  sourceSessionId: string;
  newHireName: string;
  createdAt: number;
  events: ScreenEvent[];
  transcript: TranscriptTurn[];
  evaluations: TeachEvaluation[];
  mastered: string[];
  practiceNext: string[];
  completedAt?: number;
}
