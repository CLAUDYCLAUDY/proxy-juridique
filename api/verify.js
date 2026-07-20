/* ============================================================
   CLAMO — Vérification d'une session de paiement au retour de Stripe
   ============================================================ */

const ALLOWED_ORIGINS = ["https://clamo.fr", "https://www.clamo.fr"];

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  const isAllowed = ALLOWED_ORIGINS.includes(origin) || /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin);
  if (isAllowed) { res.setHeader("Access-Control-Allow-Origin", origin); res.setHeader("Vary", "Origin"); }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Méthode non autorisée" });
  if (origin && !isAllowed) return res.status(403).json({ error: "Origine non autorisée" });

  try {
    const id = req.body && req.body.session_id;
    if (!id || !/^cs_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ ok: false });
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${id}`, {
      headers: { "Authorization": `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    if (!r.ok) return res.status(200).json({ ok: false });
    const sess = await r.json();
    const paid = sess.payment_status === "paid";
    return res.status(200).json({ ok: paid, product: (sess.metadata && sess.metadata.product) || "MED" });
  } catch (e) {
    return res.status(200).json({ ok: false });
  }
};
