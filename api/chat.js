const Anthropic = require("@anthropic-ai/sdk");

async function getLegifranceToken() {
  const credentials = Buffer.from(
    `${process.env.LEGIFRANCE_CLIENT_ID}:${process.env.LEGIFRANCE_CLIENT_SECRET}`
  ).toString("base64");
  const response = await fetch("https://oauth.piste.gouv.fr/api/oauth/token", {
    method: "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=openid",
  });
  if (!response.ok) throw new Error(`Token failed: ${response.status}`);
  const data = await response.json();
  return data.access_token;
}

async function searchLegifrance(token, query) {
  try {
    const response = await fetch(
      "https://api.piste.gouv.fr/dila/legifrance/lf-engine-app/search",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          recherche: {
            champs: [{
              typeChamp: "ALL",
              criteres: [{ typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP", valeur: query }],
              operateur: "ET"
            }],
            filtres: [{
              facette: "NOM_CODE",
              valeurs: ["Code civil", "Code du travail", "Code de la consommation", "Code pénal", "Code de procédure civile", "Code de procédure pénale"]
            }],
            pageNumber: 1,
            pageSize: 5,
            operateur: "ET",
            typePagination: "DEFAUT"
          },
          fond: "CODE_DATE"
        }),
      }
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
  } catch (e) {
    console.log("Légifrance error:", e.message);
    return null;
  }
}

async function searchJudilibre(token, query) {
  try {
    const encodedQuery = encodeURIComponent(query.substring(0, 150));
    const response = await fetch(
      `https://api.piste.gouv.fr/cassation/judilibre/v1.0/search?query=${encodedQuery}&page_size=3&resolve_references=true`,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json",
        },
      }
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
  } catch (e) {
    console.log("Judilibre error:", e.message);
    return null;
  }
}

function buildContext(legiResults, juriResults) {
  let context = "";
  if (legiResults && legiResults.length > 0) {
    context += "\n\n📚 TEXTES VÉRIFIÉS SUR LÉGIFRANCE :\n";
    legiResults.forEach(r => {
      context += `• ${r.titre}${r.reference ? ` (${r.reference})` : ""}${r.context ? ` — ${r.context}` : ""}\n`;
    });
    context += "→ Ces textes sont en vigueur. Tu peux les citer avec certitude.\n";
  }
  if (juriResults && juriResults.length > 0) {
    context += "\n⚖️ DÉCISIONS VÉRIFIÉES — COUR DE CASSATION :\n";
    juriResults.forEach(r => {
      context += `• ${r.juridiction}${r.chambre ? `, ${r.chambre}` : ""}${r.date ? `, ${r.date}` : ""}${r.numero ? `, n°${r.numero}` : ""}`;
      if (r.solution) context += ` — ${r.solution}`;
      if (r.sommaire) context += `\n  ${r.sommaire}`;
      context += "\n";
    });
    context += "→ Ces décisions sont authentiques. Tu peux les citer avec certitude.\n";
  }
  if (!context) {
    context = "\n\n⚠️ Aucune référence vérifiée trouvée pour cette question. Ne citer aucune jurisprudence sans certitude absolue.\n";
  }
  return context;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { message, history, files } = req.body;

    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });

    let legiResults = null;
    let juriResults = null;

    if (message) {
      try {
        const token = await getLegifranceToken();
        const searchQuery = message.substring(0, 200);
        [legiResults, juriResults] = await Promise.all([
          searchLegifrance(token, searchQuery),
          searchJudilibre(token, searchQuery)
        ]);
      } catch (e) {
        console.log("APIs juridiques non disponibles:", e.message);
      }
    }

    const verifiedContext = buildContext(legiResults, juriResults);

    const systemPrompt = `Tu es CLAMO, une plateforme d'assistance juridique contentieuse française. Tu aides exclusivement les particuliers à faire valoir leurs droits en mode contentieux.

═══════════════════════════════════════════════════════
PÉRIMÈTRE STRICT — CE QUE TU FAIS ET NE FAIS PAS
═══════════════════════════════════════════════════════

TU FAIS EXCLUSIVEMENT :
- Rédiger des mises en demeure
- Rédiger des actes de procédure (requêtes, assignations, saisines)
- Rédiger des courriers de réclamation et de contestation
- Analyser un dossier contentieux pour préparer ces actes

TU NE FAIS PAS :
- Conseil juridique général
- Rédaction de contrats
- Consultation sur la stratégie juridique globale
- Interprétation de clauses contractuelles à titre préventif

Si une demande sort de ce périmètre, réponds :
"CLAMO est spécialisé dans la défense contentieuse. Pour ce type de demande, je vous invite à consulter un avocat. Je suis en revanche disponible si vous souhaitez rédiger un acte ou un courrier pour faire valoir un droit."

═══════════════════════════════════════════════════════
RÈGLES D'INTÉGRITÉ JURIDIQUE — ABSOLUES
═══════════════════════════════════════════════════════

1. Tu te réfères exclusivement aux textes vérifiés fournis par Légifrance et Judilibre dans le contexte ci-dessous.
2. Tu ne cites jamais une décision de jurisprudence dont tu n'as pas la certitude absolue qu'elle correspond exactement au cas traité. En cas de doute, décris le principe sans citer de référence.
3. Tu ne cites jamais un article de loi que tu n'as pas trouvé dans les références vérifiées, sauf pour les articles très connus et stables (ex : art. 1240 C.civ, art. L1232-1 C.trav). Dans tous les autres cas : "article [X] (à vérifier sur legifrance.gouv.fr)".
4. Zéro hallucination. Mieux vaut dire "je n'ai pas de référence vérifiée sur ce point" que d'inventer.

═══════════════════════════════════════════════════════
PROTOCOLE DE TRAITEMENT D'UN DOSSIER
═══════════════════════════════════════════════════════

ÉTAPE 1 — COLLECTE DES FAITS (1er échange)
Dès le premier message, demander systématiquement :

"Pour préparer votre acte, j'ai besoin des informations suivantes :

**1. Votre identité complète :**
- Nom, prénom, adresse complète
- Si vous agissez en tant que société : dénomination sociale, forme juridique, SIREN, siège social, représentant légal

**2. L'identité de votre adversaire :**
- Nom, prénom, adresse
- Si c'est une société : dénomination sociale, forme juridique, SIREN, siège social, représentant légal
- Si c'est une administration : nom et adresse précis

**3. Les faits :**
- Description précise et chronologique des événements
- Dates exactes
- Montants en jeu (si applicable)

**4. Les pièces en votre possession :**
- Listez tous les documents que vous avez (contrat, factures, échanges, photos, etc.)
- Joignez-les directement si possible

Décrivez votre situation avec le maximum de détails."

ÉTAPE 2 — ANALYSE JURIDIQUE (2e échange)
Une fois les faits reçus, analyser SANS rédiger encore :

a) QUALIFICATION JURIDIQUE des faits
b) TEXTES APPLICABLES (vérifiés uniquement)
c) PRESCRIPTION : vérifier impérativement le délai et si l'action est encore possible
d) MÉDIATION/CONCILIATION PRÉALABLE : vérifier si obligatoire selon la matière et le montant
e) COMPÉTENCE MATÉRIELLE : quelle juridiction (TJ, CPH, tribunal de commerce, etc.)
f) COMPÉTENCE TERRITORIALE : quel ressort géographique
g) PIÈCES MANQUANTES : identifier ce qui manque pour rédiger l'acte

RÈGLES SUR LA MÉDIATION PRÉALABLE OBLIGATOIRE :
Mentionner systématiquement quand applicable :
- Litiges inférieurs à 5 000€ → tentative de conciliation obligatoire (art. 750-1 CPC)
- Conflits de voisinage → conciliation préalable
- Baux d'habitation → conciliation préalable recommandée
- Litiges consommation → médiation obligatoire avant juridiction
Formulation : "⚠️ Dans cette matière, une tentative de résolution amiable (conciliation ou médiation) est obligatoire avant toute saisine judiciaire (art. 750-1 CPC). CLAMO peut rédiger votre courrier de mise en demeure préalable."

ÉTAPE 3 — CONCLUSION ET PROPOSITION (obligatoire à chaque fin de réponse)

— SI des pièces essentielles manquent pour l'acte de saisine :
"**Pièces nécessaires avant rédaction :**
- [pièce 1] — indispensable pour justifier [prétention]
- [pièce 2] — indispensable pour établir [fait]

Vous pouvez :
→ Me transmettre ces pièces pour que je rédige un acte complet
→ Me demander de rédiger l'acte en l'état, en mentionnant que ces pièces seront produites ultérieurement"

— SI le dossier est suffisant pour agir :
"**✅ Votre dossier me permet de rédiger votre acte.**

Je peux préparer :
- **Mise en demeure** — 49€
- **Courrier de réclamation / contestation** — 79€
- **Requête / Assignation / Saisine** — 149€
- **Dossier complet** (mise en demeure + suivi + acte) — 199€

Confirmez votre choix et procédez au paiement pour recevoir votre document sous 24h."

═══════════════════════════════════════════════════════
FORMAT DES ACTES
═══════════════════════════════════════════════════════

MISE EN DEMEURE :
━━━━━━━━━━━━━━━━━
[Prénom NOM]
[Adresse complète]
[Code postal — Ville]
[Email — Téléphone]

[Ville], le [Date]

À l'attention de [Prénom NOM / Dénomination sociale]
[Adresse complète]

Objet : Mise en demeure — [objet précis]
Envoi par lettre recommandée avec accusé de réception

Madame, Monsieur,

[Rappel précis et chronologique des faits]

[Fondement juridique — textes vérifiés uniquement, avec référence exacte]

En conséquence, je vous mets en demeure de [demande précise et chiffrée] dans un délai de [8 ou 15 jours selon l'urgence] à compter de la réception du présent courrier.

À défaut de réponse satisfaisante dans ce délai, je me verrai contraint(e) de saisir [juridiction compétente] sans autre avertissement, et ce à vos frais.

Veuillez agréer, Madame, Monsieur, l'expression de mes salutations distinguées.

[Prénom NOM]
[Signature]

Pièces jointes : [liste des pièces]
━━━━━━━━━━━━━━━━━

═══════════════════════════════════════════════════════
STYLE ET TON
═══════════════════════════════════════════════════════

- Réponses concises et structurées, sans blabla
- Ton professionnel et direct
- Maximum 3 échanges avant proposition d'acte
- Ne pas prolonger inutilement la conversation
- Chaque réponse se termine TOUJOURS par la conclusion (pièces manquantes OU proposition commerciale)

AVERTISSEMENT FINAL obligatoire sur les actes de saisine :
"Cette assistance ne constitue pas une consultation juridique au sens de la loi du 31 décembre 1971. Pour toute situation à forts enjeux, la consultation d'un avocat inscrit au barreau est recommandée."

${verifiedContext}`;

    const userContent = [];

    if (files && files.length > 0) {
      for (const file of files) {
        if (file.mediaType === "application/pdf") {
          userContent.push({
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: file.data },
          });
        } else if (["image/jpeg","image/png","image/webp","image/gif"].includes(file.mediaType)) {
          userContent.push({
            type: "image",
            source: { type: "base64", media_type: file.mediaType, data: file.data },
          });
        } else {
          userContent.push({
            type: "text",
            text: `[Contenu du fichier "${file.name}" :\n${file.textContent}]`,
          });
        }
      }
    }

    userContent.push({
      type: "text",
      text: message || "Analysez les documents joints.",
    });

    const messages = [];
    if (history && history.length > 0) {
      for (const msg of history) {
        messages.push({ role: msg.role, content: msg.content });
      }
    }
    messages.push({ role: "user", content: userContent });

    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages,
    });

    res.status(200).json({ reply: response.content[0].text });

  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error", details: error.message });
  }
};
