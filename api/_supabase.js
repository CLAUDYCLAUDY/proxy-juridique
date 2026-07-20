/* ============================================================
   CLAMO — Accès Supabase côté serveur (clé service_role)
   Fichier préfixé « _ » : Vercel ne le déploie pas comme fonction.
   Aucune dépendance : appels REST directs (PostgREST).
   Toutes les opérations sont « best effort » : une indisponibilité
   de Supabase ne doit JAMAIS faire échouer le chat ni le paiement.
   Variables attendues :
   - SUPABASE_URL (ou NEXT_PUBLIC_SUPABASE_URL)
   - SUPABASE_SERVICE_ROLE_KEY
   ============================================================ */

const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ready() { return Boolean(SUPABASE_URL && SERVICE_KEY); }
function isUuid(v) { return typeof v === "string" && UUID_RE.test(v); }

function headers(extra) {
  return {
    "apikey": SERVICE_KEY,
    "Authorization": `Bearer ${SERVICE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function rest(method, path, body, extraHeaders, ms = 4000) {
  if (!ready()) return { ok: false, status: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method,
      headers: headers(extraHeaders),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    console.log("Supabase indisponible:", e.message);
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/* Crée le dossier s'il n'existe pas encore (n'écrase jamais l'existant). */
async function ensureDossier(dossierId, titre) {
  if (!isUuid(dossierId)) return;
  await rest(
    "POST",
    "dossiers?on_conflict=id",
    [{ id: dossierId, titre: (titre || "Nouveau litige").slice(0, 120) }],
    { "Prefer": "resolution=ignore-duplicates,return=minimal" }
  );
}

/* Enregistre un échange (message utilisateur et/ou réponse). */
async function saveMessages(dossierId, items) {
  if (!isUuid(dossierId) || !Array.isArray(items) || !items.length) return;
  const rows = items
    .filter(m => m && (m.role === "user" || m.role === "assistant") && m.content)
    .map(m => ({ dossier_id: dossierId, role: m.role, content: String(m.content).slice(0, 60000) }));
  if (!rows.length) return;
  await rest("POST", "messages", rows, { "Prefer": "return=minimal" });
}

/* Rattache l'adresse du payeur au dossier (sans jamais l'écraser). */
async function attachEmail(dossierId, email) {
  if (!isUuid(dossierId) || !email || typeof email !== "string") return;
  await rest(
    "PATCH",
    `dossiers?id=eq.${dossierId}&email=is.null`,
    { email: email.slice(0, 320) },
    { "Prefer": "return=minimal" }
  );
}

/* Fait progresser le statut sans jamais régresser (echange → commande → livre). */
async function advanceStatut(dossierId, statut) {
  if (!isUuid(dossierId)) return;
  if (statut === "commande") {
    await rest("PATCH", `dossiers?id=eq.${dossierId}&statut=eq.echange`,
      { statut: "commande" }, { "Prefer": "return=minimal" });
  } else if (statut === "livre") {
    await rest("PATCH", `dossiers?id=eq.${dossierId}&statut=neq.livre`,
      { statut: "livre" }, { "Prefer": "return=minimal" });
  }
}

/* Enregistre le document généré (idempotent par session Stripe). */
async function saveDocument(dossierId, doc) {
  if (!isUuid(dossierId) || !doc || !doc.contenu) return;
  const row = {
    dossier_id: dossierId,
    type: ["MED", "REC", "SAIS", "DOSS"].includes(doc.type) ? doc.type : "MED",
    titre: (doc.titre || "Document juridique").slice(0, 200),
    contenu: String(doc.contenu).slice(0, 200000),
    stripe_session_id: doc.stripeSessionId || null,
    montant_centimes: Number.isInteger(doc.montantCentimes) ? doc.montantCentimes : null,
  };
  /* L'index unique sur stripe_session_id fait échouer (409) une double
     insertion lors d'un nouvel essai : c'est le comportement voulu. */
  await rest("POST", "documents", [row], { "Prefer": "return=minimal" });
}

module.exports = { ready, isUuid, ensureDossier, saveMessages, attachEmail, advanceStatut, saveDocument };
