/* ============================================================
   CLAMO — Création d'une session de paiement Stripe Checkout
   Aucune dépendance : appel direct de l'API Stripe.
   Variable d'environnement requise : STRIPE_SECRET_KEY
   ============================================================ */

const CATALOG = {
  MED:  { name: "Mise en demeure — CLAMO",              amount: 4900 },
  REC:  { name: "Courrier de contestation / recours — CLAMO", amount: 7900 },
  SAIS: { name: "Assignation / requête / saisine — CLAMO",    amount: 14900 },
  DOSS: { name: "Dossier complet — CLAMO",              amount: 19900 },
};

const ALLOWED_ORIGINS = ["https://clamo.fr", "https://www.clamo.fr"];

const CONSENT_MESSAGE =
  "En payant, je demande l'exécution immédiate du service et reconnais renoncer à mon droit de " +
  "rétractation (article L221-28, 13° du code de la consommation), et j'accepte les conditions " +
  "générales de vente.";

function buildBody(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v));
  }
  // Stripe exige le gabarit {CHECKOUT_SESSION_ID} non encodé dans success_url
  return parts.join("&").replace(/%7BCHECKOUT_SESSION_ID%7D/g, "{CHECKOUT_SESSION_ID}");
}

async function createSession(origin, code, withConsent) {
  const item = CATALOG[code];
  const params = {
    "mode": "payment",
    "locale": "fr",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "eur",
    "line_items[0][price_data][unit_amount]": String(item.amount),
    "line_items[0][price_data][product_data][name]": item.name,
    "metadata[product]": code,
    "success_url": `${origin}/?paid={CHECKOUT_SESSION_ID}&p=${code}`,
    "cancel_url": `${origin}/`,
  };
  if (withConsent) {
    params["consent_collection[terms_of_service]"] = "required";
    params["custom_text[terms_of_service_acceptance][message]"] = CONSENT_MESSAGE;
  } else {
    params["custom_text[submit][message]"] = CONSENT_MESSAGE;
  }
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: buildBody(params),
  });
  return { ok: r.ok, data: await r.json() };
}

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
    const code = (req.body && req.body.product || "").toUpperCase();
    if (!CATALOG[code]) return res.status(400).json({ error: "Document inconnu" });
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: "Le paiement n'est pas encore activé. Réessayez dans quelques instants." });
    }
    const base = isAllowed && origin ? origin : "https://clamo.fr";

    // 1er essai avec recueil formel du consentement (exige l'URL des CGV dans les réglages Stripe)
    let s = await createSession(base, code, true);
    if (!s.ok && s.data && s.data.error && /terms of service|terms_of_service/i.test(s.data.error.message || "")) {
      // Réglage Stripe absent : repli avec le consentement porté par le bouton de paiement
      s = await createSession(base, code, false);
    }
    if (!s.ok) {
      console.error("Stripe error:", s.data && s.data.error && s.data.error.message);
      return res.status(502).json({ error: "Le paiement est momentanément indisponible. Réessayez." });
    }
    return res.status(200).json({ url: s.data.url });
  } catch (e) {
    console.error("Checkout error:", e.message);
    return res.status(500).json({ error: "Erreur interne" });
  }
};
