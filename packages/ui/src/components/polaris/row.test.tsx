import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { Chip } from "./chip";
import { Row } from "./row";

afterEach(cleanup);

describe("Row asChild", () => {
  test("slots onto a single button and puts the row's content inside it", () => {
    const onClick = mock(() => undefined);

    const { getByRole } = render(
      <Row asChild title="Mac Studio" description="Connected" meta="12ms" leading={<i />}>
        <button type="button" onClick={onClick} />
      </Row>
    );

    const button = getByRole("button", { name: /Mac Studio/ });

    expect(button.getAttribute("data-slot")).toBe("row");
    expect(button.textContent).toBe("Mac StudioConnected12ms");
    expect(button.querySelector("i")).not.toBeNull();
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("keeps the child's own children after the row's content", () => {
    const { container } = render(
      <Row asChild title="polaris">
        <a href="#polaris">
          <b>⌃1</b>
        </a>
      </Row>
    );

    const link = container.querySelector("a");

    expect(link?.getAttribute("data-slot")).toBe("row");
    expect(link?.lastElementChild?.tagName).toBe("B");
  });
});

describe("Chip asChild", () => {
  test("slots onto a link with the glyph, label and count inside", () => {
    const { container } = render(
      <Chip asChild needsYou={2} shortcut="⌃1" leading={<i />}>
        <a href="#polaris">polaris</a>
      </Chip>
    );

    const link = container.querySelector("a");

    expect(link?.getAttribute("data-slot")).toBe("chip");
    expect(link?.textContent).toBe("polaris2⌃1");
    expect(link?.querySelector("i")).not.toBeNull();
  });
});

describe("Row text direction (ENG-499)", () => {
  test("a right-to-left title and line keep their own direction, so the end is what truncates", () => {
    const { getByText } = render(
      <Row variant="session" title="تحقق من سبب فشل اختبارات المتجر" description="Idle · turn 24" />
    );

    expect(getByText("تحقق من سبب فشل اختبارات المتجر").getAttribute("dir")).toBe("auto");
    expect(getByText("Idle · turn 24").getAttribute("dir")).toBe("auto");
  });
});
