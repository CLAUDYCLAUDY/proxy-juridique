-- ============================================================
-- CLAMO — Migration initiale : espace client
-- Tables : dossiers, messages, documents
-- Sécurité : RLS activée partout.
--   · Écriture : uniquement via la clé service_role (les fonctions
--     Vercel), qui contourne la RLS. Aucune politique d'écriture
--     pour anon / authenticated.
--   · Lecture : le client authentifié (lien magique) ne voit que
--     les dossiers rattachés à son adresse électronique.
-- À exécuter dans Supabase : SQL Editor → New query → Run.
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- Table dossiers ----------
create table if not exists public.dossiers (
  id          uuid primary key,
  email       text,                          -- renseigné au paiement (Stripe) ; sert de clé d'accès à l'espace client
  titre       text not null default 'Nouveau litige',
  statut      text not null default 'echange'
              check (statut in ('echange', 'commande', 'livre')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table  public.dossiers is 'Un dossier = une conversation CLAMO. L''email est renseigné lors du paiement Stripe.';
comment on column public.dossiers.statut is 'echange = échanges en cours ; commande = paiement confirmé ; livre = document généré.';

create index if not exists dossiers_email_idx on public.dossiers (lower(email));

-- ---------- Table messages ----------
create table if not exists public.messages (
  id          bigint generated always as identity primary key,
  dossier_id  uuid not null references public.dossiers (id) on delete cascade,
  role        text not null check (role in ('user', 'assistant')),
  content     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists messages_dossier_idx on public.messages (dossier_id, created_at);

-- ---------- Table documents ----------
create table if not exists public.documents (
  id                 uuid primary key default gen_random_uuid(),
  dossier_id         uuid not null references public.dossiers (id) on delete cascade,
  type               text not null check (type in ('MED', 'REC', 'SAIS', 'DOSS')),
  titre              text not null default 'Document juridique',
  contenu            text not null,             -- texte intégral du document (marqueurs [[DOC]] retirés)
  stripe_session_id  text,
  montant_centimes   integer,
  created_at         timestamptz not null default now()
);

create index if not exists documents_dossier_idx on public.documents (dossier_id, created_at);

-- Une même session de paiement ne peut produire qu'un document (protège des doubles insertions en cas de nouvel essai)
create unique index if not exists documents_stripe_session_uidx
  on public.documents (stripe_session_id) where stripe_session_id is not null;

-- ---------- Mise à jour automatique de updated_at ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists dossiers_set_updated_at on public.dossiers;
create trigger dossiers_set_updated_at
  before update on public.dossiers
  for each row execute function public.set_updated_at();

-- ---------- Row Level Security ----------
alter table public.dossiers  enable row level security;
alter table public.messages  enable row level security;
alter table public.documents enable row level security;

-- Lecture : le client authentifié ne voit que ses dossiers (adresse du lien magique).
drop policy if exists "lecture dossiers par email" on public.dossiers;
create policy "lecture dossiers par email"
  on public.dossiers for select
  to authenticated
  using (
    email is not null
    and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );

drop policy if exists "lecture messages du client" on public.messages;
create policy "lecture messages du client"
  on public.messages for select
  to authenticated
  using (
    exists (
      select 1 from public.dossiers d
      where d.id = messages.dossier_id
        and d.email is not null
        and lower(d.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

drop policy if exists "lecture documents du client" on public.documents;
create policy "lecture documents du client"
  on public.documents for select
  to authenticated
  using (
    exists (
      select 1 from public.dossiers d
      where d.id = documents.dossier_id
        and d.email is not null
        and lower(d.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    )
  );

-- Aucune politique insert/update/delete : seules les fonctions serveur
-- (clé service_role) écrivent ; anon et authenticated ne peuvent rien modifier.
