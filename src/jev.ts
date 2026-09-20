import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

/**
 * The jev judgment domain: everything that turns a rules file and a moment in a session into calibrated
 * probabilities, and records what happened. Nothing here imports omp — the harness-facing half lives in
 * `jev-advisor.ts`, which keeps this file readable on its own and the harness-coupled surface small.
 */

// =============================================================================
// Config: jev-config.json knobs, validated over these defaults
// =============================================================================

export interface JevConfig {
	blockAt: number;
	noteAt: number;
	timeoutMs: number;
	maxResultChars: number;
	model: string;
	endpoint: string;
	/** omp provider id whose stored credential is used (auth store lookup). */
	provider: string;
	/** Environment fallback when no stored credential exists for the provider. */
	apiKeyEnv: string;
	audit: boolean;
	auditPreviewChars: number;
	/** Sites checked at all. `tool_result` is off by default: it re-judges a call that was already judged, and the
	 * state is the weakest of the four. */
	sites: Site[];
	/** Hard ceiling on cards per session, so a long run cannot drown in annotations (0 = no ceiling). */
	maxCards: number;
}

const DEFAULT_CONFIG: JevConfig = {
	blockAt: 0.75,
	noteAt: 0.6,
	timeoutMs: 5000,
	maxResultChars: 4000,
	model: "jev-latest",
	endpoint: "https://api.typesafe.ai/v1/systemone",
	provider: "typesafe",
	apiKeyEnv: "TYPESAFE_API_KEY",
	audit: true,
	auditPreviewChars: 300,
	sites: ["tool_call", "turn_end", "session_stop"],
	maxCards: 6,
};

interface ConfigLoad {
	config: JevConfig;
	warnings: string[];
}

const RANGES: Record<string, [number, number]> = {
	blockAt: [0, 1],
	noteAt: [0, 1],
	timeoutMs: [100, 120000],
	maxResultChars: [200, 1000000],
	auditPreviewChars: [20, 100000],
	maxCards: [0, 100],
};

const BOOLEAN_KEYS = ["audit"] as const;
const STRING_KEYS = ["model", "endpoint", "provider", "apiKeyEnv"] as const;

/** Validate a parsed config object over the defaults. Unknown keys warn; bad values keep the default. */
export function loadConfig(raw: unknown): ConfigLoad {
	const warnings: string[] = [];
	const config: JevConfig = { ...DEFAULT_CONFIG };
	if (raw === undefined) return { config, warnings };
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warnings.push("config: expected a JSON object, defaults used");
		return { config, warnings };
	}
	const record = raw as Record<string, unknown>;
	const known = new Set<string>([...Object.keys(RANGES), ...BOOLEAN_KEYS, ...STRING_KEYS, "sites"]);
	for (const key of Object.keys(record)) {
		if (!known.has(key)) warnings.push(`config: unknown key "${key}" ignored`);
	}
	for (const key of Object.keys(RANGES)) {
		const value = record[key];
		if (value === undefined) continue;
		const [min, max] = RANGES[key] ?? [0, 0];
		if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
			warnings.push(`config: "${key}" must be a number between ${min} and ${max}, default kept`);
			continue;
		}
		if (key === "blockAt") config.blockAt = value;
		else if (key === "noteAt") config.noteAt = value;
		else if (key === "timeoutMs") config.timeoutMs = Math.round(value);
		else if (key === "maxResultChars") config.maxResultChars = Math.round(value);
		else if (key === "maxCards") config.maxCards = Math.round(value);
		else config.auditPreviewChars = Math.round(value);
	}
	for (const key of BOOLEAN_KEYS) {
		const value = record[key];
		if (value === undefined) continue;
		if (typeof value !== "boolean") {
			warnings.push(`config: "${key}" must be a boolean, default kept`);
			continue;
		}
		config.audit = value;
	}
	for (const key of STRING_KEYS) {
		const value = record[key];
		if (value === undefined) continue;
		if (typeof value !== "string" || value.trim().length === 0) {
			warnings.push(`config: "${key}" must be a non-empty string, default kept`);
			continue;
		}
		config[key] = value.trim();
	}
	if (record.sites !== undefined) {
		const wanted = Array.isArray(record.sites) ? record.sites.filter((name): name is string => typeof name === "string") : [];
		if (wanted.length === 0) {
			warnings.push(`config: "sites" must be a non-empty array, defaults kept`);
		} else {
			for (const name of wanted) {
				if (!KNOWN_SITES.has(name)) warnings.push(`config: unknown site "${name}" ignored`);
			}
			const checked = wanted.filter((name): name is Site => KNOWN_SITES.has(name));
			if (checked.length === 0) warnings.push(`config: no known sites in "sites", defaults kept`);
			else config.sites = [...new Set(checked)];
		}
	}
	if (config.noteAt > config.blockAt) {
		warnings.push(`config: noteAt (${config.noteAt}) is above blockAt (${config.blockAt}); blocking still uses blockAt`);
	}
	return { config, warnings };
}

// =============================================================================
// Sites: where a judgment can happen, and which of them are checked
// =============================================================================

export type Site = "tool_call" | "tool_result" | "turn_end" | "session_stop";

const ALL_SITES: Site[] = ["tool_call", "tool_result", "turn_end", "session_stop"];

const KNOWN_SITES = new Set<string>(ALL_SITES);

// =============================================================================
// Rules: one JSON object per line, every bad line reported rather than dropped
// =============================================================================

/** One parsed `jev-rules.jsonl` line. `index` is the question id jev answers against. */
export interface Rule {
	index: number;
	line: number;
	text: string;
	block: boolean;
	/** Sites this rule is judged at; null means every checked site. */
	sites: Site[] | null;
}

interface RulesLoad {
	rules: Rule[];
	warnings: string[];
	hash: string;
}

const KNOWN_KEYS = new Set(["rule", "block", "sites"]);

/** Parse the rules file. Blank lines are skipped; every bad line is reported, never silently dropped. */
export function parseRules(jsonl: string): RulesLoad {
	const rules: Rule[] = [];
	const warnings: string[] = [];
	const lines = jsonl.split("\n");
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
		const raw = (lines[lineIndex] ?? "").trim();
		if (raw.length === 0) continue;
		const lineNumber = lineIndex + 1;
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			warnings.push(`line ${lineNumber}: not valid JSON, skipped`);
			continue;
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			warnings.push(`line ${lineNumber}: expected an object, skipped`);
			continue;
		}
		const record = parsed as Record<string, unknown>;
		if (typeof record.rule !== "string" || record.rule.trim().length === 0) {
			warnings.push(`line ${lineNumber}: missing a non-empty "rule" string, skipped`);
			continue;
		}
		if (record.block !== undefined && typeof record.block !== "boolean") {
			warnings.push(`line ${lineNumber}: "block" must be a boolean, treated as false`);
		}
		for (const key of Object.keys(record)) {
			if (!KNOWN_KEYS.has(key)) warnings.push(`line ${lineNumber}: unknown key "${key}" ignored`);
		}
		let sites: Site[] | null = null;
		if (record.sites !== undefined) {
			if (!Array.isArray(record.sites)) {
				warnings.push(`line ${lineNumber}: "sites" must be an array of site names, judged at every site`);
			} else {
				const wanted = record.sites.filter((name): name is string => typeof name === "string");
				for (const name of wanted) {
					if (!KNOWN_SITES.has(name)) warnings.push(`line ${lineNumber}: unknown site "${name}" ignored`);
				}
				const known = wanted.filter((name): name is Site => KNOWN_SITES.has(name));
				sites = known.length > 0 ? [...new Set(known)] : null;
				if (sites === null) warnings.push(`line ${lineNumber}: no known sites in "sites", judged at every site`);
			}
		}
		rules.push({
			index: rules.length,
			line: lineNumber,
			text: record.rule.trim(),
			block: record.block === true,
			sites,
		});
	}
	const hash = createHash("sha256")
		.update(rules.map(rule => `${rule.block ? "block" : "note"}\t${rule.sites?.join(",") ?? "*"}\t${rule.text}`).join("\n"))
		.digest("hex")
		.slice(0, 12);
	return { rules, warnings, hash };
}

// =============================================================================
// State and questions: what the judge sees at each site
// =============================================================================

/** The question jev answers. The subject lives in the question, the payload stays pure in `state`. */
function questionFor(site: Site, rule: string): string {
	const text = rule.trim().replace(/\?+$/, "");
	if (site === "tool_call") return `Would executing this tool call violate this rule: ${text}?`;
	if (site === "tool_result") return `Did the agent violate this rule: ${text}? (the tool call and its result are in the state)`;
	return `Did the agent violate this rule: ${text}? (the turn that just ended is in the state)`;
}

/** The rules that apply at one site: an unrestricted rule everywhere, a restricted one only where it can be judged. */
export function rulesForSite(site: Site, rules: Rule[]): Rule[] {
	return rules.filter(rule => rule.sites === null || rule.sites.includes(site));
}

export function buildQuestions(site: Site, rules: Rule[]): Record<string, NoulQuestion> {
	const questions: Record<string, NoulQuestion> = {};
	for (const rule of rulesForSite(site, rules)) {
		questions[`rule_${rule.index}`] = { type: "noul", instructions: questionFor(site, rule.text) };
	}
	return questions;
}

export function toRecord(value: unknown): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	return { value };
}

/** Text of a message/tool-result content field: text blocks join, images become markers, reasoning is dropped. */
export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const entry = block as Record<string, unknown>;
		if (typeof entry.text === "string") parts.push(entry.text);
		else if (entry.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

export function toolCallState(tool: string, input: Record<string, unknown>, cwd: string): Record<string, unknown> {
	return { tool, input, cwd };
}

export function toolResultState(
	tool: string,
	input: Record<string, unknown>,
	result: string,
	cwd: string,
	maxChars: number,
): Record<string, unknown> {
	const clipped =
		result.length > maxChars ? `${result.slice(0, maxChars)}\n[truncated ${result.length - maxChars} chars]` : result;
	return { tool, input, result: clipped, cwd };
}

interface TurnStateInput {
	finalMessage: string;
	toolCalls: string[];
	bashCommands: string[];
	filesTouched: string[];
	maxChars: number;
}

export function turnEndState(input: TurnStateInput): Record<string, unknown> {
	const clip = (value: string) =>
		value.length > input.maxChars ? `${value.slice(0, input.maxChars)}\n[truncated ${value.length - input.maxChars} chars]` : value;
	return {
		final_message: clip(input.finalMessage),
		tool_calls: input.toolCalls.slice(-40),
		bash_commands: input.bashCommands.slice(-20),
		files_touched: [...input.filesTouched].slice(-40),
	};
}

// =============================================================================
// Transport: one batched call that never throws
// =============================================================================

type JudgmentKind = "timeout" | "rate_limited" | "unauthorized" | "bad_request" | "malformed" | "network" | "server";

interface NoulQuestion {
	type: "noul";
	instructions: string;
}

interface JudgmentAnswer {
	type?: string;
	noul?: number;
}

type JudgmentOutcome =
	| { ok: true; answers: Record<string, JudgmentAnswer>; model: string | null; latencyMs: number }
	| { ok: false; kind: JudgmentKind; status?: number; message: string; latencyMs: number };

interface JudgmentRequest {
	endpoint: string;
	model: string;
	apiKey: string;
	state: unknown;
	questions: Record<string, NoulQuestion>;
	timeoutMs: number;
	fetchImpl?: typeof fetch;
}

const classifyStatus = (status: number): JudgmentKind => {
	if (status === 429) return "rate_limited";
	if (status === 401 || status === 403) return "unauthorized";
	if (status >= 500) return "server";
	return "bad_request";
};

/** Answers must be an object of `{ noul: number }` entries; anything else is a malformed response. */
const extractAnswers = (parsed: unknown): Record<string, JudgmentAnswer> | null => {
	if (typeof parsed !== "object" || parsed === null) return null;
	const answers = (parsed as Record<string, unknown>).answers;
	if (typeof answers !== "object" || answers === null || Array.isArray(answers)) return null;
	const out: Record<string, JudgmentAnswer> = {};
	for (const [key, value] of Object.entries(answers)) {
		if (typeof value !== "object" || value === null) return null;
		const entry = value as Record<string, unknown>;
		if (typeof entry.noul !== "number" || !Number.isFinite(entry.noul)) return null;
		out[key] = { type: typeof entry.type === "string" ? entry.type : undefined, noul: entry.noul };
	}
	return out;
};

const readModel = (parsed: unknown): string | null => {
	if (typeof parsed !== "object" || parsed === null) return null;
	const model = (parsed as Record<string, unknown>).model;
	return typeof model === "string" ? model : null;
};

/** One batched judgment call. Never throws: every failure becomes a typed outcome. */
export async function requestJudgments(request: JudgmentRequest): Promise<JudgmentOutcome> {
	const doFetch = request.fetchImpl ?? fetch;
	const started = Date.now();
	const elapsed = () => Date.now() - started;
	try {
		const response = await doFetch(request.endpoint, {
			method: "POST",
			headers: { Authorization: `Bearer ${request.apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ model: request.model, state: request.state, questions: request.questions }),
			signal: AbortSignal.timeout(request.timeoutMs),
		});
		const text = await response.text();
		if (!response.ok) {
			return {
				ok: false,
				kind: classifyStatus(response.status),
				status: response.status,
				message: `HTTP ${response.status}: ${text.slice(0, 200)}`,
				latencyMs: elapsed(),
			};
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return { ok: false, kind: "malformed", status: response.status, message: text.slice(0, 200), latencyMs: elapsed() };
		}
		const answers = extractAnswers(parsed);
		if (answers === null) {
			return {
				ok: false,
				kind: "malformed",
				status: response.status,
				message: `no numeric answers in ${text.slice(0, 200)}`,
				latencyMs: elapsed(),
			};
		}
		return { ok: true, answers, model: readModel(parsed), latencyMs: elapsed() };
	} catch (err) {
		if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
			return { ok: false, kind: "timeout", message: `no answer within ${request.timeoutMs}ms`, latencyMs: elapsed() };
		}
		return {
			ok: false,
			kind: "network",
			message: err instanceof Error ? err.message : String(err),
			latencyMs: elapsed(),
		};
	}
}

// =============================================================================
// Verdicts: probabilities in, decisions out
// =============================================================================

export interface RuleHit {
	rule: Rule;
	p: number;
}

export interface Verdicts {
	/** Every rule at or above `noteAt`. */
	hits: RuleHit[];
	/** Highest-probability blocking hit, when the site can refuse and the rule asks for it. */
	block: RuleHit | null;
	/** Hits worth a card: all hits minus the one already delivered as a refusal. */
	cards: RuleHit[];
}

const CAN_REFUSE = new Set<Site>(["tool_call", "session_stop"]);

/** A block:true rule only refuses where refusing is possible (pre-execution, or before the run settles). */
export function mapVerdicts(
	site: Site,
	rules: Rule[],
	answers: Record<string, JudgmentAnswer>,
	config: JevConfig,
): Verdicts {
	const hits: RuleHit[] = [];
	for (const rule of rulesForSite(site, rules)) {
		const p = answers[`rule_${rule.index}`]?.noul;
		if (typeof p === "number" && Number.isFinite(p) && p >= config.noteAt) hits.push({ rule, p });
	}
	hits.sort((a, b) => b.p - a.p);
	let block: RuleHit | null = null;
	if (CAN_REFUSE.has(site)) {
		for (const hit of hits) {
			if (hit.rule.block && hit.p >= config.blockAt) {
				block = hit;
				break;
			}
		}
	}
	const cards = hits.filter(hit => hit !== block);
	return { hits, block, cards };
}

export function severityFor(hit: RuleHit, config: JevConfig): "nit" | "concern" {
	return hit.p >= config.blockAt ? "concern" : "nit";
}

/** Identity of one delivered annotation: same rule at the same severity in the same rules revision. */
export function cardKey(hit: RuleHit, rulesHash: string, config: JevConfig): string {
	return `${rulesHash}:${hit.rule.index}:${severityFor(hit, config)}`;
}

interface CardSelection {
	/** Annotations worth delivering now. */
	sending: RuleHit[];
	/** Hits dropped as repeats: already sent, or already refused by their rule. */
	deduped: number[];
	/** Hits held back: a nit mid-run, or over the session ceiling. */
	suppressed: number[];
}

interface CardState {
	rulesHash: string;
	config: JevConfig;
	carded: Set<string>;
	refusedRules: Set<number>;
	sentCards: number;
}

/**
 * Which hits become cards. An annotation mid-run interrupts work for a judgment call, so only a concern earns
 * that; nits wait for a boundary where the agent is deciding something. Repeats never repeat, and a session
 * ceiling keeps a long run from drowning in notes.
 */
export function selectCards(site: Site, hits: RuleHit[], state: CardState): CardSelection {
	const deduped = hits.filter(hit => state.refusedRules.has(hit.rule.index) || state.carded.has(cardKey(hit, state.rulesHash, state.config)));
	const fresh = hits.filter(hit => !deduped.includes(hit));
	const midRun = site === "tool_call" || site === "tool_result";
	const held = fresh.filter(hit => midRun && severityFor(hit, state.config) === "nit");
	const worth = fresh.filter(hit => !held.includes(hit));
	const room = state.config.maxCards > 0 ? Math.max(0, state.config.maxCards - state.sentCards) : worth.length;
	return {
		sending: worth.slice(0, room),
		deduped: deduped.map(hit => hit.rule.index),
		suppressed: [...held, ...worth.slice(room)].map(hit => hit.rule.index),
	};
}

// =============================================================================
// Audit: append-only JSONL next to the rules file
// =============================================================================

/** Append one audit row. Audit failures never break a check. */
export function appendAudit(path: string | null, row: Record<string, unknown>): void {
	if (path === null) return;
	try {
		appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`);
	} catch {}
}

/** Compact state preview for the audit trail: enough to replay a judgment, short enough to not leak whole files. */
export function previewState(state: unknown, maxChars: number): string {
	let text: string;
	try {
		text = typeof state === "string" ? state : JSON.stringify(state);
	} catch {
		text = "[unserializable state]";
	}
	return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

// =============================================================================
// Circuit breaker: consecutive failures latch the gate off for the session
// =============================================================================

interface CircuitState {
	consecutiveFailures: number;
	disabled: boolean;
	reason: string | null;
}

export class CircuitBreaker {
	readonly limit: number;

	#state: CircuitState = { consecutiveFailures: 0, disabled: false, reason: null };

	constructor(limit = 3) {
		this.limit = limit;
	}

	get state(): CircuitState {
		return { ...this.#state };
	}

	recordSuccess(): void {
		this.#state = { consecutiveFailures: 0, disabled: this.#state.disabled, reason: this.#state.reason };
	}

	/** Returns whether this failure disabled the gate, and whether it did so right now. */
	recordFailure(reason: string): { tripped: boolean; disabled: boolean } {
		const consecutiveFailures = this.#state.consecutiveFailures + 1;
		const tripped = !this.#state.disabled && consecutiveFailures >= this.limit;
		const disabled = this.#state.disabled || tripped;
		this.#state = {
			consecutiveFailures,
			disabled,
			reason: disabled ? (this.#state.reason ?? reason) : null,
		};
		return { tripped, disabled };
	}

	reset(): void {
		this.#state = { consecutiveFailures: 0, disabled: false, reason: null };
	}
}
