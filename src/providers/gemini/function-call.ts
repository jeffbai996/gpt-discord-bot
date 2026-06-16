// Choose the model `functionCall` part to echo back into the tool-loop.
// The part MUST carry `thoughtSignature` for gemini-3 thinking models (incl.
// 3.5-flash) — without it the next call 400s or, on 3.5-flash, silently
// degrades into re-calling the same tool until exhaustion.
//
// Priority:
//   1. `capturedPart` — grabbed verbatim at stream time, where the signature
//      is guaranteed present (it can arrive in an earlier chunk than the final
//      aggregated candidate).
//   2. the part re-found in the final candidate's parts (non-streaming SDKs).
//   3. a bare reconstruct `{ functionCall }` — last resort; loses the
//      signature, but better than throwing when no part is available at all.
//
// Ported verbatim from gem-bot/src/gemini.ts:selectFunctionCallPart.
export function selectFunctionCallPart(
  capturedPart: any | null | undefined,
  candidateParts: any[] | undefined,
  bareFunctionCall: any
): any {
  if (capturedPart && capturedPart.functionCall) return capturedPart
  const found = (candidateParts ?? []).find((p: any) => p?.functionCall)
  if (found) return found
  return { functionCall: bareFunctionCall }
}
