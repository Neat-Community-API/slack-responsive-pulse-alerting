create table if not exists public.neat_pulse_alert_state (
  device_key text primary key,
  device_id text,
  device_name text not null,
  room_name text,
  location_name text,
  status text not null check (status in ('offline', 'online')),
  active_incident boolean not null default false,
  slack_channel text,
  slack_ts text,
  last_event_id text,
  last_event_type text,
  last_event_at timestamptz not null default timezone('utc', now()),
  raw_payload jsonb not null
);

create index if not exists neat_pulse_alert_state_active_incident_idx
  on public.neat_pulse_alert_state (active_incident);
