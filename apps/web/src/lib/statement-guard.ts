/**
 * what the query editor does BEFORE it sends a statement: nothing, ask first,
 * or not send it at all. pure, so that the rule can be tested without an editor.
 *
 *  - a read-only connection: only a read is sent. (the server refuses the rest
 *    anyway; refusing here says so without a round trip, in the editor's words)
 *  - anything destructive — a DROP, a TRUNCATE, a DELETE or UPDATE with no
 *    WHERE, a FLUSHALL — is confirmed first, on any connection
 *  - on a connection labelled PRODUCTION, so is any write
 */
import {
  assessStatement,
  type ConnectionConfig,
  type StatementAssessment,
} from '@syncle/core';

export type StatementVerdict =
  | { action: 'run' }
  | {
      action: 'confirm';
      why: 'destructive' | 'production-write';
      assessment: StatementAssessment;
    }
  | { action: 'refuse'; assessment: StatementAssessment };

export function statementVerdict(
  connection: Pick<ConnectionConfig, 'engine' | 'readOnly' | 'environment'>,
  statement: string,
): StatementVerdict {
  const assessment = assessStatement(connection.engine, statement);
  if (assessment.risk === 'read') return { action: 'run' };
  if (connection.readOnly) return { action: 'refuse', assessment };
  if (assessment.risk === 'destructive')
    return { action: 'confirm', why: 'destructive', assessment };
  if (connection.environment === 'production')
    return { action: 'confirm', why: 'production-write', assessment };
  return { action: 'run' };
}
