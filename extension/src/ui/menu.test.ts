// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { closeMenu, menuItem, openMenu } from './menu';

beforeEach(() => {
  closeMenu();
  document.body.innerHTML = '';
});

describe('menuItem', () => {
  it('closes the menu and then runs its action when clicked', () => {
    const order: string[] = [];
    const menu = openMenu(0, 0, [menuItem('Archive', () => order.push(`run, menu ${document.querySelector('.popup-menu') ? 'open' : 'closed'}`))]);
    (menu.querySelector('button') as HTMLButtonElement).click();
    expect(order).toEqual(['run, menu closed']);
  });

  it('shows a check, a title and a disabled state when asked', () => {
    const button = menuItem('Compact', () => {}, { checked: true, title: 'Denser rows', disabled: true });
    expect(button.textContent).toBe('✓ Compact');
    expect(button.title).toBe('Denser rows');
    expect(button.disabled).toBe(true);
    expect(menuItem('Plain', () => {}).disabled).toBe(false);
  });
});

describe('openMenu', () => {
  it('adds a menu to the page with its items and extra class', () => {
    const menu = openMenu(10, 20, [menuItem('One', () => {}), menuItem('Two', () => {})], 'wide');
    expect(menu.parentElement).toBe(document.body);
    expect(menu.className).toBe('popup-menu wide');
    expect(menu.getAttribute('role')).toBe('menu');
    expect([...menu.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['One', 'Two']);
    expect([menu.style.left, menu.style.top]).toEqual(['10px', '20px']);
  });

  it('keeps the menu inside the panel', () => {
    const near = openMenu(-50, -50, []);
    expect([near.style.left, near.style.top]).toEqual(['4px', '4px']);
    const far = openMenu(99_999, 99_999, []);
    expect(far.style.left).toBe(`${window.innerWidth - 4}px`);
    expect(far.style.top).toBe(`${window.innerHeight - 4}px`);
  });

  it('shows only one menu at a time', () => {
    openMenu(0, 0, []);
    openMenu(0, 0, []);
    expect(document.querySelectorAll('.popup-menu')).toHaveLength(1);
  });
});

describe('dismissing', () => {
  const dismissals: [string, () => void][] = [
    ['clicking elsewhere', () => document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))],
    ['pressing Escape', () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))],
    ['the panel losing focus', () => window.dispatchEvent(new Event('blur'))],
  ];
  it.each(dismissals)('closes the menu on %s', (_name, dismiss) => {
    openMenu(0, 0, [menuItem('One', () => {})]);
    dismiss();
    expect(document.querySelector('.popup-menu')).toBeNull();
  });

  it('stays open for a click inside it, or another key', () => {
    const menu = openMenu(0, 0, [menuItem('One', () => {})]);
    menu.querySelector('button')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(document.querySelector('.popup-menu')).toBe(menu);
  });

  it('is safe to close when nothing is open', () => {
    expect(() => closeMenu()).not.toThrow();
  });
});

describe('keyboard', () => {
  const press = (key: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  const labels = () => [...document.querySelectorAll('.popup-menu button')].map((b) => b.textContent);

  it('moves focus into the menu, onto its first enabled item', () => {
    openMenu(0, 0, [menuItem('Off', () => {}, { disabled: true }), menuItem('One', () => {}), menuItem('Two', () => {})]);
    expect(document.activeElement?.textContent).toBe('One');
    expect(labels()).toEqual(['Off', 'One', 'Two']);
    expect(document.querySelector('.popup-menu button')?.getAttribute('role')).toBe('menuitem');
  });

  it('moves among the enabled items with the arrow keys, Home and End, wrapping round', () => {
    openMenu(0, 0, [menuItem('One', () => {}), menuItem('Off', () => {}, { disabled: true }), menuItem('Two', () => {}), menuItem('Three', () => {})]);
    const at = () => document.activeElement?.textContent;
    press('ArrowDown');
    expect(at()).toBe('Two');
    press('ArrowDown');
    press('ArrowDown');
    expect(at()).toBe('One');
    press('ArrowUp');
    expect(at()).toBe('Three');
    press('Home');
    expect(at()).toBe('One');
    press('End');
    expect(at()).toBe('Three');
  });

  it('hands focus back to what had it when it closes, on Escape or on choosing an item', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    openMenu(0, 0, [menuItem('One', () => {})]);
    press('Escape');
    expect(document.activeElement).toBe(opener);

    openMenu(0, 0, [menuItem('One', () => {})]);
    (document.querySelector('.popup-menu button') as HTMLButtonElement).click();
    expect(document.activeElement).toBe(opener);
  });

  it('closes on Tab', () => {
    openMenu(0, 0, [menuItem('One', () => {})]);
    press('Tab');
    expect(document.querySelector('.popup-menu')).toBeNull();
  });
});
