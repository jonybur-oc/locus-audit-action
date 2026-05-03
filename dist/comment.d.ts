import { AuditReport } from './types';
export declare function buildCommentBody(report: AuditReport): string;
/**
 * Posts or updates the Locus audit comment on the PR.
 * If a previous comment exists, edits it in place (idempotent).
 */
export declare function postOrUpdateComment(githubToken: string, body: string): Promise<void>;
