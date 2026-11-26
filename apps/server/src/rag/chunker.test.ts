import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TIERS } from '@acme/contracts';
import { describe, expect, it } from 'vitest';
import {
  buildSectionTree,
  chunkDocument,
  CHUNK_MAX_TOKENS,
  CHUNK_MIN_TOKENS,
  parseDocument,
  slugify,
  tokens,
  type Chunk,
} from './chunker';

const KB_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../knowledge-base');

/** A sentence of `n` distinct-ish words — used to build sections of a controlled token size. */
const sentence = (word: string, n: number) => {
  const words = Array.from({ length: n }, (_, i) => `${word}${i % 9}`);
  // Capitalised start: the sentence splitter only breaks before an uppercase letter / digit.
  return `${words.join(' ').replace(/^./, (c) => c.toUpperCase())}.`;
};

/** Grow a paragraph until it has at least `min` tokens. */
function paragraphOf(word: string, min: number): string {
  let p = sentence(word, 12);
  while (tokens(p) < min) p += ` ${sentence(word, 12)}`;
  return p;
}

const doc = (body: string, front = 'id: test-doc\ntitle: Test Doc\ncategory: billing\ntiers: all') =>
  parseDocument(`---\n${front}\n---\n${body}`, 'fallback-id');

const filler = 'This paragraph exists to give the section enough substance that it is kept as a chunk on its own.';

describe('parseDocument', () => {
  it('parses YAML frontmatter and strips it from the body', () => {
    const d = parseDocument(
      '---\nid: refund-policy\ntitle: Refund Policy\ncategory: billing\ntiers: all\nupdated: 2026-10-01\n---\n\n# Refund Policy\n\nBody.',
      'ignored',
    );
    expect(d).toMatchObject({ id: 'refund-policy', title: 'Refund Policy', category: 'billing', tiers: [], updated: '2026-10-01' });
    expect(d.body.startsWith('---')).toBe(false);
    expect(d.body).toContain('# Refund Policy');
    expect(d.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('falls back to the file id / defaults when there is no frontmatter', () => {
    const d = parseDocument('# Untitled\n\nJust a body.', 'my-file');
    expect(d).toMatchObject({ id: 'my-file', title: 'my-file', category: 'general', tiers: [], updated: null });
    expect(d.body).toBe('# Untitled\n\nJust a body.');
  });

  it('parses tier lists, and treats "every tier" as "no restriction"', () => {
    expect(doc('x', 'id: a\ntiers: [pro, enterprise]').tiers).toEqual(['pro', 'enterprise']);
    expect(doc('x', 'id: a\ntiers: "Pro"').tiers).toEqual(['pro']);
    expect(doc('x', 'id: a\ntiers: [free, pro, enterprise]').tiers).toEqual([]);
    expect(doc('x', 'id: a\ntiers: all').tiers).toEqual([]);
  });

  it('rejects unknown tiers instead of silently mis-scoping content', () => {
    expect(() => doc('x', 'id: a\ntiers: [pro, platinum]')).toThrow(/Unknown tier "platinum"/);
  });

  it('content hash changes with the raw file', () => {
    expect(doc('A body.').contentHash).not.toBe(doc('A different body.').contentHash);
    expect(doc('A body.').contentHash).toBe(doc('A body.').contentHash);
  });
});

describe('buildSectionTree — tier tags', () => {
  const body = [
    '# Test Doc',
    '',
    'Intro paragraph.',
    '',
    '## General',
    '',
    'Applies to everyone.',
    '',
    '## Pro Things',
    '<!-- tiers: pro -->',
    '',
    'Pro only.',
    '',
    '### Pro Limits',
    '',
    'Inherited from the parent section.',
    '',
    '### Enterprise Override',
    '<!-- tiers: enterprise -->',
    '',
    'Explicit tag wins over inheritance.',
    '',
    '## Paid Plans',
    '<!-- tiers: Pro, Enterprise -->',
    '',
    'Both paid tiers.',
  ].join('\n');

  const tree = buildSectionTree(doc(body));

  it('treats the H1 as the document root and keeps intro text on it', () => {
    expect(tree.level).toBe(0);
    expect(tree.title).toBe('Test Doc');
    expect(tree.blocks).toEqual(['Intro paragraph.']);
    expect(tree.children.map((c) => c.title)).toEqual(['General', 'Pro Things', 'Paid Plans']);
  });

  it('applies <!-- tiers: … --> tags and consumes the tag line', () => {
    const [general, pro, paid] = tree.children;
    expect(general!.tiers).toEqual([]);
    expect(pro!.tiers).toEqual(['pro']);
    expect(paid!.tiers).toEqual(['pro', 'enterprise']);
    expect(pro!.blocks).toEqual(['Pro only.']);
    expect(JSON.stringify(tree)).not.toContain('<!--');
  });

  it('children inherit the parent tiers unless they carry their own tag', () => {
    const pro = tree.children[1]!;
    expect(pro.children.map((c) => [c.title, c.tiers])).toEqual([
      ['Pro Limits', ['pro']],
      ['Enterprise Override', ['enterprise']],
    ]);
  });
});

describe('chunkDocument', () => {
  it('keeps a heading-bounded section (including its sub-sections) whole when it fits', () => {
    const body = [
      '# Test Doc',
      '',
      '## Refund Window',
      '',
      `Refunds are available within 14 days of the charge date. ${filler}`,
      '',
      '### Exceptions',
      '',
      `Duplicate charges are refundable for 90 days. ${filler}`,
    ].join('\n');
    const chunks = chunkDocument(doc(body), 'model-a');
    expect(chunks).toHaveLength(1);
    const [c] = chunks as [Chunk];
    // The rule and its exception stay together — the whole point of structure-aware chunking.
    expect(c.content).toContain('within 14 days');
    expect(c.content).toContain('### Exceptions');
    expect(c.content).toContain('refundable for 90 days');
    expect(c.headingPath).toEqual(['Refund Window']);
    expect(c.anchor).toBe('refund-window');
    expect(c.id).toBe('test-doc::0');
    expect(c.embeddingInput.startsWith('Test Doc > Refund Window\n\n')).toBe(true);
    expect(c.tokenCount).toBe(tokens(c.embeddingInput));
  });

  it('splits a tier-mixed section so each chunk carries exactly one tier scope', () => {
    const body = [
      '# Test Doc',
      '',
      '## Seats',
      '',
      `Seats can be added at any time from the billing page. ${filler}`,
      '',
      '### Enterprise Seats',
      '<!-- tiers: enterprise -->',
      '',
      `Enterprise seats are true-ups billed quarterly by the account manager. ${filler}`,
    ].join('\n');
    const chunks = chunkDocument(doc(body), 'model-a');
    expect(chunks.map((c) => [c.headingPath, c.tiers])).toEqual([
      [['Seats'], []],
      [['Seats', 'Enterprise Seats'], ['enterprise']],
    ]);
    // The enterprise-only text must never leak into the all-tier chunk.
    expect(chunks[0]!.content).not.toContain('true-ups');
    expect(chunks[1]!.anchor).toBe('enterprise-seats');
    expect(chunks[1]!.embeddingInput.startsWith('Test Doc > Seats > Enterprise Seats\n\n')).toBe(true);
  });

  it('splits an oversized section at block boundaries, never cutting a paragraph', () => {
    const paragraphs = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map((w) => paragraphOf(w, 150));
    const body = `# Test Doc\n\n## Big Section\n\n${paragraphs.join('\n\n')}`;
    expect(tokens(paragraphs.join('\n\n'))).toBeGreaterThan(CHUNK_MAX_TOKENS);

    const chunks = chunkDocument(doc(body), 'model-a');
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(tokens(c.content)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
      expect(c.headingPath).toEqual(['Big Section']);
      // Every chunk is made of whole paragraphs.
      for (const piece of c.content.split('\n\n')) expect(paragraphs).toContain(piece);
    }
    // Nothing is lost.
    const covered = new Set(chunks.flatMap((c) => c.content.split('\n\n')));
    expect([...covered].sort()).toEqual([...paragraphs].sort());
  });

  it('falls back to sentence splitting for a single block larger than the budget', () => {
    const huge = paragraphOf('omega', CHUNK_MAX_TOKENS + 200);
    const chunks = chunkDocument(doc(`# Test Doc\n\n## Wall Of Text\n\n${huge}`), 'model-a');
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(tokens(c.content)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
      expect(c.content.trim().endsWith('.')).toBe(true); // cut at sentence ends
    }
  });

  it('never exceeds the budget when carrying a short overlap block into the next chunk', () => {
    // A short block (overlap-eligible) followed by a block just under the max: carrying the short
    // block forward as overlap would produce a chunk above CHUNK_MAX_TOKENS.
    const short = sentence('alpha', 30);
    const large = paragraphOf('beta', CHUNK_MAX_TOKENS - 20);
    const tail = paragraphOf('gamma', 200);
    expect(tokens(short)).toBeLessThanOrEqual(80);
    expect(tokens(large)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
    const chunks = chunkDocument(doc(`# Test Doc\n\n## Mixed\n\n${short}\n\n${large}\n\n${tail}`), 'model-a');
    for (const c of chunks) expect(tokens(c.content)).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
    // Every block is still covered.
    const all = chunks.map((c) => c.content).join('\n\n');
    for (const block of [short, large, tail]) expect(all).toContain(block);
  });

  it('carries a short trailing block into the next chunk as overlap', () => {
    const big = ['alpha', 'beta', 'gamma'].map((w) => paragraphOf(w, 200));
    const bridge = sentence('bridge', 20); // short → overlap-eligible
    const body = `# Test Doc\n\n## Overlap\n\n${big[0]}\n\n${bridge}\n\n${big[1]}\n\n${big[2]}`;
    const chunks = chunkDocument(doc(body), 'model-a');
    const withBridge = chunks.filter((c) => c.content.includes(bridge));
    expect(withBridge.length).toBe(2);
  });

  it('drops chunks below the minimum token count', () => {
    const body = [
      '# Test Doc',
      '',
      '## Tiny',
      '',
      'Too short.',
      '',
      '## Substantial',
      '',
      `${filler} ${filler}`,
    ].join('\n');
    const chunks = chunkDocument(doc(body), 'model-a');
    expect(chunks.map((c) => c.headingPath)).toEqual([['Substantial']]);
    // Ordinals / ids are assigned after filtering, so they stay contiguous.
    expect(chunks[0]!.ordinal).toBe(0);
    expect(chunks[0]!.id).toBe('test-doc::0');
    expect(tokens(chunks[0]!.content)).toBeGreaterThanOrEqual(CHUNK_MIN_TOKENS);
  });

  it('keeps fenced code blocks intact as one block', () => {
    const code = ['```bash', 'curl -X POST https://api.example/v1/keys', '', 'echo done', '```'].join('\n');
    const chunks = chunkDocument(doc(`# Test Doc\n\n## Rotate Keys\n\n${filler}\n\n${code}`), 'model-a');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain(code);
  });

  it('does not treat "#" lines inside fenced code as headings', () => {
    const code = ['```bash', '# rotate the key, then restart', 'acme keys rotate --project web', '```'].join('\n');
    const body = `# Test Doc\n\n## Rotating API Keys\n\n${filler}\n\n${code}\n\nAfter rotating, update every client that used the old key.`;
    const tree = buildSectionTree(doc(body));
    expect(tree.children.map((c) => c.title)).toEqual(['Rotating API Keys']);
    const chunks = chunkDocument(doc(body), 'model-a');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain(code);
  });

  it('content hashes depend on the embedding model and tiers (forces re-embed on model change)', () => {
    const body = `# Test Doc\n\n## Section\n\n${filler} ${filler}`;
    const a = chunkDocument(doc(body), 'model-a')[0]!;
    const b = chunkDocument(doc(body), 'model-b')[0]!;
    const proOnly = chunkDocument(doc(body, 'id: test-doc\ntitle: Test Doc\ntiers: [pro]'), 'model-a')[0]!;
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(a.contentHash).not.toBe(proOnly.contentHash);
    expect(proOnly.tiers).toEqual(['pro']);
    expect(chunkDocument(doc(body), 'model-a')[0]!.contentHash).toBe(a.contentHash);
  });

  it('slugify produces URL-safe anchors', () => {
    expect(slugify('First-Response Targets (SLA)')).toBe('first-response-targets-sla');
    expect(slugify('Two-Factor Authentication (2FA) Problems')).toBe('two-factor-authentication-2fa-problems');
  });
});

describe('chunking the real knowledge base', () => {
  const files = readdirSync(KB_DIR).filter((f) => f.endsWith('.md')).sort();
  const docs = files.map((f) => parseDocument(readFileSync(path.join(KB_DIR, f), 'utf8'), f.replace(/\.md$/, '')));
  const chunks = docs.flatMap((d) => chunkDocument(d, 'text-embedding-3-small'));

  it('finds the knowledge base', () => {
    expect(files.length).toBeGreaterThanOrEqual(10);
    expect(chunks.length).toBeGreaterThan(files.length);
  });

  it('every chunk is within the token budget and above the minimum', () => {
    for (const c of chunks) {
      expect(tokens(c.content), c.id).toBeLessThanOrEqual(CHUNK_MAX_TOKENS);
      expect(tokens(c.content), c.id).toBeGreaterThanOrEqual(CHUNK_MIN_TOKENS);
    }
  });

  it('chunk ids are unique and every document produced chunks', () => {
    const ids = chunks.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(chunks.map((c) => c.docId))).toEqual(new Set(docs.map((d) => d.id)));
  });

  it('tiers are valid, normalised, and tier tags never leak into content', () => {
    for (const c of chunks) {
      for (const t of c.tiers) expect(TIERS).toContain(t);
      expect(c.tiers.length).toBeLessThan(TIERS.length); // "all tiers" is normalised to []
      expect(c.content).not.toMatch(/<!--\s*tiers:/);
      expect(c.content).not.toMatch(/^---$/m); // frontmatter never leaks either
    }
  });

  it('tier-tagged policy sections are scoped (e.g. Pro refund limits are Pro-only)', () => {
    const find = (docId: string, heading: string) => chunks.find((c) => c.docId === docId && c.headingPath.at(-1) === heading);
    expect(find('refund-policy', 'Pro Plan Refunds')?.tiers).toEqual(['pro']);
    expect(find('refund-policy', 'Pro Plan Refunds')?.content).toContain('Pro Approval Limits');
    expect(find('refund-policy', 'Enterprise Plan Refunds')?.tiers).toEqual(['enterprise']);
    expect(find('refund-policy', 'Free Plan Refunds')?.tiers).toEqual(['free']);
    expect(find('refund-policy', 'Duplicate Charges')?.tiers).toEqual([]);
    expect(find('data-privacy-and-security', 'Custom DPA Negotiation')?.tiers).toEqual(['enterprise']);
  });
});
