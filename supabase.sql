create extension if not exists pgcrypto;

create table public.menus (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  active boolean not null default true
);

create unique index one_active_menu on public.menus (active) where active;

create table public.flavors (
  id uuid primary key default gen_random_uuid(),
  menu_id uuid not null references public.menus(id) on delete cascade,
  position integer not null,
  name text not null,
  unique (menu_id, name)
);

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  menu_id uuid not null references public.menus(id) on delete cascade,
  name text not null,
  name_key text not null,
  updated_at timestamptz not null default now(),
  unique (menu_id, name_key)
);

create table public.order_items (
  order_id uuid not null references public.orders(id) on delete cascade,
  flavor_id uuid not null references public.flavors(id) on delete cascade,
  scoops text not null check (trim(scoops) <> ''),
  primary key (order_id, flavor_id)
);

alter table public.menus enable row level security;
alter table public.flavors enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

revoke all on public.menus, public.flavors, public.orders, public.order_items from anon, authenticated;

create or replace function public.get_active_menu()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'id', m.id,
    'createdAt', m.created_at,
    'flavors', coalesce((
      select jsonb_agg(jsonb_build_object('id', f.id, 'name', f.name) order by f.position)
      from flavors f where f.menu_id = m.id
    ), '[]'::jsonb),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
        'name', o.name,
        'nameKey', o.name_key,
        'scoops', coalesce((
          select jsonb_object_agg(oi.flavor_id::text, oi.scoops)
          from order_items oi where oi.order_id = o.id
        ), '{}'::jsonb)
      ) order by o.name)
      from orders o where o.menu_id = m.id
    ), '[]'::jsonb)
  )
  from menus m
  where m.active
  limit 1;
$$;

create or replace function public.save_order(p_name text, p_scoops jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_menu_id uuid;
  saved_order_id uuid;
  clean_name text := trim(p_name);
begin
  if clean_name = '' or length(clean_name) > 80 then
    raise exception 'Enter a name between 1 and 80 characters.';
  end if;

  select id into current_menu_id from menus where active limit 1;
  if current_menu_id is null then raise exception 'There is no active menu.'; end if;

  insert into orders (menu_id, name, name_key)
  values (current_menu_id, clean_name, lower(clean_name))
  on conflict (menu_id, name_key) do update
    set name = excluded.name, updated_at = now()
  returning id into saved_order_id;

  delete from order_items where order_id = saved_order_id;
  insert into order_items (order_id, flavor_id, scoops)
  select saved_order_id, f.id, trim(value)
  from jsonb_each_text(p_scoops) requested(id, value)
  join flavors f on f.id::text = requested.id and f.menu_id = current_menu_id
  where trim(value) <> ''
    and case
      when trim(value) ~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)$' then trim(value)::numeric <> 0
      else true
    end;
end;
$$;

create or replace function public.cancel_order(p_name_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_menu_id uuid;
begin
  select id into current_menu_id from menus where active limit 1;
  if current_menu_id is null then raise exception 'There is no active menu.'; end if;

  delete from orders
  where menu_id = current_menu_id
    and name_key = lower(trim(p_name_key));
end;
$$;

create or replace function public.start_new_menu(p_flavors text[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  new_menu_id uuid;
begin
  if coalesce(array_length(p_flavors, 1), 0) = 0 then
    raise exception 'Enter at least one flavor.';
  end if;
  if exists (select 1 from unnest(p_flavors) value where trim(value) = '') then
    raise exception 'Flavor names cannot be blank.';
  end if;
  if (select count(*) from unnest(p_flavors)) <> (select count(distinct lower(trim(value))) from unnest(p_flavors) value) then
    raise exception 'Flavor names must be unique.';
  end if;

  update menus set active = false, archived_at = now() where active;
  insert into menus default values returning id into new_menu_id;
  insert into flavors (menu_id, position, name)
  select new_menu_id, position::integer, trim(name)
  from unnest(p_flavors) with ordinality as item(name, position);
end;
$$;

create or replace function public.get_menu_history()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', m.id,
    'createdAt', m.created_at,
    'archivedAt', m.archived_at,
    'orderCount', (select count(*) from orders o where o.menu_id = m.id)
  ) order by m.created_at desc), '[]'::jsonb)
  from menus m where not m.active;
$$;

revoke all on function public.get_active_menu() from public;
revoke all on function public.save_order(text, jsonb) from public;
revoke all on function public.cancel_order(text) from public;
revoke all on function public.start_new_menu(text[]) from public;
revoke all on function public.get_menu_history() from public;
grant execute on function public.get_active_menu() to anon, authenticated;
grant execute on function public.save_order(text, jsonb) to anon, authenticated;
grant execute on function public.cancel_order(text) to anon, authenticated;
grant execute on function public.start_new_menu(text[]) to anon, authenticated;
grant execute on function public.get_menu_history() to anon, authenticated;