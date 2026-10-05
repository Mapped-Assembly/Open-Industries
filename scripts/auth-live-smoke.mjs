import { chromium, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

// Checks real provider configuration without signing into or authorizing a GitHub account.
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
let authorization;
page.on('request', request => {
  const url = new URL(request.url());
  if (url.hostname === 'github.com' && url.pathname === '/login/oauth/authorize') authorization = url;
});
try {
  const base = process.env.ASTRA_BASE_URL || 'http://127.0.0.1:8787';
  await page.goto(base);
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await page.waitForURL(url => url.hostname === 'github.com', { timeout: 30000 });
  await expect.poll(() => authorization?.searchParams.get('client_id')).toBeTruthy();
  expect(authorization.searchParams.get('redirect_uri')).toBe('https://mrhxfmtofvrgfaikllfw.supabase.co/auth/v1/callback');
  expect(authorization.searchParams.get('redirect_to')).toBe(base);
  await expect(page.getByRole('textbox', { name: 'Username or email address' })).toBeVisible();
  await expect(page.getByText('Sign in to GitHub to continue to Mergence')).toBeVisible();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/github-auth-live-provider.png' });
  console.log('PASS live Mergence → Supabase → GitHub redirect, configured client ID, expected callback, and GitHub sign-in page. Account authorization/token exchange still requires the user.');
} finally { await browser.close(); }
