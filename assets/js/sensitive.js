/**
 * Likely-sensitive content in free text. The rule comes from the website's own
 * compliance lines (texc/content/services.ts): never publish magazine
 * locations, stock levels, access procedures, transport routes, schedules,
 * quantities or vehicle details. The editor WARNS on these — it never blocks,
 * because a phrase like "40 kg" can be harmless — and publishing waits until
 * each warning is acknowledged.
 *
 * Shared by the editor and (Phase 3) the server's publish check.
 */

const EXPLOSIVE = '(?:explosive|explosives|anfo|emulsion|detonator|detonators|booster|boosters|primer|primers|product|charge|cartridge|cartridges|powder)';

export const RULES = Object.freeze([
  {
    id: 'coordinates',
    label: 'GPS coordinates',
    re: /-?\b\d{1,3}\.\d{4,}\s*[,;/]\s*-?\d{1,3}\.\d{4,}\b/g,
  },
  {
    id: 'dms',
    label: 'Coordinates in degrees and minutes',
    re: /\b\d{1,3}\s*°\s*\d{1,2}\s*['′]\s*(?:\d{1,2}(?:\.\d+)?\s*["″])?\s*[NSEW]\b/g,
  },
  {
    id: 'magazine-location',
    label: 'Where a magazine is',
    re: /\bmagazines?\s+(?:is\s+|are\s+)?(?:at|located|situated|address|on|behind|next to)\b/gi,
  },
  {
    id: 'explosive-quantity',
    label: 'A quantity of explosives',
    re: new RegExp(`\\b\\d+(?:[.,]\\d+)?\\s?(?:kg|kgs|kilograms?|t|tonnes?|tons?)\\b[^.]{0,40}\\b${EXPLOSIVE}\\b|\\b${EXPLOSIVE}\\b[^.]{0,40}\\b\\d+(?:[.,]\\d+)?\\s?(?:kg|kgs|kilograms?|t|tonnes?|tons?)\\b`, 'gi'),
  },
  {
    id: 'vehicle',
    label: 'Vehicle details',
    re: /\b(?:rego|registration|number\s?plate|licence\s?plate)\b/gi,
  },
  {
    id: 'route-time',
    label: 'A transport route or schedule',
    re: /\b(?:route|via|depart(?:s|ing|ure)?|convoy|deliver(?:y|ies)?\s+(?:at|on))\b[^.]{0,50}\b\d{1,2}[:.]\d{2}\s?(?:am|pm)?\b/gi,
  },
  {
    id: 'stock-level',
    label: 'Stock levels',
    re: /\b(?:stock|inventory)\s+(?:level|levels|on hand|holding)\b/gi,
  },
]);

/** Matches in one string. */
export function scanText(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) out.push({ rule: rule.id, label: rule.label, match: m[0].trim(), index: m.index });
  }
  return out;
}

/** A street number in the locality — the cover shows suburb and region only. */
export function localityWarning(locality) {
  if (typeof locality !== 'string') return null;
  if (/^\s*(?:lot\s+)?\d+[a-z]?\s+\S/i.test(locality) || /\b\d+\s+\w+\s+(?:road|rd|street|st|lane|ln|drive|dr|avenue|ave|court|ct|place|pl|highway|hwy)\b/i.test(locality)) {
    return { rule: 'street-address', label: 'A street address on the cover', match: locality.trim() };
  }
  return null;
}
