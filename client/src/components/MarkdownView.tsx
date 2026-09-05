import { lazy, Suspense } from 'react';
const Renderer = lazy(() => import('./MarkdownRenderer'));
export function MarkdownView({ content }: { content: string }) {
  return <Suspense fallback={<div className="whitespace-pre-wrap">{content}</div>}><Renderer content={content} /></Suspense>;
}
