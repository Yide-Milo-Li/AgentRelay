/**
 * What the signed-in caller needs to turn sharing on. The id is the caller's own platform id,
 * returned only while sharing is off; a shared workspace never reveals another member's id.
 */
export type WorkspaceInfo = ({ shared: true } | { shared: false; userId: string }) & {
  viewerName: string | null; workspaceLabel: string;
};
