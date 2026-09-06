import { lazy, memo, Suspense } from 'react';
const Renderer = lazy(() => import('./MarkdownRenderer'));
export const MarkdownView = memo(function MarkdownView({ content }: { content: string }) {
  return <Suspense fallback={<div className="whitespace-pre-wrap">{content}</div>}><Renderer content={content} /></Suspense>;
});
