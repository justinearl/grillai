import type { AiReviewState, DiffLine, RepoInfo, ReviewPayload, Thread } from '../../shared/types';

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  repo: () => call<RepoInfo>('GET', '/api/repo'),
  review: (base: string, target: string) =>
    call<ReviewPayload>('GET', `/api/review?base=${encodeURIComponent(base)}&target=${encodeURIComponent(target)}`),
  fileLines: (reviewId: number, path: string) =>
    call<{ lines: string[] }>('GET', `/api/reviews/${reviewId}/file?path=${encodeURIComponent(path)}`),
  aiReview: (reviewId: number) => call<AiReviewState>('GET', `/api/reviews/${reviewId}/ai-review`),
  startAiReview: (reviewId: number) => call<AiReviewState>('POST', `/api/reviews/${reviewId}/ai-review`, {}),
  cancelAiReview: (reviewId: number) => call<{ ok: true }>('POST', `/api/reviews/${reviewId}/ai-review/cancel`, {}),
  threads: (reviewId: number) => call<Thread[]>('GET', `/api/reviews/${reviewId}/threads`),
  createThread: (reviewId: number, file: string, lines: DiffLine[], body: string, ask: boolean) =>
    call<Thread>('POST', `/api/reviews/${reviewId}/threads`, { file, lines, body, ask }),
  reply: (threadId: number, body: string, ask: boolean) =>
    call<Thread>('POST', `/api/threads/${threadId}/messages`, { body, ask }),
  cancel: (threadId: number) => call<{ ok: true }>('POST', `/api/threads/${threadId}/cancel`),
  resolve: (threadId: number, resolved: boolean) => call<Thread>('PATCH', `/api/threads/${threadId}`, { resolved }),
  remove: (threadId: number) => call<{ ok: true }>('DELETE', `/api/threads/${threadId}`),
  setViewed: (reviewId: number, file: string, hash: string | null) =>
    call<{ ok: true }>('PUT', `/api/reviews/${reviewId}/viewed`, { file, hash }),
};
