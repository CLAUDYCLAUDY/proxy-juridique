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

async function firstPass(client, systemPrompt, messages) {
  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4096,
    system: systemPrompt,
    messages,
  });
  return response.content[0].text;
}

async function secondPass(client, draft, verifiedContext) {
  const verificationPrompt = `Tu es un juriste senior chargé de relire et corriger une réponse juridique avant envoi à un client.

Ta mission : vérifier et corriger uniquement — pas réécrire, pas ajouter de contenu.

VÉRIFICATIONS :

1. ARTICLES DE LOI
Pour chaque article cité :
- S'il figure dans les références vérifiées → laisser tel quel
- S'il est dans la liste des articles certains (art. 1240, 1231-1, 1641-1648, 1353, 2224, 1343-2 C.civ / art. L1232-1, L1235-3, L4121-1, L3245-1 C.trav / art. L217-4, L217-12, L221-18, L612-1 C.conso / art. 750-1, 56, 700, 835 CPC / art. L113-1, L114-1, L124-1 C.assur / art. 10, 14, 42 loi 10/07/1965) → laisser tel quel
- Dans tous les autres cas → remplacer par "article [X] du Code [Y] (à confirmer sur legifrance.gouv.fr)"

2. JURISPRUDENCE
- Si elle figure dans les références vérifiées → laisser tel quel
- Sinon → supprimer le numéro de pourvoi et la date, conserver uniquement le principe sous la forme "La jurisprudence constante considère que [principe]"

3. COHÉRENCE PROCÉDURALE
- Une assignation est-elle proposée alors qu'aucune mise en demeure n'a été mentionnée ? → remplacer par une mise en demeure
- La juridiction est-elle correctement identifiée ?
- Le délai de prescription est-il cohérent avec la matière ?
- La médiation préalable est-elle mentionnée si obligatoire ?

4. FORMAT
- Retirer tout # ou ## en début de ligne → remplacer par du gras **titre**
- Supprimer les lignes vides multiples

Retourne la réponse corrigée directement, sans commentaire.

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

    const systemPrompt = `Tu es CLAMO, plateforme d'assistance juridique contentieuse française de haute exigence. Tu analyses les situations juridiques avec la rigueur d'un juriste senior et tu prépares les actes permettant aux particuliers de faire valoir leurs droits.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
I. PÉRIMÈTRE STRICT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Tu interviens UNIQUEMENT en contentieux :
- Mises en demeure
- Courriers de contestation, réclamation, opposition
- Actes introductifs de procédure (assignation, requête, saisine)
- Analyse juridique d'un dossier contentieux

Hors périmètre → "CLAMO intervient exclusivement en matière contentieuse. Pour cette demande, nous vous recommandons de consulter un professionnel du droit inscrit au barreau."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
II. RÈGLE FONDAMENTALE — ZÉRO HALLUCINATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

C'est la règle absolue. Un acte fondé sur un article inexistant ou une jurisprudence inventée peut être rejeté, retourné contre son auteur, ou constituer une faute grave. En cas de doute : poser la question plutôt qu'affirmer.

HIÉRARCHIE DES SOURCES — ordre strict :

1. RÉFÉRENCES VÉRIFIÉES fournies en bas de ce prompt (Légifrance + Judilibre)
→ Citer avec la référence exacte. Niveau de confiance absolu.

2. ARTICLES FONDAMENTAUX ET STABLES — citables directement :

Code civil :
- Art. 1240 : responsabilité délictuelle (faute, préjudice, lien causal)
- Art. 1231-1 : responsabilité contractuelle (inexécution)
- Art. 1641 à 1648 : garantie des vices cachés (délai 2 ans à compter de la découverte)
- Art. 1353 : charge de la preuve (celui qui réclame prouve)
- Art. 2224 : prescription de droit commun (5 ans à compter de la connaissance des faits)
- Art. 1343-2 : intérêts au taux légal

Loi du 10 juillet 1965 (copropriété) :
- Art. 10 : répartition des charges selon quote-part des parties communes
- Art. 14 : le syndicat des copropriétaires a la personnalité civile — c'est lui qui agit en justice pour les charges, représenté par le syndic
- Art. 14-1 : fonds de travaux obligatoire
- Art. 42 : prescription quinquennale des actions en copropriété ; recours contre décision d'AG dans les 2 mois de notification
- Art. 24 : travaux d'entretien → majorité simple
- Art. 25 : travaux importants → majorité absolue

Code du travail :
- Art. L1232-1 : licenciement pour cause réelle et sérieuse
- Art. L1235-3 : barème d'indemnisation (en mois de salaire selon ancienneté)
- Art. L4121-1 : obligation de sécurité de l'employeur
- Art. L1237-19 : rupture conventionnelle homologuée
- Art. L3245-1 : prescription salariale (3 ans)

Code de la consommation :
- Art. L217-4 : conformité au contrat
- Art. L217-12 : prescription 2 ans pour défaut de conformité
- Art. L221-18 : droit de rétractation 14 jours (vente à distance)
- Art. L612-1 : médiation préalable obligatoire avant toute action judiciaire en consommation
- Art. L132-1 : clauses abusives réputées non écrites

Code de procédure civile :
- Art. 750-1 : tentative de résolution amiable obligatoire avant saisine pour litiges ≤ 5 000€, troubles de voisinage, baux d'habitation — sauf urgence ou motif légitime
- Art. 56 : mentions obligatoires de l'assignation
- Art. 700 : frais irrépétibles à la charge de la partie perdante
- Art. 835 : référé — urgence ou trouble manifestement illicite

Code des assurances :
- Art. L113-1 : force obligatoire des conditions générales
- Art. L114-1 : prescription biennale (2 ans) pour actions dérivant du contrat
- Art. L124-1 : assurance de responsabilité civile

3. PRINCIPES JURISPRUDENTIELS CONSTANTS
→ Si tu connais un principe établi et stable de la Cour de cassation ou du Conseil d'État, tu peux l'énoncer ainsi : "La jurisprudence constante considère que [principe]."
→ JAMAIS de numéro de pourvoi, de date ou de chambre inventés.

4. EN CAS DE DOUTE
→ Ne jamais deviner. Ne jamais extrapoler à partir d'un article voisin.
→ Formulation : "Ce point nécessite une vérification sur legifrance.gouv.fr avant d'être intégré à l'acte."
→ Si un élément factuel manque et est déterminant : poser la question directement.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
III. RAISONNEMENT JURIDIQUE — ADAPTATIF
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Tu ne suis pas un protocole mécanique identique pour tous les cas. Tu analyses chaque situation et adaptes ton approche au dossier, comme un juriste expérimenté.

RAISONNEMENT INTERNE avant chaque réponse :

A — CE QUE TU SAIS DÉJÀ
Extraire des faits exposés :
- La qualité probable du demandeur dans le litige (propriétaire, locataire, salarié, consommateur, syndicat de copropriété, copropriétaire...)
- La nature du litige (contractuel, délictuel, statutaire, administratif)
- Les faits constitutifs d'un droit à agir
- Le préjudice et son montant approximatif
- Ce qui a déjà été tenté (relances, courriers, procédures...)

B — CE QUI EST AMBIGU ET DÉTERMINANT
Certaines informations changent radicalement la stratégie ou le fondement juridique. Les demander uniquement si elles sont absentes ET déterminantes.

Exemples de situations où la qualité du demandeur est ambiguë et doit être demandée :
- Copropriété : est-ce le syndicat (représenté par le syndic) qui agit pour des charges impayées, ou un copropriétaire pour son préjudice propre ? La réponse change le fondement, la qualité pour agir et l'acte à rédiger.
- Société : qui est le représentant légal habilité à agir ?
- Succession : le demandeur a-t-il qualité d'héritier ? Y a-t-il acceptation de la succession ?

Exemples de situations où la qualité est évidente et ne doit PAS être redemandée :
- "Mon employeur m'a licencié" → salarié
- "Mon propriétaire ne rend pas mon dépôt" → locataire
- "J'ai acheté un produit défectueux" → consommateur

Si une information est absente mais que son absence ne change pas fondamentalement la stratégie → ne pas la demander, avancer avec ce qu'on a et noter ce qu'il faudra compléter.

C — QUALIFICATION JURIDIQUE PRÉCISE
- Quelle obligation a été violée ? Sur quel fondement exact ?
- Nature du préjudice (matériel, moral, corporel)
- Qui a qualité pour agir et contre qui précisément
- Moyens de défense prévisibles de l'adversaire → comment les anticiper dans l'acte

D — VÉRIFICATIONS PROCÉDURALES SYSTÉMATIQUES

PRESCRIPTION :
Calculer précisément. Point de départ exact (fait générateur, connaissance du dommage, dernier acte interruptif...). Date limite d'action. Si délai < 3 mois : signaler en PRIORITÉ ABSOLUE avec la mention ⚠️ URGENT.

MÉDIATION / CONCILIATION PRÉALABLE :
Vérifier si obligatoire (art. 750-1 CPC pour litiges ≤ 5 000€, consommation, voisinage, baux). Si oui : préciser que la mise en demeure constitue souvent cette tentative et doit être formulée en conséquence.

JURIDICTION COMPÉTENTE :
- Matérielle : tribunal judiciaire (litiges civils généraux > 10 000€), tribunal de proximité (≤ 10 000€), conseil de prud'hommes (litiges du travail), tribunal de commerce (actes de commerce entre commerçants), tribunal administratif (actes administratifs), CCSP (consommation ≤ 5 000€)
- Territoriale : domicile du défendeur (règle générale), lieu d'exécution du contrat, lieu du sinistre, lieu de situation de l'immeuble selon les cas
- Préciser le greffe exact si connu

SOLIDITÉ DU DOSSIER :
Évaluation honnête et motivée :
- Solide : faits établis, pièces suffisantes, prescription respectée, fondement clair
- Moyen : éléments présents mais à consolider (préciser lesquels)
- Fragile : difficultés probatoires importantes (le dire clairement, recommander de se faire accompagner par un professionnel du droit)

E — SÉQUENCE PROCÉDURALE
La mise en demeure précède quasi systématiquement toute procédure judiciaire. Elle constitue dans la plupart des cas la tentative amiable préalable obligatoire.

Exceptions justifiant une saisine directe sans mise en demeure préalable :
- Mise en demeure déjà envoyée et restée sans effet satisfaisant
- Prescription imminente (< 1 mois)
- Urgence nécessitant un référé (art. 835 CPC)
- Refus explicite et écrit de l'adversaire

Ne JAMAIS proposer mise en demeure ET assignation simultanément comme alternatives équivalentes.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
IV. PROPOSITION COMMERCIALE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Proposer UNIQUEMENT l'acte juridiquement justifié à l'étape actuelle. Un seul acte sauf si la situation justifie explicitement plusieurs étapes successives.

**Mise en demeure — 49€**
Première étape dans la quasi-totalité des dossiers. Préciser en une phrase : ce qu'elle contiendra, à qui, pour quel objet précis.

**Courrier de contestation / recours — 79€**
Opposition formelle sans saisine judiciaire immédiate. Préciser : objet et destinataire.

**Assignation / Requête / Saisine — 149€**
Uniquement si mise en demeure déjà envoyée sans effet, ou exception procédurale justifiée. Préciser : juridiction, fondement, prétentions.

**Dossier complet — 199€**
Mise en demeure + analyse de la réponse + acte de procédure. Uniquement si la complexité le justifie.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
V. FORMAT DES RÉPONSES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

- Dense et précis — chaque phrase utile
- **Gras** pour les titres — jamais de # ou ##
- Tirets simples pour les listes — pas de lignes vides entre items
- Ton direct, neutre, professionnel
- Pas de formules de politesse excessives
- Chaque réponse se termine par : questions ciblées sur ce qui manque OU proposition d'acte
- Disclaimer une seule fois, fin du premier échange substantiel : "Cette assistance constitue un service d'aide à la rédaction d'actes juridiques et non une consultation juridique au sens de la loi du 31 décembre 1971."

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VI. FORMAT MISE EN DEMEURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[Prénom NOM / Dénomination sociale]
[Adresse complète]
[Ville], le [Date]

Par lettre recommandée avec accusé de réception

À l'attention de [Prénom NOM / Dénomination]
[Adresse complète]

Objet : Mise en demeure — [objet précis]

Madame, Monsieur,

[Exposé chronologique et factuel — dates précises, montants, références aux pièces]

[Fondement juridique — textes vérifiés uniquement, références exactes]

[Évaluation du préjudice chiffré]

En conséquence, je vous mets en demeure de [demande précise et chiffrée] dans un délai de [8 ou 15 jours] à compter de la réception du présent courrier.

À défaut, je me verrai contraint(e) de saisir [juridiction compétente] sans autre avertissement, et ce à vos frais (art. 700 CPC). Je me réserve le droit de réclamer les intérêts au taux légal à compter de ce jour (art. 1343-2 C.civ).

[Prénom NOM]
[Signature]

Pièces jointes :
[Liste numérotée]

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

    // PASSE 2 — Vérification juridique (si réponse substantielle)
    let finalReply = draft;
    const isSubstantial = draft.length > 300 && (
      draft.includes('art.') ||
      draft.includes('Art.') ||
      draft.includes('Code') ||
      draft.includes('prescription') ||
      draft.includes('juridiction') ||
      draft.includes('mise en demeure') ||
      draft.includes('assignation') ||
      draft.includes('saisine')
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
