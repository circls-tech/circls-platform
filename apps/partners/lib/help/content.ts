import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { HELP_SLUGS } from './articles';

// Reads a help article's markdown body from content/help/<slug>.md.
// Server-only — relies on the filesystem. Returns null if the slug is unknown
// or the file is missing, so callers can render a 404.

const CONTENT_DIR = path.join(process.cwd(), 'content', 'help');

export async function getArticleBody(slug: string): Promise<string | null> {
  if (!HELP_SLUGS.includes(slug)) return null;
  try {
    return await readFile(path.join(CONTENT_DIR, `${slug}.md`), 'utf8');
  } catch {
    return null;
  }
}
