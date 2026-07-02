// api/stripe-webhook.js
// Webhook Stripe -> Supabase pour l'app "Menu du jour"
//
// Ce fichier reçoit les notifications que Stripe envoie automatiquement
// à chaque paiement, renouvellement, échec ou annulation d'abonnement,
// et met à jour le statut de l'utilisateur correspondant dans Supabase.
//
// Déploiement : place ce fichier dans un dossier /api à la racine de ton
// projet Vercel. Vercel le transforme automatiquement en endpoint accessible
// à l'URL : https://tondomaine.fr/api/stripe-webhook

import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

// Vercel parse le body en JSON par défaut. Stripe a besoin du body BRUT
// (non modifié) pour vérifier que la requête vient bien de lui. On désactive
// donc le parsing automatique.
export const config = {
  api: {
    bodyParser: false,
  },
};

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// La "service role key" de Supabase a tous les droits (contrairement à la clé
// publique utilisée côté app) : elle ne doit JAMAIS être exposée côté client,
// uniquement ici, côté serveur.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Lit le corps brut de la requête (nécessaire pour la vérification de signature)
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).send("Méthode non autorisée");
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers["stripe-signature"];

  // 1. Vérifier que la requête vient réellement de Stripe (et pas d'un tiers
  // malveillant qui simulerait un paiement). C'est l'étape de sécurité
  // la plus importante de tout ce fichier.
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Signature Stripe invalide :", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2. Traiter l'événement selon son type
  try {
    switch (event.type) {
      // Un client vient de payer pour la première fois (fin du Checkout Stripe)
      case "checkout.session.completed": {
        const session = event.data.object;

        // client_reference_id : l'identifiant de l'utilisateur Supabase,
        // qu'on aura transmis nous-mêmes lors de la création de la session
        // de paiement (voir le code du bouton "S'abonner" côté app).
        const userId = session.client_reference_id;
        const stripeCustomerId = session.customer;
        const stripeSubscriptionId = session.subscription;

        const { error } = await supabase.from("abonnements").upsert(
          {
            user_id: userId,
            stripe_customer_id: stripeCustomerId,
            stripe_subscription_id: stripeSubscriptionId,
            statut: "actif",
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" }
        );
        if (error) throw error;
        break;
      }

      // Renouvellement mensuel réussi, changement de carte, etc.
      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const statut =
          subscription.status === "active" || subscription.status === "trialing"
            ? "actif"
            : "inactif";

        const { error } = await supabase
          .from("abonnements")
          .update({ statut, updated_at: new Date().toISOString() })
          .eq("stripe_subscription_id", subscription.id);
        if (error) throw error;
        break;
      }

      // L'utilisateur annule son abonnement
      case "customer.subscription.deleted": {
        const subscription = event.data.object;

        const { error } = await supabase
          .from("abonnements")
          .update({ statut: "inactif", updated_at: new Date().toISOString() })
          .eq("stripe_subscription_id", subscription.id);
        if (error) throw error;
        break;
      }

      // Le paiement du renouvellement a échoué (carte expirée, etc.)
      case "invoice.payment_failed": {
        const invoice = event.data.object;

        const { error } = await supabase
          .from("abonnements")
          .update({ statut: "inactif", updated_at: new Date().toISOString() })
          .eq("stripe_customer_id", invoice.customer);
        if (error) throw error;
        break;
      }

      default:
        // Tous les autres types d'événements Stripe (il y en a des dizaines)
        // ne nous concernent pas ici, on les ignore sans erreur.
        break;
    }

    // Stripe attend un code 200 rapide. Si on ne répond pas à temps,
    // il considère l'envoi comme échoué et réessaiera plus tard.
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error("Erreur de traitement du webhook :", err);
    return res.status(500).send("Erreur serveur");
  }
}
