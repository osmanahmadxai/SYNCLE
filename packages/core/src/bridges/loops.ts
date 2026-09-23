/**
 * bridges that feed each other (A -> B plus B -> A, or a longer ring).
 *
 * Syncle remembers what it writes to a table that another live bridge reads,
 * and that bridge does not send this instance's own writes round again. This is
 * what a bridge's page is told about it: who it is tied to, and how many changes
 * were held back — so that "why did this change not arrive?" has an answer.
 */
export interface BridgeLoopPeer {
  bridgeId: string;
  name: string;
}

export interface BridgeLoopStatus {
  /** false when SYNCLE_ECHO_TTL_SECONDS is 0: nothing is recognised, and two such bridges WILL loop */
  guard: boolean;
  /** bridges that write the table this one reads */
  fedBy: BridgeLoopPeer[];
  /** live bridges that read a table this one writes */
  feeds: BridgeLoopPeer[];
  /** changes this bridge recognised as this instance's own and did not send on (every API process together) */
  heldBack: number;
}
