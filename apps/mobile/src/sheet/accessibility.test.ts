import { test } from "bun:test";
import { nativeProbe } from "../app/nativeProbe.testing.ts";

test("Android sheets expose only the top open sheet and restore the app when closed", () => {
  nativeProbe(`
mock.module("./sheet/frame.tsx", () => ({ SheetFrame: "SheetFrame" }));
const { SheetHost } = await import("./sheet/host.tsx");
const render = () => { cursor = 0; return SheetHost({ children: jsx("Button", { label: "Home" }) }); };
const labels = (tree) => exposed(tree).flatMap((node) => node.type === "Button" ? [node.props.label]
  : node.type === "SheetFrame" ? [node.props.children] : []);
let tree = render();
const { show } = tree.props.value;
const sheet = (children, open = true) => ({ open, onClose: () => {}, children });
assert.deepEqual(labels(tree), ["Home"]);
show("host", sheet("Host details", false));
assert.deepEqual(labels(render()), ["Home"]);
show("host", sheet("Host details"));
assert.deepEqual(labels(render()), ["Host details"]);
show("menu", sheet("Actions"));
assert.deepEqual(labels(render()), ["Actions"]);
show("menu", sheet("Actions", false));
assert.deepEqual(labels(render()), ["Host details"]);
show("menu", null);
show("host", sheet("Host details", false));
assert.deepEqual(labels(render()), ["Home"]);
show("host", null);
assert.deepEqual(labels(render()), ["Home"]);
`);
});

test("iOS keeps the existing sheet and app hierarchy", () => {
  nativeProbe(
    `
mock.module("./sheet/frame.tsx", () => ({ SheetFrame: "SheetFrame" }));
const { SheetHost } = await import("./sheet/host.tsx");
const child = jsx("Button", { label: "Home" });
const render = () => { cursor = 0; return SheetHost({ children: child }); };
let tree = render();
tree.props.value.show("host", { open: true, onClose: () => {}, children: "Host details" });
tree = render();
assert.equal(tree.props.children[0], child);
assert.equal(nodes(tree).filter((node) => node.type === "SheetFrame").length, 1);
assert.equal(nodes(tree).some((node) => node.props?.importantForAccessibility !== undefined), false);
`,
    "ios"
  );
});
