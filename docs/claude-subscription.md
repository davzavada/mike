# Claude subscriptions

A deployment can let each person run Claude models on their own Claude plan
(Pro, Max, Team or Enterprise) instead of an API key. It is off by default.

## What it does

With `CLAUDE_CODE_SUBSCRIPTION=on`, Settings → API Keys shows a Claude
Subscription section. The person clicks Connect, signs in at Anthropic in
their browser, and pastes the confirmation code back. From then on the
`claude-*` models answer through that person's plan, and usage counts against
that plan's limits.

Which credential answers a Claude request:

1. a key the person saved (personal work) or their organization saved
   (organization work);
2. otherwise the person's own subscription, when connected;
3. otherwise the deployment's `ANTHROPIC_API_KEY`.

A subscription is always the acting person's own. It is never shared with
other users, and an organization cannot provide one.

## How it works

The backend runs Claude Code, the binary published by Anthropic and installed
with `@anthropic-ai/claude-agent-sdk`, once per request:

- Each person has a configuration directory,
  `CLAUDE_CODE_DATA_DIR/<user id>`. `claude auth login` runs there; Claude
  Code performs the sign-in with Anthropic and stores its credentials there.
  The backend passes on the link and the code. It does not read, copy or log
  the credentials, and keeps only a marker file (`mike-connection.json`) with
  the account email and plan that `claude auth status` reports.
- Claude Code's own tools (shell, files, web) are switched off, as are
  settings files and the person's claude.ai connectors. Mike's tools reach it
  as an in-process MCP server, and each call runs through the same code as
  with any other provider (`backend/src/lib/llm/claudeCode.ts`).
- The subprocess environment is built from scratch. The deployment's
  provider keys are never passed to it.
- Mike sends the whole conversation on each turn; Claude Code keeps no
  session between requests.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLAUDE_CODE_SUBSCRIPTION` | off | `on` enables the feature. |
| `CLAUDE_CODE_DATA_DIR` | `~/.mike/claude-code` | Where the per-user directories live. Mount a volume here in a container. |
| `CLAUDE_CODE_MAX_CONCURRENCY` | 3 | Claude Code processes answering at once (1–16). Further requests wait. Each process needs roughly 300–500 MB. |
| `CLAUDE_CODE_EXECUTABLE` | the SDK's binary | Path to another copy of the published binary. |

The data directory holds live sign-ins. Treat it, and any backup of it, like
a credential store.

## Limits

- Anthropic's web search tool is not available on this path. Mike's own web
  search (`docs/web-search.md`) works.
- Prompt caching is Claude Code's own, per request; long conversations cost
  more of the plan's allowance than through the API.
- When a sign-in expires or is revoked, the next request fails with "Your
  Claude subscription is not signed in"; the person reconnects in Settings.

## Anthropic's terms

Read Anthropic's
[Claude Code legal and compliance page](https://code.claude.com/docs/en/legal-and-compliance)
before enabling this for anyone but yourself. It lets a service run the
unmodified Claude Code for its users only if each user signs in with their
own credentials through Anthropic's flow, usage is billed to that user, and
the operator has agreed to Anthropic's Commercial Terms. It forbids routing
other people's requests through your own plan. The same page tells
developers building on the Agent SDK to use API keys; whether a deployment
like this one qualifies is a question for Anthropic, not for this document.
