import { describe, expect, it } from 'vitest';
import { terminalTheme } from './terminal-theme';

describe('terminalTheme', () => {
  it('gives the light theme a white page and a dark cursor, so the terminal matches the panel', () => {
    const light = terminalTheme('light');
    expect(light.background).toBe('#ffffff');
    expect(light).toMatchObject({ foreground: '#1f2328', cursor: '#1f2328', cursorAccent: '#ffffff' });
    expect((light as { selectionBackground?: string }).selectionBackground).toContain('rgba');
  });

  it('leaves the dark theme to xterm’s own colours but for its background', () => {
    expect(terminalTheme('dark')).toEqual({ background: '#1e1e1e' });
  });

  it('hands out the same object for the same theme, so a view can compare them', () => {
    expect(terminalTheme('light')).toBe(terminalTheme('light'));
    expect(terminalTheme('dark')).not.toBe(terminalTheme('light'));
  });
});
