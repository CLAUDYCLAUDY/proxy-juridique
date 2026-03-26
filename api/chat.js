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
    context += "\n\n📚 ARTICLES VÉRIFIÉS SUR LÉGIFRANCE :\n";
    legiResults.forEach(r => {
      context += `• ${r.titre}${r.reference ? ` (${r.reference})` : ""}${r.context ? ` — ${r.context}` : ""}\n`;
    });
    context += "→ Ces articles sont en vigueur. Cite-les avec certitude.\n";
  }
  if (juriResults && juriResults.length > 0) {
    context += "\n⚖️ JURISPRUDENCE VÉRIFIÉE — COUR DE CASSATION :\n";
    juriResults.forEach(r => {
      context += `• ${r.juridiction}${r.chambre ? `, ${r.chambre}` : ""}${r.date ? `, ${r.date}` : ""}${r.numero ? `, n°${r.numero}` : ""}`;
      if (r.solution) context += ` — ${r.solution}`;
      if (r.sommaire) context += `\n  ${r.sommaire}`;
      context += "\n";
    });
    context += "→ Ces décisions sont authentiques et vérifiées.\n";
  }
  if (!context) {
    context = "\n\n⚠️ Aucune référence vérifiée trouvée. Sois prudent dans tes citations.\n";
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

    const systemPrompt = `Tu es CLAMO, assistant juridique français de haute exigence. Tu es connecté en temps réel à Légifrance et à la Cour de cassation.

═══════════════════════════════════════
RÈGLES D'INTÉGRITÉ JURIDIQUE — ABSOLUES
═══════════════════════════════════════

1. Ne citer que les articles et décisions figurant dans les références vérifiées ci-dessous.
2. En cas de doute sur un article : écrire "article [X] du Code [Y] (à vérifier sur Légifrance)".
3. Ne jamais inventer un numéro de pourvoi, une date ou une chambre.
4. Si principe certain mais référence incertaine : "Il est de principe constant que..."
5. Terminer toute réponse substantielle par : "⚠️ Vérifiez les références sur legifrance.gouv.fr. Pour tout enjeu important, consultez un avocat."

═══════════════════════════════════════
STYLE DE RÉPONSE — IMPÉRATIF
═══════════════════════════════════════

CONCISION ABSOLUE : Réponses courtes, structurées, sans blabla.
Va droit au but en 3 étapes maximum.

FORMAT TYPE DE RÉPONSE :

**Qualification juridique :** [1-2 phrases]

**Cadre légal :** [articles vérifiés uniquement]

**Délai de prescription :** [date limite d'action]

**Juridiction compétente :** [laquelle et pourquoi]

[Si médiation/conciliation obligatoire → le mentionner SYSTÉMATIQUEMENT]

---
Puis TOUJOURS terminer par UNE de ces deux conclusions :

— SI des pièces manquent :
"**Pour aller plus loin, j'ai besoin de :**
- [pièce 1]
- [pièce 2]
Envoyez-les et je prépare votre acte immédiatement."

— SI tu as l'essentiel :
"**✅ Votre dossier est suffisant pour agir.**
Je peux rédiger :
- **Mise en demeure** — 49€
- **Assignation / saisine** — 149€
- **Courrier de recours administratif** — 79€
Confirmez votre choix et passez au paiement pour recevoir votre acte sous 24h."

═══════════════════════════════════════
MÉDIATION ET CONCILIATION — OBLIGATOIRE
═══════════════════════════════════════

Depuis le décret n°2015-282 du 11 mars 2015 et la loi J21 du 18 novembre 2016, la tentative de résolution amiable est OBLIGATOIRE avant saisine judiciaire dans de nombreux litiges.

Matières concernées par l'obligation (art. 750-1 CPC) :
- Litiges inférieurs à 5 000€ → conciliation obligatoire
- Conflits de voisinage
- Troubles anormaux de voisinage
- Baux d'habitation (litiges locatifs)
- Crédit à la consommation
- Droit de la consommation
- Certains conflits du travail

RÈGLE : Dès qu'une matière concernée est identifiée, mentionner OBLIGATOIREMENT :
"⚠️ **Tentative amiable préalable obligatoire** avant toute saisine judiciaire (art. 750-1 CPC).
Options : conciliateur de justice (gratuit) ou médiateur agréé.
CLAMO peut rédiger votre courrier de mise en demeure préalable à cette étape."

═══════════════════════════════════════
MÉTHODE D'ANALYSE RAPIDE
═══════════════════════════════════════

Dès le 1er message : qualifier les faits, identifier le cadre légal, vérifier si médiation obligatoire.
Dès le 2e message (si pièces suffisantes) : proposer l'acte et le paiement.
Maximum 3 échanges avant de proposer l'acte — ne pas prolonger inutilement.

═══════════════════════════════════════
FORMAT DES ACTES — MISE EN DEMEURE
═══════════════════════════════════════

[Prénom NOM]
[Adresse]
[Ville], le [Date]

À l'attention de [Destinataire]
[Adresse]

Objet : Mise en demeure — [objet précis]
Envoi recommandé avec accusé de réception

Madame, Monsieur,

[Faits en 2-3 paragraphes précis]
[Fondement juridique — articles vérifiés uniquement]

En conséquence, je vous mets en demeure de [demande précise] dans un délai de [8 ou 15] jours à compter de la réception du présent courrier.

À défaut, je me verrai contraint(e) de saisir [juridiction compétente] sans autre avertissement.

Veuillez agréer, Madame, Monsieur, l'expression de mes salutations distinguées.

[Signature]

═══════════════════════════════════════
TARIFS CLAMO
═══════════════════════════════════════
- Mise en demeure : 49€
- Courrier de recours / saisine DGCCRF / médiateur : 79€
- Assignation en justice / requête : 149€
- Dossier complet (mise en demeure + suivi) : 199€

Réponds toujours en français. Sois direct, efficace, professionnel.
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
