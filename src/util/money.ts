/** Money is always integer minor units plus an explicit asset code. */

const EXPONENTS: Record<string, number> = {
  INR: 2, USD: 2, EUR: 2, GBP: 2, JPY: 0, KRW: 0,
};

/** Decimal exponent for an asset. Unknown fiat codes default to 2; tokens must register explicitly. */
export function assetExponent(asset: string): number {
  return EXPONENTS[asset] ?? 2;
}

export class MoneyError extends Error {}

/** Parse a decimal string (or integer) into minor units, rejecting excess precision. */
export function parseToMinor(value: unknown, asset: string): number {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value.trim())) {
    throw new MoneyError(`amount must be an integer minor value or decimal string: ${JSON.stringify(value)}`);
  }
  const [whole, frac = ''] = value.trim().replace('-', '').split('.');
  const exp = assetExponent(asset);
  if (frac.length > exp) {
    throw new MoneyError(`amount has more than ${exp} decimal places for ${asset}: ${value}`);
  }
  const sign = value.trim().startsWith('-') ? -1 : 1;
  const minor = sign * (Number(whole) * 10 ** exp + Number(frac.padEnd(exp, '0') || '0'));
  if (!Number.isSafeInteger(minor)) throw new MoneyError(`amount out of range: ${value}`);
  return minor;
}

/** Convert a minor-unit amount across assets via a pinned rational conversion (rate_num/rate_den). */
export function convertMinor(amountMinor: number, rateNum: number, rateDen: number): number {
  if (!Number.isInteger(rateNum) || !Number.isInteger(rateDen) || rateDen <= 0 || rateNum < 0) {
    throw new MoneyError('conversion rate must be a non-negative rational');
  }
  const out = (amountMinor * rateNum) / rateDen;
  if (!Number.isSafeInteger(out)) throw new MoneyError('conversion result out of range');
  // Bill comparisons round down: the quote must not exceed the cap.
  return Math.floor(out);
}
