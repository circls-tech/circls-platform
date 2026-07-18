import { describe, expect, it } from 'vitest';
import {
  applyAuthorStatusPatch,
  nextStatusOnReply,
  resolveAuthorKind,
} from './questions_transitions.js';

describe('resolveAuthorKind', () => {
  it('platform members post as circls', () => {
    expect(resolveAuthorKind({ isPlatformMember: true, isOrgMember: false })).toBe('circls');
  });

  it('platform membership outranks org membership', () => {
    expect(resolveAuthorKind({ isPlatformMember: true, isOrgMember: true })).toBe('circls');
  });

  it('thread-tenant members post as org', () => {
    expect(resolveAuthorKind({ isPlatformMember: false, isOrgMember: true })).toBe('org');
  });

  it('everyone else posts as consumer', () => {
    expect(resolveAuthorKind({ isPlatformMember: false, isOrgMember: false })).toBe('consumer');
  });
});

describe('nextStatusOnReply', () => {
  it('org reply on an open thread auto-answers it', () => {
    expect(nextStatusOnReply('open', 'org', false)).toBe('answered');
  });

  it('circls reply on an open thread auto-answers it', () => {
    expect(nextStatusOnReply('open', 'circls', false)).toBe('answered');
  });

  it('org reply on an already-answered thread leaves it answered', () => {
    expect(nextStatusOnReply('answered', 'org', false)).toBe('answered');
  });

  it('author (consumer) reply on an answered thread reopens it', () => {
    expect(nextStatusOnReply('answered', 'consumer', true)).toBe('open');
  });

  it('third-party consumer reply on an answered thread does not reopen it', () => {
    expect(nextStatusOnReply('answered', 'consumer', false)).toBe('answered');
  });

  it('consumer reply on an open thread leaves it open', () => {
    expect(nextStatusOnReply('open', 'consumer', true)).toBe('open');
    expect(nextStatusOnReply('open', 'consumer', false)).toBe('open');
  });

  it('author who is also an org member auto-answers their own open thread (accepted edge)', () => {
    expect(nextStatusOnReply('open', 'org', true)).toBe('answered');
  });

  it('org-kind author reply on answered does not reopen (reopen is consumer-authored only)', () => {
    expect(nextStatusOnReply('answered', 'org', true)).toBe('answered');
  });

  it('passes closed through unchanged (rejection happens before transition)', () => {
    expect(nextStatusOnReply('closed', 'org', false)).toBe('closed');
    expect(nextStatusOnReply('closed', 'consumer', true)).toBe('closed');
  });
});

describe('applyAuthorStatusPatch', () => {
  it('author can mark an open thread answered or closed', () => {
    expect(applyAuthorStatusPatch('open', 'answered')).toBe('answered');
    expect(applyAuthorStatusPatch('open', 'closed')).toBe('closed');
  });

  it('author can close an answered thread', () => {
    expect(applyAuthorStatusPatch('answered', 'closed')).toBe('closed');
  });

  it('author cannot resurrect a closed thread to answered', () => {
    expect(applyAuthorStatusPatch('closed', 'answered')).toBeNull();
  });

  it('closing an already-closed thread is an idempotent no-op', () => {
    expect(applyAuthorStatusPatch('closed', 'closed')).toBe('closed');
  });
});
