import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AiReviewState, DiffLine, Message, Severity, Thread } from '../shared/types';

export function dataDir(): string {
  return (
    process.env.GRILLAI_DATA_DIR ??
    path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'grillai')
  );
}

export interface ReviewRow {
  id: number;
  repoPath: string;
  base: string;
  target: string;
}

type Row = Record<string, any>;

export class Store {
  private db: DatabaseSync;

  constructor(file?: string) {
    if (!file) {
      mkdirSync(dataDir(), { recursive: true });
      file = path.join(dataDir(), 'grillai.db');
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY,
        repo_path TEXT NOT NULL,
        base TEXT NOT NULL,
        target TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (repo_path, base, target)
      );
      CREATE TABLE IF NOT EXISTS threads (
        id INTEGER PRIMARY KEY,
        review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        file TEXT NOT NULL,
        lines TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY,
        thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        body TEXT NOT NULL,
        error INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS viewed (
        review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        file TEXT NOT NULL,
        hash TEXT NOT NULL,
        PRIMARY KEY (review_id, file)
      );
      CREATE TABLE IF NOT EXISTS ai_reviews (
        id INTEGER PRIMARY KEY,
        review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        error INTEGER NOT NULL DEFAULT 0,
        findings INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Columns added after the first release.
    const columns = new Set((this.db.prepare('PRAGMA table_info(threads)').all() as Row[]).map((c) => c.name));
    if (!columns.has('origin')) this.db.exec("ALTER TABLE threads ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'");
    if (!columns.has('severity')) this.db.exec('ALTER TABLE threads ADD COLUMN severity TEXT');
  }

  private review(row: Row | undefined): ReviewRow | null {
    return row ? { id: row.id, repoPath: row.repo_path, base: row.base, target: row.target } : null;
  }

  getOrCreateReview(repoPath: string, base: string, target: string): ReviewRow {
    this.db
      .prepare('INSERT OR IGNORE INTO reviews (repo_path, base, target) VALUES (?, ?, ?)')
      .run(repoPath, base, target);
    return this.review(
      this.db.prepare('SELECT * FROM reviews WHERE repo_path = ? AND base = ? AND target = ?').get(repoPath, base, target),
    )!;
  }

  getReview(id: number): ReviewRow | null {
    return this.review(this.db.prepare('SELECT * FROM reviews WHERE id = ?').get(id));
  }

  private messagesOf(threadId: number): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id').all(threadId) as Row[]).map(
      (m) => ({ id: m.id, role: m.role, body: m.body, error: !!m.error, createdAt: m.created_at + 'Z' }),
    );
  }

  private thread(row: Row): Thread {
    return {
      id: row.id,
      reviewId: row.review_id,
      file: row.file,
      origin: row.origin === 'ai' ? 'ai' : 'user',
      severity: (row.severity as Severity | null) ?? null,
      lines: JSON.parse(row.lines) as DiffLine[],
      resolved: !!row.resolved,
      createdAt: row.created_at + 'Z',
      messages: this.messagesOf(row.id),
      running: false,
    };
  }

  listThreads(reviewId: number): Thread[] {
    return (this.db.prepare('SELECT * FROM threads WHERE review_id = ? ORDER BY id').all(reviewId) as Row[]).map(
      (r) => this.thread(r),
    );
  }

  getThread(id: number): Thread | null {
    const row = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Row | undefined;
    return row ? this.thread(row) : null;
  }

  createThread(
    reviewId: number,
    file: string,
    lines: DiffLine[],
    origin: 'user' | 'ai' = 'user',
    severity: Severity | null = null,
  ): number {
    const r = this.db
      .prepare('INSERT INTO threads (review_id, file, lines, origin, severity) VALUES (?, ?, ?, ?, ?)')
      .run(reviewId, file, JSON.stringify(lines), origin, severity);
    return Number(r.lastInsertRowid);
  }

  addMessage(threadId: number, role: 'user' | 'agent', body: string, error = false): void {
    this.db
      .prepare('INSERT INTO messages (thread_id, role, body, error) VALUES (?, ?, ?, ?)')
      .run(threadId, role, body, error ? 1 : 0);
  }

  setResolved(threadId: number, resolved: boolean): void {
    this.db.prepare('UPDATE threads SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, threadId);
  }

  getSession(threadId: number): string | null {
    const row = this.db.prepare('SELECT session_id FROM threads WHERE id = ?').get(threadId) as Row | undefined;
    return row?.session_id ?? null;
  }

  setSession(threadId: number, sessionId: string | null): void {
    this.db.prepare('UPDATE threads SET session_id = ? WHERE id = ?').run(sessionId, threadId);
  }

  deleteThread(threadId: number): void {
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
  }

  /** Findings of earlier AI reviews that the reviewer never replied to; a new AI review replaces them. */
  deleteUnansweredAiThreads(reviewId: number): void {
    this.db
      .prepare(
        `DELETE FROM threads WHERE review_id = ? AND origin = 'ai'
           AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id = threads.id AND m.role = 'user')`,
      )
      .run(reviewId);
  }

  addAiReview(reviewId: number, summary: string, findings: number, error = false): void {
    this.db
      .prepare('INSERT INTO ai_reviews (review_id, summary, findings, error) VALUES (?, ?, ?, ?)')
      .run(reviewId, summary, findings, error ? 1 : 0);
  }

  latestAiReview(reviewId: number): AiReviewState['latest'] {
    const r = this.db.prepare('SELECT * FROM ai_reviews WHERE review_id = ? ORDER BY id DESC LIMIT 1').get(reviewId) as
      | Row
      | undefined;
    return r
      ? { id: r.id, summary: r.summary, error: !!r.error, findings: r.findings, createdAt: r.created_at + 'Z' }
      : null;
  }

  getViewed(reviewId: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of this.db.prepare('SELECT file, hash FROM viewed WHERE review_id = ?').all(reviewId) as Row[]) {
      out[r.file] = r.hash;
    }
    return out;
  }

  setViewed(reviewId: number, file: string, hash: string | null): void {
    if (hash == null) {
      this.db.prepare('DELETE FROM viewed WHERE review_id = ? AND file = ?').run(reviewId, file);
    } else {
      this.db
        .prepare('INSERT INTO viewed (review_id, file, hash) VALUES (?, ?, ?) ON CONFLICT (review_id, file) DO UPDATE SET hash = excluded.hash')
        .run(reviewId, file, hash);
    }
  }
}
