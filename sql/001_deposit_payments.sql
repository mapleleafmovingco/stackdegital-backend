-- Deposit payments. Run once in the Supabase SQL editor.
-- Extends the existing portal schema (public.projects, public.has_role).

-- 1. Price data lives on the project, never in the client -------------------

alter table public.projects
  add column estimate_cents  integer check (estimate_cents > 0),   -- e.g. 1200000 = $12,000.00; null until quoted
  add column deposit_percent integer not null default 25 check (deposit_percent between 1 and 100),
  add column currency        text not null default 'cad' check (currency ~ '^[a-z]{3}$'),
  add column deposit_status  text not null default 'not_started'
             check (deposit_status in ('not_started','pending','paid','needs_review','refunded'));

-- Clients may insert their own project requests and admins may edit projects
-- from the browser, so RLS alone does not protect the new columns. This
-- trigger does: browser sessions can never set deposit_status, and only
-- admins can set the quote. The backend (service_role) is not restricted.
create or replace function public.guard_project_payment_fields()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.deposit_status := 'not_started';
    if not public.has_role(auth.uid(), 'admin') then
      new.estimate_cents  := null;
      new.deposit_percent := 25;
      new.currency        := 'cad';
    end if;
    return new;
  end if;

  if new.deposit_status is distinct from old.deposit_status then
    raise exception 'deposit_status is managed by the payment backend';
  end if;
  if not public.has_role(auth.uid(), 'admin') and (
       new.estimate_cents  is distinct from old.estimate_cents
    or new.deposit_percent is distinct from old.deposit_percent
    or new.currency        is distinct from old.currency) then
    raise exception 'only admins can change the estimate';
  end if;
  return new;
end $$;

create trigger guard_project_payment_fields
  before insert or update on public.projects
  for each row execute function public.guard_project_payment_fields();

-- 2. One row per checkout attempt ------------------------------------------

create table public.payments (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references public.projects(id),
  user_id               uuid not null references auth.users(id),
  purpose               text not null default 'deposit',
  amount_cents          integer not null check (amount_cents > 0),
  currency              text not null,
  stripe_session_id     text unique,
  stripe_payment_intent text,
  status                text not null default 'pending'
                        check (status in ('pending','paid','expired','failed','needs_review','refunded')),
  created_at            timestamptz not null default now()
);

-- At most one open deposit attempt per project: a concurrent double-click
-- cannot create two Checkout Sessions.
create unique index payments_one_pending_deposit
  on public.payments (project_id) where purpose = 'deposit' and status = 'pending';

create index payments_project_id_idx on public.payments (project_id);

-- 3. Webhook de-duplication -------------------------------------------------

create table public.stripe_events (
  id          text primary key,         -- Stripe event ID (evt_...)
  type        text not null,
  received_at timestamptz not null default now()
);

-- 4. Access -----------------------------------------------------------------

alter table public.payments      enable row level security;
alter table public.stripe_events enable row level security;

-- Clients may READ their own payments. No insert/update/delete policies or
-- grants, so only the backend (secret key) can change payment state.
revoke all on public.payments, public.stripe_events from anon, authenticated;
grant select on public.payments to authenticated;
grant all on public.payments, public.stripe_events to service_role;

create policy "owner or admin reads payments"
  on public.payments for select to authenticated
  using (user_id = auth.uid() or public.has_role(auth.uid(), 'admin'));

-- stripe_events: no policies = no client access at all
