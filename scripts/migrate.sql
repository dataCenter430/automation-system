-- Snorkel Automation Workflow — additive migration. Nothing is dropped or renamed.
--
-- `terminus.task_status` is SNORKEL'S lifecycle (0 Working on / 1 AI review / 2 Human
-- review / 3 Accepted) and `payment_status` is 0 None / 1 Pending / 2 Pay out. Neither
-- can carry build-pipeline state, so the pipeline gets its own column.

alter table terminus
  add column if not exists slug              text,
  add column if not exists pipeline_state    smallint not null default 0,
  add column if not exists claude_session_id text,
  add column if not exists attempt           smallint not null default 0,
  add column if not exists feedback_attempt  smallint not null default 0,
  add column if not exists last_error        text,
  add column if not exists zip_path          text,
  -- The per-task id from the revise-list href (?assignmentId=). `submission_id` holds the
  -- project-level uuid from /projects/{p}/submission-{THIS}/review, which is the same for
  -- every task — assignment_id is the one that actually identifies OUR task.
  add column if not exists assignment_id     uuid,
  add column if not exists updated_at        timestamptz default now();

comment on column terminus.pipeline_state is
  'Build pipeline state. 0=DRAFT (inert; the worker will never touch it), 5=QUEUED (human clicked Start Build), 10=BUILD_RUNNING, 20=BUILT, 30=VERIFY_RUNNING, 35=VERIFY_FAILED, 40=VERIFIED, 45=FIX_RUNNING, 50=ZIPPED, 55=EXPLAINED, 60=UPLOADING, 65=CHECKING_FEEDBACK, 67=FEEDBACK_FAILED, 69=REMOTE_FIX_RUNNING, 70=AWAITING_APPROVAL, 80=SUBMITTING, 90=SUBMITTED, -1=FAILED, -2=NEEDS_HUMAN. Distinct from task_status.';

create index if not exists terminus_pipeline_state_idx on terminus (pipeline_state);
create unique index if not exists terminus_task_id_key on terminus (task_id);

alter table terminus_implementation
  add column if not exists difficulty_explanation   text,
  add column if not exists solution_explanation     text,
  add column if not exists verification_explanation text;

create unique index if not exists terminus_implementation_task_id_key
  on terminus_implementation (task_id);

-- Append-only progress log. One row per stage boundary, including every Claude turn
-- completion. This is what the dashboard renders and what lets you answer "why did task X
-- fail" without opening a log file.
create table if not exists pipeline_events (
  id         bigserial primary key,
  task_id    uuid       not null,
  stage      text       not null,  -- parse|build|verify|fix|probe|zip|explain|upload|feedback|submit|sync
  status     text       not null,  -- started|completed|failed|heartbeat
  from_state smallint,
  to_state   smallint,
  attempt    smallint   default 0,
  detail     jsonb,                -- claude: {session_id,subtype,num_turns,total_cost_usd,duration_ms}
                                   -- docker: {oracle_reward,null_reward,lint_findings,exit_code}
  message    text,
  created_at timestamptz default now()
);

create index if not exists pipeline_events_task_idx on pipeline_events (task_id, created_at desc);

-- Keep updated_at honest so a stuck row is visible at a glance.
create or replace function touch_terminus_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists terminus_touch_updated_at on terminus;
create trigger terminus_touch_updated_at
  before update on terminus
  for each row execute function touch_terminus_updated_at();

-- submission_id is only known AFTER Snorkel accepts the submission, so a row cannot
-- possibly carry it at insert time. The original NOT NULL made queueing a task impossible.
alter table terminus alter column submission_id drop not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- ACCEPTED-TASK IMPLEMENTATION LIBRARY.
--
-- A task that clears human review is a PROVEN recipe. We mark its implementation row accepted
-- and denormalise the few fields retrieval needs (category / languages / title / slug), so a
-- future build of a SIMILAR task can be handed the summaries of accepted ones and copy what
-- worked. `implementation_summary` was always in the table but never written; it is now the
-- assembled recipe. Denormalising the keys keeps retrieval a single-table filter, no join.
alter table terminus_implementation
  add column if not exists accepted     boolean     not null default false,
  add column if not exists accepted_at  timestamptz,
  add column if not exists category     text,
  add column if not exists sub_category text,
  add column if not exists languages    text,
  add column if not exists title        text,
  add column if not exists slug         text;

create index if not exists terminus_implementation_accepted_idx
  on terminus_implementation (accepted, category);
