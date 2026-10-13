import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

export const serverMarker = "cm_test_sk_next_build_marker_000001";
const hash = (data) => createHash("sha256").update(data).digest("hex");
export function nextBuildChild(root, path) {
  const actual = realpathSync(path),
    part = relative(root, actual);
  assert(
    part && !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`),
    "framework path escaped owned root",
  );
  return actual;
}
export function nextBuildFiles(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).flatMap((entry) => {
    assert(entry.isFile() || entry.isDirectory(), "framework inventory contains a link");
    return entry.isDirectory() ? [] : [nextBuildChild(root, join(entry.parentPath, entry.name))];
  });
}

export function inspectNextBuild(consumer) {
  const build = nextBuildChild(realpathSync(consumer), join(consumer, ".next"));
  const server = nextBuildChild(build, join(build, "server"));
  const client = nextBuildChild(build, join(build, "static"));
  const routes = JSON.parse(
    readFileSync(nextBuildChild(server, join(server, "app-paths-manifest.json"))),
  );
  assert.equal(routes["/api/artifact/route"], "app/api/artifact/route.js", "missing marker route");
  nextBuildChild(server, join(server, routes["/api/artifact/route"]));
  const serverFiles = nextBuildFiles(server).filter((path) => path.endsWith(".js"));
  const clientFiles = nextBuildFiles(client).filter((path) => path.endsWith(".js"));
  assert(serverFiles.length && clientFiles.length, "empty Next build JavaScript inventory");
  // The SDK client must also bundle for the Edge runtime: its route is compiled by
  // the edge compiler and listed as a function in the middleware manifest.
  const edge = JSON.parse(
    readFileSync(nextBuildChild(server, join(server, "middleware-manifest.json"))),
  );
  const edgeRoute = edge.functions?.["/api/edge/route"];
  assert(Array.isArray(edgeRoute?.files) && edgeRoute.files.length > 0, "missing edge route");
  const edgeFiles = edgeRoute.files.map((file) => nextBuildChild(build, join(build, file)));
  const witness = serverFiles
    .filter((path) => !edgeFiles.includes(path))
    .find((path) => readFileSync(path).includes(serverMarker));
  assert(witness, "server marker witness missing");
  assert(
    clientFiles.every((path) => !readFileSync(path).includes(serverMarker)),
    "server marker leaked into client output",
  );
  const edgeWitness = edgeFiles.find((path) => readFileSync(path).includes(serverMarker));
  assert(edgeWitness, "edge marker witness missing");
  return {
    serverFiles: serverFiles.length,
    clientFiles: clientFiles.length,
    witness: relative(build, witness),
    sha256: hash(readFileSync(witness)),
    edgeWitness: relative(build, edgeWitness),
  };
}
