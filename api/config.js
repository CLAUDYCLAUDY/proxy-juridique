/* ============================================================
   CLAMO — Configuration publique pour le front (site statique)
   Le site n'ayant pas d'étape de build, les variables publiques
   Supabase sont servies par cet endpoint depuis Vercel.
   Seules des valeurs PUBLIQUES sortent d'ici : l'URL du projet
   et la clé anon (protégée par la RLS). Jamais la service_role.
   Variables acceptées (les deux jeux de noms fonctionnent) :
   - SUPABASE_URL           ou NEXT_PUBLIC_SUPABASE_URL
   - SUPABASE_ANON_KEY      ou NEXT_PUBLIC_SUPABASE_ANON_KEY
   ============================================================ */

const ALLOWED_ORIGINS = ["https://clamo.fr", "https://www.clamo.fr"];

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin);
  if (isAllowed) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Méthode non autorisée" });

  const url =
    process.env.SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const anonKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

  if (!url || !anonKey) {
    return res.status(503).json({ error: "Configuration Supabase absente" });
  }
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=3600");
  return res.status(200).json({ supabaseUrl: url, supabaseAnonKey: anonKey });
};
