/**
 * sanitize.ts
 * Strip PII patterns before sending any text to external AI APIs (Groq, etc.)
 *
 * What is stripped:
 *  - Israeli ID numbers (ת"ז)  — exactly 9 consecutive digits
 *  - Bank / credit-card account numbers — 10+ consecutive digits
 *  - Credit card numbers in 4-4-4-4 format
 *  - Israeli mobile phone numbers (05x, 07x)
 *
 * What is intentionally kept:
 *  - Amounts (e.g. 1,234.56)   — needed for categorization
 *  - Dates                     — needed for context
 *  - Merchant / company names  — needed for categorization
 *  - Stock symbols / amounts   — needed for portfolio parsing
 */

/** Replace a 9-digit Israeli ID or 10+ digit account number with a placeholder. */
export function sanitizeText(text: string): string {
  return text
    // Credit card numbers: groups of 4 digits separated by space or dash
    .replace(/\b\d{4}[\s\-]\d{4}[\s\-]\d{4}[\s\-]\d{4}\b/g, '[CARD]')
    // Account / IBAN numbers: 10 or more consecutive digits
    .replace(/\b\d{10,}\b/g, '[ACCOUNT]')
    // Israeli ID (ת"ז): exactly 9 digits not adjacent to other digits
    .replace(/(?<!\d)\d{9}(?!\d)/g, '[ID]')
    // Israeli mobile phones: 05x or 07x followed by 7 digits (with optional separator)
    .replace(/\b0[57]\d[\s\-]?\d{3}[\s\-]?\d{4}\b/g, '[PHONE]');
}

/**
 * Sanitize a list of transaction descriptions before sending to the LLM.
 * Returns a new array — does not mutate the originals.
 */
export function sanitizeDescriptions<T extends { description: string }>(items: T[]): T[] {
  return items.map(item => ({ ...item, description: sanitizeText(item.description) }));
}
