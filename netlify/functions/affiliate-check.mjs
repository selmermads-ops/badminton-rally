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
  const report = await readJSON('https://api.involve.asia/api/conversions/all', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ page: '1', limit: '100' }).toString()
  }, fetcher);
  let conversions;
  if (report.failure) conversions = report.failure;
  else {
    const data = report.data?.data;
    const records = Array.isArray(data) ? data : data?.data ?? data?.conversions;
    conversions = report.data?.status === 'success' && Array.isArray(records) ? {
      status: 'ok', returnedCount: records.length, scope: 'account_first_page',
      totalCount: Number.isFinite(Number(data?.count)) && data?.count != null ? Number(data.count) : null,
      hasMore: Boolean(data?.nextPage),
      fieldNames: Object.keys(records[0] || {}).filter(k => /^[a-z_]{1,40}$/i.test(k)),
      commissionValues: records.length ? 'schema_review_required' : 'no_records_to_verify',
      siteAttribution: 'not_verified'
    } : { status: 'unexpected_response', fieldNames: Object.keys(data || {}).filter(k => /^[a-z_]{1,40}$/i.test(k)) };
  }
  const selected = rows.find(r => /banggood/i.test(r.offer_name || ''));
  if (!selected) return { authentication: 'ok', offers: 'ok', offerCount: rows.length, linkGeneration: 'no_test_offer' };
  let destination;
  try { destination = new URL(selected.preview_url); } catch { return { authentication: 'ok', offers: 'ok', offerCount: rows.length, linkGeneration: 'invalid_preview_url' }; }
  if (destination.protocol !== 'https:' || !(destination.hostname === 'banggood.com' || destination.hostname.endsWith('.banggood.com'))) return { authentication: 'ok', offers: 'ok', offerCount: rows.length, linkGeneration: 'unexpected_destination' };
  const link = await readJSON('https://api.involve.asia/api/deeplink/generate', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ offer_id: String(selected.offer_id), url: destination.href, aff_sub: 'badmintonrally-api-test' }).toString()
  }, fetcher);
  const summary = { authentication: 'ok', offers: 'ok', offerCount: rows.length, testAdvertiser: 'Banggood', destinationHost: destination.hostname, conversions };
  if (link.failure) return { ...summary, linkGeneration: link.failure };
  const generated = link.data?.data;
  const candidate = typeof generated === 'string' ? generated : generated?.deeplink ?? generated?.link ?? generated?.url ?? generated?.tracking_link;
  let valid = false;
  try { valid = new URL(candidate).protocol === 'https:'; } catch {}
  let redirectStatus = 'not_verified';
  if (valid && link.data?.status === 'success') {
    let next = new URL(candidate);
    for (let hop = 0; hop < 5; hop++) {
      const host = next.hostname;
      const allowed = ['invl.me', 'involve.asia', 'banggood.com'].some(d => host === d || host.endsWith('.' + d));
      if (next.protocol !== 'https:' || !allowed || next.username || next.password) { redirectStatus = 'unexpected_redirect'; break; }
      if (host === 'banggood.com' || host.endsWith('.banggood.com')) { redirectStatus = 'destination_verified'; break; }
      const response = await fetcher(next.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(5000) });
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (![301,302,303,307,308].includes(response.status) || !location) { redirectStatus = 'not_verified'; break; }
      next = new URL(location, next);
    }
  }
  return { ...summary, redirectStatus, linkGeneration: link.data?.status === 'success' && valid ? 'ok' : 'unexpected_response', linkResponseFields: generated && typeof generated === 'object' ? Object.keys(generated).filter(k => /^[a-z_]{1,40}$/i.test(k)) : [], linkHost: valid ? new URL(candidate).hostname : null };
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
  const now = Date.now();
  const topDate = ms => new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
  const orderParams = { start_time: topDate(now - 24 * 3600000), end_time: topDate(now), page_no: '1', page_size: '50' };
  const orderResults = await Promise.all(['Payment Completed', 'Buyer Confirmed Receipt'].map(async status => {
    const reply = await aliRequest('aliexpress.affiliate.order.list', { ...orderParams, status }, env, fetcher);
    if (reply.failure) return { orderStatus: status, ...reply.failure };
    const data = reply.result;
    const records = data?.orders?.order ?? data?.orders;
    return { orderStatus: status, status: Array.isArray(records) ? 'ok' : 'unexpected_response',
      returnedCount: Array.isArray(records) ? records.length : null,
      totalCount: data?.total_record_count ?? null,
      responseFields: Object.keys(data || {}).filter(k => /^[a-z_]{1,40}$/i.test(k)),
      fieldNames: Array.isArray(records) ? Object.keys(records[0] || {}).filter(k => /^[a-z_]{1,40}$/i.test(k)) : [],
      siteAttribution: 'not_verified', commissionValues: Array.isArray(records) && records.length ? 'schema_review_required' : 'no_records_to_verify' };
  }));
  return {
    salesReports: { window: 'last_24_hours', scope: 'account_first_page_per_status', results: orderResults },
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
