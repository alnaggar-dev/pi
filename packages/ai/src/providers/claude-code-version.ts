// Claude Code fingerprint versions, shared by every surface that claims the
// Claude Code identity: the Messages API User-Agent + billing header (node-only
// billing module) and the OAuth token-exchange bootstrap. Browser-safe (no node
// imports) so the OAuth flow can import it statically. One source of truth —
// the surfaces previously drifted apart (claude-code/2.1.160 bootstrap vs
// claude-cli/2.1.165 on /v1/messages), a fingerprint inconsistency real Claude
// Code never exhibits.
export const claudeCodeVersion = "2.1.165";
export const claudeAgentSdkVersion = "0.3.165";
export const claudeClientVersion = "1.11187.4";
