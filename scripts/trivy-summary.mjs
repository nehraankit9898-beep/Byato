#!/usr/bin/env node
/**
 * Turn Trivy JSON reports into a readable CI job summary (and check annotations).
 *
 * Why this exists: when the Trivy gate fails, the step log only says "Process
 * completed with exit code 1" in the API — the findings table lives in the raw
 * log archive, which is served from a different host and is unreachable from
 * restricted environments (and easy to lose when logs expire). This script
 * re-publishes the same findings to:
 *
 *   1. stdout  → appended to $GITHUB_STEP_SUMMARY (visible on the run page)
 *   2. `::error` lines → check-run annotations, readable through api.github.com
 *
 * It NEVER changes the gate: the scans keep `exit-code: "1"`. This step runs
 * with `if: always()` and always exits 0 — a missing or unparsable report must
 * not mask (or fake) the real scan result.
 *
 * Reproducing locally:
 *   trivy image --format json --output trivy-web.json --severity HIGH,CRITICAL \
 *     --ignore-unfixed stayloop-web:ci
 *   node scripts/trivy-summary.mjs trivy-web.json
 */

import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

const MAX_TABLE_ROWS = 25;
const MAX_ANNOTATIONS = 5;

/** GitHub Actions command escaping (annotation values). */
function escapeAnnotation(text) {
  return String(text)
    .replace(/%/g, "%25")
    .replace(/\r/g, "%0D")
    .replace(/\n/g, "%0A")
    .replace(/:/g, "%3A")
    .replace(/,/g, "%2C");
}

/** Markdown table cells must not contain raw pipes or newlines. */
function cell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .slice(0, 160);
}

function severityRank(severity) {
  return { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, UNKNOWN: 4 }[severity] ?? 5;
}

function loadReport(path) {
  if (!existsSync(path)) {
    return { path, missing: true, artifact: path, findings: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const findings = [];
    for (const result of parsed.Results ?? []) {
      for (const vuln of result.Vulnerabilities ?? []) {
        findings.push({
          id: vuln.VulnerabilityID ?? "unknown",
          package: vuln.PkgName ?? "unknown",
          installed: vuln.InstalledVersion ?? "",
          fixed: vuln.FixedVersion ?? "",
          severity: vuln.Severity ?? "UNKNOWN",
          target: result.Target ?? "",
          title: vuln.Title ?? "",
        });
      }
    }
    findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    return { path, missing: false, artifact: parsed.ArtifactName ?? basename(path), findings };
  } catch (err) {
    return {
      path,
      missing: false,
      artifact: basename(path),
      findings: [],
      parseError: err instanceof Error ? err.message : String(err),
    };
  }
}

const paths = process.argv.slice(2);
const reports = paths.map(loadReport);

const lines = ["", "## Trivy — HIGH/CRITICAL findings (unfixed advisories ignored)", ""];

for (const report of reports) {
  if (report.missing) {
    lines.push(
      `- \`${report.path}\` — **no report produced** (the scan did not run to completion).`,
    );
    continue;
  }
  const counts = report.findings.reduce((acc, f) => {
    acc[f.severity] = (acc[f.severity] ?? 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([severity, count]) => `${count} ${severity}`)
    .join(", ");

  lines.push(`### ${report.artifact}`);
  if (report.parseError) {
    lines.push(`- Report could not be parsed: ${cell(report.parseError)}`);
  }
  if (report.findings.length === 0) {
    lines.push("- No HIGH/CRITICAL findings with an available fix. ✅");
    lines.push("");
    continue;
  }
  lines.push(`- **${report.findings.length} finding(s)**: ${summary}`);
  lines.push("");
  lines.push("| Severity | CVE | Package | Installed | Fixed in | Target |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const finding of report.findings.slice(0, MAX_TABLE_ROWS)) {
    lines.push(
      `| ${cell(finding.severity)} | ${cell(finding.id)} | ${cell(finding.package)} | ${cell(
        finding.installed,
      )} | ${cell(finding.fixed || "—")} | ${cell(finding.target)} |`,
    );
  }
  if (report.findings.length > MAX_TABLE_ROWS) {
    lines.push("");
    lines.push(`_(${report.findings.length - MAX_TABLE_ROWS} more in the JSON report.)_`);
  }
  lines.push("");
}

// Annotations: bounded and escaped, so a hostile package name cannot inject
// workflow commands or blow up the check-run payload.
for (const report of reports) {
  for (const finding of report.findings.slice(0, MAX_ANNOTATIONS)) {
    const detail = `${finding.id} in ${finding.package} ${finding.installed}${
      finding.fixed ? ` (fixed in ${finding.fixed})` : ""
    }${finding.target ? ` — ${finding.target}` : ""}`;
    console.log(
      `::error title=Trivy ${escapeAnnotation(finding.severity)} ${escapeAnnotation(
        report.artifact,
      )}::${escapeAnnotation(detail)}`,
    );
  }
}

console.log(lines.join("\n"));
process.exit(0);
