import { argumentsFor, errorReceipt, fail } from "./cli-http.mjs";
import { managementClient } from "./management-client.mjs";
export const doctorHelp = () => ({ version: 1, status: "help", command: "doctor --program <id> --auth-file <path> --mode test --json",
  requiredScope: "diagnostics.read", flags: ["--program <id>", "--auth-file <path>", "--mode test|live", "--management-url <url>", "--json", "--non-interactive"],
  interpretation: "Current configuration and bounded linked conversion/commission/delivery evidence. Never certifies settlement, payout or complete integration behavior.",
  exitCodes: { 0: "all_reported_checks_observed", 1: "error", 2: "unmet_or_unevaluated_conditions" } });
export async function executeDoctor(args, options = {}) {
  const { values: v, positionals: p } = argumentsFor(args, ["program", "auth-file", "mode", "management-url"], ["help", "json", "non-interactive"]);
  if (v.help) return doctorHelp();
  if (p.length || !/^prg_[A-Za-z0-9_-]{12,}$/.test(v.program ?? "")) fail("invalid_arguments");
  const client = managementClient({ ...options, authFile: v["auth-file"], mode: v.mode, url: v["management-url"] });
  const receipt = await client.call("diagnostics.get", { programId: v.program });
  const report = receipt.data?.report;
  if (!report || report.version !== 1 || report.mode !== client.mode || report.programId !== v.program ||
    !["observed", "incomplete"].includes(report.status) || report.integrationVerified !== false || !Array.isArray(report.unmetConditions)) fail("invalid_response");
  return { ...receipt, status: report.status, integrationVerified: false };
}
export async function runDoctorCommand(args, { out = console.log, diagnostic = console.error, ...options } = {}) {
  try { const result = await executeDoctor(args, options); out(JSON.stringify(result)); return result.status === "incomplete" ? 2 : 0; }
  catch (error) { diagnostic(JSON.stringify(errorReceipt(error))); return 1; }
}
