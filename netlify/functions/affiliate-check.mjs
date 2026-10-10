import { createHmac } from 'node:crypto';

// Server-only diagnostics. Never log provider bodies, credentials, signatures or tokens.
export function signTop(params, secret) {
  const text = Object.keys(params).filter(k => k !== 'sign' && params[k] !== '').sort()
    .map(k => k + params[k]).join('');
  return createHmac('md5', secret).update(text, 'utf8').digest('hex').toUpperCase();
}

async function readJSON(url, options, fetcher) {
  const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(7000) });
  const type = response.headers.get('content-type') || '';
  if (!type.includes('json')) return { failure: { status: 'non_json_response', httpStatus: response.status } };
  const data = await response.json();
  if (!response.ok) return { failure: { status: 'http_error', httpStatus: response.status } };
  return { data };
}

async function checkInvolve(env, fetcher) {
  if (!env.INVOLVE_ASIA_API_KEY || !env.INVOLVE_ASIA_API_SECRET) return { status: 'missing_credentials' };
  const auth = await readJSON('https://api.involve.asia/api/authenticate', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ key: env.INVOLVE_ASIA_API_KEY, secret: env.INVOLVE_ASIA_API_SECRET })
  }, fetcher);
  if (auth.failure) return auth.failure;
  const token = auth.data?.data?.token;
  if (typeof token !== 'string' || !token) return { status: 'authentication_not_confirmed' };
  const offers = await readJSON('https://api.involve.asia/api/offers/all', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: '{}'
  }, fetcher);
  if (offers.failure) return { authentication: 'ok', offers: offers.failure };
  const payload = offers.data?.data;
  const rows = Array.isArray(payload) ? payload : payload?.offers ?? payload?.data ?? offers.data?.offers;
  if (offers.data?.status !== 'success' || !Array.isArray(rows)) return {
    authentication: 'ok', offers: 'unexpected_response',
    responseShape: {
      topLevelKeys: Object.keys(offers.data || {}).filter(k => /^[a-z_]{1,32}$/i.test(k)).slice(0, 20),
      dataKeys: payload && typeof payload === 'object' && !Array.isArray(payload) ? Object.keys(payload).filter(k => /^[a-z_]{1,32}$/i.test(k)).slice(0, 20) : [],
      successStatus: offers.data?.status === 'success'
    }
  };
  return { authentication: 'ok', offers: 'ok', offerCount: rows.length, offerFieldNames: Object.keys(rows[0] || {}).filter(k => /^[a-z_]{1,40}$/i.test(k)), linkGeneration: 'not_tested' };
}

export async function aliRequest(method, extra, env, fetcher = fetch) {
  const timestamp = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const params = { app_key: env.ALIEXPRESS_APP_KEY, method, timestamp, format: 'json', v: '2.0', sign_method: 'hmac', ...extra };
  params.sign = signTop(params, env.ALIEXPRESS_APP_SECRET);
  const response = await readJSON('https://api-sg.aliexpress.com/sync', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString()
  }, fetcher);
  if (response.failure) return { failure: response.failure };
  const root = response.data?.[method.replaceAll('.', '_') + '_response']?.resp_result;
  if (response.data?.error_response) {
    const code = Number(response.data.error_response.code);
    return { failure: { status: 'provider_rejected', ...(Number.isFinite(code) ? { code } : {}) } };
  }
  if (Number(root?.resp_code) !== 200) return { failure: { status: 'api_not_confirmed', ...(Number.isFinite(Number(root?.resp_code)) ? { code: Number(root.resp_code) } : {}) } };
  return { result: root.result };
}

async function checkAli(env, fetcher) {
  if (!env.ALIEXPRESS_APP_KEY || !env.ALIEXPRESS_APP_SECRET) return { status: 'missing_credentials' };
  if (!/^\d+$/.test(env.ALIEXPRESS_APP_KEY)) return { status: 'invalid_app_key_format' };
  const categories = await aliRequest('aliexpress.affiliate.category.get', {}, env, fetcher);
  if (categories.failure) return categories.failure;
  const params = { keywords: 'badminton grip', page_size: '5', target_currency: 'USD', target_language: 'EN', ship_to_country: 'DK' };
  if (env.ALIEXPRESS_TRACKING_ID) params.tracking_id = env.ALIEXPRESS_TRACKING_ID;
  const search = await aliRequest('aliexpress.affiliate.product.query', params, env, fetcher);
  if (search.failure) return { authentication: 'ok', productSearch: search.failure };
  const products = search.result?.products?.product;
  if (!Array.isArray(products)) return { authentication: 'ok', productSearch: 'unexpected_response' };
  return {
    authentication: 'ok', productSearch: 'ok', productCount: products.length,
    affiliateLinks: env.ALIEXPRESS_TRACKING_ID ? products.filter(p => p.promotion_link).length : 'tracking_id_required',
    publication: 'not_enabled'
  };
}

export async function runChecks(env = process.env, fetcher = fetch) {
  const safe = async fn => {
    try { return await fn(); }
    catch (error) { return { status: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'connection_or_response_error' }; }
  };
  const [involveAsia, aliExpress] = await Promise.all([
    safe(() => checkInvolve(env, fetcher)), safe(() => checkAli(env, fetcher))
  ]);
  return { checkedAt: new Date().toISOString(), involveAsia, aliExpress };
}

export default async () => {
  console.log('AFFILIATE_CHECK ' + JSON.stringify(await runChecks()));
};
