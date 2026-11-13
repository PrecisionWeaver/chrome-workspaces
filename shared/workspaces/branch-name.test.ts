import { describe, expect, it } from 'vitest';
import { isBranchName, slugBranch } from './branch-name';

describe('slugBranch', () => {
  it('turns a workspace name into a branch git accepts', () => {
    expect(slugBranch('PROJ-123')).toBe('PROJ-123');
    expect(slugBranch('  Email table fix  ')).toBe('Email-table-fix');
    expect(slugBranch('web-app#482')).toBe('web-app482');
    expect(slugBranch('feat//x..y/')).toBe('feat/x.y');
    expect(slugBranch('-.lock')).toBe('');
    expect(slugBranch('')).toBe('');
  });
});

describe('isBranchName', () => {
  it('accepts plain names and rejects what check-ref-format would', () => {
    expect(isBranchName('PROJ-1')).toBe(true);
    expect(isBranchName('feat/one.two')).toBe(true);
    expect(isBranchName('-x')).toBe(false);
    expect(isBranchName('a..b')).toBe(false);
    expect(isBranchName('a b')).toBe(false);
    expect(isBranchName('a/')).toBe(false);
    expect(isBranchName('a.lock')).toBe(false);
    expect(isBranchName('a@{b')).toBe(false);
    expect(isBranchName('')).toBe(false);
    expect(isBranchName('x'.repeat(101))).toBe(false);
  });
});
