import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

// WCAG 2.0/2.1/2.2 A+AA rules plus axe best practices (landmarks, headings,
// region). Violations are reported by rule id and selector only.
export async function audit(page: Page, label: string) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();
  const violations = result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(violations, `axe violations on ${label}`).toEqual([]);
}

export async function structure(page: Page, app = true) {
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveCount(1);
  if (app) {
    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('navigation', { name: 'Principal' })).toHaveCount(1);
  }
  // Every button and link has an accessible name.
  const unnamed = await page.evaluate(() => [...document.querySelectorAll('button, a[href]')]
    .filter((el) => !(el.textContent ?? '').trim() && !el.getAttribute('aria-label')).length);
  expect(unnamed).toBe(0);
}

export async function targets(page: Page) {
  // WCAG 2.5.8: interactive targets at least 24x24 CSS px; primary buttons 44 px high.
  const small = await page.evaluate(() => [...document.querySelectorAll('button, a[href], input, select, textarea, summary')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const visible = r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('.visually-hidden');
      return visible && !el.classList.contains('skip-link') && (r.width < 24 || r.height < 24 || (el.tagName === 'BUTTON' && r.height < 44));
    }).map((el) => el.outerHTML.slice(0, 60)));
  expect(small).toEqual([]);
}
