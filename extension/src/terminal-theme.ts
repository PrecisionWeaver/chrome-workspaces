export const DARK_TERMINAL = { background: '#1e1e1e' };

export const LIGHT_TERMINAL = {
  background: '#ffffff',
  foreground: '#1f2328',
  cursor: '#1f2328',
  cursorAccent: '#ffffff',
  selectionBackground: 'rgba(31, 111, 235, 0.25)',
};

export const terminalTheme = (theme: 'light' | 'dark') => (theme === 'light' ? LIGHT_TERMINAL : DARK_TERMINAL);
