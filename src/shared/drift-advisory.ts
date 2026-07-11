/**
 * v1 PostToolUse drift advisory — a RULE-SCOPED REMINDER, not a drift verdict.
 *
 * v1 SCOPE (honest boundary): this only reminds the agent that the landed file
 * is under high-altitude Mentor governance and to verify the change still
 * matches what was cleared in consult. It does NOT compare the landed content
 * against the consultation — full substance-drift review lands in v2 (it needs
 * the v2 server-threaded consultation transcript). Do not extend this into a
 * partial substance check: a sometimes-right check implies coverage we don't have.
 */
export function driftAdvisory(consultRequired: boolean, ruleIds: readonly string[]): string | null {
  if (!consultRequired || ruleIds.length === 0) return null;
  return (
    `Axtar Mentor (advisory): this file is under high-altitude Mentor governance ` +
    `(rules: ${ruleIds.join(', ')}). Verify the landed change still matches what you ` +
    `cleared in consult. This is a v1 rule-scoped reminder only — full substance-drift ` +
    `review lands in v2.`
  );
}
