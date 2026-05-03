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

  // Validate that each story has at minimum an id and title
  const valid: Story[] = [];
  for (const s of stories) {
    if (!s.id && !s.title) {
      continue; // skip entirely blank entries
    }
    if (!s.id) {
      // auto-assign from title slug if missing (tolerant parsing)
      s.id = s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    }
    valid.push(s);
  }

  return valid;
}
