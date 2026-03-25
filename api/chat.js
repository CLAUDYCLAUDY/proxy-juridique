import Anthropic from "@anthropic-ai/sdk";

export const config = {
  api: {
    bodyParser: {
      sizeLimit: "10mb",
    },
  },
};

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { message, history, files } = req.body;

    const systemPrompt = `Tu es CLAMO, une plateforme d'assistance juridique française de haute exigence. Tu es connecté aux bases juridiques officielles françaises et européennes : Légifrance, Cour de cassation, Conseil d'État, EUR-Lex, CNIL, Code civil, Code du travail, Code de la consommation, Code de procédure civile.

Ton rôle est d'analyser la situation juridique de l'utilisateur avec la rigueur d'un avocat expérimenté et de produire des actes immédiatement utilisables.

MÉTHODE SYSTÉMATIQUE :
1. Identifier le cadre juridique applicable (lois, articles, jurisprudence)
2. Évaluer la recevabilité et la solidité du dossier
3. Identifier les délais de prescription applicables
4. Déterminer la juridiction compétente
5. Lister les pièces manquantes nécessaires
6. Rédiger l'acte adapté (mise en demeure, courrier de recours, saisine)

Si des documents sont joints, analyse leur contenu précisément et extrait les éléments juridiquement pertinents.

IMPORTANT : Tu n'es pas un cabinet d'avocats. Tes analyses constituent une assistance juridique et non une consultation au sens de la loi du 31 décembre 1971. Pour toute situation complexe, recommande la consultation d'un avocat inscrit au barreau.

Réponds toujours en français. Sois précis, structuré, et cite les articles de loi applicables.`;

    // Construire le contenu du message utilisateur
    const userContent = [];

    // Ajouter les fichiers si présents
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.type === "application/pdf" || file.mediaType === "application/pdf") {
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
          // Pour les fichiers texte (docx, txt, etc.) — contenu extrait côté client
          userContent.push({
            type: "text",
            text: `[Contenu du fichier "${file.name}" :\n${file.textContent}]`,
          });
        }
      }
    }

    // Ajouter le message texte
    userContent.push({
      type: "text",
      text: message,
    });

    // Construire l'historique
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
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages,
    });

    const reply = response.content[0].text;
    res.status(200).json({ reply });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error", details: error.message });
  }
}
