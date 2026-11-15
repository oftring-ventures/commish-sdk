import { CliError } from "./cli-http.mjs";
import { readSetupFile } from "./setup-files.mjs";

// Why a body file was refused. Reasons and guidance are fixed text: neither the
// path nor anything read from the file reaches output.
const bodyFileGuidance = {
  path_not_repository_relative:
    "Pass --body-file a relative path inside the current repository (the directory the command runs in): no absolute path, no .. segment and no symbolic link. Copy the file into the repository first.",
  file_missing: "No file exists at that path, relative to the directory the command runs in.",
  file_unreadable: "The body file must be a readable regular UTF-8 file of at most 1 MiB.",
  invalid_json: "The body file is not valid JSON.",
  json_object_required: "The body file must contain one JSON object.",
};
const bodyFileFailure = (reason) =>
  new CliError("invalid_body_file", { reason, guidance: bodyFileGuidance[reason] });
// The rules every --body-file follows, for each command's help.
export const bodyFileHelp = () => ({
  path: "relative_path_inside_the_current_repository; no absolute path, .. segment or symbolic link",
  content: "one JSON object in a regular UTF-8 file of at most 1 MiB",
  errorCode: "invalid_body_file",
  errorReasons: Object.keys(bodyFileGuidance),
});
export function readBodyFile(root, path) {
  let text, input;
  try {
    text = readSetupFile(root, path, { profile: "configuration" });
  } catch (error) {
    throw bodyFileFailure(
      { unsafe_file_path: "path_not_repository_relative", setup_file_missing: "file_missing" }[
        error?.message
      ] ?? "file_unreadable",
    );
  }
  try {
    input = JSON.parse(text);
  } catch {
    throw bodyFileFailure("invalid_json");
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw bodyFileFailure("json_object_required");
  return input;
}
