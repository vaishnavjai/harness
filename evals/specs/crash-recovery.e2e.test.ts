import { expect } from 'vitest';
import { spec, createBriefRun, claim } from '@harness/testkit';
import type { User } from '@harness/testkit';
import { crashRecoveryWorld } from '../worlds/crash-recovery.ts';
import type { CrashRecoveryWorld } from '../worlds/crash-recovery.ts';
import type { RecoverySnapshot } from '../fixtures/crash-recovery/state.ts';

const test = spec.world(crashRecoveryWorld, {
  // Each test provisions a fresh Chrome sandbox and installs dependencies; Daytona has needed over 90 s.
  timeout: 300_000,
  needs: { commands: ['git', ...(process.env.HARNESS_EVAL_DAYTONA === '1' ? ['daytona'] : [])] },
  // Real app source in a standalone Chrome; no Den, mock services or Electron.
  resources: { surfaces: ['appWeb'], services: [] },
});
const heading = 'Harness hit an unexpected error';
const safeMessage = 'synthetic ordinary failure';
const safeStack = `Error: ${safeMessage}\n    at SyntheticChild (file:///synthetic/source.tsx:12:34)`;
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 350));
const click = (user: User, text: string) => user.click({ role: 'button', text: text === 'Technical details' ? /Technical details$/ : text });

async function observe(world: CrashRecoveryWorld, label: string) {
  const state = await world.observe(label);
  createBriefRun({ behavior: 'Inspect synthetic source-browser observations', claims: { observation: claim('the observation is available for assertion audit') } }).prove.observation(true, JSON.stringify({ label, state, requests: world.requests, interceptionErrors: world.interceptionErrors }));
  return state;
}
/** Harness ships no crash reporter: nothing leaves the page, by fetch, beacon or any browser request. */
function nothingSent(world: CrashRecoveryWorld, state: RecoverySnapshot) {
  expect(state.witness.fetches).toEqual([]);
  expect(state.witness.beacons).toEqual([]);
  expect(world.requests.length).toBeGreaterThan(0);
  expect(world.requests.filter(request => request.method !== 'GET' || new URL(request.url).origin !== world.origin)).toEqual([]);
  expect(world.interceptionErrors).toEqual([]);
}
function recovered(state: RecoverySnapshot) {
  expect(state.heading).toBe(heading);
  expect(state.buttons).toContain('Reload');
  expect(state.text).not.toContain('Healthy synthetic child');
  expect(state.witness.throws).toBeGreaterThan(0);
  expect(state.witness.errors).toEqual([]);
  expect(state.witness.rejections).toEqual([]);
  expect(state.witness.trustedClicks.length).toBeGreaterThan(0);
  expect(state.witness.trustedClicks.every(Boolean)).toBe(true);
}
async function crash(world: CrashRecoveryWorld, user: User, route = 'web/') {
  await user.navigate(world.url(route));
  await user.see({ text: 'Healthy synthetic child' });
  const initial = await observe(world, 'healthy');
  expect(initial.heading).toBe(''); expect(initial.witness.fetches).toEqual([]);
  await click(user, 'Crash'); await settle();
  return observe(world, 'after-render-throw');
}

test('crash recovery ordinary Error recovers, copies exact diagnostics, and sends no report', async ({ world, user }) => {
  const state = await crash(world, user); recovered(state); nothingSent(world, state);
  expect(state.expanded).toBe('false'); expect(state.text).not.toContain(safeMessage); expect(state.stack).toBe('');
  expect(state.buttons).not.toContain('Copy details');
  await click(user, 'Technical details'); await click(user, 'Copy details'); await settle();
  const copied = await observe(world, 'ordinary-copy');
  expect(copied.stack).toBe(safeStack); expect(copied.witness.copies).toHaveLength(1);
  expect(copied.witness.copies[0].split('\n\n')[0]).toMatch(new RegExp(`^Harness ${world.version.replaceAll('.', '\\.')} \\(web, [^)]+\\)$`));
  expect(copied.witness.copies[0].split('\n\n').slice(1)).toEqual([safeMessage, safeStack]);
  expect(copied.buttons).toContain('Copied'); recovered(copied); nothingSent(world, copied);
});

for (const [name, route] of [['desktop', 'desktop/'], ['Electron', 'web/?electron=yes']]) {
  test(`crash recovery on ${name} sends no report either`, async ({ world, user }) => {
    const state = await crash(world, user, route); recovered(state); nothingSent(world, state);
    await click(user, 'Crash'); await settle();
    const again = await observe(world, 'second-crash'); recovered(again); nothingSent(world, again);
  });
}

for (const mode of ['object', 'toString', 'getter-name', 'getter-message', 'getter-stack']) {
  test(`crash recovery survives ${mode} without a secondary crash`, async ({ world, user }) => {
    const state = await crash(world, user, `web/?case=${mode}`); recovered(state);
    await click(user, 'Technical details'); await click(user, 'Copy details'); await settle();
    const copied = await observe(world, 'hostile-value-copy'); recovered(copied);
    expect(copied.witness.copies).toHaveLength(1); expect(copied.buttons).toContain('Copied');
    expect(copied.text).not.toContain('FAKE_GETTER_FAILURE'); expect(copied.witness.copies[0]).not.toContain('FAKE_GETTER_FAILURE');
    expect(copied.text.length).toBeGreaterThan(heading.length); nothingSent(world, copied);
  });
}

const secrets = ['FAKE_USER', 'FAKE_PASSWORD', 'FAKE_QUERY', 'FAKE_FRAGMENT', 'FAKE_BEARER', 'FAKE_API', 'FAKE_STACK_USER', 'FAKE_STACK_PASSWORD', 'FAKE_STACK_API', 'FAKE_STACK_FRAGMENT'];
for (const surface of ['visible', 'copied']) {
  test(`crash recovery removes mixed URL api_key and Bearer secrets from ${surface}`, async ({ world, user }) => {
    recovered(await crash(world, user, 'web/?case=mixed'));
    await click(user, 'Technical details'); await click(user, 'Copy details'); await settle();
    const observed = await observe(world, `mixed-${surface}`);
    expect(observed.witness.copies).toHaveLength(1);
    const fields = surface === 'visible' ? [observed.text, observed.stack] : [observed.witness.copies[0]];
    expect(fields.flatMap((field, index) => secrets.filter(secret => field.includes(secret)).map(secret => ({ index, secret })))).toEqual([]);
    expect(fields.join('\n')).toContain('https://asset.invalid/view'); recovered(observed); nothingSent(world, observed);
  });
}

test('crash recovery preserves redacted URL frame line column and closing parenthesis', async ({ world, user }) => {
  recovered(await crash(world, user, 'web/?case=mixed'));
  await click(user, 'Technical details'); await click(user, 'Copy details'); await settle();
  const state = await observe(world, 'diagnostic-positions'); nothingSent(world, state);
  const suffix = 'at SyntheticChild (https://asset.invalid/chunk.js:12:34)';
  expect([state.stack, state.witness.copies[0]].map(text => typeof text === 'string' && text.includes(suffix))).toEqual([true, true]);
});

test('crash recovery renders benign HTML literally without injected elements or execution', async ({ world, user }) => {
  recovered(await crash(world, user, 'web/?case=html'));
  await click(user, 'Technical details'); await click(user, 'Copy details'); await settle();
  const state = await observe(world, 'literal-html');
  const html = '<img src=x onerror="window.residual.executed=true"><script>window.residual.executed=true</script>';
  expect(state.text).toContain(html); expect(state.witness.copies[0]).toContain(html);
  expect(state.injected).toBe(0); expect(state.witness.executed).toBe(false); recovered(state); nothingSent(world, state);
});

for (const mode of ['denied', 'absent']) {
  test(`crash recovery ${mode} clipboard shows generic failure without false success or escaped rejection`, async ({ world, user }) => {
    recovered(await crash(world, user, `web/?clipboard=${mode}`));
    await click(user, 'Technical details'); await click(user, 'Copy details'); await settle();
    const state = await observe(world, 'clipboard-failure'); nothingSent(world, state);
    expect(state.witness.copies).toEqual([]); expect(state.buttons).not.toContain('Copied'); expect(state.buttons).toContain('Copy details');
    expect(state.text).not.toContain('FAKE_CLIPBOARD_DENIAL_SECRET');
    const issues = { errors: state.witness.errors, rejections: state.witness.rejections, genericFailureVisible: /(?:could not|couldn't|unable|failed|unavailable|not available).{0,50}cop|cop.{0,50}(?:failed|unavailable|not available)/i.test(state.text) };
    expect(issues).toEqual({ errors: [], rejections: [], genericFailureVisible: true });
    expect(state.stack).toBe(safeStack); expect(state.heading).toBe(heading);
    expect(state.witness.trustedClicks.every(Boolean)).toBe(true);
  });
}

test('crash recovery healthy child transitions to recovery and Reload boots healthy again', async ({ world, user, probe }) => {
  const crashed = await crash(world, user); recovered(crashed);
  await click(user, 'Reload'); await user.see({ text: 'Healthy synthetic child' });
  const state = await probe.eventually(() => world.observe('reload-poll'), { until: state => state.witness.boot !== crashed.witness.boot, within: 5000 });
  await observe(world, 'after-reload');
  expect(state.heading).toBe(''); expect(state.buttons).not.toContain('Reload'); expect(state.witness.throws).toBe(0);
  expect(state.witness.errors).toEqual([]); expect(state.witness.rejections).toEqual([]); nothingSent(world, state);
});
