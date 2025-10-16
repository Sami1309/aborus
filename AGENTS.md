# Agents

## Package
- Use uv as the python package manager

## Modeler Recorder
- Watches real-time browser actions streamed from the browser-use agent instrumentation.
- Normalizes each action into a structured event (navigation, click, input, wait) and tracks DOM context snapshots.
- Pushes normalized actions into the flow graph builder and selector miner subsystems.

## Selector Miner
- Generates robust selector candidates from DOM metadata and user-facing semantics for every recorded action.
- Scores selectors by stability heuristics (ID > ARIA role > text > CSS fallback) and persists them alongside the action node.
- Supplies selector candidates to downstream deterministic runners once the flow is exported.

## Flow Synthesizer
- Maintains the evolving directed graph of the session, linking recorded actions into a runnable flow.
- Calls the LLM annotator to paraphrase each action, determine intent, and decide whether a node should be declarative (semantic) or explicit (DOM selector).
- Exposes the flow graph over the modeler service API and serializes a canonical JSON representation.

## Prompt Editor
- Accepts user edits—either direct JSON patches or natural-language prompts—and applies them to the flow graph.
- Delegates prompt interpretation to the LLM annotator with guardrails that only allow mutations on existing nodes or edges.
- Re-scores selectors and re-annotates nodes after edits so deterministic runners stay in sync.

Each agent runs inside the modeler service defined in `agent/`, with clear module boundaries to swap implementations as we build the rest of the stack in SPEC.md.
