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
  session between requests, and every call, a retry included, starts a new
  one. Claude Code's own request for a session title is switched off.
- Mike asks for the summary of the model's thinking, as it does through the
  API. Claude 5 models send none unless asked.
- Claude Code streams a tool call's input as the model writes it
  (`CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING`). Otherwise the API holds
  the input back until it is complete, and a call that carries a whole
  document is minutes in which nothing arrives.

## Plan usage

Once a subscription is connected, the Claude Subscription section shows how
much of the plan is used: the five-hour session, the week, and each model's
week, with the time each resets. The figures are Anthropic's. Mike starts
Claude Code in the person's directory and sends its usage request
(`backend/src/lib/claudeCode/usage.ts`); no prompt goes to a model, so
reading them uses none of the plan. An answer is kept for a minute.

The request is an Agent SDK method marked experimental. If a later SDK
renames it, the section reports that the usage could not be loaded and
everything else keeps working.

## Deadlines and waiting

A chat turn has the same silence limits as with any other provider
(`STREAM_FIRST_CHUNK_TIMEOUT_MS`, `STREAM_CHUNK_TIMEOUT_MS`), counted from
the start of its Claude Code process. What counts as silence differs,
because Claude Code reports on itself between the model's outputs
(`backend/src/lib/llm/providerDeadlines.ts`):

- Any message from the process renews the limit it is under: the API's
  keep-alive pings while the model thinks, the notice it repeats while it
  compacts a long conversation, the start of each request. Only a process
  that sends nothing at all is ended as one that stopped responding.
- When the API is overloaded, Claude Code says how long it waits before it
  asks again. That wait is added to the first-chunk limit of the retry.
- Time a tool takes inside Claude Code does not count, and the model's
  request after the tool results gets the first-chunk limit again.

None of these is output. A turn in which the model writes nothing for
`STREAM_IDLE_TIMEOUT_MS`, five minutes by default, is still ended by the
run's own idle limit.

A call that is not streamed (a chat title, a tabular review cell) is ended
after `STREAM_IDLE_TIMEOUT_MS`, counted from the start of its Claude Code
process. The process is stopped and its slot freed.

When every slot is taken, further requests wait. The wait counts against no
limit: a waiting turn starts when a slot is free, and a waiting chat turn
starts before waiting one-shot calls. If turns wait noticeably while a large
tabular review runs or several people chat at once, raise
`CLAUDE_CODE_MAX_CONCURRENCY`.

Claude Code runs the tool calls of one model message one after another, not
side by side, so a turn that delegates to several subagents takes the sum of
their times.

A turn that uses up its tool-call rounds ends with what it has written and
the same notice as through the API. Claude Code reports that limit as an
error; Mike does not pass it on as one.

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
