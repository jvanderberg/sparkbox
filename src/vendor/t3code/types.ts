export type PendingApproval = {
  requestKind: "command" | "file-read" | "file-change" | "mcp-elicitation";
  appName?: string;
  detail?: string;
};
