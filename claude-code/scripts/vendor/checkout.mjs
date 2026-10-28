// GENERATED COPY of connectors/shared/checkout.mjs. Do not edit here: edit shared/ and run `node scripts/sync-shared.mjs`.
// Checkout asks Aimiru (ADR-0065): deterministic matchers for the moments an agent commits money at
// a store, and the cart Aimiru shows the person. Pattern matching on the tool and the command only;
// never a model (spec D3).
//
//   UCP and Shopify:  a store's checkout tools (Universal Commerce Protocol, spec 2026-08-25):
//                     complete_checkout {meta, id, checkout: {payment}} places the order. Its
//                     arguments carry no cart, so the cart is read from the store's own answers to
//                     create_checkout, update_checkout and get_checkout (structuredContent: id,
//                     currency, line_items[{item: {title, price}, quantity}], totals[{type, amount}],
//                     continue_url, links; amounts in minor units) and remembered by checkout id.
//                     The order id comes back in complete_checkout's answer (order.id).
//   Stripe Link:      `link-cli spend-request create --amount <minor> --currency --merchant-name
//                     --merchant-url --line-item "name:..,unit_amount:..,quantity:.." --total
//                     "type:..,amount:.."`, and `spend-request update <lsrq_id> --amount`, which asks
//                     the person again. The request id (lsrq_...) comes back on stdout.
//   A store page:     a browser tool whose code runs the page's own checkout tool
//                     (document.modelContext.executeTool('complete_checkout'), Shopify's checkout in
//                     the browser). Aimiru sees it only when that browser tool passes through a
//                     connector; purchases an agent clicks through stay Advised.
//
// Everything read here is the agent's or the store's, so it is untrusted: card numbers and payment
// tokens are taken out of every text before it leaves this computer, and Aimiru reads the cart again.
// Vendored into each connector by scripts/sync-shared.mjs. Edit it only in connectors/shared/.

/** How the agent pays (the wire values of action.checkout.protocol). */
export const CHECKOUT_PROTOCOLS = Object.freeze(['ucp', 'shopify', 'link', 'browser', 'other']);

const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
const MAX_ITEMS = 100;
const MAX_NAME = 120;
const MAX_TEXT = 500_000;

/** A whole number of minor units in major units for the currency (13100 USD is 131, 500 JPY is 500). */
export function fromMinor(value, currency) {
  const n = typeof value === 'string' && /^\d{1,15}$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1e15) return null;
  const code = typeof currency === 'string' ? currency.trim().toUpperCase() : 'USD';
  const exp = ZERO_DECIMAL.has(code) ? 0 : THREE_DECIMAL.has(code) ? 3 : 2;
  return Math.round(n) / 10 ** exp;
}

function currencyOf(value) {
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim()) ? value.trim().toUpperCase() : null;
}

const DIGIT_RUN = /\d(?:[ -]?\d){12,18}/g;
const TOKEN_RE = /\b(?:tok|pm|spt|src|seti|card|btok|ctoken|lpt|pmc)_[A-Za-z0-9]{6,}|\b[A-Za-z]{2,6}_[A-Za-z0-9]+_secret_[A-Za-z0-9]+/g;

/** Half of a character (a surrogate without its other half), which no stored text can hold. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** A name as it may leave this computer: one line, no card number, no payment token, cut short. */
export function cleanName(value, max = MAX_NAME) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(LONE_SURROGATE, '\uFFFD').replace(/\s+/g, ' ').trim()
    .replace(DIGIT_RUN, '[number removed]').replace(TOKEN_RE, '[removed]');
  if (!text) return null;
  // Never cut a character in half: half of one is not text Aimiru can store.
  return text.length > max ? `${text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '').trimEnd()}…` : text;
}

/** A checkout id, order id or Link request id, only as a plain id. */
export function cleanId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  if (!text || text.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9_\-:./#]*$/.test(text)) return null;
  TOKEN_RE.lastIndex = 0;
  if (TOKEN_RE.test(text)) return null;
  for (const m of text.matchAll(DIGIT_RUN)) if (isLuhn(m[0].replace(/[ -]/g, ''))) return null;
  return text;
}

function isLuhn(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function hostOf(url) {
  if (typeof url !== 'string' || url.length > 2000) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return /^[a-z0-9.-]+\.[a-z0-9-]{2,}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

function words(name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** UCP's checkout operation a tool name is: create, get, update, complete, cancel; else null. */
export function ucpOperation(toolName) {
  const w = words(toolName);
  if (w.length < 2 || w[w.length - 1] !== 'checkout') return null;
  const op = w[w.length - 2];
  return ['create', 'get', 'update', 'complete', 'cancel'].includes(op) ? op : null;
}

/**
 * Which store a checkout tool belongs to: the tool server it came through and the tool's name
 * without its operation ("mcp__shop__get_checkout" and "mcp__shop__complete_checkout" are both
 * "mcp_shop"). A cart is remembered under it and recalled only for the same store, so another tool
 * server answering with the same checkout id (a lower total, other items) never sets this one's.
 */
export function ucpScope(toolName, server = '') {
  const w = words(toolName);
  return `${String(server ?? '')}\n${w.slice(0, Math.max(0, w.length - 2)).join('_')}`;
}

function isShopifyId(value) {
  return typeof value === 'string' && /^gid:\/\/shopify\//i.test(value);
}

/** shopify for Shopify's checkout (its ids, its hosts, a server named for it), else ucp. */
export function ucpProtocol({ server = '', serverUrl = null, checkoutId = null, host = null, orderId = null } = {}) {
  const hosts = [host, hostOf(serverUrl)].filter(Boolean);
  if (isShopifyId(checkoutId) || isShopifyId(orderId)) return 'shopify';
  if (hosts.some((h) => h === 'myshopify.com' || h.endsWith('.myshopify.com') || h === 'shopify.com' || h.endsWith('.shopify.com'))) return 'shopify';
  if (/shopify/i.test(String(server))) return 'shopify';
  return 'ucp';
}

function looksLikeCheckout(obj) {
  return (
    obj !== null &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    (typeof obj.id === 'string' || typeof obj.id === 'number') &&
    (Array.isArray(obj.line_items) || Array.isArray(obj.totals) || (obj.order && typeof obj.order === 'object'))
  );
}

/** The UCP checkout object inside a tool's answer (structuredContent, a text block of JSON, or the object). */
export function ucpCheckoutIn(response, depth = 0) {
  if (depth > 5 || response === null || response === undefined) return null;
  if (typeof response === 'string') {
    if (response.length > MAX_TEXT) return null;
    const t = response.trim();
    if (!t.startsWith('{') && !t.startsWith('[')) return null;
    try {
      return ucpCheckoutIn(JSON.parse(t), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(response)) {
    for (const part of response.slice(0, 20)) {
      const found = part && typeof part === 'object' && part.type === 'text' ? ucpCheckoutIn(part.text, depth + 1) : ucpCheckoutIn(part, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof response !== 'object') return null;
  if (looksLikeCheckout(response)) return response;
  for (const key of ['structuredContent', 'result', 'checkout', 'content', 'output']) {
    if (key in response) {
      const found = ucpCheckoutIn(response[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

const AMOUNT_TYPES = { subtotal: 'subtotal', items_base_amount: 'subtotal', fulfillment: 'shipping', shipping: 'shipping', tax: 'tax', discount: 'discount', items_discount: 'discount', fee: 'fee' };

function addAmount(list, type, amount) {
  if (amount === null) return;
  const found = list.find((a) => a.type === type);
  if (found) found.amount = Math.round((found.amount + amount) * 10_000) / 10_000;
  else list.push({ type, amount });
}

function mostCommonHost(links) {
  const counts = new Map();
  for (const l of Array.isArray(links) ? links.slice(0, 20) : []) {
    const h = hostOf(l?.url);
    if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  let best = null;
  for (const [h, n] of counts) if (!best || n > best[1]) best = [h, n];
  return best ? best[0] : null;
}

/**
 * The cart a UCP checkout object describes, in Aimiru's shape (action.checkout), or null.
 * @param {object} checkout  the checkout object (ucpCheckoutIn)
 * @param {{server?: string, serverUrl?: string|null}} [where]  the tool server it came from
 */
export function ucpCart(checkout, { server = '', serverUrl = null } = {}) {
  if (!looksLikeCheckout(checkout)) return null;
  const currency = currencyOf(checkout.currency);
  const items = [];
  for (const li of Array.isArray(checkout.line_items) ? checkout.line_items.slice(0, MAX_ITEMS) : []) {
    const item = li && typeof li.item === 'object' && li.item ? li.item : {};
    const name = cleanName(item.title ?? item.name ?? li?.title ?? li?.name);
    if (!name) continue;
    const q = li?.quantity;
    items.push({
      name,
      quantity: Number.isInteger(q) && q >= 1 && q <= 100_000 ? q : 1,
      unit_price: fromMinor(item.price ?? item.unit_price, currency),
    });
  }
  let total = null;
  const amounts = [];
  for (const t of Array.isArray(checkout.totals) ? checkout.totals.slice(0, 30) : []) {
    const type = typeof t?.type === 'string' ? t.type.toLowerCase() : '';
    const raw = typeof t?.amount === 'number' ? Math.abs(t.amount) : t?.amount;
    const value = fromMinor(raw, currency);
    if (type === 'total') total = value;
    else if (AMOUNT_TYPES[type]) addAmount(amounts, AMOUNT_TYPES[type], value);
  }
  const host = hostOf(checkout.continue_url) ?? mostCommonHost(checkout.links) ?? hostOf(serverUrl);
  const merchant = cleanName(checkout.merchant?.name ?? checkout.business?.name ?? checkout.seller?.name ?? null);
  const reference = cleanId(checkout.id);
  const cart = {
    protocol: ucpProtocol({ server, serverUrl, checkoutId: checkout.id, host, orderId: checkout.order?.id ?? null }),
    ...(merchant ? { merchant } : {}),
    ...(host ? { merchant_url: `https://${host}` } : {}),
    ...(total !== null ? { total } : {}),
    ...(currency ? { currency } : {}),
    items,
    amounts: amounts.slice(0, 5),
    ...(reference ? { reference } : {}),
  };
  return cart;
}

/** The order id in complete_checkout's answer (checkout.order.id), or null. */
export function ucpOrderId(response) {
  const checkout = ucpCheckoutIn(response);
  return checkout?.order ? cleanId(checkout.order.id) : null;
}

// ---------------------------------------------------------------------------
// Stripe Link: link-cli spend-request create | update

const LINK_PROGRAM = /^(?:.*\/)?link-cli$|^@stripe\/link-cli(?:@[\w.-]+)?$/;

function pairs(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  for (const part of text.split(/,(?=\s*[a-z_]+\s*:)/)) {
    const i = part.indexOf(':');
    if (i <= 0) continue;
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * A Link spend request in one command's words, as a cart: {op: 'create'|'update', cart}, or null.
 * @param {string[]} w  the words of one simple command (classify.mjs lexShell)
 * @param {boolean[]} [dynamic]  which words are built when the command runs (unknown values)
 */
export function linkSpendRequest(w, dynamic = []) {
  if (!Array.isArray(w)) return null;
  const at = w.findIndex((x, i) => !dynamic[i] && typeof x === 'string' && LINK_PROGRAM.test(x));
  if (at < 0 || w[at + 1] !== 'spend-request' || !['create', 'update'].includes(w[at + 2])) return null;
  const op = w[at + 2];
  const flags = {};
  const many = { 'line-item': [], total: [] };
  const positional = [];
  for (let i = at + 3; i < w.length; i += 1) {
    const word = String(w[i]);
    if (!word.startsWith('--')) {
      positional.push(dynamic[i] ? null : word);
      continue;
    }
    const eq = word.indexOf('=');
    const name = (eq > 0 ? word.slice(2, eq) : word.slice(2)).toLowerCase();
    let value = true;
    let valueDynamic = false;
    if (eq > 0) {
      value = word.slice(eq + 1);
      valueDynamic = Boolean(dynamic[i]);
    } else if (!['test', 'no-request-approval', 'request-approval', 'force'].includes(name) && i + 1 < w.length && !String(w[i + 1]).startsWith('--')) {
      value = String(w[i + 1]);
      valueDynamic = Boolean(dynamic[i + 1]);
      i += 1;
    }
    if (valueDynamic) value = null;
    if (name in many) many[name].push(value);
    else flags[name] = value;
  }
  const currency = currencyOf(typeof flags.currency === 'string' ? flags.currency : 'usd') ?? 'USD';
  const items = [];
  for (const raw of many['line-item'].slice(0, MAX_ITEMS)) {
    const p = pairs(raw);
    const name = cleanName(p.name);
    if (!name) continue;
    const q = /^\d{1,6}$/.test(p.quantity ?? '') ? Number(p.quantity) : 1;
    items.push({ name, quantity: q >= 1 ? q : 1, unit_price: fromMinor(p.unit_amount, currency) });
  }
  const amounts = [];
  let statedTotal = null;
  for (const raw of many.total.slice(0, 30)) {
    const p = pairs(raw);
    const type = (p.type ?? '').toLowerCase();
    const value = fromMinor(p.amount, currency);
    if (type === 'total') statedTotal = value;
    else if (AMOUNT_TYPES[type]) addAmount(amounts, AMOUNT_TYPES[type], value);
  }
  const amount = fromMinor(flags.amount, currency);
  const totals = [amount, statedTotal].filter((n) => typeof n === 'number');
  const merchant = cleanName(typeof flags['merchant-name'] === 'string' ? flags['merchant-name'] : null);
  const host = hostOf(typeof flags['merchant-url'] === 'string' ? flags['merchant-url'] : null);
  const reference = op === 'update' ? cleanId(positional.find((p) => typeof p === 'string' && /^lsrq_/.test(p)) ?? null) : null;
  return {
    op,
    cart: {
      protocol: 'link',
      ...(merchant ? { merchant } : {}),
      ...(host ? { merchant_url: `https://${host}` } : {}),
      // What Link authorises: the amount, or the larger total the approval screen shows.
      ...(totals.length ? { total: Math.max(...totals) } : {}),
      currency,
      items,
      amounts: amounts.slice(0, 5),
      ...(reference ? { reference } : {}),
      ...(flags.test === true ? { test: true } : {}),
    },
  };
}

/** The Link request id (lsrq_...) in a command's output, or null. */
export function linkRequestIdIn(output) {
  let text = output;
  if (output && typeof output === 'object') text = typeof output.stdout === 'string' ? output.stdout : JSON.stringify(output).slice(0, MAX_TEXT);
  if (typeof text !== 'string') return null;
  const m = /\blsrq_[A-Za-z0-9]{4,100}\b/.exec(text.slice(0, MAX_TEXT));
  return m ? cleanId(m[0]) : null;
}

// ---------------------------------------------------------------------------
// A store's checkout tool inside a web page (Shopify's checkout in the browser)

const PAGE_CHECKOUT = /modelContext\s*\.\s*executeTool\s*\(\s*(['"`])complete_checkout\1/;

/** True when a tool's arguments run a page's own complete_checkout tool. */
export function pageCheckoutIn(args) {
  const seen = [];
  const walk = (v, depth) => {
    if (depth > 5 || seen.length > 50) return;
    if (typeof v === 'string') seen.push(v.length > MAX_TEXT ? v.slice(0, MAX_TEXT) : v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(args, 0);
  return seen.some((s) => PAGE_CHECKOUT.test(s));
}

// ---------------------------------------------------------------------------
// The action a cart makes, and carts remembered between calls

/** A remembered cart where the check only knows the checkout id; the call's own facts win. */
export function withRememberedCart(cart, remembered) {
  if (!cart || !remembered || !cart.reference || remembered.reference !== cart.reference) return cart;
  return { ...remembered, protocol: cart.protocol === 'ucp' ? remembered.protocol : cart.protocol };
}

/**
 * The fields an action takes from its cart: a payment with the person's card, to the store's host,
 * for the cart's total. An Aimiru that does not read carts yet still decides the right amount.
 */
export function cartFacts(cart) {
  if (!cart) return {};
  const host = hostOf(cart.merchant_url);
  return {
    class: 'spend',
    resource: 'money.card',
    ...(host || cart.merchant ? { counterparty: host ?? cart.merchant } : {}),
    ...(typeof cart.total === 'number' ? { amount: cart.total } : {}),
    ...(cart.currency ? { currency: cart.currency } : {}),
    checkout: cart,
  };
}

/**
 * Carts by store and checkout id, for a connector that stays running (the tool server proxy,
 * OpenClaw). `scope` is ucpScope of the tool that answered: a cart is recalled only for its store.
 */
export function cartMemory({ max = 200, ttlMs = 60 * 60_000, now = () => Date.now() } = {}) {
  const carts = new Map();
  const keyOf = (scope, reference) => `${String(scope ?? '')}\u0000${reference}`;
  return {
    remember(cart, scope = '') {
      if (!cart?.reference) return;
      const key = keyOf(scope, cart.reference);
      carts.delete(key);
      carts.set(key, { cart, at: now() });
      while (carts.size > max) carts.delete(carts.keys().next().value);
    },
    recall(reference, scope = '') {
      const key = keyOf(scope, reference);
      const e = reference ? carts.get(key) : null;
      if (!e) return null;
      if (now() - e.at > ttlMs) {
        carts.delete(key);
        return null;
      }
      return e.cart;
    },
    size: () => carts.size,
  };
}
