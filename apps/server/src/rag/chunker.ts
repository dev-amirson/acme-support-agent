import { createHash } from 'node:crypto';
import { countTokens } from 'gpt-tokenizer/encoding/cl100k_base';
import { parse as parseYaml } from 'yaml';
import { TIERS, type Tier } from '@acme/contracts';

/**
 * Structure-aware chunker for Markdown support policies.
 *
 * Strategy — "largest coherent unit that fits":
 *  1. Parse the document into a heading tree (H1 → H2 → H3 …), carrying tier tags
 *     (`<!-- tiers: pro, enterprise -->`) down the tree.
 *  2. Walk top-down. If a whole subtree fits the token budget *and* has uniform tiers, it becomes
 *     ONE chunk. Policy rules and their exceptions usually live in the same section, so keeping
 *     a section whole is what stops retrieval returning a rule without its conditions.
 *  3. Only oversized (or tier-mixed) subtrees are split: first at child headings, then by
 *     Markdown blocks (paragraphs / lists / tables are never cut), then by sentences.
 *  4. Every chunk is embedded with a contextual header ("Doc > Section > Subsection") so short
 *     chunks still carry their meaning; the header is not shown to the model as content.
 */

export const CHUNK_MAX_TOKENS = 450;
export const CHUNK_TARGET_TOKENS = 320;
export const CHUNK_OVERLAP_MAX_TOKENS = 80;
export const CHUNK_MIN_TOKENS = 20;

export interface ParsedDocument {
  id: string;
  title: string;
  category: string;
  /** Empty = applies to every tier. */
  tiers: Tier[];
  updated: string | null;
  body: string;
  contentHash: string;
}

export interface Chunk {
  id: string;
  docId: string;
  docTitle: string;
  ordinal: number;
  headingPath: string[];
  anchor: string;
  content: string;
  embeddingInput: string;
  tiers: Tier[];
  tokenCount: number;
  contentHash: string;
}

interface SectionNode {
  level: number;
  title: string;
  /** Effective tiers (own tag, else inherited). Empty = all. */
  tiers: Tier[];
  blocks: string[];
  children: SectionNode[];
}

export function tokens(text: string): number {
  return countTokens(text);
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function parseTiers(raw: unknown): Tier[] {
  if (raw === undefined || raw === null || raw === 'all') return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  const tiers = list.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  for (const t of tiers) {
    if (!(TIERS as readonly string[]).includes(t)) throw new Error(`Unknown tier "${t}"`);
  }
  // Tagging every tier is the same as tagging none.
  return tiers.length === TIERS.length ? [] : (tiers as Tier[]);
}

export function parseDocument(raw: string, fallbackId: string): ParsedDocument {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = (match ? parseYaml(match[1] ?? '') : {}) as Record<string, unknown>;
  const body = match ? raw.slice(match[0].length) : raw;
  const id = String(meta.id ?? fallbackId);
  return {
    id,
    title: String(meta.title ?? id),
    category: String(meta.category ?? 'general'),
    tiers: parseTiers(meta.tiers),
    updated: meta.updated ? String(meta.updated) : null,
    body,
    contentHash: createHash('sha256').update(raw).digest('hex'),
  };
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const TIER_TAG_RE = /^<!--\s*tiers:\s*([a-z,\s]+?)\s*-->$/i;

/** Split section text into Markdown blocks; fenced code is kept intact. */
function toBlocks(lines: string[]): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = current.join('\n').trim();
    if (text) blocks.push(text);
    current = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === '') flush();
    else current.push(line);
  }
  flush();
  return blocks;
}

export function buildSectionTree(doc: ParsedDocument): SectionNode {
  const root: SectionNode = { level: 0, title: doc.title, tiers: doc.tiers, blocks: [], children: [] };
  const stack: SectionNode[] = [root];
  let lines: string[] = [];
  let current = root;
  const commit = () => {
    current.blocks = toBlocks(lines);
    lines = [];
  };

  const rawLines = doc.body.split(/\r?\n/);
  let inFence = false;
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i] ?? '';
    // "# comment" inside fenced code is content, not a heading.
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = inFence ? null : line.match(HEADING_RE);
    if (!heading) {
      lines.push(line);
      continue;
    }
    commit();
    const level = heading[1]!.length;
    const title = heading[2]!.trim();
    // The H1 is the document title: treat it as the root rather than a child.
    if (level === 1 && root.children.length === 0 && root.blocks.length === 0) {
      current = root;
      continue;
    }
    while (stack.length > 1 && (stack.at(-1)?.level ?? 0) >= level) stack.pop();
    const parent = stack.at(-1) ?? root;
    const tagLine = rawLines[i + 1]?.trim() ?? '';
    const tag = tagLine.match(TIER_TAG_RE);
    const node: SectionNode = {
      level,
      title,
      tiers: tag ? parseTiers(tag[1]) : parent.tiers,
      blocks: [],
      children: [],
    };
    if (tag) i++; // consume the tag line
    parent.children.push(node);
    stack.push(node);
    current = node;
  }
  commit();
  return root;
}

const sameTiers = (a: Tier[], b: Tier[]) =>
  a.length === b.length && [...a].sort().join() === [...b].sort().join();

function subtreeUniform(node: SectionNode): boolean {
  return node.children.every((c) => sameTiers(c.tiers, node.tiers) && subtreeUniform(c));
}

/** Render a subtree as Markdown, with child headings demoted relative to the chunk root. */
function renderSubtree(node: SectionNode, depth = 0): string {
  const parts: string[] = [];
  if (depth > 0) parts.push(`${'#'.repeat(Math.min(6, depth + 2))} ${node.title}`);
  parts.push(...node.blocks);
  for (const child of node.children) parts.push(renderSubtree(child, depth + 1));
  return parts.filter(Boolean).join('\n\n');
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/).filter(Boolean);
}

/** Greedy block packing with a single-block overlap (only if that block is short). */
function packBlocks(blocks: string[]): string[] {
  const units = blocks.flatMap((b) => (tokens(b) > CHUNK_MAX_TOKENS ? splitSentences(b) : [b]));
  const out: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const unit of units) {
    const t = tokens(unit);
    if (current.length && currentTokens + t > CHUNK_TARGET_TOKENS) {
      out.push(current.join('\n\n'));
      const tail = current.at(-1)!;
      const tailTokens = tokens(tail);
      // Carry the overlap only if the next chunk still fits the hard max.
      current = tailTokens <= CHUNK_OVERLAP_MAX_TOKENS && tokens(`${tail}\n\n${unit}`) <= CHUNK_MAX_TOKENS ? [tail] : [];
      currentTokens = current.length ? tailTokens : 0;
    }
    current.push(unit);
    currentTokens += t;
  }
  if (current.length) out.push(current.join('\n\n'));
  return out;
}

export function chunkDocument(doc: ParsedDocument, embeddingModel: string): Chunk[] {
  const tree = buildSectionTree(doc);
  const drafts: Array<{ path: string[]; content: string; tiers: Tier[] }> = [];

  const visit = (node: SectionNode, path: string[]) => {
    const whole = renderSubtree(node);
    if (whole && subtreeUniform(node) && tokens(whole) <= CHUNK_MAX_TOKENS) {
      drafts.push({ path, content: whole, tiers: node.tiers });
      return;
    }
    if (node.blocks.length) {
      for (const piece of packBlocks(node.blocks)) drafts.push({ path, content: piece, tiers: node.tiers });
    }
    for (const child of node.children) visit(child, [...path, child.title]);
  };

  // Each top-level section is its own unit; the doc root never swallows the whole document,
  // because one giant chunk per doc would destroy retrieval precision.
  if (tree.blocks.length) {
    for (const piece of packBlocks(tree.blocks)) drafts.push({ path: [], content: piece, tiers: tree.tiers });
  }
  for (const child of tree.children) visit(child, [child.title]);

  return drafts
    .filter((d) => tokens(d.content) >= CHUNK_MIN_TOKENS)
    .map((d, ordinal) => {
      const header = [doc.title, ...d.path].join(' > ');
      const embeddingInput = `${header}\n\n${d.content}`;
      return {
        id: `${doc.id}::${ordinal}`,
        docId: doc.id,
        docTitle: doc.title,
        ordinal,
        headingPath: d.path,
        anchor: d.path.length ? slugify(d.path.at(-1)!) : doc.id,
        content: d.content,
        embeddingInput,
        tiers: d.tiers,
        tokenCount: tokens(embeddingInput),
        contentHash: createHash('sha256')
          .update(`${embeddingModel}\n${d.tiers.join(',')}\n${embeddingInput}`)
          .digest('hex'),
      };
    });
}
