import { Story } from './types';
/**
 * Reads and parses stories.yaml from the given path.
 * Supports both flat list format and StoriesFile envelope.
 */
export declare function parseStoriesFile(storiesPath: string): Story[];
