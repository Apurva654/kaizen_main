import { LongTermMemoryRecord, LongTermCategory, sanitizeSecretInfo } from './memoryTypes';
import { persistenceEngine } from '../../tools/persistenceEngine';

/**
 * Normalizes text by removing prompt filler prefixes, punctuation, extra whitespace, and lowercasing.
 */
export function normalizeMemoryText(text: string): string {
  if (!text) return '';
  let norm = sanitizeSecretInfo(text).toLowerCase().trim();

  // Strip common prompt filler prefixes only (do not strip valid key names)
  norm = norm.replace(/^(?:remember\s+(?:that|this|for\s+our\s+current\s+project:?)?|save\s+(?:this\s+)?preference:?|keep\s+in\s+mind\s+(?:that)?|our\s+convention\s+is:?|don't\s+forget\s+that|store\s+this:?)\s*/gi, '');

  // Normalize punctuation and whitespace
  norm = norm.replace(/[^a-z0-9_\-\.\[\]]/gi, ' ').replace(/\s+/g, ' ').trim();
  return norm;
}


/**
 * Determines whether two long-term memory records (or candidate & existing record) represent the same logical fact.
 */
export function isEquivalentLongTermFact(
  cat1: string, key1: string, val1: string,
  cat2: string, key2: string, val2: string
): boolean {
  // Category MUST match (do not collapse different categories!)
  if (cat1 !== cat2) return false;

  const normKey1 = normalizeMemoryText(key1);
  const normKey2 = normalizeMemoryText(key2);

  const normVal1 = normalizeMemoryText(val1);
  const normVal2 = normalizeMemoryText(val2);

  // 1. Exact key match
  if (normKey1 && normKey2 && normKey1 === normKey2) return true;

  // 2. Exact value match (after secret scrubbing & normalization)
  if (normVal1 && normVal2 && normVal1 === normVal2) return true;

  // 3. Combined key+value match
  const combined1 = `${normKey1} ${normVal1}`.trim();
  const combined2 = `${normKey2} ${normVal2}`.trim();
  if (combined1 === combined2) return true;

  // 4. Semantic check ONLY if one of the keys is generic/unspecified
  const isGenericKey1 = !normKey1 || normKey1 === 'project preference' || normKey1 === 'coding convention';
  const isGenericKey2 = !normKey2 || normKey2 === 'project preference' || normKey2 === 'coding convention';

  if ((isGenericKey1 || isGenericKey2) && normVal1 && normVal2) {
    const isTS1 = normVal1.includes('typescript') && normVal1.includes('strict');
    const isTS2 = normVal2.includes('typescript') && normVal2.includes('strict');
    if (isTS1 && isTS2) return true;

    const isTailwind1 = normVal1.includes('tailwind');
    const isTailwind2 = normVal2.includes('tailwind');
    if (isTailwind1 && isTailwind2) return true;
  }

  return false;
}


export class LongTermMemoryManager {
  private records: Map<string, LongTermMemoryRecord> = new Map();

  constructor() {
    this.loadFromPersistence();
  }

  private buildRecordKey(key: string, workspaceId: string): string {
    return `${workspaceId}::${key.toLowerCase().trim()}`;
  }

  /**
   * Search existing records in memory for an equivalent logical fact.
   */
  public findEquivalentFact(category: string, key: string, value: string, workspaceId: string = 'default'): LongTermMemoryRecord | null {
    for (const record of this.records.values()) {
      const matchWorkspace = record.workspaceId === workspaceId || record.workspaceId === 'default' || workspaceId === 'default' || record.workspaceId === 'global';
      if (matchWorkspace && isEquivalentLongTermFact(record.category, record.key, record.value, category, key, value)) {
        return record;
      }
    }
    return null;
  }

  public addFact(
    category: LongTermCategory,
    key: string,
    value: string,
    source: string = 'user',
    confidence: number = 0.9,
    workspaceId: string = 'default',
    tags: string[] = []
  ): LongTermMemoryRecord {
    const sanitizedVal = sanitizeSecretInfo(value);
    const sanitizedKey = sanitizeSecretInfo(key);

    // Check if an equivalent logical fact already exists
    const existing = this.findEquivalentFact(category, sanitizedKey, sanitizedVal, workspaceId);
    if (existing) {
      existing.timestamp = new Date().toISOString();
      if (sanitizedVal && sanitizedVal.length > existing.value.length) {
        existing.value = sanitizedVal;
      }
      existing.confidence = Math.max(existing.confidence, confidence);
      this.saveToPersistence();
      return existing;
    }

    const recordKey = this.buildRecordKey(sanitizedKey, workspaceId);
    const record: LongTermMemoryRecord = {
      id: `lt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      type: 'long_term',
      workspaceId,
      category,
      key: sanitizedKey,
      value: sanitizedVal,
      source,
      confidence: Math.min(1.0, Math.max(0.1, confidence)),
      timestamp: new Date().toISOString(),
      importance: 0.9,
      tags: tags.length > 0 ? tags : [category]
    };

    this.records.set(recordKey, record);
    this.saveToPersistence();
    return record;
  }

  public getFact(key: string, workspaceId: string = 'default'): LongTermMemoryRecord | null {
    const recordKey = this.buildRecordKey(key, workspaceId);
    if (this.records.has(recordKey)) return this.records.get(recordKey)!;
    return this.findEquivalentFact('coding_convention', key, '', workspaceId) || 
           this.findEquivalentFact('project_fact', key, '', workspaceId) || null;
  }

  public getAllFacts(workspaceId?: string): LongTermMemoryRecord[] {
    const all = Array.from(this.records.values());
    const filtered = (!workspaceId || workspaceId === 'default' || workspaceId === 'global')
      ? all
      : all.filter(r => r.workspaceId === workspaceId || r.workspaceId === 'global' || r.workspaceId === 'default');

    // Deduplicate on retrieval to guarantee canonical records
    const deduplicated: LongTermMemoryRecord[] = [];
    for (const record of filtered) {
      const exists = deduplicated.some(d =>
        isEquivalentLongTermFact(d.category, d.key, d.value, record.category, record.key, record.value)
      );
      if (!exists) {
        deduplicated.push(record);
      }
    }
    return deduplicated;
  }

  public searchFacts(query: string, category?: LongTermCategory, workspaceId: string = 'default'): LongTermMemoryRecord[] {
    const q = query.toLowerCase();
    const facts = this.getAllFacts(workspaceId);

    return facts.filter(f => {
      if (category && f.category !== category) return false;
      return f.key.toLowerCase().includes(q) || f.value.toLowerCase().includes(q) || f.tags?.some(t => t.toLowerCase().includes(q));
    });
  }

  public loadFromPersistence(): void {
    const data = persistenceEngine.readMemoryJson<LongTermMemoryRecord[]>('long-term.json');
    if (data && Array.isArray(data)) {
      this.records.clear();
      for (const rec of data) {
        rec.key = sanitizeSecretInfo(rec.key);
        rec.value = sanitizeSecretInfo(rec.value);
        const ws = rec.workspaceId || 'default';

        const existing = this.findEquivalentFact(rec.category, rec.key, rec.value, ws);
        if (existing) {
          if (rec.confidence > existing.confidence) {
            existing.confidence = rec.confidence;
            existing.value = rec.value;
          }
        } else {
          const k = this.buildRecordKey(rec.key, ws);
          this.records.set(k, rec);
        }
      }
      this.saveToPersistence();
    }
  }

  public saveToPersistence(): void {
    const list = Array.from(this.records.values());
    persistenceEngine.writeMemoryJson('long-term.json', list);
  }

  public formatForPrompt(workspaceId: string = 'default'): string {
    const facts = this.getAllFacts(workspaceId);
    if (facts.length === 0) {
      return 'LONG-TERM MEMORY: (No persistent project facts or conventions recorded)';
    }

    const categories: Record<string, string[]> = {};
    for (const f of facts) {
      const catLabel = f.category.toUpperCase().replace('_', ' ');
      if (!categories[catLabel]) categories[catLabel] = [];
      categories[catLabel].push(`  - ${f.key}: ${f.value} (Confidence: ${f.confidence.toFixed(2)})`);
    }

    let output = 'LONG-TERM / PERSISTENT KNOWLEDGE:\n=================================\n';
    for (const [cat, items] of Object.entries(categories)) {
      output += `[${cat}]\n${items.join('\n')}\n`;
    }

    return output;
  }
}

