import * as nodeCrypto from "node:crypto";
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

// =============================================================================
// Install identity (shared, fork-owned)
// =============================================================================
//
// Port of oh-my-pi's `packages/utils/src/dirs.ts:getInstallId`. pi has no
// `packages/utils` package, so the shared helper lives under `packages/ai/src/utils`.
//
// `packages/ai` must not import `packages/coding-agent` (the dependency runs the
// other way), so the agent dir is resolved locally rather than via `getAgentDir()`.
// This mirrors `coding-agent/src/config.ts` (APP_NAME `pi`, CONFIG_DIR_NAME `.pi`,
// ENV_AGENT_DIR `PI_CODING_AGENT_DIR`). A renamed downstream fork would diverge,
// which is acceptable: the install id only feeds Anthropic's device/session
// counting, so a wrong dir just mints a fresh id.

const INSTALL_ID_FILE = "install-id";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cachedInstallId: string | null = null;

function getAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) {
		if (envDir.startsWith("~")) return path.join(homedir(), envDir.slice(1));
		return envDir;
	}
	return path.join(homedir(), ".pi", "agent");
}

/**
 * Persistent per-install UUID stored at `<agentDir>/install-id`.
 *
 * Generated lazily on first call and persisted with `O_CREAT|O_EXCL` so
 * concurrent first-call races don't clobber each other (loser re-reads the
 * winner's id). On a read-only filesystem the generated id is kept in memory so
 * the rest of the process has a stable value; future processes retry. Never
 * throws.
 */
export function getInstallId(): string {
	if (cachedInstallId) return cachedInstallId;
	const filePath = path.join(getAgentDir(), INSTALL_ID_FILE);

	let observedInvalid = false;
	try {
		const existing = fs.readFileSync(filePath, "utf8").trim();
		if (UUID_RE.test(existing)) {
			cachedInstallId = existing;
			return existing;
		}
		// File present but unparseable — fall through and overwrite below.
		observedInvalid = existing.length > 0;
	} catch {}

	const next = nodeCrypto.randomUUID();
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		// If we already saw garbage in the file, unlink first so O_EXCL doesn't
		// trip on it. Ignored if the unlink races against another writer.
		if (observedInvalid) {
			try {
				fs.unlinkSync(filePath);
			} catch {}
		}
		const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
		try {
			fs.writeSync(fd, `${next}\n`);
		} finally {
			fs.closeSync(fd);
		}
	} catch (err) {
		// Lost the create race — re-read whatever the winner wrote.
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			try {
				const existing = fs.readFileSync(filePath, "utf8").trim();
				if (UUID_RE.test(existing)) {
					cachedInstallId = existing;
					return existing;
				}
			} catch {}
		}
		// Any other failure (e.g. read-only FS): keep the generated id in-memory
		// so the rest of this process has a stable value; future processes retry.
	}

	cachedInstallId = next;
	return next;
}

function resetInstallIdCache(): void {
	cachedInstallId = null;
}

export const __testing = { resetInstallIdCache };
