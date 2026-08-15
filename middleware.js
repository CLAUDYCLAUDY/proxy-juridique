// clamo.fr — porte d'accès temporaire
// Déposer ce fichier à la RACINE du dépôt, à côté de index.html.
// Variables d'environnement à définir dans Vercel (Settings > Environment Variables) :
//   CLAMO_CLE     le mot de passe (ex. : Palatino-2026)
//   CLAMO_OUVERT  mettre à 1 le jour de l'ouverture publique, ou supprimer ce fichier

export const config = {
  // tout est protégé sauf les ressources qui doivent rester lisibles
  matcher: ['/((?!_next|favicon.ico|robots.txt|images/).*)'],
};

const COOKIE = 'clamo_acces';

export default function middleware(request) {
  const cle = process.env.CLAMO_CLE;

  // ouverture publique : le middleware s'efface
  if (process.env.CLAMO_OUVERT === '1' || !cle) {
    return;
  }

  const url = new URL(request.url);

  // 1. déjà autorisé
  const cookies = request.headers.get('cookie') || '';
  if (cookies.split(';').some((c) => c.trim() === `${COOKIE}=${cle}`)) {
    return;
  }

  // 2. le formulaire vient d'être validé
  if (url.searchParams.get('cle') === cle) {
    url.searchParams.delete('cle');
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.pathname + (url.search || ''),
        'Set-Cookie': `${COOKIE}=${cle}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  // 3. porte fermée
  const erreur = url.searchParams.has('cle');
  return new Response(page(url.pathname, erreur), {
    status: 401,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

function page(chemin, erreur) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>CLAMO — accès réservé</title>
<style>
  :root{ --fond:#0E0F12; --encre:#F2F1EE; --gris:#8A8A85; --filet:rgba(242,241,238,.16); --alerte:#B4796A; }
  *{margin:0;padding:0;box-sizing:border-box}
  body{background:var(--fond);color:var(--encre);min-height:100svh;display:flex;
    align-items:center;justify-content:center;padding:32px 22px;
    font-family:ui-sans-serif,-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;
    font-weight:300;-webkit-font-smoothing:antialiased}
  .porte{width:100%;max-width:380px;text-align:center}
  .marque{font-size:15px;letter-spacing:.42em;text-transform:uppercase;padding-left:.42em}
  .filet{width:40px;height:1px;background:var(--filet);margin:26px auto}
  p{color:var(--gris);font-size:14.5px;line-height:1.7;margin-bottom:28px}
  form{display:flex;flex-direction:column;gap:14px}
  input{width:100%;background:transparent;border:none;border-bottom:1px solid var(--filet);
    color:var(--encre);font:inherit;font-size:16px;padding:11px 2px;text-align:center;
    letter-spacing:.06em;transition:border-color .3s}
  input:focus{outline:none;border-bottom-color:var(--encre)}
  input::placeholder{color:var(--gris);letter-spacing:.14em;font-size:13px;text-transform:uppercase}
  button{background:transparent;border:1px solid var(--filet);color:var(--encre);font:inherit;
    font-size:11.5px;letter-spacing:.24em;text-transform:uppercase;padding:14px;cursor:pointer;
    transition:.3s;margin-top:6px}
  button:hover{background:var(--encre);color:var(--fond);border-color:var(--encre)}
  .erreur{color:var(--alerte);font-size:12.5px;letter-spacing:.06em;margin-top:16px}
  .pied{color:var(--gris);font-size:11px;letter-spacing:.2em;text-transform:uppercase;margin-top:38px}
  @media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
  <main class="porte">
    <p class="marque">CLAMO</p>
    <div class="filet"></div>
    <p>Cet espace n'est pas encore ouvert.<br>L'accès est réservé aux personnes disposant de la clé.</p>
    <form method="GET" action="${chemin}">
      <input type="password" name="cle" placeholder="Clé d'accès" autofocus autocomplete="current-password" required>
      <button type="submit">Entrer</button>
    </form>
    ${erreur ? '<p class="erreur">Clé non reconnue.</p>' : ''}
    <p class="pied">Ouverture prochaine</p>
  </main>
</body>
</html>`;
}
