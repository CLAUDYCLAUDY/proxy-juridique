const Anthropic = require("@anthropic-ai/sdk");

function fetchWithTimeout(url, options, ms = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function getLegifranceToken() {
  const credentials = Buffer.from(
    `${process.env.LEGIFRANCE_CLIENT_ID}:${process.env.LEGIFRANCE_CLIENT_SECRET}`
  ).toString("base64");
  const response = await fetchWithTimeout(
    "https://oauth.piste.gouv.fr/api/oauth/token",
    {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=openid",
    },
    3000
  );
  if (!response.ok) throw new Error(`Token failed: ${response.status}`);
  const data = await response.json();
  return data.access_token;
}

async function searchLegifrance(token, query) {
  try {
    const response = await fetchWithTimeout(
      "https://api.piste.gouv.fr/dila/legifrance/lf-engine-app/search",
      {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          recherche: {
            champs: [{ typeChamp: "ALL", criteres: [{ typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP", valeur: query }], operateur: "ET" }],
            filtres: [{ facette: "NOM_CODE", valeurs: ["Code civil", "Code du travail", "Code de la consommation", "Code pénal", "Code de procédure civile", "Code de procédure pénale", "Code des assurances"] }],
            pageNumber: 1, pageSize: 5, operateur: "ET", typePagination: "DEFAUT"
          },
          fond: "CODE_DATE"
        }),
      },
      4000
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (data.results && data.results.length > 0) {
      return data.results.slice(0, 4).map(r => ({
        titre: r.titles?.[0]?.title || r.title || "",
        reference: r.titles?.[0]?.id || "",
        context: r.titles?.[0]?.context || ""
      }));
    }
    return null;
  } catch (e) { return null; }
}

async function searchJudilibre(token, query) {
  try {
    const encodedQuery = encodeURIComponent(query.substring(0, 150));
    const response = await fetchWithTimeout(
      `https://api.piste.gouv.fr/cassation/judilibre/v1.0/search?query=${encodedQuery}&page_size=3&resolve_references=true`,
      {
        method: "GET",
        headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
      },
      4000
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (data.results && data.results.length > 0) {
      return data.results.slice(0, 3).map(r => ({
        juridiction: r.jurisdiction || "Cour de cassation",
        chambre: r.chamber || "",
        date: r.decision_date || "",
        numero: r.number || "",
        solution: r.solution || "",
        sommaire: r.summary ? r.summary.substring(0, 300) : "",
      }));
    }
    return null;
  } catch (e) { return null; }
}

function buildContext(legiResults, juriResults) {
  let context = "";
  if (legiResults && legiResults.length > 0) {
    context += "\n\n=== TEXTES VÉRIFIÉS (LÉGIFRANCE) ===\n";
    legiResults.forEach(r => {
      context += `• ${r.titre}${r.reference ? ` [${r.reference}]` : ""}${r.context ? ` — ${r.context}` : ""}\n`;
    });
    context += "→ Ces textes sont en vigueur. Cite-les avec leur référence exacte.\n";
  }
  if (juriResults && juriResults.length > 0) {
    context += "\n=== JURISPRUDENCE VÉRIFIÉE (COUR DE CASSATION) ===\n";
    juriResults.forEach(r => {
      context += `• ${r.juridiction}${r.chambre ? `, ${r.chambre}` : ""}${r.date ? `, ${r.date}` : ""}${r.numero ? `, n°${r.numero}` : ""}`;
      if (r.solution) context += ` — ${r.solution}`;
      if (r.sommaire) context += `\n  ${r.sommaire}`;
      context += "\n";
    });
    context += "→ Ces décisions sont authentiques. Cite-les avec précision.\n";
  }
  return context;
}

// ═══════════════════════════════════════
// PASSE 1 — RÉDACTION
// ═══════════════════════════════════════
async function firstPass(client, systemPrompt, messages) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });
  return response.content[0].text;
}

// ═══════════════════════════════════════
// PASSE 2 — VÉRIFICATION JURIDIQUE
// ═══════════════════════════════════════
async function secondPass(client, draft, verifiedContext) {
  const verificationPrompt = `Tu es un avocat senior français chargé de relire et corriger une réponse juridique avant envoi à un client.

Ta mission est UNIQUEMENT de vérifier et corriger — pas de réécrire, pas d'ajouter du contenu.

VÉRIFICATIONS À EFFECTUER :

1. ARTICLES DE LOI
Pour chaque article cité, vérifie s'il figure dans les références vérifiées ci-dessous.
- S'il y figure : laisse la référence telle quelle
- S'il n'y figure pas ET que c'est un article très connu et stable (art. 1240 C.civ, art. L1232-1 C.trav, art. 1641 C.civ, art. 2224 C.civ, art. L217-4 C.conso, art. 750-1 CPC, art. 700 CPC...) : laisse-le
- S'il n'y figure pas ET que tu n'en es pas certain : remplace par "article [X] du Code [Y] (à confirmer sur legifrance.gouv.fr)"

2. JURISPRUDENCE
Pour chaque décision citée (numéro de pourvoi, chambre, date) :
- Si elle figure dans les références vérifiées : laisse-la
- Si elle n'y figure pas : supprime le numéro de pourvoi et remplace par "jurisprudence constante de la Cour de cassation" ou supprime la référence tout en conservant le principe juridique énoncé

3. COHÉRENCE JURIDIQUE
- Le délai de prescription est-il correct pour la matière traitée ?
- La juridiction compétente est-elle correctement identifiée ?
- La médiation préalable est-elle mentionnée si elle est obligatoire ?

4. FORMAT
- Vérifie que la réponse ne commence pas par # ou ##
- Vérifie qu'il n'y a pas de lignes vides multiples excessives
- La proposition commerciale finale est-elle adaptée à la situation ?

INSTRUCTION FINALE :
Retourne la réponse corrigée, en français, directement sans commentaire ni explication de tes corrections. Si la réponse est déjà correcte, retourne-la telle quelle.

${verifiedContext}

RÉPONSE À VÉRIFIER :
${draft}`;

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4096,
    system: verificationPrompt,
    messages: [{ role: "user", content: "Vérifie et corrige cette réponse juridique." }],
  });
  return response.content[0].text;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { message, history, files } = req.body;
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Appels juridiques avec timeout
    let legiResults = null, juriResults = null;
    if (message) {
      try {
        const token = await Promise.race([
          getLegifranceToken(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3500))
        ]);
        [legiResults, juriResults] = await Promise.allSettled([
          searchLegifrance(token, message.substring(0, 200)),
          searchJudilibre(token, message.substring(0, 150))
        ]).then(r => r.map(x => x.status === 'fulfilled' ? x.value : null));
      } catch (e) {
        console.log("APIs juridiques non disponibles:", e.message);
      }
    }

    const verifiedContext = buildContext(legiResults, juriResults);

    const systemPrompt = `Tu es CLAMO, assistant juridique contentieux français de haute exigence. Tu assistes exclusivement des particuliers dans la défense de leurs droits en mode contentieux.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
I. PÉRIMÈTRE ET REFUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Tu interviens UNIQUEMENT pour :
- Rédiger des mises en demeure
- Rédiger des courriers de contestation, réclamation, opposition
- Rédiger des actes introductifs de procédure (assignation, requête, saisine)
- Analyser un dossier contentieux pour préparer ces actes

Tu REFUSES pour : conseil préventif, rédaction de contrats, fiscalité, questions hors contentieux.
Formulation : "CLAMO intervient uniquement en matière contentieuse. Pour cette demande, consultez un avocat inscrit au barreau."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
II. RÈGLES D'INTÉGRITÉ JURIDIQUE — ABSOLUES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RÈGLE 1 — SOURCES VÉRIFIÉES EN PRIORITÉ
Utilise en priorité les textes et décisions fournis dans les références vérifiées ci-dessous.

RÈGLE 2 — ARTICLES CERTAINS (citables sans vérification)
Code civil : art. 1240 (responsabilité délictuelle), art. 1231-1 (responsabilité contractuelle), art. 1641-1648 (vices cachés), art. 1353 (charge de la preuve), art. 2224 (prescription 5 ans)
Code du travail : art. L1232-1 (cause réelle et sérieuse), art. L1235-3 (barème indemnités), art. L4121-1 (obligation sécurité)
Code de la consommation : art. L217-4 (conformité), art. L217-12 (prescription 2 ans), art. L221-18 (rétractation 14 jours)
CPC : art. 750-1 (tentative amiable obligatoire), art. 56 (assignation), art. 700 (frais de procédure)

RÈGLE 3 — INCERTITUDE
Pour tout article absent des références vérifiées et de la liste ci-dessus :
"article [X] du Code [Y] (à confirmer sur legifrance.gouv.fr)"

RÈGLE 4 — JURISPRUDENCE
Citer uniquement les décisions présentes dans les références vérifiées.
Si principe connu sans référence certaine : "La jurisprudence constante considère que [principe]" — sans inventer de numéro.

RÈGLE 5 — ZÉRO HALLUCINATION
Un article inventé peut invalider un acte. En cas de doute : abstention totale.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
III. PROTOCOLE DE TRAITEMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ÉTAPE 1 — PREMIER CONTACT
Collecter systématiquement :
**Votre identité :** nom, prénom, adresse (ou dénomination sociale, SIREN, siège si société)
**Adversaire :** mêmes informations
**Faits :** chronologie précise avec dates et montants
**Pièces disponibles :** lister + joindre si possible

ÉTAPE 2 — ANALYSE JURIDIQUE (après réception des faits)
A) Qualification juridique exacte des faits
B) Textes applicables (vérifiés uniquement)
C) Prescription : délai applicable, date de départ, date limite — si < 3 mois : mention URGENT
D) Médiation préalable obligatoire ? (art. 750-1 CPC pour litiges ≤ 5 000€, consommation, voisinage, baux)
E) Juridiction compétente : matérielle (TJ, CPH, tribunal de commerce, CCSP) ET territoriale
F) Solidité du dossier : fort / moyen / fragile + explication
G) Pièces manquantes et leur impact

ÉTAPE 3 — PROPOSITION (fin de chaque réponse à partir de l'étape 2)
Proposer UNIQUEMENT l'acte adapté :

Premier recours sans mise en demeure préalable :
"**Je peux rédiger votre mise en demeure — 49€**"

Mise en demeure déjà envoyée sans effet, ou saisine directe nécessaire :
"**Je peux rédiger votre [assignation / requête / saisine] — 149€**"

Contestation ou recours administratif :
"**Je peux rédiger votre courrier de contestation — 79€**"

Dossier complexe nécessitant accompagnement complet :
"**Je peux constituer votre dossier complet — 199€**"

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IV. FORMAT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Réponses courtes et denses, sans blabla
- Gras **titre** pour les sections — jamais de #
- Listes avec tirets simples
- Ton direct et professionnel
- Chaque réponse se termine par : pièces manquantes OU proposition d'acte
- Disclaimer une seule fois en fin de premier échange : "Cette analyse constitue une assistance juridique et non une consultation au sens de la loi du 31 décembre 1971."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
V. FORMAT MISE EN DEMEURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Prénom NOM] — [Adresse] — [Ville], le [Date]
À : [Destinataire] — [Adresse]
Objet : Mise en demeure — [objet]
Envoi par LRAR

Madame, Monsieur,
[Faits précis et chronologiques]
[Fondement juridique — textes vérifiés]
Je vous mets en demeure de [demande précise] sous [8/15] jours à compter de la réception.
À défaut, je saisirai [juridiction] sans autre avertissement, et réclamerai les intérêts au taux légal ainsi que les frais de procédure (art. 700 CPC).
[Signature] — Pièces jointes : [liste]

${verifiedContext}`;

    const userContent = [];
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.mediaType === "application/pdf") {
          userContent.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: file.data } });
        } else if (["image/jpeg","image/png","image/webp","image/gif"].includes(file.mediaType)) {
          userContent.push({ type: "image", source: { type: "base64", media_type: file.mediaType, data: file.data } });
        } else {
          userContent.push({ type: "text", text: `[Fichier "${file.name}" :\n${file.textContent}]` });
        }
      }
    }
    userContent.push({ type: "text", text: message || "Analysez les documents joints." });

    const messages = [];
    if (history && history.length > 0) {
      for (const msg of history) messages.push({ role: msg.role, content: msg.content });
    }
    messages.push({ role: "user", content: userContent });

    // PASSE 1 — Rédaction
    const draft = await firstPass(client, systemPrompt, messages);

    // PASSE 2 — Vérification juridique (uniquement si réponse substantielle)
    let finalReply = draft;
    const isSubstantial = draft.length > 300 && (
      draft.includes('art.') ||
      draft.includes('Code') ||
      draft.includes('prescription') ||
      draft.includes('juridiction') ||
      draft.includes('mise en demeure') ||
      draft.includes('assignation')
    );

    if (isSubstantial) {
      try {
        finalReply = await secondPass(client, draft, verifiedContext);
      } catch (e) {
        console.log("Vérification échouée, envoi draft:", e.message);
        finalReply = draft;
      }
    }

    res.status(200).json({ reply: finalReply });

  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error", details: error.message });
  }
};
