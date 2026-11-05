import "../../../test/dom.testing.ts";
import { expect, test } from "bun:test";
import { subjectAt } from "./menuSubject.ts";

test.each(["https://example.com/docs", "http://localhost:3000/", "http://127.0.0.1:5173/"])(
  "offers external link actions for a transcript link: %s",
  (url) => {
    const anchor = document.createElement("a");
    anchor.href = url;
    const label = document.createElement("span");
    anchor.append(label);

    expect(subjectAt(label).link).toBe(url);
  }
);

test.each(["file:///C:/notes.html", "javascript:alert(1)", "https://user:secret@example.com/"])(
  "does not offer external link actions for an unsafe URL: %s",
  (url) => {
    const anchor = document.createElement("a");
    anchor.href = url;

    expect(subjectAt(anchor).link).toBeNull();
  }
);

test("offers browser actions for an HTTP image URL", () => {
  const image = document.createElement("img");
  image.src = "http://localhost:3000/chart.png";

  expect(subjectAt(image)).toMatchObject({ image: true, link: "http://localhost:3000/chart.png" });
});
