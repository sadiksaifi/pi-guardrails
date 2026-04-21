import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { lstat, realpath } from "node:fs/promises";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type PermissionMode = "default" | "full-access";
export type GuardrailsClassification =
  | "allow"
  | "ask"
  | "deny"
  | "safety"
  | "direct-interaction-required"
  | "explicit-ask";

export interface GuardrailsToolContext {
  cwd: string;
  permissions: PermissionMode;
}

export interface GuardrailsToolContract<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> {
  classify(
    input: TInput,
    context: GuardrailsToolContext,
  ): GuardrailsClassification | Promise<GuardrailsClassification>;
  getScopeCandidate?(
    input: TInput,
    context: GuardrailsToolContext,
  ): string | undefined | Promise<string | undefined>;
  matchesScope?(
    grant: string,
    input: TInput,
    context: GuardrailsToolContext,
  ): boolean | Promise<boolean>;
}

export interface GuardrailsToolRegistration {
  toolName: string;
  contract: GuardrailsToolContract;
}

export interface GuardrailsControllerOptions {
  cwd: string;
  initialPermissions?: PermissionMode;
}

export interface GuardrailsDecisionInput {
  toolName: string;
  input: Record<string, unknown>;
}

export type PermissionDecision =
  | {
      outcome: "allow";
      classification: Extract<GuardrailsClassification, "allow" | "ask">;
      reason: "policy" | "full-access" | "scoped-grant";
      scopeCandidate?: string;
    }
  | {
      outcome: "block";
      classification: "deny";
      reason: string;
    }
  | {
      outcome: "prompt";
      classification: Exclude<GuardrailsClassification, "allow" | "deny">;
      promptKind: "normal" | "strict";
      title: string;
      options: string[];
      summary: string;
      scopeCandidate?: string;
    };

export interface ExtensionRegistration {
  commands: Array<{ name: string; description?: string }>;
  flags: Array<{
    name: string;
    description?: string;
    type: string;
    defaultValue?: boolean | string;
  }>;
  shortcuts: Array<{ shortcut: string; description?: string }>;
  handlers: Array<{ event: string; handler: unknown }>;
  events: {
    emit(channel: string, data: unknown): void;
    on(channel: string, handler: (data: unknown) => void): () => void;
  };
}

interface ScopedGrant {
  toolName: string;
  scope: string;
}

interface CanonicalTarget {
  canonicalPath: string;
  parentDir: string;
  hadTraversal: boolean;
  outsideCwd: boolean;
  candidates: string[];
}

interface PathRule {
  include: string[];
  exclude?: string[];
}

interface ParsedShellCommand {
  tokens: string[];
  complex: boolean;
}

export const NORMAL_PROMPT_TITLE = "Do you want to allow this action?";
export const STRICT_PROMPT_TITLE = "Do you want to allow this sensitive action?";
export const PERMISSIONS_SELECTOR_TITLE = "What permissions do you want for this session?";
export const PERMISSIONS_EVENT_CHANNEL = "pi-guardrails:register-tool-contract";

const BUILT_IN_READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls"]);
const SAFETY_PATH_RULES: PathRule[] = [
  { include: [".pi/**", ".agents/**", "AGENTS.md", "CLAUDE.md", "SYSTEM.md", "APPEND_SYSTEM.md"] },
  { include: [".git/**"] },
  { include: [".env", ".env.*"], exclude: [".env.example"] },
  {
    include: [
      ".npmrc",
      ".netrc",
      ".pypirc",
      ".aws/**",
      ".ssh/**",
      "*.pem",
      "*.key",
      "*.p12",
      "*.pfx",
    ],
  },
  { include: ["node_modules/**"] },
  { include: ["~/.bashrc", "~/.zshrc", "~/.profile", "~/.config/**"] },
];
const SIMPLE_READ_ONLY_BASH_COMMANDS = new Set([
  "pwd",
  "ls",
  "find",
  "fd",
  "cat",
  "head",
  "tail",
  "grep",
  "rg",
  "which",
  "whereis",
  "type",
  "file",
  "stat",
  "du",
  "wc",
]);
const ALWAYS_INTERACTIVE_BASH_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "fish",
  "vim",
  "nvim",
  "nano",
  "less",
  "more",
  "man",
  "top",
  "htop",
  "watch",
]);
const REPL_LIKE_COMMANDS = new Set(["python", "ipython", "node", "sqlite3"]);
const SQL_REPL_COMMANDS = new Set(["psql", "mysql"]);
const DANGEROUS_BASH_COMMANDS = new Set(["sudo", "rm", "chmod", "chown"]);
const SCOPEABLE_SINGLE_COMMANDS = new Set(["mkdir", "touch", "cp", "mv"]);
const SCOPEABLE_GIT_SUBCOMMANDS = new Set(["add", "commit", "checkout", "switch", "restore"]);
const DANGEROUS_POWERSHELL_PATTERNS = [
  /\bRemove-Item\b/i,
  /\bSet-Content\b/i,
  /\bAdd-Content\b/i,
  /\bClear-Content\b/i,
  /\bInvoke-Expression\b/i,
  /\bStart-Process\b/i,
  /\bStop-Process\b/i,
];

export function isPermissionMode(value: string | undefined): value is PermissionMode {
  return value === "default" || value === "full-access";
}

function normalizeForGlob(value: string): string {
  return value.replaceAll("\\", "/");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!;
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      continue;
    }

    source += escapeRegExp(char);
  }

  source += "$";
  return new RegExp(source);
}

function matchesGlob(pattern: string, candidates: readonly string[]): boolean {
  const matcher = globToRegExp(normalizeForGlob(pattern));
  return candidates.some((candidate) => matcher.test(normalizeForGlob(candidate)));
}

function matchesPathRule(rule: PathRule, candidates: readonly string[]): boolean {
  const included = rule.include.some((pattern) => matchesGlob(pattern, candidates));
  if (!included) return false;

  return !(rule.exclude ?? []).some((pattern) => matchesGlob(pattern, candidates));
}

function isSameOrDescendant(path: string, parent: string): boolean {
  const relativePath = relative(parent, path);
  return relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== "..");
}

function splitSegments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

function hasTraversalSegments(path: string): boolean {
  return splitSegments(path).includes("..");
}

function expandHomePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith(`~${sep}`)) return join(homedir(), path.slice(2));
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function findExistingProbe(
  path: string,
  missingSegments: string[] = [],
): Promise<{ probe: string; missingSegments: string[] }> {
  if (await pathExists(path)) {
    return { probe: path, missingSegments };
  }

  const parent = dirname(path);
  if (parent === path) {
    return { probe: path, missingSegments };
  }

  return findExistingProbe(parent, [basename(path), ...missingSegments]);
}

async function resolveCanonicalTarget(cwd: string, rawPath: string): Promise<CanonicalTarget> {
  const expanded = expandHomePath(rawPath);
  const absoluteInput = isAbsolute(expanded) ? normalize(expanded) : resolve(cwd, expanded);

  const { probe, missingSegments } = await findExistingProbe(absoluteInput);
  const canonicalBase = await realpath(probe);
  const canonicalPath = normalize(join(canonicalBase, ...missingSegments));
  const parentDir = dirname(canonicalPath);
  const canonicalCwd = await realpath(cwd);
  const canonicalHome = normalize(await realpath(homedir()));
  const candidates = buildPathCandidates(canonicalPath, canonicalCwd, canonicalHome);

  return {
    canonicalPath,
    parentDir,
    hadTraversal: hasTraversalSegments(rawPath),
    outsideCwd: !isSameOrDescendant(canonicalPath, canonicalCwd),
    candidates,
  };
}

function buildPathCandidates(path: string, canonicalCwd: string, canonicalHome: string): string[] {
  const normalizedPath = normalize(path);
  const candidates = new Set<string>([normalizedPath, basename(normalizedPath)]);

  if (isSameOrDescendant(normalizedPath, canonicalCwd)) {
    const relativePath = normalizeForGlob(relative(canonicalCwd, normalizedPath)) || ".";
    candidates.add(relativePath);
  }

  if (isSameOrDescendant(normalizedPath, canonicalHome)) {
    const homeRelative = normalizeForGlob(relative(canonicalHome, normalizedPath));
    candidates.add(homeRelative === "" ? "~" : `~/${homeRelative}`);
  }

  return [...candidates];
}

function isProtectedPath(target: CanonicalTarget): boolean {
  return SAFETY_PATH_RULES.some((rule) => matchesPathRule(rule, target.candidates));
}

function getDirectoryScope(toolName: "edit" | "write", target: CanonicalTarget): string {
  return `${toolName}:dir:${target.parentDir}`;
}

function buildNormalPrompt(
  summary: string,
  scopeCandidate: string | undefined,
): PermissionDecision {
  return {
    outcome: "prompt",
    classification: "ask",
    promptKind: "normal",
    title: NORMAL_PROMPT_TITLE,
    options: scopeCandidate
      ? ["Yes", `Yes, ${scopeCandidate} during this session`, "No"]
      : ["Yes", "No"],
    summary,
    scopeCandidate,
  };
}

function buildStrictPrompt(
  summary: string,
  classification: Extract<
    GuardrailsClassification,
    "safety" | "direct-interaction-required" | "explicit-ask"
  >,
): PermissionDecision {
  return {
    outcome: "prompt",
    classification,
    promptKind: "strict",
    title: STRICT_PROMPT_TITLE,
    options: ["Yes", "No"],
    summary,
  };
}

function parseShellCommand(command: string): ParsedShellCommand {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  const flush = () => {
    if (current.length === 0) return;
    tokens.push(current);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    const next = command[index + 1];

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (!quote) {
      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }

      if (
        char === "`" ||
        char === ";" ||
        char === "|" ||
        char === "&" ||
        char === ">" ||
        char === "<" ||
        char === "(" ||
        char === ")" ||
        (char === "$" && next === "(")
      ) {
        flush();
        return { tokens, complex: true };
      }

      if (/\s/.test(char)) {
        flush();
        continue;
      }

      current += char;
      continue;
    }

    if (char === quote) {
      quote = undefined;
      continue;
    }

    current += char;
  }

  flush();

  if (quote || escaping) {
    return { tokens, complex: true };
  }

  return { tokens, complex: false };
}

function hasGroupedFlag(flagSet: readonly string[], token: string): boolean {
  if (flagSet.includes(token)) return true;
  if (!token.startsWith("-") || token.startsWith("--") || token.length < 3) return false;
  const grouped = new Set(token.slice(1).split(""));
  return flagSet.some((flag) => flag.startsWith("-") && flag.length === 2 && grouped.has(flag[1]!));
}

function isReadOnlyGitCommand(tokens: readonly string[]): boolean {
  if (tokens[0] !== "git") return false;
  const subcommand = tokens[1];

  if (
    subcommand === "status" ||
    subcommand === "diff" ||
    subcommand === "log" ||
    subcommand === "show"
  ) {
    return true;
  }

  return subcommand === "branch" && tokens.includes("--show-current");
}

function isInteractiveBashCommand(tokens: readonly string[]): boolean {
  const command = tokens[0];
  if (!command) return false;
  if (ALWAYS_INTERACTIVE_BASH_COMMANDS.has(command)) return true;
  if (REPL_LIKE_COMMANDS.has(command)) return tokens.length === 1;
  if (command === "bun") return tokens[1] === "repl";
  if (command === "deno") return tokens[1] === "repl";
  if (SQL_REPL_COMMANDS.has(command)) return tokens.length === 1;

  if (command === "ssh") {
    const hostArgs = tokens.slice(1).filter((token) => !token.startsWith("-"));
    return hostArgs.length <= 1;
  }

  return false;
}

function getBashScopeCandidate(tokens: readonly string[]): string | undefined {
  if (tokens.length === 0) return undefined;
  const command = tokens[0]!;

  if (SCOPEABLE_SINGLE_COMMANDS.has(command)) {
    return `shell:prefix:${command}:*`;
  }

  if (command === "git" && tokens[1] && SCOPEABLE_GIT_SUBCOMMANDS.has(tokens[1])) {
    return `shell:prefix:git ${tokens[1]}:*`;
  }

  if (command === "bun" && tokens[1] && ["add", "remove", "install", "run"].includes(tokens[1])) {
    return `shell:prefix:bun ${tokens[1]}:*`;
  }

  return undefined;
}

function isReadOnlyBashCommand(parsed: ParsedShellCommand): boolean {
  if (parsed.complex || parsed.tokens.length === 0) return false;
  const command = parsed.tokens[0]!;

  if (command.includes("=") && parsed.tokens.length > 1) {
    return false;
  }

  if (parsed.tokens.includes("tee")) {
    return false;
  }

  return SIMPLE_READ_ONLY_BASH_COMMANDS.has(command) || isReadOnlyGitCommand(parsed.tokens);
}

function getNonOptionArgs(tokens: readonly string[], startIndex: number): string[] {
  return tokens.slice(startIndex).filter((token) => !token.startsWith("-"));
}

function getMutationTargets(tokens: readonly string[]): string[] {
  const command = tokens[0];
  if (!command) return [];

  if (command === "mkdir" || command === "touch" || command === "rm" || command === "rmdir") {
    return getNonOptionArgs(tokens, 1);
  }

  if (command === "cp") {
    const operands = getNonOptionArgs(tokens, 1);
    return operands.length === 0 ? [] : [operands[operands.length - 1]!];
  }

  if (command === "mv") {
    return getNonOptionArgs(tokens, 1);
  }

  if (command === "chmod" || command === "chown") {
    const operands = getNonOptionArgs(tokens, 1);
    return operands.slice(1);
  }

  return [];
}

function isRecursiveRm(tokens: readonly string[]): boolean {
  return tokens.some(
    (token) => hasGroupedFlag(["-r", "-R", "-f"], token) || token === "--recursive",
  );
}

async function classifyBashTargets(cwd: string, tokens: readonly string[]) {
  const targets = getMutationTargets(tokens);
  const resolvedTargets = await Promise.all(
    targets.map((target) => resolveCanonicalTarget(cwd, target)),
  );

  return {
    resolvedTargets,
  };
}

function isCatastrophicTarget(path: string, cwd: string): boolean {
  const rootPath = dirname(path) === path;
  if (rootPath) return true;
  if (path === cwd) return true;
  if (path === homedir()) return true;
  const name = basename(path);
  return name === ".git" || name === ".pi" || name === ".agents";
}

function extractRedirectionTarget(command: string): string | undefined {
  const match = command.match(/(?:^|\s)(?:>>|>)\s*([^\s]+)/);
  return match?.[1];
}

export function registerGuardrailsToolContract(
  events: Pick<ExtensionAPI, "events"> | Pick<ExtensionRegistration, "events">,
  registration: GuardrailsToolRegistration,
): void {
  events.events.emit(PERMISSIONS_EVENT_CHANNEL, registration);
}

export class GuardrailsController {
  private permissions: PermissionMode;
  private readonly cwd: string;
  private readonly scopedGrants: ScopedGrant[] = [];
  private readonly toolContracts = new Map<string, GuardrailsToolContract>();

  constructor(options: GuardrailsControllerOptions) {
    this.cwd = options.cwd;
    this.permissions = options.initialPermissions ?? "default";
  }

  getPermissions(): PermissionMode {
    return this.permissions;
  }

  setPermissions(value: PermissionMode): void {
    this.permissions = value;
  }

  togglePermissions(): PermissionMode {
    this.permissions = this.permissions === "default" ? "full-access" : "default";
    return this.permissions;
  }

  registerToolContract(registration: GuardrailsToolRegistration): void {
    this.toolContracts.set(registration.toolName, registration.contract);
  }

  addScopedGrant(toolName: string, scope: string): void {
    this.scopedGrants.push({ toolName, scope });
  }

  clearScopedGrants(): void {
    this.scopedGrants.length = 0;
  }

  async decide(input: GuardrailsDecisionInput): Promise<PermissionDecision> {
    if (BUILT_IN_READ_ONLY_TOOLS.has(input.toolName)) {
      return {
        outcome: "allow",
        classification: "allow",
        reason: "policy",
      };
    }

    if (input.toolName === "write") {
      return this.decideFileMutation("write", input.input);
    }

    if (input.toolName === "edit") {
      return this.decideFileMutation("edit", input.input);
    }

    if (input.toolName === "bash") {
      return this.decideBash(input.input);
    }

    const contract = this.toolContracts.get(input.toolName);
    if (!contract) {
      return buildStrictPrompt(input.toolName, "explicit-ask");
    }

    const context: GuardrailsToolContext = {
      cwd: this.cwd,
      permissions: this.permissions,
    };
    const classification = await contract.classify(input.input, context);

    if (classification === "allow") {
      return {
        outcome: "allow",
        classification,
        reason: "policy",
      };
    }

    if (classification === "deny") {
      return {
        outcome: "block",
        classification,
        reason: `Blocked by pi-guardrails: ${input.toolName}`,
      };
    }

    if (
      classification === "safety" ||
      classification === "direct-interaction-required" ||
      classification === "explicit-ask"
    ) {
      return buildStrictPrompt(input.toolName, classification);
    }

    const scopeCandidate = await contract.getScopeCandidate?.(input.input, context);
    if (
      await this.matchesCustomGrant(input.toolName, scopeCandidate, input.input, contract, context)
    ) {
      return {
        outcome: "allow",
        classification,
        reason: "scoped-grant",
        scopeCandidate,
      };
    }

    if (this.permissions === "full-access") {
      return {
        outcome: "allow",
        classification,
        reason: "full-access",
        scopeCandidate,
      };
    }

    return buildNormalPrompt(input.toolName, scopeCandidate);
  }

  private async decideFileMutation(
    toolName: "edit" | "write",
    input: Record<string, unknown>,
  ): Promise<PermissionDecision> {
    const rawPath = typeof input.path === "string" ? input.path : ".";
    const summary = `${toolName} ${rawPath}`;
    const target = await resolveCanonicalTarget(this.cwd, rawPath);

    if (target.hadTraversal || target.outsideCwd || isProtectedPath(target)) {
      return buildStrictPrompt(summary, "safety");
    }

    const scopeCandidate = getDirectoryScope(toolName, target);
    if (this.permissions === "full-access") {
      return {
        outcome: "allow",
        classification: "ask",
        reason: "full-access",
        scopeCandidate,
      };
    }

    if (this.hasBuiltInGrant(toolName, target.parentDir)) {
      return {
        outcome: "allow",
        classification: "ask",
        reason: "scoped-grant",
        scopeCandidate,
      };
    }

    return buildNormalPrompt(summary, scopeCandidate);
  }

  private async decideBash(input: Record<string, unknown>): Promise<PermissionDecision> {
    const command = typeof input.command === "string" ? input.command : "";
    const summary = `bash ${command}`.trim();
    const parsed = parseShellCommand(command);
    const firstToken = parsed.tokens[0];

    if (!firstToken) {
      return buildNormalPrompt(summary, undefined);
    }

    if (isInteractiveBashCommand(parsed.tokens)) {
      return buildStrictPrompt(summary, "direct-interaction-required");
    }

    if (
      (firstToken === "powershell" || firstToken === "pwsh") &&
      DANGEROUS_POWERSHELL_PATTERNS.some((pattern) => pattern.test(command))
    ) {
      return buildStrictPrompt(summary, "safety");
    }

    if (DANGEROUS_BASH_COMMANDS.has(firstToken)) {
      if (firstToken === "sudo") {
        return buildStrictPrompt(summary, "safety");
      }

      const { resolvedTargets } = await classifyBashTargets(this.cwd, parsed.tokens);
      if (firstToken === "rm" && isRecursiveRm(parsed.tokens)) {
        const canonicalCwd = await realpath(this.cwd);
        for (const target of resolvedTargets) {
          if (isCatastrophicTarget(target.canonicalPath, canonicalCwd)) {
            return {
              outcome: "block",
              classification: "deny",
              reason: `Blocked by pi-guardrails: ${command}`,
            };
          }
        }
      }

      return buildStrictPrompt(summary, "safety");
    }

    const redirectionTarget = extractRedirectionTarget(command);
    if (redirectionTarget) {
      const target = await resolveCanonicalTarget(this.cwd, redirectionTarget);
      if (target.hadTraversal || target.outsideCwd || isProtectedPath(target)) {
        return buildStrictPrompt(summary, "safety");
      }
    }

    if (!parsed.complex) {
      const { resolvedTargets } = await classifyBashTargets(this.cwd, parsed.tokens);
      if (
        resolvedTargets.some(
          (target) => target.hadTraversal || target.outsideCwd || isProtectedPath(target),
        )
      ) {
        return buildStrictPrompt(summary, "safety");
      }
    }

    if (isReadOnlyBashCommand(parsed)) {
      return {
        outcome: "allow",
        classification: "allow",
        reason: "policy",
      };
    }

    const scopeCandidate = parsed.complex ? undefined : getBashScopeCandidate(parsed.tokens);
    if (scopeCandidate && this.hasExactGrant("bash", scopeCandidate)) {
      return {
        outcome: "allow",
        classification: "ask",
        reason: "scoped-grant",
        scopeCandidate,
      };
    }

    if (this.permissions === "full-access") {
      return {
        outcome: "allow",
        classification: "ask",
        reason: "full-access",
        scopeCandidate,
      };
    }

    return buildNormalPrompt(summary, scopeCandidate);
  }

  private hasBuiltInGrant(toolName: "edit" | "write", targetDir: string): boolean {
    const prefix = `${toolName}:dir:`;

    return this.scopedGrants.some((grant) => {
      if (grant.toolName !== toolName || !grant.scope.startsWith(prefix)) return false;
      const grantedDir = grant.scope.slice(prefix.length);
      return isSameOrDescendant(targetDir, grantedDir);
    });
  }

  private hasExactGrant(toolName: string, scope: string): boolean {
    return this.scopedGrants.some((grant) => grant.toolName === toolName && grant.scope === scope);
  }

  private async matchesCustomGrant(
    toolName: string,
    scopeCandidate: string | undefined,
    input: Record<string, unknown>,
    contract: GuardrailsToolContract,
    context: GuardrailsToolContext,
  ): Promise<boolean> {
    const toolGrants = this.scopedGrants.filter((grant) => grant.toolName === toolName);
    if (toolGrants.length === 0) return false;

    if (contract.matchesScope) {
      const matches = await Promise.all(
        toolGrants.map((grant) => contract.matchesScope!(grant.scope, input, context)),
      );
      return matches.includes(true);
    }

    return scopeCandidate ? toolGrants.some((grant) => grant.scope === scopeCandidate) : false;
  }
}
