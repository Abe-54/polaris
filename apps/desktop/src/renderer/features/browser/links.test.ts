import { expect, test } from "bun:test";
import { browserLinkOf } from "./links.ts";

test.each([
  ["http://localhost:5173/", "http://localhost:5173/"],
  ["http://LOCALHOST:3000/app?x=1#top", "http://localhost:3000/app?x=1#top"],
  ["https://app.localhost/", "https://app.localhost/"],
  ["http://127.0.0.1:8080/", "http://127.0.0.1:8080/"],
  ["http://[::1]:4000/", "http://[::1]:4000/"],
])("%s is a Host address and opens in the Browser", (href, url) => {
  expect(browserLinkOf(href)).toBe(url);
});

test.each([
  ["a public site", "https://effect.website/docs"],
  ["a name that only resolves to loopback", "http://localtest.me:3000/"],
  ["another scheme", "ftp://localhost/file"],
  ["a file URL", "file:///home/u/index.html"],
  ["a relative path", "docs/index.html"],
  ["no href", undefined],
])("%s stays out of the Browser", (_, href) => {
  expect(browserLinkOf(href)).toBeNull();
});
