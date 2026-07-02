// api/create-checkout-session.js
// Reçoit le token de connexion de l'utilisateur (envoyé par le bouton
// "S'abonner" de l'app), vérifie son identité auprès de Supabase, puis crée
// une session de paiement Stripe et renvoie l'URL vers laquelle rediriger.
//
// Déploiement : place ce fichier dans /api à la racine de ton projet Vercel.
// Accessible ensuite à : https://tondomaine.fr/api/create-checkout-session

import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Vérifie le token auprès de Supabase et renvoie l'utilisateur correspondant.
// On ne fait JAMAIS confiance à un identifiant envoyé tel quel par le
// navigateur : on redemande la vérité à Supabase avec le token fourni.
async function getSupabaseUser(accessToken) {
  const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: process.env.SUPABASE_ANON_KEY,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Méthode non autorisée" });
  }

  const { access_token } = req.body || {};
  if (!access_token) {
    return res.status(400).json({ error: "access_token manquant" });
  }

  const user = await getSupabaseUser(access_token);
  if (!user || !user.id) {
    return res.status(401).json({ error: "Session invalide, reconnecte-toi." });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID, // ID du prix récurrent créé dans Stripe
          quantity: 1,
        },
      ],
      // Relie ce paiement à l'utilisateur Supabase : c'est cette valeur que
      // le webhook (stripe-webhook.js) lit dans client_reference_id pour
      // savoir quel compte marquer comme "actif".
      client_reference_id: user.id,
      customer_email: user.email,
      success_url: `${process.env.APP_URL}?checkout=success`,
      cancel_url: `${process.env.APP_URL}?checkout=cancel`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error("Erreur création session Stripe :", err);
    return res.status(500).json({ error: "Erreur lors de la création du paiement" });
  }
}
