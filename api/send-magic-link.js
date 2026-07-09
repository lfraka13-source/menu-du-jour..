// api/send-magic-link.js
// Contournement de l'envoi d'email de Supabase (SMTP en panne) :
// 1. Genere le lien magique via l'API admin Supabase (aucun email envoye par Supabase)
// 2. Envoie ce lien par email via l'API Resend
// Variables d'environnement requises (Vercel > Settings > Environment Variables) :
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (deja presentes pour le webhook Stripe)
//   RESEND_API_KEY (cle API Resend, commence par re_)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_KEY = process.env.RESEND_API_KEY;

function adminHeaders() {
  return {
    "apikey": SERVICE_KEY,
    "Authorization": "Bearer " + SERVICE_KEY,
    "Content-Type": "application/json",
  };
}

async function generateLink(email, redirectTo) {
  const res = await fetch(SUPABASE_URL + "/auth/v1/admin/generate_link", {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({ type: "magiclink", email, redirect_to: redirectTo }),
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { email, redirect_to } = req.body || {};
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Email invalide" });
  }
  const redirectTo = redirect_to || "https://menu-du-jour.com";

  try {
    // 1. Genere le lien magique
    let link = await generateLink(email, redirectTo);

    // Si l'utilisateur n'existe pas encore, on le cree puis on reessaie
    if (!link.ok) {
      const createRes = await fetch(SUPABASE_URL + "/auth/v1/admin/users", {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ email, email_confirm: true }),
      });
      if (!createRes.ok) {
        const err = await createRes.json();
        // 422 = existe deja : on ignore, sinon vraie erreur
        if (createRes.status !== 422) {
          console.error("create user error:", err);
          return res.status(500).json({ error: "user creation failed" });
        }
      }
      link = await generateLink(email, redirectTo);
    }

    if (!link.ok || !link.data.action_link) {
      console.error("generate_link error:", link.data);
      return res.status(500).json({ error: "generate_link failed" });
    }

    // 2. Envoie l'email via Resend
    const sendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + RESEND_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "menu du jour <no-reply@menu-du-jour.com>",
        to: [email],
        subject: "Ton lien de connexion — Menu du jour",
        html:
          '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">' +
          '<h2 style="color:#d05a2b">Menu du jour</h2>' +
          '<p>Clique sur le bouton ci-dessous pour te connecter :</p>' +
          '<p style="text-align:center;margin:32px 0">' +
          '<a href="' + link.data.action_link + '" style="background:#d05a2b;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold">Se connecter</a>' +
          '</p>' +
          '<p style="color:#888;font-size:13px">Ce lien est valable 1 heure et ne peut etre utilise qu\'une fois. Si tu n\'es pas a l\'origine de cette demande, ignore cet email.</p>' +
          '</div>',
      }),
    });

    if (!sendRes.ok) {
      const err = await sendRes.json();
      console.error("resend error:", err);
      return res.status(500).json({ error: "email send failed" });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("send-magic-link error:", e);
    return res.status(500).json({ error: "internal error" });
  }
}
