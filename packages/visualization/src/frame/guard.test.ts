import { expect, test } from "bun:test";
import { buildFrameDocument } from "../index.ts";
import { runFrame } from "./run.testing.ts";

const frameFor = () =>
  runFrame(
    buildFrameDocument({
      html: '<div id="host"></div>',
      title: "guard",
      tokens: {},
      scheme: "dark",
      mode: "expanded",
    })
  );

test("poisoning WeakSet.has cannot leave a child in a new closed shadow root", async () => {
  const frame = frameFor();
  frame.run(`const has = WeakSet.prototype.has;
    WeakSet.prototype.has = () => true;
    window.shadow = document.getElementById('host').attachShadow({mode:'closed'});
    shadow.appendChild(document.createElement('iframe'));
    WeakSet.prototype.has = has;`);
  await Bun.sleep(0);
  expect(frame.evaluate("shadow.querySelectorAll('iframe').length")).toBe(0);
});

test("poisoning Function.apply cannot capture the original attachShadow", () => {
  const frame = frameFor();
  frame.run(`const proto = Object.getPrototypeOf(Element.prototype.setAttribute);
    const apply = proto.apply;
    window.stolen = false;
    proto.apply = function(owner, args) {
      window.stolen = true;
      return Reflect.apply(this, owner, args);
    };
    document.getElementById('host').attachShadow({mode:'closed'});
    proto.apply = apply;`);
  expect(frame.global("stolen")).toBe(false);
});

test("poisoning Element.remove cannot preserve a nested browsing context", async () => {
  const frame = frameFor();
  frame.run(`Element.prototype.remove = function() {};
    document.body.appendChild(document.createElement('iframe'));`);
  await Bun.sleep(0);
  expect(frame.evaluate("document.querySelectorAll('iframe').length")).toBe(0);
});

test("a frame's poisoned Element.remove doesn't reach the next frame's guard", async () => {
  frameFor().run(`Element.prototype.remove = function() {};`);
  const next = frameFor();
  next.run(`document.body.appendChild(document.createElement('object'));`);
  await Bun.sleep(0);
  expect(next.evaluate("document.querySelectorAll('object').length")).toBe(0);
});

test("cloning a host cannot copy an unobserved closed shadow tree", () => {
  const frame = frameFor();
  frame.run(`const host = document.getElementById('host');
    host.attachShadow({mode:'closed',clonable:true,serializable:true}).innerHTML = '<p>private</p>';
    const clone = host.cloneNode(true);
    window.fresh = false;
    try { window.fresh = clone.attachShadow({mode:'closed'}).childNodes.length === 0; } catch {}`);
  expect(frame.global("fresh")).toBe(true);
});
