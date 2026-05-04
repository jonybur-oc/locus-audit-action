import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYAML } from 'yaml';
import { Story, StoriesFile } from './types';

/**
 * Reads and parses stories.yaml from the given path.
 * Supports both flat list format and StoriesFile envelope.
 */
export function parseStoriesFile(storiesPath: string): Story[] {
  const absPath = path.resolve(process.cwd(), storiesPath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`stories file not found: ${storiesPath} (resolved to ${absPath})`);
  }

  const raw = fs.readFileSync(absPath, 'utf-8');
  const parsed = parseYAML(raw);

  if (!parsed) {
    throw new Error(`stories file is empty or invalid YAML: ${storiesPath}`);
  }

  // Support both formats:
  // 1. Root array: [{id, title, ...}, ...]
  // 2. Envelope:   {version, project, stories: [...]}
  let stories: Story[];

  if (Array.isArray(parsed)) {
    stories = parsed as Story[];
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as StoriesFile).stories)) {
    stories = (parsed as StoriesFile).stories;
  } else {
    throw new Error(`unrecognised stories.yaml format — expected array or {stories: [...]} envelope`);
  }

  // Normalise: ensure story_id is set (canonical Locus spec field).
  // The spec uses story_id as the human-readable identifier; id is the optional UUID v4.
  // Tolerate legacy files that use id for the human-readable string.
  const valid: Story[] = [];
  for (const s of stories) {
    const raw = s as unknown as Record<string, unknown>;

    // Canonical: story_id present — use it directly
    // Legacy: only id present and looks like a human-readable slug (not UUID v4) — promote to story_id
    if (!raw.story_id && raw.id && typeof raw.id === 'string') {
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      if (!uuidPattern.test(raw.id as string)) {
        // Looks like a human-readable id (e.g. US-01, BT-07) — promote to story_id
        raw.story_id = raw.id;
      }
    }

    // Auto-generate story_id from title slug if both id and story_id are missing
    if (!raw.story_id && !raw.id) {
      if (!s.title) {
        continue; // skip entirely blank entries
      }
      raw.story_id = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }

    if (!raw.story_id && !s.title) {
      continue; // still nothing useful — skip
    }

    valid.push(s as Story);
  }

  return valid;
}
