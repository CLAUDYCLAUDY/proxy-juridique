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
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          recherche: {
            champs: [{ typeChamp: "ALL", criteres: [{ typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP", valeur: query }], operateur: "ET" }],
            filtres: [{ facette: "NOM_CODE", valeurs: ["Code civil", "Code du travail", "Code de la consommation", "Code pénal", "Code de procédure civile", "Code de procédure pénale", "Code des assurances", "Code de la route", "Code de l'éducation", "Code de la santé publique"] }],
            pageNumber: 1, pageSize: 6, operateur: "ET", typePagination: "DEFAUT"
          },
          fond: "CODE_DATE"
        }),
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (data.results && data.results.length > 0) {
      return data.results.slice(0, 5).map(r => ({
        titre: r.titles?.[0]?.title || r.title || "",
        reference: r.titles?.[0]?.id || "",
        context: r.titles?.[0]?.context || "",
        texte: r.titles?.[0]?.text ? r.titles[0].text.substring(0, 400) : ""
      }));
    }
    return null;
  } catch (e) { return null; }
}

async function searchLegifranceJORI(token, query) {
  try {
    const response = await fetch(
      "https://api.piste.gouv.fr/dila/legifrance/lf-engine-app/search",
      {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          recherche: {
            champs: [{ typeChamp: "ALL", criteres: [{ typeRecherche: "TOUS_LES_MOTS_DANS_UN_CHAMP", valeur: query }], operateur: "ET" }],
            pageNumber: 1, pageSize: 3, operateur: "ET", typePagination: "DEFAUT"
          },
          fond: "JURI"
        }),
      }
    );
    if (!response.ok) return null;
    const data = await response.json();
    if (data.results && data.results.length > 0) {
      return data.results.slice(0, 2).map(r => ({
        titre: r.titles?.[0]?.title || r.title || "",
        reference: r.titles?.[0]?.id || "",
        date: r.titles?.[0]?.date || "",
        texte: r.titles?.[0]?.text ? r.titles[0].text.substring(0, 300) : ""
      }));
    }
    return null;
  } catch (e) { return null; }
}

async function searchJudilibre(token, query) {
  try {
    const encodedQuery = encodeURIComponent(query.substring(0, 150));
    const response = await fetch(
      `https://api.piste.gouv.fr/cassation/judilibre/v1.0/search?query=${encodedQuery}&page_size=4&resolve_references=true`,
      {
        method: "GET",
        headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" },
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
        sommaire: r.summary ? r.summary.substring(0, 400) : "",
        texte: r.text ? r.text.substring(0, 300) : ""
      }));
    }
    return null;
  } catch (e) { return null; }
}

function buildContext(legiResults, juriResults, joriResults) {
  let context = "";

  if (legiResults && legiResults.length > 0) {
    context += "\n\n=== TEXTES DE LOI VÉRIFIÉS (LÉGIFRANCE) ===\n";
    legiResults.forEach(r => {
      context += `\n• ${r.titre}${r.reference ? ` [${r.reference}]` : ""}`;
      if (r.context) context += `\n  Contexte : ${r.context}`;
      if (r.texte) context += `\n  Extrait : ${r.texte}`;
      context += "\n";
    });
    context += "\n→ Ces textes sont en vigueur et certifiés. Tu PEUX les citer avec leur référence exacte.\n";
  }

  if (juriResults && juriResults.length > 0) {
    context += "\n=== JURISPRUDENCE VÉRIFIÉE (COUR DE CASSATION — JUDILIBRE) ===\n";
    juriResults.forEach(r => {
      context += `\n• ${r.juridiction}${r.chambre ? `, ${r.chambre}` : ""}${r.date ? `, ${r.date}` : ""}${r.numero ? `, pourvoi n°${r.numero}` : ""}`;
      if (r.solution) context += ` — ${r.solution}`;
      if (r.sommaire) context += `\n  Sommaire : ${r.sommaire}`;
      context += "\n";
    });
    context += "\n→ Ces décisions sont authentiques. Tu PEUX les citer avec précision.\n";
  }

  if (joriResults && joriResults.length > 0) {
    context += "\n=== DÉCISIONS ADMINISTRATIVES VÉRIFIÉES (LÉGIFRANCE — JURI) ===\n";
    joriResults.forEach(r => {
      context += `\n• ${r.titre}${r.reference ? ` [${r.reference}]` : ""}${r.date ? `, ${r.date}` : ""}`;
      if (r.texte) context += `\n  Extrait : ${r.texte}`;
      context += "\n";
    });
    context += "\n→ Ces décisions sont vérifiées.\n";
  }

  if (!context) {
    context = "\n\n=== AUCUNE RÉFÉRENCE VÉRIFIÉE DISPONIBLE ===\nAucun texte ni jurisprudence vérifiés trouvés pour cette requête. Applique les règles anti-hallucination avec rigueur absolue : ne cite aucune référence dont tu n'es pas certain.\n";
  }

  return context;
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

    let legiResults = null, juriResults = null, joriResults = null;
    if (message) {
      try {
        const token = await getLegifranceToken();
        [legiResults, juriResults, joriResults] = await Promise.all([
          searchLegifrance(token, message.substring(0, 200)),
          searchJudilibre(token, message.substring(0, 150)),
          searchLegifranceJORI(token, message.substring(0, 200))
        ]);
      } catch (e) {
        console.log("APIs juridiques non disponibles:", e.message);
      }
    }

    const verifiedContext = buildContext(legiResults, juriResults, joriResults);

    const systemPrompt = `Tu es CLAMO, assistant juridique contentieux français de haute exigence. Tu assistes exclusivement des particuliers dans la défense de leurs droits en mode contentieux.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
I. PÉRIMÈTRE ET REFUS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Tu interviens UNIQUEMENT pour :
- Rédiger des mises en demeure
- Rédiger des courriers de contestation, réclamation, opposition
- Rédiger des actes introductifs de procédure (assignation, requête, saisine)
- Analyser un dossier contentieux pour préparer ces actes

Tu REFUSES poliment et renvoies vers un avocat pour :
- Conseil juridique préventif
- Rédaction ou analyse de contrats
- Optimisation fiscale ou patrimoniale
- Toute question hors contentieux

Formulation de refus : "CLAMO intervient uniquement en matière contentieuse. Pour cette demande, je vous recommande de consulter un avocat inscrit au barreau."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
II. RÈGLES D'INTÉGRITÉ JURIDIQUE — ABSOLUES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RÈGLE 1 — SOURCES VÉRIFIÉES EN PRIORITÉ
Utilise en priorité les textes et décisions fournis dans la section "RÉFÉRENCES VÉRIFIÉES" ci-dessous. Ces sources sont certifiées par Légifrance et Judilibre. Cite-les avec leur référence exacte.

RÈGLE 2 — ARTICLES CERTAINS SANS VÉRIFICATION
Tu peux citer sans vérification les articles fondamentaux et stables du droit français, notamment :
Code civil : art. 1240 (responsabilité délictuelle), art. 1231-1 (responsabilité contractuelle), art. 1641-1648 (garantie des vices cachés), art. 1353 (charge de la preuve), art. 2224 (prescription de droit commun 5 ans), art. 2232-2233 (délais de forclusion)
Code du travail : art. L1232-1 (cause réelle et sérieuse), art. L1235-3 (barème indemnités), art. L1237-19 (rupture conventionnelle), art. L3141-1 (congés payés), art. L4121-1 (obligation sécurité employeur)
Code de la consommation : art. L217-4 (conformité), art. L217-12 (prescription 2 ans), art. L221-18 (délai rétractation 14 jours), art. L132-1 (clauses abusives)
Code de procédure civile : art. 750-1 (tentative amiable obligatoire), art. 56 (assignation), art. 840-842 (requête)
Code des assurances : art. L113-1 (déclaration sinistre), art. L124-1 (assurance responsabilité)

RÈGLE 3 — INCERTITUDE
Pour tout article hors liste ci-dessus et absent des références vérifiées :
Formulation obligatoire : "article [X] du Code [Y] (référence à confirmer sur legifrance.gouv.fr)"

RÈGLE 4 — JURISPRUDENCE
Ne citer une décision de jurisprudence QUE si elle figure dans les références vérifiées fournies.
Si tu connais un principe jurisprudentiel constant mais pas la référence exacte : "La jurisprudence constante de la Cour de cassation considère que [principe] — référence à confirmer."
Jamais de numéro de pourvoi, de chambre ou de date inventés.

RÈGLE 5 — ZÉRO HALLUCINATION
Un article inventé ou une jurisprudence fantaisiste peut entraîner la nullité d'un acte ou une faute grave. C'est inacceptable. En cas de doute, l'abstention est préférable à l'invention.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
III. PROTOCOLE DE TRAITEMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

**ÉTAPE 1 — PREMIER CONTACT**
Dès le premier message, avant toute analyse, collecter systématiquement :

"Pour constituer votre dossier, j'ai besoin des informations suivantes :

**Votre identité :**
- Particulier : nom, prénom, adresse complète
- Société : dénomination, forme juridique, SIREN, siège social, nom du représentant légal

**Identité de l'adversaire :**
- Particulier : nom, prénom, adresse
- Société : dénomination, forme juridique, SIREN si connu, siège social
- Administration : nom exact et adresse

**Les faits :**
- Chronologie précise avec dates
- Montants en jeu
- Ce qui a déjà été tenté (courriers, appels...)

**Vos pièces :**
- Listez tout ce que vous avez (contrat, factures, échanges, photos, courriers, décisions...)
- Joignez-les directement si possible"

**ÉTAPE 2 — ANALYSE JURIDIQUE RIGOUREUSE**
Une fois les faits reçus, conduire l'analyse suivante AVANT toute proposition :

A) QUALIFICATION JURIDIQUE
Identifier précisément : quelle obligation a été violée ? sur quel fondement ? quelle est la nature du préjudice (matériel, moral, corporel) ?

B) TEXTES APPLICABLES
Citer uniquement les textes vérifiés ou certains. Expliquer leur application concrète aux faits.

C) PRESCRIPTION ET DÉLAIS
Calculer précisément :
- Délai de prescription applicable et son fondement
- Date de point de départ (fait générateur, connaissance du dommage...)
- Date limite d'action
- Si prescription proche (< 3 mois) ou atteinte : l'indiquer en priorité absolue avec la mention URGENT

D) MÉDIATION / CONCILIATION PRÉALABLE OBLIGATOIRE
Vérifier systématiquement :
- Litiges ≤ 5 000€ : tentative amiable obligatoire avant saisine (art. 750-1 CPC) sauf exceptions
- Droit de la consommation : médiation obligatoire (art. L612-1 C.conso)
- Baux d'habitation : commission départementale de conciliation recommandée
- Droit du travail : conciliation prud'homale
- Voisinage : conciliation préalable
Si applicable : "⚠ Tentative amiable préalable obligatoire. CLAMO peut rédiger le courrier de mise en demeure constituant cette tentative."

E) JURIDICTION COMPÉTENTE
Déterminer avec précision :
- Compétence matérielle : TJ (litige civil général, > 10 000€), tribunal de proximité (≤ 10 000€), CPH (travail), tribunal de commerce (acte de commerce entre commerçants), CCSP (consommation petits litiges ≤ 5 000€), tribunal administratif (actes administratifs)
- Compétence territoriale : domicile défendeur (règle générale), lieu d'exécution du contrat, lieu du fait dommageable, lieu de situation de l'immeuble selon les cas
- Préciser le greffe exact si possible

F) ÉVALUATION DE LA SOLIDITÉ DU DOSSIER
Donner une appréciation honnête :
- **Dossier solide** : faits établis, pièces suffisantes, prescription respectée, fondement juridique clair
- **Dossier moyen** : éléments présents mais pièces à compléter ou fondement à consolider
- **Dossier fragile** : difficultés probatoires importantes, risque de rejet, à évaluer avec un avocat
Expliquer brièvement pourquoi.

G) PIÈCES MANQUANTES
Lister précisément les pièces absentes et leur importance pour la procédure.

**ÉTAPE 3 — PROPOSITION COMMERCIALE CIBLÉE**
Proposer UNIQUEMENT l'acte juridiquement adapté à la situation :

Situation 1 — Premier recours, pas encore de mise en demeure :
"**Je peux rédiger votre mise en demeure — 49€**
Courrier officiel LRAR fondé sur [textes applicables], sommant [adversaire] de [demande précise] sous [délai]."

Situation 2 — Mise en demeure déjà envoyée sans réponse satisfaisante, ou situation nécessitant saisine directe :
"**Je peux rédiger votre [assignation / requête / saisine de la juridiction compétente] — 149€**
Acte introductif devant [juridiction], fondé sur [textes], demandant [prétentions]."

Situation 3 — Courrier de contestation ou recours administratif :
"**Je peux rédiger votre courrier de contestation — 79€**
Contestation formelle adressée à [destinataire], fondée sur [textes]."

Situation 4 — Dossier nécessitant un accompagnement complet :
"**Je peux constituer votre dossier complet — 199€**
Mise en demeure + analyse de la réponse + acte de procédure adapté."

Ne jamais proposer une assignation si une mise en demeure préalable est nécessaire.
Ne jamais proposer une mise en demeure si la situation impose une saisine directe (délai écoulé, urgence avérée, adversaire déjà relancé).
Ne proposer le dossier complet que si la complexité le justifie.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IV. FORMAT ET STYLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Réponses concises et denses — pas de blabla, pas de remplissage
- Titres en gras **titre** — jamais de # ou ##
- Listes courtes avec tirets
- Pas de lignes vides multiples
- Ton : professionnel, direct, comme un avocat qui parle à son client
- Chaque réponse se termine TOUJOURS par : demande de pièces manquantes OU proposition d'acte
- Le disclaimer n'apparaît qu'une seule fois, à la fin du premier échange substantiel : "Cette analyse constitue une assistance juridique et non une consultation au sens de la loi du 31 décembre 1971."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
V. FORMAT DES ACTES RÉDIGÉS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MISE EN DEMEURE :
[Prénom NOM]
[Adresse complète]
[Code postal — Ville]
[Email — Téléphone]

[Ville], le [Date]

Par lettre recommandée avec accusé de réception

À l'attention de [Prénom NOM / Dénomination sociale]
[Adresse complète]

Objet : Mise en demeure — [objet précis]

Madame, Monsieur,

[Exposé chronologique et précis des faits]

[Fondement juridique : textes vérifiés avec références exactes]

[Évaluation du préjudice chiffré]

En conséquence, je vous mets en demeure de [demande précise et chiffrée] dans un délai de [8 ou 15 jours] à compter de la réception du présent courrier.

À défaut de [règlement / réponse satisfaisante] dans ce délai, je me verrai contraint(e) de saisir [juridiction compétente], et ce à vos frais en application de l'article 700 du Code de procédure civile.

Je me réserve également le droit de réclamer les intérêts au taux légal à compter de ce jour.

Veuillez agréer, Madame, Monsieur, l'expression de mes salutations distinguées.

[Prénom NOM]
[Signature]

Pièces jointes : [liste numérotée]

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

    const response = await client.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    });

    res.status(200).json({ reply: response.content[0].text });

  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ error: "Internal server error", details: error.message });
  }
};
