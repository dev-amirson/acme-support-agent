import { describe, expect, it } from 'vitest';
import type { Database } from '../db/pool';
import { CrmRepository, normalizeAccountId, normalizeEmail, normalizeZip } from './crm-repository';

describe('normalizeAccountId', () => {
  it.each([
    ['AC-1001', 'AC-1001'],
    ['ac-1001', 'AC-1001'],
    ['ac 1001', 'AC-1001'],
    ['AC1001', 'AC-1001'],
    ['  AC – 1001 ', 'AC-1001'],
    ['1001', 'AC-1001'],
    ['A C one zero zero one', 'AC-1001'],
    ['a c one oh oh six', 'AC-1006'],
    ['one zero zero three', 'AC-1003'],
    ['A-C-1-0-0-2', 'AC-1002'],
  ])('%j → %s', (raw, expected) => {
    expect(normalizeAccountId(raw)).toBe(expected);
  });

  it.each(['', 'hello', 'AC-100', 'AC-10011', 'XY-1001', 'AC-1O01', '12345'])('rejects %j', (raw) => {
    expect(normalizeAccountId(raw)).toBeNull();
  });
});

describe('normalizeEmail', () => {
  it.each([
    ['alice@example.com', 'alice@example.com'],
    ['  Alice@Example.COM ', 'alice@example.com'],
    ['alice at example dot com', 'alice@example.com'],
    ['Alice At Example Dot Com', 'alice@example.com'],
    ['carol at globex dot example', 'carol@globex.example'],
    ['alice dot chen at example dot com', 'alice.chen@example.com'],
    ['alice @ example . com', 'alice@example.com'],
  ])('%j → %s', (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });
});

describe('normalizeZip', () => {
  it.each([
    ['94107', '94107'],
    ['nine four one zero seven', '94107'],
    ['Nine, four, one, zero, seven', '94107'],
    ['oh two one three nine', '02139'],
    ['941 07', '94107'],
    ['94107-1234', '94107'],
    ['zip is 98101', '98101'],
  ])('%j → %s', (raw, expected) => {
    expect(normalizeZip(raw)).toBe(expected);
  });
});

describe('CrmRepository.findCustomer (fixtures, no DB needed)', () => {
  // findCustomer only reads the in-memory fixtures; the DB handle is never touched.
  const crm = new CrmRepository({} as Database, () => new Date('2026-11-26T12:00:00Z'));

  it('finds a customer from a transcribed account ID', () => {
    expect(crm.findCustomer({ accountId: 'A C one zero zero one' })?.name).toBe('Alice Chen');
  });

  it('finds a customer from a spoken email', () => {
    expect(crm.findCustomer({ email: 'frank at example dot com' })?.id).toBe('AC-1006');
  });

  it('falls back to email when the account ID does not match', () => {
    expect(crm.findCustomer({ accountId: 'AC-9999', email: 'bob@example.com' })?.id).toBe('AC-1002');
  });

  it('returns null for unknown identifiers', () => {
    expect(crm.findCustomer({ accountId: 'AC-9999' })).toBeNull();
    expect(crm.findCustomer({ email: 'nobody@example.com' })).toBeNull();
    expect(crm.findCustomer({})).toBeNull();
  });

  it('spoken ZIP matches the fixture verification factor', () => {
    const alice = crm.findCustomer({ accountId: 'AC-1001' })!;
    expect(normalizeZip('nine four one zero seven')).toBe(alice.zip);
  });
});
