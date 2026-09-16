// Exercise installed provider wiring with controlled hooks, without claiming browser hydration.
export async function providerProbe(loadProvider = () => import("@commish/next/react")) {
  const { default: assert } = await import("node:assert/strict");
  const { registerHooks } = await import("node:module");
  const key = Symbol.for("commish.provider.probe");
  assert(!Object.hasOwn(globalThis, key), "provider probe state already exists");
  const state = { calls: [], pending: [], pathname: "/first", query: new URLSearchParams("a=1") };
  globalThis[key] = state;
  const access = 'globalThis[Symbol.for("commish.provider.probe")]';
  const mocks = {
    react: `export const Suspense = "Suspense";
export function useEffect(effect, deps) {
  const state = ${access};
  if (!state.deps || deps.some((value, index) => !Object.is(value, state.deps[index]))) state.pending.push(effect);
  state.deps = deps;
}`,
    "react/jsx-runtime": `export const Fragment = "Fragment";
export const jsx = (type, props) => ({ type, props }); export const jsxs = jsx;`,
    "next/navigation.js": `export const usePathname = () => ${access}.pathname;
export const useSearchParams = () => ${access}.query;`,
    "@commish/sdk/browser": `export async function captureReferral(options) { ${access}.calls.push(options); }`,
  };
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    return Object.hasOwn(mocks, specifier)
      ? { url: `data:text/javascript,${encodeURIComponent(mocks[specifier])}`, shortCircuit: true }
      : nextResolve(specifier, context);
  } });
  try {
    const provider = await loadProvider();
    assert.deepEqual(Object.keys(provider), ["CommishProvider"]);
    let props = { publishableKey: "pk_first", applicationId: "app_first", capturePath: undefined };
    const expected = [];
    for (const change of ["initial", "unchanged", "pathname", "query", "publishableKey", "applicationId", "capturePath", "children"]) {
      if (change === "pathname") state.pathname = "/second";
      if (change === "query") state.query = new URLSearchParams("a=2");
      if (["publishableKey", "applicationId", "capturePath"].includes(change))
        props = { ...props, [change]: change === "capturePath" ? "/custom-capture" : `${change}_second` };
      const children = change === "children" ? "updated child" : "preserved child";
      const tree = provider.CommishProvider({ ...props, children });
      assert.equal(tree.type, "Fragment");
      assert.equal(tree.props.children.length, 2);
      assert.equal(tree.props.children[1], children, "provider changed its children");
      const suspense = tree.props.children[0];
      assert.equal(suspense.type, "Suspense");
      assert.equal(suspense.props.fallback, null);
      const capture = suspense.props.children;
      assert.equal(capture.type(capture.props), null);
      assert.deepEqual(state.calls, expected, "capture ran during render");
      for (const effect of state.pending.splice(0)) await effect();
      if (!["unchanged", "children"].includes(change)) expected.push({ ...props });
      assert.deepEqual(state.calls, expected, `capture effect after ${change}`);
    }
  } finally {
    hooks.deregister();
    delete globalThis[key];
  }
}
