# PERMISSIONS_SPEC

## Purpose

This document defines the desired permissions mental model for the `pi-guardrails` extension.

It is a product and behavior specification, not an implementation guide.

The goal is to make the intended behavior unambiguous for another agent that already understands its own APIs, extension surfaces, event systems, and runtime architecture.

This spec defines:

- what users should experience
- what runtime concepts should exist
- how permission decisions should behave
- what should and should not survive during a session
- where responsibility belongs conceptually

This spec does **not** define:

- how `pi-coding-agent` should structure code
- what storage layer or hook system it should use
- what internal classes, modules, or files it should create
- how UI should be rendered at an implementation level

## Product Goal

`pi-guardrails` adds a permission system to an environment that is otherwise effectively full-access by default.

The desired behavior is:

- users can choose between `Default` and `Full Access`
- users can switch permissions at any time
- ordinary blocked actions can be approved once or approved for a scoped portion of the current runtime session
- sensitive actions use a stricter prompt
- everything is runtime-only

The extension should feel like a live runtime control plane, not a settings editor.

## Core Mental Model

There are two kinds of permission state:

1. Global session permissions
2. Runtime scoped grants

Global session permissions answer:

- what is the current overall permission posture?

Runtime scoped grants answer:

- what narrow temporary allowances has the user granted during this runtime session?

These are distinct.

Global session permissions are broad. Scoped grants are narrow.

A blocked action may be allowed because:

- the global permissions are broad enough
- or a matching scoped grant exists
- or the user explicitly approved the current action

## Global Runtime State

The extension conceptually owns:

- `permissions = Default | Full Access`
- `sessionScopedGrants[]`

Both are runtime-only.

Both are forward-looking.

Neither survives process exit, restart, reopen, or new session creation.

## Terminology

### User-facing terminology

Use:

- `permissions`
- `Default`
- `Full Access`
- `Yes`
- `Yes, {{scope}} during this session`
- `No`

Do not expose internal policy jargon to users.

### Internal terminology

The internal decision system may use:

- `allow`
- `ask`
- `deny`
- `safety`

But `safety` should be treated as an internal classification or reason, not as user-facing language.

Conceptually:

- `allow | ask | deny` are decisions
- `safety` is a reason/category that changes prompt behavior

## Lifetime Rules

Everything in this MVP is runtime-only.

That includes:

- global `permissions`
- all `sessionScopedGrants[]`

If the user quits and reopens the agent, all of it is gone.

This spec intentionally excludes:

- project-level persistence
- global persistence
- saved allowlists
- saved deny rules
- saved default permission choice

## Non-Goals

This MVP does **not** include:

- plan mode
- persistent rules
- persistent default permission selection
- a grant management UI
- per-project policy files
- global policy files
- session restore of permissions state
- universal scope language defined by guardrails

## Surfaces That Change Global Permissions

Users can change global `permissions` in exactly two ways:

1. `Ctrl+Alt+P`
2. `/permissions`

### `Ctrl+Alt+P`

`Ctrl+Alt+P` toggles only global `permissions`.

It is single-purpose.

It is not reused inside prompts for alternate meanings.

It should always toggle:

- `Default <-> Full Access`

### `/permissions`

`/permissions` is a selector, not a rules screen.

It should show:

- `Default`
- `Full Access`

The user can select either at any time.

Selection updates global `permissions` immediately.

The `/permissions` screen does not need to show:

- active scoped grants
- saved rules
- previous choices
- persistence controls

## Fixed Titles

Use these fixed titles:

| UI                       | Title                                            |
| ------------------------ | ------------------------------------------------ |
| Normal permission prompt | `Do you want to allow this action?`              |
| Safety prompt            | `Do you want to allow this sensitive action?`    |
| `/permissions` selector  | `What permissions do you want for this session?` |

These titles are intentionally fixed for MVP.

They do not need dynamic synthesis.

## Prompt Classes

There are two prompt classes.

### 1. Normal permission prompt

Title:

- `Do you want to allow this action?`

Options:

- `Yes`
- `Yes, {{scope}} during this session`
- `No`

### 2. Safety prompt

Title:

- `Do you want to allow this sensitive action?`

Options:

- `Yes`
- `No`

Safety prompts never offer scoped session widening.

## Meaning of Prompt Choices

### `Yes`

Approves the currently blocked action only.

It does not:

- change global `permissions`
- create deny memory
- create a scoped session grant

### `Yes, {{scope}} during this session`

Approves the currently blocked action and adds exactly one runtime scoped grant for future matching actions during the current runtime session.

It does not:

- change global `permissions`
- persist anything
- create broad global trust

### `No`

Rejects the currently blocked action only.

It does not:

- create runtime deny memory
- create a deny scope
- change global `permissions`

## Scope Model

`{{scope}}` does not need to be translated into human-friendly language for MVP.

Raw or internal-looking scope labels are acceptable.

Examples of acceptable scope styles:

- `edit:*`
- `read:dir:/some/path`
- `write:dir:/some/path`
- `shell:prefix:npm run:*`
- `web:domain:api.example.com`

The important requirement is not human readability.

The important requirement is that the scope is real, precise, and meaningful to the capability/tool that generated it.

## Scope Candidate Rules

At most one session-scope candidate may be shown per blocked action in MVP.

That means:

- zero or one
- never more than one

If the capability/tool cannot produce exactly one clear scope candidate, the prompt should omit the scoped-session option and show only:

- `Yes`
- `No`

for the normal prompt, or:

- `Yes`
- `No`

for safety as already required.

## Matching Model

Guardrails does not define a universal scope matching language in MVP.

Instead:

- the capability/tool provides the scope candidate
- the capability/tool also defines what it means for a future action to match that scope

So the conceptual split is:

- guardrails owns storage of runtime scoped grants
- capability/tool owns scope semantics

This avoids forcing a central matcher to understand every capability’s domain.

## Forward-Only Runtime Behavior

Permission updates are forward-only, not retroactive.

If the user changes global `permissions` while work is already happening:

- currently running tool call keeps the decision it started with
- already-fired action does not re-evaluate itself
- the next tool call reads the latest `permissions`

The same forward-only principle applies to newly added scoped session grants:

- they influence future matching calls
- they do not rewrite the decision of an already-running action

## Relationship Between Global Permissions and Scoped Grants

Global `permissions` and `sessionScopedGrants[]` are layered, not interchangeable.

Global `permissions` describe the broad runtime posture.

Scoped grants describe narrower temporary approvals inside the current session.

Scoped grants survive global permission toggles.

Example:

1. user starts in `Default`
2. user approves `Yes, edit:* during this session`
3. user switches to `Full Access`
4. user later switches back to `Default`

That earlier scoped grant should still exist until the runtime session ends.

## Full Access Semantics

`Full Access` is broad, but not absolute.

This is a key part of the intended mental model.

`Full Access` should skip only ordinary/default asks.

`Full Access` should **not** bypass:

- `deny`
- explicit `ask`
- `safety`
- direct-interaction-required actions

So `Full Access` does **not** mean:

- run everything no matter what

It means:

- skip normal permission friction
- still respect strong blocks and strong approval requirements

## Decision Flow

For each new tool/capability action, the conceptual decision order is:

1. If the action is already in flight, do nothing; no retroactive effect.
2. Evaluate hard deny behavior.
3. Evaluate explicit ask behavior.
4. Evaluate safety behavior.
5. Evaluate direct-interaction-required behavior.
6. If global `permissions = Full Access`, allow.
7. Else if global `permissions = Default` and a matching runtime scoped grant exists, allow.
8. Else show the normal permission prompt.

This order matters.

It ensures `Full Access` is powerful but still constrained by higher-priority safety and policy layers.

## Safety Classification

The MVP should include a real `safety` classification rather than treating every blocked action the same.

Claude-inspired categories that should count as `safety` include:

- protected or internal config/metadata edits
- dangerous or destructive file-system targets
- suspicious path tricks or path canonicalization bypass patterns
- dangerous shell execution patterns
- dangerous PowerShell execution patterns
- actions that explicitly require direct user interaction

This spec does not require guardrails itself to discover these categories centrally.

It is acceptable for capabilities/tools to classify actions as `safety`.

Guardrails then enforces the stricter prompt contract for that classification.

## Responsibility Split

Conceptually, responsibilities should be split like this:

### Guardrails owns

- global `permissions`
- runtime lifetime of `sessionScopedGrants[]`
- the distinction between normal vs safety prompt classes
- the user-facing option set for each prompt class
- forward-only runtime update behavior
- high-level decision ordering

### Capability/tool owns

- whether an action should be `allow`, `ask`, `deny`, or `safety`
- whether a blocked action can produce a scoped session candidate
- what the single scope candidate is
- how future actions match stored scoped grants

This keeps guardrails generic while still giving tools control over domain-specific meaning.

## UX Principles

The permissions system should feel:

- live
- reversible
- runtime-scoped
- predictable

It should not feel:

- like editing config files
- like managing a saved policy database
- like the system is hiding escalation behind vague language

The user should always understand:

- whether they approved only this action
- whether they approved a broader runtime session scope
- whether they changed global `permissions`

## Example Flows

### Example A: Ordinary blocked file write

Current global `permissions`: `Default`

Capability returns a normal ask with one scope candidate:

- `edit:*`

Prompt:

- `Do you want to allow this action?`
- `Yes`
- `Yes, edit:* during this session`
- `No`

If user chooses:

- `Yes` -> only this file write proceeds
- `Yes, edit:* during this session` -> this write proceeds and a runtime grant is stored
- `No` -> this write is rejected only

### Example B: Sensitive config edit

Current global `permissions`: `Default`

Capability classifies action as `safety`

Prompt:

- `Do you want to allow this sensitive action?`
- `Yes`
- `No`

No scoped-session option is shown.

### Example C: User toggles while agent is working

Current global `permissions`: `Default`

Action A already started.

User presses `Ctrl+Alt+P`.

Global `permissions` becomes `Full Access`.

Action A keeps its existing decision.

Action B, fired afterward, evaluates using `Full Access`.

## Handoff Summary

The intended product is a runtime-only permissions layer with:

- a broad global permission posture
- narrow scoped runtime grants
- a clear distinction between ordinary asks and safety asks
- no persistence
- no hidden escalation
- forward-only runtime behavior

The central mental model is:

- global `permissions` controls the broad posture
- scoped grants provide narrow temporary allowances
- prompts resolve the current blocked action
- only future actions see newly changed permission state

That is the desired behavior contract for `pi-guardrails`.
