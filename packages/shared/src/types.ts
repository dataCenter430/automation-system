export interface TerminusRow {
  id: number;
  task_id: string;
  submission_id: string | null;
  category: string;
  sub_category: string;
  title: string;
  description: string;
  languages: string;
  task_status: number;      // Snorkel lifecycle: 0 Working on, 1 AI review, 2 Human review, 3 Accepted
  task_owner: string | null;
  payment_status: number | null; // 0 None, 1 Pending, 2 Pay out
  created_at: string;
  additional_note: string | null;

  // Pipeline bookkeeping (added by scripts/migrate.sql)
  slug: string | null;
  pipeline_state: number;   // see packages/shared/src/status.ts — NOT task_status
  claude_session_id: string | null;
  attempt: number;
  feedback_attempt: number;
  last_error: string | null;
  zip_path: string | null;
  assignment_id: string | null;
  updated_at: string | null;
}

export interface TerminusImplementationRow {
  id: number;
  task_id: string;
  implementation_summary: string | null;
  difficulty_explanation: string | null;
  solution_explanation: string | null;
  verification_explanation: string | null;
  created_at: string;
}

export type EventStage =
  | "parse" | "build" | "verify" | "fix" | "probe" | "zip"
  | "explain" | "upload" | "feedback" | "submit" | "sync";

export type EventStatus = "started" | "completed" | "failed" | "heartbeat";

export interface PipelineEvent {
  id: number;
  task_id: string;
  stage: EventStage;
  status: EventStatus;
  from_state: number | null;
  to_state: number | null;
  attempt: number;
  detail: Record<string, unknown> | null;
  message: string | null;
  created_at: string;
}
