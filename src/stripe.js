import Stripe from 'stripe';
import { config } from './config.js';

export const stripe = new Stripe(config.stripe.secretKey);
