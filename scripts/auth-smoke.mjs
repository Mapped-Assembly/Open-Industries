import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const base = 'http://127.0.0.1:8787';
let enabled = false;
let verifierSeen = false;
const user = { id: 'ad510000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: 'astra-test@example.invalid', app_metadata: { provider: 'github', providers: ['github'] }, user_metadata: { user_name: 'astra-test' }, created_at: new Date().toISOString() };
const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'), Buffer.from(JSON.stringify({ sub: user.id, aud: 'authenticated', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'test-signature'].join('.');
try {
  // These routes exercise the real Supabase client without creating a GitHub account/session.
  await page.route('**/auth/v1/settings', route => route.fulfill({ json: { external: { github: enabled } } }));
  await page.route('**/auth/v1/authorize?**', async route => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get('provider')).toBe('github');
    expect(url.searchParams.get('redirect_to')).toBe(base);
    expect(url.searchParams.get('code_challenge_method')).toBe('s256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('scopes')).toBe('read:user user:email');
    await route.fulfill({ status: 302, headers: { location: `${base}/?code=test-auth-code` } });
  });
  await page.route('**/auth/v1/token?**', route => {
    const payload = route.request().postDataJSON();
    expect(payload.auth_code).toBe('test-auth-code');
    expect(payload.code_verifier.length).toBeGreaterThan(20); verifierSeen = true;
    return route.fulfill({ json: { access_token: token, refresh_token: 'test-refresh-token', token_type: 'bearer', expires_in: 3600, user } });
  });
  await page.route('**/auth/v1/logout?**', route => route.fulfill({ status: 204 }));
  await page.goto(base);
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(page.getByRole('alert')).toContainText('not enabled yet');
  await expect(page).toHaveURL(`${base}/`);
  await page.getByRole('button', { name: 'Dismiss sign-in error' }).click();
  enabled = true;
  await page.locator('input[type=file]').setInputFiles({ name: 'auth-room.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
    hardware_ir_version: '0.2', overview: { title: 'Preserved during GitHub login' }, mechanical: { render_dimensions: { x_mm: 100, y_mm: 200, z_mm: 300 } },
  })) });
  await expect(page.locator('.asset')).toHaveCount(1);
  await page.getByLabel('Width', { exact: true }).fill('8');
  await page.getByLabel('Preserved during GitHub login X position', { exact: true }).fill('2.5');
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await expect(page.locator('.account-name')).toHaveText('@astra-test');
  await expect(page.locator('.asset')).toHaveCount(1);
  await expect(page.getByLabel('Width', { exact: true })).toHaveValue('8');
  await expect(page.getByLabel('Preserved during GitHub login X position', { exact: true })).toHaveValue('2.5');
  expect(verifierSeen).toBe(true);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/github-auth-desktop-after.png' });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/github-auth-mobile-after.png', fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  await page.goto(`${base}/?error=access_denied&error_description=User%20cancelled%20login`);
  await expect(page.getByRole('alert')).toContainText('User cancelled login');
  await expect(page).toHaveURL(`${base}/`);
  expect(errors).toEqual([]);
  console.log('PASS mocked GitHub PKCE redirect/exchange, disabled-provider error, persisted session, sign-out, callback error, workspace preservation and mobile layout.');
} finally { await browser.close(); }
