/** @jsxImportSource react */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { AppErrorBoundary } from '@/react-app/shell/app-error-boundary';
import type {} from './state';

const witness = window.crashRecovery;
if (!witness) throw new Error('Pre-initialization witness missing');
const query = new URLSearchParams(location.search);
const rootElement = document.getElementById('root');
const controls = document.getElementById('controls');
if (!rootElement || !controls) throw new Error('Fixture roots missing');
const root = createRoot(rootElement);
let count = 0;
const mode = query.get('case');
const mixed = 'synthetic https://FAKE_USER:FAKE_PASSWORD@asset.invalid/view?grant=FAKE_QUERY#FAKE_FRAGMENT Authorization: Bearer FAKE_BEARER api_key=FAKE_API';
const html = '<img src=x onerror="window.residual.executed=true"><script>window.residual.executed=true</script>';
const message = mode === 'mixed' ? mixed : mode === 'html' ? html : 'synthetic ordinary failure';
function thrownValue(): unknown {
  if (mode === 'object') return { detail: 'synthetic arbitrary object' };
  if (mode === 'toString') { const value = { toString() { throw value; } }; return value; }
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at SyntheticChild (${mode === 'mixed' ? 'https://FAKE_STACK_USER:FAKE_STACK_PASSWORD@asset.invalid/chunk.js?api_key=FAKE_STACK_API#FAKE_STACK_FRAGMENT:12:34' : 'file:///synthetic/source.tsx:12:34'})`;
  if (mode?.startsWith('getter-')) Object.defineProperty(error, mode.slice(7), { get() { throw new Error('FAKE_GETTER_FAILURE'); } });
  return error;
}
function ThrowingChild(): React.ReactNode { if (witness) witness.throws++; throw thrownValue(); }
function button(label: string, action: () => void) {
  const element = document.createElement('button'); element.textContent = label;
  element.onclick = action; controls?.append(element);
}
button('Crash', () => root.render(<AppErrorBoundary key={++count}><ThrowingChild /></AppErrorBoundary>));
root.render(<AppErrorBoundary><p>Healthy synthetic child</p></AppErrorBoundary>);
witness.ready = true;
