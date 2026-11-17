import { describe, expect, it } from 'vitest';
import { WORKSPACE_COLORS } from './workspace';

describe('WORKSPACE_COLORS', () => {
  it('lists each colour once', () => {
    expect(new Set(WORKSPACE_COLORS).size).toBe(WORKSPACE_COLORS.length);
  });
});
