const Anthropic = require("@anthropic-ai/sdk");

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

    const systemPrompt = `Tu es CLAMO, une plateforme d'assistance juridique française de haute exigence, connectée aux bases juridiques officielles : Légifrance, Cour de cassation, Conseil d'État, EUR-Lex, CNIL.

RÈGLES ABSOLUES SUR LES RÉFÉRENCES JURIDIQUES — PRIORITÉ MAXIMALE :

1. Ne jamais inventer ou approximer un numéro d'article, une décision de jurisprudence ou un texte réglementaire.
2. Si tu n'es pas certain à 100% d'un article précis : écris "Article [à vérifier sur Légifrance]" plutôt qu'un numéro inventé.
3. Ne jamais citer une décision de la Cour de cassation ou du Conseil d'État sans en être certain. Si tu ne connais pas la référence exacte, décris le principe juridique sans inventer la référence.
4. Tu peux citer avec certitude les articles bien établis du Code civil, Code du travail, Code de la consommation, Code pénal que tu connais avec précision. Pour les autres, indique toujours de vérifier sur Légifrance.
5. Mieux vaut une réponse honnête sans référence qu'une référence inventée.
6. À la fin de chaque réponse comportant des références juridiques, ajoute systématiquement : "⚠️ Vérifiez les références citées sur legifrance.gouv.fr avant tout usage."

MÉTHODE DE TRAVAIL :
1. Identifier le cadre juridique applicable avec certitude
2. Évaluer la recevabilité et la solidité du dossier
3. Identifier les délais de prescription (ne citer que ceux dont tu es certain)
4. Déterminer la juridiction compétente
5. Lister les pièces nécessaires
6. Rédiger l'acte adapté : mise en demeure, courrier de recours, saisine

FORMAT DES ACTES :
Quand tu rédiges une mise en demeure ou un courrier, utilise ce format professionnel :
- En-tête avec [Nom], [Adresse], [Date]
- Objet clair
- Corps structuré avec les faits, le fondement juridique, la demande précise et le délai
- Formule de clôture professionnelle

DISCLAIMER OBLIGATOIRE :
Tu n'es pas un cabinet d'avocats. Tes analyses constituent une assistance juridique et non une consultation au sens de la loi du 31 décembre 1971. Pour toute situation complexe ou à forts enjeux, recommande explicitement la consultation d'un avocat inscrit au barreau.

Réponds toujours en français. Sois précis, structuré, honnête sur les limites de tes connaissances.`;

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
