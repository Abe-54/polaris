import { describe, expect, test } from "bun:test";
import { allowedFrameUrl, allowedUrl, isHostAddress, urlFromInput } from "./navigation.ts";

describe("allowedUrl", () => {
  test.each([
    "http://localhost:3000/",
    "https://example.com/path?q=1",
    "http://[::1]:8080/",
    "about:blank",
  ])("lets a tab load %s", (url) => expect(allowedUrl(url)).toBe(true));

  test.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "chrome://settings",
    "devtools://devtools/bundled/inspector.html",
    "app://polaris/index.html",
    "blob:https://example.com/uuid",
    "about:srcdoc",
    "not a url",
    "http://",
  ])("refuses %s", (url) => expect(allowedUrl(url)).toBe(false));
});

describe("allowedFrameUrl", () => {
  test.each([
    "data:text/html,<script>alert(1)</script>",
    "blob:http://localhost:3000/0b5c6f1e",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "about:srcdoc",
  ])("%s loads in no main frame, and in an iframe only when it's a srcdoc", (url) => {
    expect(allowedFrameUrl(url, true)).toBe(false);
    expect(allowedFrameUrl(url, false)).toBe(url === "about:srcdoc");
  });

  test("an iframe loads http and https as a page does", () => {
    expect(allowedFrameUrl("http://localhost:3000/embed", false)).toBe(true);
    expect(allowedFrameUrl("https://example.com/", false)).toBe(true);
  });
});

describe("urlFromInput", () => {
  test.each([
    ["localhost:3000", "http://localhost:3000/"],
    ["app.localhost/sign-in", "http://app.localhost/sign-in"],
    ["127.0.0.1:8080", "http://127.0.0.1:8080/"],
    ["[::1]:5173", "http://[::1]:5173/"],
    ["example.com", "https://example.com/"],
    ["  https://example.com/a  ", "https://example.com/a"],
    ["HTTP://Example.com", "http://example.com/"],
    ["about:blank", "about:blank"],
  ])("loads %s as %s", (input, url) => expect(urlFromInput(input)).toBe(url));

  test.each([
    "file:///Users/me/.ssh/id_ed25519",
    "javascript:fetch('/')",
    "JavaScript:alert(1)",
    "data:text/html,hi",
    "chrome://gpu",
    "devtools://devtools",
    "app://polaris/",
    "",
    "two words",
  ])("refuses %s", (input) => expect(urlFromInput(input)).toBeNull());
});

describe("isHostAddress", () => {
  test.each([
    "http://localhost:3000/",
    "http://LOCALHOST./",
    "http://my-app.localhost/",
    "http://127.4.5.6/",
    "http://[::1]:3000/",
  ])("%s is a Host address", (url) => expect(isHostAddress(url)).toBe(true));

  test.each([
    "https://example.com/",
    "http://localhost.example.com/",
    "http://128.0.0.1/",
    "http://192.168.1.10:3000/",
    "about:blank",
  ])("%s is not", (url) => expect(isHostAddress(url)).toBe(false));
});
