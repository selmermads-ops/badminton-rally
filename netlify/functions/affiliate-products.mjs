import { aliRequest } from './affiliate-check.mjs';

const topics = { grips: 'badminton grip', bags: 'badminton racket bag', accessories: 'badminton racket cover' };
const cache = new Map();
const ttl = 6 * 60 * 60 * 1000;

export function safeLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && (url.hostname === 'aliexpress.com' || url.hostname.endsWith('.aliexpress.com')) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export async function getProducts(topic, env = process.env, fetcher = fetch) {
  if (!Object.hasOwn(topics, topic)) return { status: 'invalid_topic', products: [] };
  if (!env.ALIEXPRESS_APP_KEY || !env.ALIEXPRESS_APP_SECRET || !env.ALIEXPRESS_TRACKING_ID) return { status: 'not_configured', products: [] };
  const reply = await aliRequest('aliexpress.affiliate.product.query', {
    keywords: topics[topic], page_size: '10', target_currency: 'USD', target_language: 'EN', ship_to_country: 'DK', tracking_id: env.ALIEXPRESS_TRACKING_ID
  }, env, fetcher);
  if (reply.failure) return { status: 'provider_unavailable', products: [] };
  const rows = reply.result?.products?.product;
  if (!Array.isArray(rows)) return { status: 'unexpected_response', products: [] };
  const products = rows.map(p => ({
    id: String(p.product_id || ''), title: String(p.product_title || '').slice(0, 300),
    productUrl: safeLink(p.product_detail_url), affiliateUrl: safeLink(p.promotion_link)
  })).filter(p => p.id && p.title && p.productUrl && p.affiliateUrl && /badminton/i.test(p.title)).slice(0, 5);
  return { status: 'ok', source: 'AliExpress Affiliate API', topic, checkedAt: new Date().toISOString(), shipToCountry: 'DK', reviewRequired: true, products };
}

export default async request => {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'X-Robots-Tag': 'noindex', 'X-Content-Type-Options': 'nosniff' };
  if (request.method !== 'GET') return new Response(JSON.stringify({ status: 'method_not_allowed' }), { status: 405, headers: { ...headers, Allow: 'GET' } });
  const topic = new URL(request.url).searchParams.get('topic') || 'grips';
  if (!Object.hasOwn(topics, topic)) return new Response(JSON.stringify({ status: 'invalid_topic' }), { status: 400, headers });
  let entry = cache.get(topic);
  if (!entry || Date.now() - entry.at > ttl) {
    try { entry = { at: Date.now(), data: await getProducts(topic) }; }
    catch { entry = { at: Date.now(), data: { status: 'provider_unavailable', products: [] } }; }
    cache.set(topic, entry);
  }
  const ok = entry.data.status === 'ok';
  return new Response(JSON.stringify(entry.data), { status: ok ? 200 : 503, headers: {
    ...headers, 'Cache-Control': ok ? 'public, max-age=300' : 'no-store',
    'Netlify-CDN-Cache-Control': ok ? 'public, durable, max-age=21600' : 'no-store'
  } });
};
