import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	appendAudit,
	buildQuestions,
	cardKey,
	CircuitBreaker,
	loadConfig,
	mapVerdicts,
	parseRules,
	previewState,
	requestJudgments,
	rulesForSite,
	selectCards,
	severityFor,
	textFromContent,
	toRecord,
	toolCallState,
	toolResultState,
	turnEndState,
	type JevConfig,
	type Rule,
	type RuleHit,
	type Site,
	type Verdicts,
} from "./jev.ts";

const RULES_FILENAME = "jev-rules.jsonl";
const CONFIG_FILENAME = "jev-config.json";
const AUDIT_FILENAME = "jev-audit.jsonl";
const RULES_PATH_ENV = "JEV_RULES";
const FAILURE_LIMIT = 3;

interface Runtime {
	rulesPath: string;
	configPath: string;
	auditPath: string | null;
	rules: Rule[];
	rulesHash: string;
	rulesMtimeMs: number;
	configMtimeMs: number;
	config: JevConfig;
	warnings: string[];
	circuit: CircuitBreaker;
	enabled: boolean;
	apiKey: { provider: string; value: string } | null;
	toolCalls: string[];
	bashCommands: string[];
	touchedFiles: Set<string>;
	refusedRules: Set<number>;
	carded: Set<string>;
	notices: Set<string>;
	stats: { checks: number; blocks: number; cards: number; failures: number };
	lastModel: string | null;
	lastError: string | null;
}

interface CheckResult {
	verdicts: Verdicts | null;
	/** Non-null when the gate must refuse even though no judgment was produced. */
	refusal: string | null;
}

interface FileSnapshot {
	text: string | null;
	mtimeMs: number;
}

const readSnapshot = (path: string): FileSnapshot => {
	try {
		return { text: readFileSync(path, "utf8"), mtimeMs: statSync(path).mtimeMs };
	} catch {
		return { text: null, mtimeMs: 0 };
	}
};

const rulesPathFor = (cwd: string): string => {
	const override = process.env[RULES_PATH_ENV]?.trim();
	return override && override.length > 0 ? resolve(override) : join(resolve(cwd), RULES_FILENAME);
};

const inputDigest = (input: Record<string, unknown>): string => {
	let text: string;
	try {
		text = JSON.stringify(input);
	} catch {
		text = "[unserializable]";
	}
	return text.length > 120 ? `${text.slice(0, 120)}…` : text;
};

const statusText = (runtime: Runtime): string =>
	[
		`jev rules gate — ${runtime.enabled ? "enabled" : "disabled"}`,
		`rules: ${runtime.rules.length} (${runtime.rulesHash}) ${runtime.rulesPath}`,
		`thresholds: block ${runtime.config.blockAt} / note ${runtime.config.noteAt} · timeout ${runtime.config.timeoutMs}ms`,
		`endpoint: ${runtime.config.model} @ ${runtime.config.endpoint} (provider ${runtime.config.provider})`,
		`last model: ${runtime.lastModel ?? "—"} · last error: ${runtime.lastError ?? "—"}`,
		`checks ${runtime.stats.checks} · refusals ${runtime.stats.blocks} · cards ${runtime.stats.cards} · failed checks ${runtime.stats.failures}`,
		`breaker: ${runtime.circuit.state.disabled ? `disabled after ${runtime.circuit.state.consecutiveFailures} failures (${runtime.circuit.state.reason ?? "?"})` : `${runtime.circuit.state.consecutiveFailures}/${FAILURE_LIMIT} consecutive failures`}`,
		`audit: ${runtime.auditPath ?? "off"}`,
	].join("\n");

// =============================================================================
// Prose: the only text the agent ever sees from this extension
// =============================================================================

const escapeXml = (text: string) =>
	text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Message the model sees when the gate refuses a tool call. */
const blockReason = (hit: RuleHit, config: JevConfig): string =>
	[
		`Blocked by jev rule #${hit.rule.index + 1} (${hit.rule.line}) at p=${hit.p.toFixed(2)} (threshold ${config.blockAt}):`,
		`"${hit.rule.text}"`,
		"Revise the action so it complies, or ask the user before proceeding.",
	].join("\n");

/** Message the model sees when the gate refuses to let the run settle. */
const stopReason = (hit: RuleHit, config: JevConfig): string =>
	[
		`jev refused to finish: rule #${hit.rule.index + 1} (${hit.rule.line}) looks violated at p=${hit.p.toFixed(2)} (threshold ${config.blockAt}):`,
		`"${hit.rule.text}"`,
		"Fix the violation, then finish again. /jev off disables these checks for this session.",
	].join("\n");

/** Human-readable card body for hits that annotate instead of refusing. */
const cardNote = (site: Site, hits: RuleHit[]): string => {
	const where = site === "tool_call" ? "pending tool call" : site === "tool_result" ? "tool result" : "finished turn";
	const lines = hits.map(hit => `- rule #${hit.rule.index + 1} p=${hit.p.toFixed(2)}: ${hit.rule.text}`);
	return `jev flagged ${hits.length === 1 ? "a rule" : `${hits.length} rules`} on the ${where}:\n${lines.join("\n")}`;
};

const advisorCardPayload = (note: string, severity: "nit" | "concern", site: Site) => ({
	customType: "advisor",
	display: true,
	attribution: "agent",
	content: `<advisory advisor="jev" severity="${severity}" guidance="weigh, don't blindly obey">${escapeXml(note)}</advisory>`,
	details: { notes: [{ note, severity, advisor: "jev" }], site },
});

export default function (pi: ExtensionAPI) {
	const runtime: Runtime = {
		rulesPath: "",
		configPath: "",
		auditPath: null,
		rules: [],
		rulesHash: "",
		rulesMtimeMs: 0,
		configMtimeMs: 0,
		config: loadConfig(undefined).config,
		warnings: [],
		circuit: new CircuitBreaker(FAILURE_LIMIT),
		enabled: true,
		apiKey: null,
		toolCalls: [],
		bashCommands: [],
		touchedFiles: new Set<string>(),
		refusedRules: new Set<number>(),
		carded: new Set<string>(),
		notices: new Set<string>(),
		stats: { checks: 0, blocks: 0, cards: 0, failures: 0 },
		lastModel: null,
		lastError: null,
	};

	const notifyOnce = (ctx: ExtensionContext, key: string, message: string, kind: "info" | "warning" | "error") => {
		if (runtime.notices.has(key)) return;
		runtime.notices.add(key);
		ctx.ui.notify(message, kind);
	};

	/** Re-read rules and config when their mtimes move. Returns whether the gate has work to do. */
	const refresh = (cwd: string): boolean => {
		const rulesPath = rulesPathFor(cwd);
		const configPath = join(dirname(rulesPath), CONFIG_FILENAME);
		const rulesSnapshot = readSnapshot(rulesPath);
		const configSnapshot = readSnapshot(configPath);
		if (
			rulesPath !== runtime.rulesPath ||
			rulesSnapshot.mtimeMs !== runtime.rulesMtimeMs ||
			configSnapshot.mtimeMs !== runtime.configMtimeMs
		) {
			const loadedRules = parseRules(rulesSnapshot.text ?? "");
			let parsedConfig: unknown;
			let configWarning: string | null = null;
			if (configSnapshot.text !== null) {
				try {
					parsedConfig = JSON.parse(configSnapshot.text);
				} catch {
					configWarning = `config: ${CONFIG_FILENAME} is not valid JSON, defaults used`;
				}
			}
			const loadedConfig = loadConfig(parsedConfig);
			runtime.rules = loadedRules.rules;
			runtime.rulesHash = loadedRules.hash;
			runtime.config = loadedConfig.config;
			runtime.warnings = [...loadedRules.warnings, ...loadedConfig.warnings, ...(configWarning === null ? [] : [configWarning])];
			runtime.auditPath = loadedConfig.config.audit ? join(dirname(rulesPath), AUDIT_FILENAME) : null;
			runtime.apiKey = null;
			runtime.rulesMtimeMs = rulesSnapshot.mtimeMs;
			runtime.configMtimeMs = configSnapshot.mtimeMs;
			runtime.rulesPath = rulesPath;
			runtime.configPath = configPath;
			if (runtime.rules.length > 100) {
				runtime.warnings.push(`${runtime.rules.length} rules: every rule is asked at every site, so consider trimming`);
			}
		}
		return runtime.enabled && !runtime.circuit.state.disabled && runtime.rules.length > 0;
	};

	/** Credential from omp's auth store first, environment second: the extension never owns a key. */
	const apiKeyFor = async (ctx: ExtensionContext): Promise<string | null> => {
		const provider = runtime.config.provider;
		if (runtime.apiKey !== null && runtime.apiKey.provider === provider) return runtime.apiKey.value;
		let stored: string | null = null;
		const registry: unknown = ctx.modelRegistry;
		if (typeof registry === "object" && registry !== null && "getApiKeyForProvider" in registry) {
			const lookup = registry.getApiKeyForProvider;
			if (typeof lookup === "function") {
				const value: unknown = await Reflect.apply(lookup, registry, [provider, ctx.sessionManager.getSessionId()]);
				stored = typeof value === "string" && value.length > 0 ? value : null;
			}
		}
		const fallback = process.env[runtime.config.apiKeyEnv];
		const key = stored ?? (typeof fallback === "string" && fallback.length > 0 ? fallback : null);
		if (key !== null) runtime.apiKey = { provider, value: key };
		return key;
	};

	/** Failure policy: ask the operator when a UI exists, allow otherwise, and trip the breaker on repeats. */
	const handleFailure = async (ctx: ExtensionContext, kind: string, message: string): Promise<boolean> => {
		const breaker = runtime.circuit.recordFailure(`${kind}: ${message}`);
		if (breaker.tripped) {
			notifyOnce(
				ctx,
				"breaker",
				`jev: ${FAILURE_LIMIT} consecutive failures (${kind}) — checks disabled for this session. /jev on re-enables.`,
				"warning",
			);
		}
		if (ctx.hasUI) {
			const allow = await ctx.ui.confirm("jev unavailable", `${kind}: ${message}\n\nAllow this call without a rule check?`);
			return allow;
		}
		notifyOnce(ctx, "headless-failure", `jev: checks failing (${kind}); calls proceed unjudged.`, "warning");
		return true;
	};

	const emitCards = async (ctx: ExtensionContext, site: Site, hits: RuleHit[]): Promise<void> => {
		if (hits.length === 0) return;
		const selection = selectCards(site, hits, {
			rulesHash: runtime.rulesHash,
			config: runtime.config,
			carded: runtime.carded,
			refusedRules: runtime.refusedRules,
			sentCards: runtime.stats.cards,
		});
		const deliverAs = ctx.isIdle() ? "nextTurn" : "aside";
		appendAudit(runtime.auditPath, {
			session: ctx.sessionManager.getSessionId(),
			site,
			event: "cards",
			sent: selection.sending.map(hit => hit.rule.index),
			deduped: selection.deduped,
			suppressed: selection.suppressed,
			delivery: deliverAs,
		});
		if (selection.sending.length === 0) return;
		for (const hit of selection.sending) runtime.carded.add(cardKey(hit, runtime.rulesHash, runtime.config));
		const severity = selection.sending.some(hit => severityFor(hit, runtime.config) === "concern") ? "concern" : "nit";
		const note = cardNote(site, selection.sending);
		runtime.stats.cards += selection.sending.length;
		await pi.sendMessage(advisorCardPayload(note, severity, site), { deliverAs });
	};

	const runCheck = async (ctx: ExtensionContext, site: Site, checkState: unknown): Promise<CheckResult> => {
		// Rules can be restricted to sites; a site no rule applies to costs nothing, not even a round trip.
		if (rulesForSite(site, runtime.rules).length === 0) return { verdicts: null, refusal: null };
		const key = await apiKeyFor(ctx);
		if (key === null) {
			runtime.stats.failures += 1;
			const allowed = await handleFailure(ctx, "unauthorized", `no stored ${runtime.config.provider} credential and $${runtime.config.apiKeyEnv} is unset`);
			return {
				verdicts: null,
				refusal: allowed ? null : `jev has no credential for ${runtime.config.provider}; refusing the ${site} unjudged.`,
			};
		}
		const outcome = await requestJudgments({
			endpoint: runtime.config.endpoint,
			model: runtime.config.model,
			apiKey: key,
			state: checkState,
			questions: buildQuestions(site, runtime.rules),
			timeoutMs: runtime.config.timeoutMs,
		});
		if (!outcome.ok) {
			runtime.stats.failures += 1;
			runtime.lastError = `${outcome.kind}: ${outcome.message}`;
			appendAudit(runtime.auditPath, {
				session: ctx.sessionManager.getSessionId(),
				site,
				verdict: "error",
				error: outcome.kind,
				message: outcome.message,
				ms: outcome.latencyMs,
				rules_hash: runtime.rulesHash,
				state_preview: previewState(checkState, runtime.config.auditPreviewChars),
			});
			const allowed = await handleFailure(ctx, outcome.kind, outcome.message);
			return {
				verdicts: null,
				refusal: allowed ? null : `jev could not judge the ${site} (${outcome.kind}); refusing it while it is unchecked.`,
			};
		}
		runtime.circuit.recordSuccess();
		runtime.stats.checks += 1;
		runtime.lastModel = outcome.model;
		runtime.lastError = null;
		const verdicts = mapVerdicts(site, runtime.rules, outcome.answers, runtime.config);
		if (verdicts.block !== null) runtime.stats.blocks += 1;
		appendAudit(runtime.auditPath, {
			session: ctx.sessionManager.getSessionId(),
			site,
			p: runtime.rules.map(rule => outcome.answers[`rule_${rule.index}`]?.noul ?? null),
			verdict: verdicts.block !== null ? "block" : verdicts.cards.length > 0 ? "card" : "none",
			rule: verdicts.block?.rule.index ?? null,
			cards: verdicts.cards.map(hit => hit.rule.index),
			rules_hash: runtime.rulesHash,
			model: outcome.model,
			ms: outcome.latencyMs,
			state_preview: previewState(checkState, runtime.config.auditPreviewChars),
		});
		return { verdicts, refusal: null };
	};

	/** Accumulate what the finished-turn state needs; reset once a turn has been judged. */
	const trackToolCall = (toolName: string, input: Record<string, unknown>) => {
		runtime.toolCalls.push(`${toolName} ${inputDigest(input)}`);
		if (toolName === "bash" && typeof input.command === "string") runtime.bashCommands.push(input.command);
		for (const key of ["path", "file_path"]) {
			const value = input[key];
			if (typeof value === "string" && value.length > 0) runtime.touchedFiles.add(value);
		}
		const paths = input.paths;
		if (Array.isArray(paths)) {
			for (const path of paths) if (typeof path === "string" && path.length > 0) runtime.touchedFiles.add(path);
		}
	};

	const resetTurnTracking = () => {
		runtime.toolCalls = [];
		runtime.bashCommands = [];
		runtime.touchedFiles = new Set<string>();
	};

	pi.setLabel("jev rules gate");

	pi.on("session_start", async (_event, ctx) => {
		const ready = refresh(ctx.cwd);
		if (runtime.warnings.length > 0) {
			ctx.ui.notify(`jev: ${runtime.warnings.length} warning(s): ${runtime.warnings.slice(0, 3).join("; ")}`, "warning");
		}
		if (!ready) {
			ctx.ui.notify(`jev: no rules at ${runtime.rulesPath} — the rules gate is inert.`, "info");
			return;
		}
		ctx.ui.notify(`jev: ${runtime.rules.length} rules loaded (${runtime.rulesHash}) from ${runtime.rulesPath}`, "info");
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!refresh(ctx.cwd)) return undefined;
		const input = toRecord(event.input);
		if (!runtime.config.sites.includes("tool_call")) {
			trackToolCall(event.toolName, input);
			return undefined;
		}
		const result = await runCheck(ctx, "tool_call", toolCallState(event.toolName, input, ctx.cwd));
		if (result.refusal !== null) return { block: true, reason: result.refusal };
		if (result.verdicts?.block != null) {
			runtime.refusedRules.add(result.verdicts.block.rule.index);
			return { block: true, reason: blockReason(result.verdicts.block, runtime.config) };
		}
		// Only calls that actually execute feed the turn state: a refused command is not work the turn did.
		trackToolCall(event.toolName, input);
		if (result.verdicts !== null) await emitCards(ctx, "tool_call", result.verdicts.cards);
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!refresh(ctx.cwd)) return undefined;
		if (!runtime.config.sites.includes("tool_result")) return undefined;
		const input = toRecord(event.input);
		const checkState = toolResultState(
			event.toolName,
			input,
			textFromContent(event.content),
			ctx.cwd,
			runtime.config.maxResultChars,
		);
		const result = await runCheck(ctx, "tool_result", checkState);
		if (result.verdicts !== null) await emitCards(ctx, "tool_result", result.verdicts.cards);
		return undefined;
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!refresh(ctx.cwd)) return undefined;
		if (!runtime.config.sites.includes("turn_end")) {
			resetTurnTracking();
			return undefined;
		}
		const checkState = turnEndState({
			finalMessage: textFromContent(event.message.content),
			toolCalls: runtime.toolCalls,
			bashCommands: runtime.bashCommands,
			filesTouched: [...runtime.touchedFiles],
			maxChars: runtime.config.maxResultChars,
		});
		const result = await runCheck(ctx, "turn_end", checkState);
		if (result.verdicts !== null) await emitCards(ctx, "turn_end", result.verdicts.cards);
		resetTurnTracking();
		return undefined;
	});

	pi.on("session_stop", async (event, ctx) => {
		if (!refresh(ctx.cwd)) return undefined;
		if (!runtime.config.sites.includes("session_stop")) return undefined;
		const checkState = turnEndState({
			finalMessage: textFromContent(event.last_assistant_message?.content),
			toolCalls: runtime.toolCalls,
			bashCommands: runtime.bashCommands,
			filesTouched: [...runtime.touchedFiles],
			maxChars: runtime.config.maxResultChars,
		});
		const result = await runCheck(ctx, "session_stop", checkState);
		const hit = result.verdicts?.block ?? null;
		if (hit === null) {
			if (result.verdicts !== null) await emitCards(ctx, "session_stop", result.verdicts.cards);
			return undefined;
		}
		if (runtime.refusedRules.has(hit.rule.index)) {
			notifyOnce(
				ctx,
				`repeat-${hit.rule.index}`,
				`jev: rule #${hit.rule.index + 1} still looks violated (p=${hit.p.toFixed(2)}); not refusing the stop twice for the same rule.`,
				"warning",
			);
			return undefined;
		}
		runtime.refusedRules.add(hit.rule.index);
		return { decision: "block", reason: stopReason(hit, runtime.config) };
	});

	pi.registerCommand("jev", {
		description: "jev rules gate: on | off | status",
		handler: async (args, ctx) => {
			const command = (args ?? "").trim().toLowerCase();
			if (command === "off") {
				runtime.enabled = false;
				ctx.ui.notify("jev: checks disabled for this session.", "info");
				return;
			}
			if (command === "on") {
				runtime.enabled = true;
				runtime.circuit.reset();
				runtime.refusedRules.clear();
				runtime.carded.clear();
				runtime.notices.delete("breaker");
				refresh(ctx.cwd);
				ctx.ui.notify(`jev: enabled — ${runtime.rules.length} rules (${runtime.rulesHash}).`, "info");
				return;
			}
			if (command === "status") {
				refresh(ctx.cwd);
				ctx.ui.notify(statusText(runtime), "info");
				return;
			}
			ctx.ui.notify("Usage: /jev [on|off|status]", "info");
		},
	});
}
