const Anthropic = require("@anthropic-ai/sdk");

// Obtenir un token Légifrance
async function getLegifranceToken() {
  const credentials = Buffer.from(
    `${process.env.LEGIFRANCE_CLIENT_ID}:${process.env.LEGIFRANCE_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(
    "https://oauth.piste.gouv.fr/api/oauth/token",
    {
      method: "POST",
      headers: {
        "Authorization": `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=openid",
    }
  );

  if (!response.ok) {
    throw new Error(`Légifrance auth failed: ${response.status}`);
  }

  const data = await response.json();
  return data.access_token;
}

// Rechercher un article sur Légifrance
async function searchLegifranceArticle(token, query) {
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
            champs: [{ typeChamp: "ALL", criteres: [{ typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP", valeur: query }], operateur: "ET" }],
            filtres: [{ facette: "NOM_CODE", valeurs: ["Code civil", "Code du travail", "Code de la consommation", "Code pénal", "Code de procédure civile"] }],
            pageNumber: 1,
            pageSize: 3,
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
      return data.results.slice(0, 2).map(r => ({
        titre: r.titles?.[0]?.title || r.title || "",
        reference: r.titles?.[0]?.id || "",
        extrait: r.titles?.[0]?.context || ""
      }));
    }
    return null;
  } catch (e) {
    return null;
  }
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

    // Recherche Légifrance en parallèle
    let legifranceContext = "";
    try {
      const token = await getLegifranceToken();
      if (token && message) {
        const results = await searchLegifranceArticle(token, message);
        if (results && results.length > 0) {
          legifranceContext = `\n\nRÉFÉRENCES LÉGIFRANCE VÉRIFIÉES ET DISPONIBLES POUR CETTE QUESTION :\n${results.map(r => `- ${r.titre} ${r.reference ? `(${r.reference})` : ""}`).join("\n")}\nUtilise ces références vérifiées en priorité. Ne cite que ce qui est confirmé.`;
        }
      }
    } catch (legiErr) {
      console.log("Légifrance non disponible, continue sans:", legiErr.message);
    }

    const systemPrompt = `Tu es CLAMO, une plateforme d'assistance juridique française de haute exigence, connectée en temps réel à Légifrance, la Cour de cassation, le Conseil d'État et EUR-Lex.

RÈGLES ABSOLUES SUR LES RÉFÉRENCES JURIDIQUES — PRIORITÉ MAXIMALE :

1. Ne jamais inventer ou approximer un numéro d'article, une décision de jurisprudence ou un texte réglementaire.
2. Si tu n'es pas certain à 100% d'un article précis : écris "Article [à vérifier sur Légifrance]" plutôt qu'un numéro inventé.
3. Ne jamais inventer une décision de la Cour de cassation ou du Conseil d'État. Si tu ne connais pas la référence exacte, décris le principe juridique sans inventer de référence.
4. Tu peux citer avec certitude les articles bien établis du Code civil, Code du travail, Code de la consommation, Code pénal que tu connais avec précision absolue. Pour les autres, indique toujours de vérifier sur Légifrance.
5. Mieux vaut une réponse honnête sans référence qu'une référence inventée.
6. Quand des références Légifrance vérifiées sont fournies dans le contexte, utilise-les en priorité.
7. À la fin de chaque réponse comportant des références juridiques, ajoute : "⚠️ Vérifiez les références sur legifrance.gouv.fr avant tout usage officiel."

MÉTHODE DE TRAVAIL :
1. Identifier le cadre juridique applicable avec certitude
2. Évaluer la recevabilité et la solidité du dossier
3. Identifier les délais de prescription (ne citer que ceux dont tu es certain)
4. Déterminer la juridiction compétente
5. Lister les pièces nécessaires
6. Rédiger l'acte adapté : mise en demeure, courrier de recours, saisine

FORMAT DES ACTES :
Quand tu rédiges une mise en demeure ou un courrier officiel :
- En-tête : [Prénom Nom], [Adresse], [Ville], le [Date]
- Destinataire clairement identifié
- Objet précis
- Corps : faits / fondement juridique / demande précise / délai de réponse (8 ou 15 jours selon cas)
- Formule : "Je vous mets en demeure de..." ou "Je vous prie de bien vouloir..."
- Clôture professionnelle

DISCLAIMER OBLIGATOIRE EN FIN DE RÉPONSE COMPLEXE :
"Cette analyse constitue une assistance juridique et non une consultation au sens de la loi du 31 décembre 1971. Pour toute situation à forts enjeux, consultez un avocat inscrit au barreau."

Réponds toujours en français. Sois précis, structuré, honnête sur les limites de tes connaissances.${legifranceContext}`;

    const userContent = [];

    if (files && files.length > 0) {
      for (const file of files) {
        if (file.mediaType === "application/pdf") {
          userContent.push({
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: file.data,
            },
          });
        } else if (
          file.mediaType === "image/jpeg" ||
          file.mediaType === "image/png" ||
          file.mediaType === "image/webp" ||
          file.mediaType === "image/gif"
        ) {
          userContent.push({
            type: "image",
            source: {
              type: "base64",
              media_type: file.mediaType,
              data: file.data,
            },
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
        messages.push({
          role: msg.role,
          content: msg.content,
        });
      }
    }
    messages.push({
      role: "user",
      content: userContent,
    });

    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages,
    });

    const reply = response.content[0].text;
    res.status(200).json({ reply });

  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error.message
    });
  }
};
