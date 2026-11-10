/** Best-effort nested-realm removal; the host remains the WebRTC boundary (ADR 0101). */
export const GUARD_JS = String.raw`
var call = Reflect.apply;
var define = Object.defineProperty;
var weakHas = WeakSet.prototype.has;
var weakAdd = WeakSet.prototype.add;
var observe = MutationObserver.prototype.observe;
var matches = Element.prototype.matches;
var remove = Element.prototype.remove;
var elementQuery = Element.prototype.querySelectorAll;
var fragmentQuery = DocumentFragment.prototype.querySelectorAll;
var nodeType = Object.getOwnPropertyDescriptor(Node.prototype, "nodeType").get;
var shadowRoot = Object.getOwnPropertyDescriptor(Element.prototype, "shadowRoot").get;
// CSP doesn't govern WebRTC: an ICE server is a way out, so the constructors go before agent code runs.
["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCRtpTransceiver"].forEach(function (name) {
  try {
    define(window, name, { value: undefined, writable: false, configurable: false });
  } catch (error) {}
});

// A nested frame is a fresh realm with WebRTC intact, so none may stay: removed after insertion.
var NESTED = "iframe, frame, object, embed";
var WATCH = { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "srcdoc", "data"] };
var watched = new WeakSet();

function sweep(node) {
  var type = call(nodeType, node, []);
  if (type !== 1 && type !== 11) return;
  if (type === 1 && call(matches, node, [NESTED])) return call(remove, node, []);
  var query = type === 1 ? elementQuery : fragmentQuery;
  var nested = call(query, node, [NESTED]);
  for (var i = 0; i < nested.length; i++) call(remove, nested[i], []);
  var shadow = type === 1 ? call(shadowRoot, node, []) : null;
  if (shadow) watch(shadow);
  var elements = call(query, node, ["*"]);
  for (var j = 0; j < elements.length; j++) {
    var inner = call(shadowRoot, elements[j], []);
    if (inner) watch(inner);
  }
}

var nestedObserver = new MutationObserver(function (records) {
  for (var i = 0; i < records.length; i++) {
    var record = records[i];
    for (var j = 0; j < record.addedNodes.length; j++) sweep(record.addedNodes[j]);
    if (record.type === "attributes") sweep(record.target);
  }
});

function watch(target) {
  if (call(weakHas, watched, [target])) return;
  call(weakAdd, watched, [target]);
  call(observe, nestedObserver, [target, WATCH]);
  sweep(target);
}

function lock(owner, name, value) {
  try {
    define(owner, name, { value: value, writable: false, configurable: false });
  } catch (error) {}
}

// The observer can't see into a shadow root, so each new one is watched too.
var attachShadow = Element.prototype.attachShadow;
lock(Element.prototype, "attachShadow", function (options) {
  var shadow = call(attachShadow, this, [{ mode: options.mode, delegatesFocus: options.delegatesFocus,
    slotAssignment: options.slotAssignment, clonable: false, serializable: false }]);
  watch(shadow);
  return shadow;
});

// These parse declarative shadow roots, which can be closed and so out of reach: not available.
function refused(name) {
  return function () { throw new Error(name + " isn't available in a Visualization"); };
}
[Document.prototype, document].forEach(function (owner) {
  lock(owner, "write", refused("document.write"));
  lock(owner, "writeln", refused("document.writeln"));
});
lock(Element.prototype, "setHTMLUnsafe", refused("setHTMLUnsafe"));
if (window.ShadowRoot) lock(ShadowRoot.prototype, "setHTMLUnsafe", refused("setHTMLUnsafe"));
lock(Document, "parseHTMLUnsafe", refused("Document.parseHTMLUnsafe"));

watch(document);
`;
