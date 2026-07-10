import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'userId manquant' });
    }

    // Récupérer le customer_id Stripe lié à l'utilisateur
    const { data: profile, error } = await supabase
      .from('abonnements')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .single();

    if (error || !profile?.stripe_customer_id) {
      return res.status(404).json({ error: 'Client Stripe introuvable pour cet utilisateur' });
    }

    // Créer la session du portail client Stripe
    const session = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${process.env.APP_URL || 'https://www.menu-du-jour.com'}`,
    });

    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Erreur création portail Stripe:', err);
    return res.status(500).json({ error: 'Erreur serveur' });
  }
}
